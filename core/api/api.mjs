// Claude Code Mobile - API 客户端（OpenAI 兼容）
// @ts-nocheck
import { KeyPool, isKeyExhaustedError, maskKey } from './key-pool.mjs'
import { normalizeProviderUrl } from './provider-url.mjs'
// 超时分级：流式首字节 300s（非流式 600s）
// 说明：自主任务在息屏挂机模式下，Android Doze 会让网络请求延迟到维护窗口（最长 9 分钟）。
//       因此 API 超时必须拉长到 5-10 分钟，否则 daemon 还在跑但请求被错误超时。
/**
 * 单次回复的输出上限（max_tokens）默认值。
 *
 * 【2026-09-20 用户拍板：默认 64k】
 * 原来是 8192 —— 写长文/长代码时经常被截断（模型正写到一半就 finish_reason=length）。
 * 64k 覆盖绝大多数场景，且现代模型/中转站普遍支持。
 *
 * ⚠ 注意链路上的钳制关系（见 buildRequestBody）：
 *   Agent 不传 maxTokens → 用这个默认值 → 再被 provider.maxOutputTokens 钳制（只能下调）。
 *   所以 provider 设了更小的值仍然生效（保护那些上限低的模型，如 deepseek-v4-flash 限 [1,1024]）。
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 65536

const DEFAULT_TIMEOUT = 600000
// 连接层出过故障后，多久内所有请求都不复用连接（带 Connection: close）。
// 目的是让 Node 内置 fetch 连接池里的半开连接自然排空 —— 那是
// 「一次流超时之后连 /config test 也一直卡、只有重启才好」的根因。
// 给 2 分钟：足够覆盖用户「超时 → 立刻重试几次」的操作窗口；
// 过期自动恢复复用，不需要重启。只影响性能，不影响正确性。
const CONNECTION_SUSPECT_MS = 120000
const DEFAULT_STREAM_TIMEOUT = 300000
// 【2026-09-01：这里曾经加过一层"建连超时"，已移除，不要再加回来】
// 当时想法是"响应头几秒就该到，慢了说明连接坏了，快速失败去重试"，先设 60s 后调 150s。
// 实际后果全是坏的：
//   1. 首字节延迟本来就跟上下文大小正相关（实测中位 13.6s、p90 30.9s、最大 196.7s），
//      任何低于 watchdog 的固定门槛都会误杀"慢但能成功"的请求，上下文越大越容易中。
//   2. 工具调用会把一次对话放大成多次请求，每次都多一遍撞门槛的机会，
//      用户视角就是"调完工具必超时"。
//   3. 与 agent 的 300s watchdog 形成两层夹击：150s 掐一刀 → 重试 → 还没跑完 watchdog
//      又补一刀，日志出现"建连超时(150s)第1/3次重试"紧跟"Stream timeout (300s no data)"，
//      报错来源完全说不清。
// 结论：流式请求的超时只保留 agent 那一层 watchdog（它会 resetWatchdog，
// 只在真正"持续无数据"时才触发，天然不误杀慢首字节）。fetch 层不再叠加超时。

// 智谱 API 限制 JSON 嵌套深度 20。
// 我们在请求序列化前把 body 深度压到 MAX_JSON_DEPTH（≤17，留 3+ 层余量）。
// 超过阈值的子树折叠为 JSON 字符串：模型本身就在读写 JSON-as-string（tool_calls.arguments），
// 所以折叠后语义可读；引用关系（tool_use_id / tool_call_id）都是字符串本身，不受嵌套影响。
// 唯一例外：tools[].function.parameters 是工具 schema，必须原样保留（压缩了模型就读不懂工具签名了）。
const MAX_JSON_DEPTH = 16
const MAX_FOLDED_STRING = 50000  // 折叠串超过 50KB 带截断标记，防止单个超大对象撑爆请求

// ── microcompact 策略（见 buildRequestBody）────────────────────────────────
// 核心权衡：清理省下的是「这一轮的输入 token」，但如果模型因为内容没了必须重调工具，
// 净消耗 = 重调的输入+输出+又一轮完整历史，**远超**当初省下的那几百字符。
// 所以只清「重调便宜且结果稳定」的工具，且永远保留头尾让模型能判断要不要重调。

// 可再生：随时能用同样参数重调、结果基本一致、且调用成本低
const MICRO_REGENERABLE_TOOLS = new Set([
  'Read', 'HashlineRead',
  'Grep', 'HashlineGrep', 'Glob', 'CodeSearch',
  'RepoMap', 'Symbols',
  'GitStatus', 'GitDiff', 'GitLog',
  'LSP', 'Diagnostics',
  'Bash', 'BashOutput', 'Test',
  'WebFetch', 'WebSearch',
])

// 元信息 / 不可再生：清了要么拿不回来，要么重调代价高于保留
// （任务要求、队友消息、用户原话、子 Agent 产出、多模态旁路注入）
const MICRO_PROTECTED_TOOLS = new Set([
  'TaskGet', 'TaskList', 'TaskCreate', 'TaskClaim', 'TaskUpdate', 'TaskDelete',
  'CheckMessages', 'SendMessage', 'TeamStatus', 'TeamJoin', 'TeamCreate',
  'AgentOutput', 'AgentStatus', 'Agent', 'AgentWorkflow', 'AgentMemory',
  'AskUserQuestion', 'TodoWrite', 'Memory', 'UserInputHistory',
  'ImageGen', 'ViewImage', 'ViewVideo', 'Screencap',
  'Skill', 'CommandExec',
])

const MICRO_LIMITS = {
  threshold: 4096,      // 4KB 以下不值得动：省的 token 抵不上误清的风险
  keepHead: 900,        // 开头通常是结构信息（文件头、命令、匹配摘要）
  keepTail: 400,        // 结尾通常是结论（错误信息、退出码、末尾行）
  unknownThreshold: 16384,  // 拿不到工具名时更保守，只处理超大结果
}

function interruptedError() {
  const error = new Error('Interrupted')
  error.code = 'ABORT_ERR'
  return error
}

function normalizeToolCallId(value) {
  // Bedrock/Anthropic 要求 tool_use.id 仅含 [a-zA-Z0-9_-]。
  // 中转返回的 call id 可能含 : . 等字符；确定性转换保证 tool_use / tool_result 两端一致。
  const raw = String(value || '')
  if (/^[a-zA-Z0-9_-]+$/.test(raw)) return raw
  let hash = 2166136261
  for (let i = 0; i < raw.length; i++) hash = Math.imul(hash ^ raw.charCodeAt(i), 16777619)
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100) || 'tool_call'
  return `${cleaned}_${(hash >>> 0).toString(36)}`
}

function delayWithSignal(ms, signal) {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms))
  if (signal.aborted) return Promise.reject(interruptedError())
  return new Promise((resolve, reject) => {
    let timer
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(interruptedError())
    }
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

// 部分中转会把上下文超限包装成 400/413/422，甚至 502/503。
// 这类错误重试同一份 body 没有意义，应交给 Agent 做历史收缩。
function isContextOverflowText(value) {
  const text = String(value || '')
  return /input\s+exceeds?\s+(?:the\s+)?context\s+window|context\s*(?:window|length|limit)|maximum\s+context|too\s+many\s+tokens|prompt\s+(?:is\s+)?too\s+long|request\s+(?:is\s+)?too\s+large|上下文.{0,12}(?:超|过大|限制)|(?:超出|超过).{0,12}(?:上下文|token)|inputs?\s*tokens?\s*\+\s*max[_-]?new[_-]?tokens?\s+must\s+be\s+<=|(?:tokens|token)\s+must\s+be\s+<=|exceed.*max.*tokens?|too\s+long\s*(?:for|given)|maximum\s+context\s+length|context\s+too\s+long|input\s+length\s+must\s+be\s+<|sequence\s+length\s+exceeded|(?:input|inputs?)\s+(?:tokens?|length).{0,20}(?:exceed|larger|bigger|greater)|(?:exceed|exceeds?|larger|bigger|greater).{0,20}(?:input|inputs?|token|tokens?|context|window)/i.test(text)
}

// 模型能力不支持的 400：最常见的是非 vision 模型收到图片（MODEL_CAPABILITY_NOT_SUPPORTED: vision）。
// 这类错误重试同一份 body 没有意义，应标记能力降级 + 交给 Agent 剥离历史图片后自动恢复。
function isVisionCapabilityError(body, status) {
  if (status !== 400 && status !== 422) return false
  const text = String(body || '')
  return /MODEL_CAPABILITY_NOT_SUPPORTED|capabilit.{0,20}(?:not\s+)?support/i.test(text)
    || /不(?:支持|具备).{0,10}(?:vision|图片|图像|视觉|多模态)|(?:vision|图片|图像|视觉|多模态).{0,10}不(?:支持|具备)/i.test(text)
    // 【英文直白写法】sharellm 实际返回 "This model does not support image"，
    // 上面两条都不匹配（既没有 capability 字样也不是中文）→ 图片没被剥离 → 每轮都失败。
    // 实测：剔掉会话里 21 条图片消息后，2900 条 / 2MB 请求全部成功。
    || /(?:does\s*not|doesn'?t|not)\s+support.{0,20}(?:image|vision|multimodal|picture)/i.test(text)
    || /(?:image|vision|multimodal)\s+(?:is\s+)?not\s+supported/i.test(text)
    // 【中转换措辞 · 2026-09-19 补】下面两种真实报错上面全都不匹配 →
    // isVisionCapabilityError=false → 不标记降级、不剥离历史图片 → 每轮原样重发同一个 400，
    // 表现就是「带图历史的会话永远打不通」，用户只看到一句 400 反复出现。
    //   ① "messages[109].content[1].type has unsupported value \"image_url\""
    //      （关键词 unsupported 在 image_url 之前，且字段名 image_url 本身含 image）
    //   ② "image input is not supported by the qwen gateway yet"
    //      （image 与 not supported 之间隔了 input/is，旧正则的 \s+(?:is\s+)? 卡死）
    || /unsupported\s+value[^a-z]{0,6}image_url/i.test(text)
    || /(?:image|vision|multimodal)\s+(?:input|content|block)[\s\S]{0,30}?(?:not\s+supported|unsupported|不支持)/i.test(text)
}

/**
 * 发送前文本清理（防"上下文污染导致整轮 400/死掉"）：
 * - 孤立 surrogate（未配对的 U+D800-DFFF）→ U+FFFD，这类字符来自终端乱码/截断粘贴，部分 API 直接拒绝
 * - C0 控制字符（\x00-\x08 \x0B \x0C \x0E-\x1F）与 DEL → 删除（保留 \n \t \r）
 * 合法 emoji（含冷门）都是合法码点，不受影响。
 */
export function sanitizeTextForApi(str) {
  if (typeof str !== 'string') return str
  let out = ''
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = str.charCodeAt(i + 1)
      if (next >= 0xDC00 && next <= 0xDFFF) { out += str[i] + str[i + 1]; i++ }
      else out += '\uFFFD'
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      out += '\uFFFD'
    } else {
      out += str[i]
    }
  }
  return out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

const IMAGE_OMITTED = '[图片已省略]'

/**
 * vision 降级时的图片替代文本。
 * 只塞「[图片已省略]」会让模型以为图片彻底不可访问，于是既不看图也不调工具。
 * 这里尽量带上本地路径并明确要求调用 ViewImage。
 */
function imageOmittedText(msgContent) {
  const path = Array.isArray(msgContent)
    ? msgContent.find(x => x?.type === 'web_attachment' && x?.file_type === 'image' && x?.path)?.path
    : null
  return path
    ? `${IMAGE_OMITTED} 图片本地路径：${path}。请调用 ViewImage 工具读取该路径后再回答，不要只回复「图片已省略」。`
    : `${IMAGE_OMITTED} 当前模型不支持直接读图；若消息中给出了图片路径，请调用 ViewImage 工具读取。`
}

/**
 * 规整工具 schema，保证跨后端可被接受。
 *
 * 【为什么必须有这层】2026-09-04 修的 400：
 *   HTTP 400 {"code":"invalid-argument","error":"Invalid request content:
 *   Schema validation failed: [standard_violation] /properties: null is not of type \"object\""}
 *
 * 部分中转站后端实际是 Google GenAI（Gemini），它的 schema 校验器比 OpenAI 严：
 * `type:"object"` **必须**带 `properties` 对象，缺字段被视作 null 直接判违规。
 * OpenAI / Anthropic 对「无参工具」写 `{type:'object'}` 都照收，所以这种 schema
 * 在项目里长期存在且从未报错，一旦请求落到 Gemini 后端就整体 400。
 *
 * 关键特征：**一个工具坏 → 整个请求被拒**，且发生在 turn 1（首轮就带全量工具列表），
 * 表现为「这个配置什么都干不了」，与具体提问内容无关。
 *
 * 无参工具是主要来源（Battery/ClipboardGet/QQInbox/EnterPlanMode 一类），
 * 另一个不可控来源是 MCP server 返回的 inputSchema（第三方给什么就是什么）。
 * 所以工具侧修好之后，这里仍要兜底 —— 这是唯一能覆盖 MCP 的位置。
 */
/**
 * Anthropic stop_reason → OpenAI finish_reason 映射。
 *
 * 【为什么必须映射】agent.mjs 靠 `finishReason === 'length'` 判断「被 max_tokens 截断」，
 * 截断时要给模型发「继续写」的提示（483 行附近），否则一次截断就白掉半条回复。
 * Anthropic 说的是 `max_tokens`，直接透传的话这个分支永远不命中。
 *
 * 官方对照（Anthropic docs / OpenAI docs）：
 *   end_turn      → stop         正常结束
 *   max_tokens    → length       截断（关键！）
 *   tool_use      → tool_calls   要调工具
 *   stop_sequence → stop         撞上 stop_sequences
 *   pause_turn    → stop         长任务暂停（服务端可继续）
 *   refusal       → content_filter 拒答
 */
function mapAnthropicStopReason(reason) {
  switch (reason) {
    case 'end_turn': return 'stop'
    case 'max_tokens': return 'length'
    case 'tool_use': return 'tool_calls'
    case 'stop_sequence': return 'stop'
    case 'pause_turn': return 'stop'
    case 'refusal': return 'content_filter'
    default: return reason || null
  }
}

/**
 * 判断一个 input 项是否属于「服务端自己产出的内容」。
 *
 * 增量的关键判据：服务端把它生成的项（assistant 文本、function_call、
 * reasoning）也存进历史；而客户端重放历史时不一定逐项对应
 * （尤其 reasoning 项通常不回放）。这些项出现在增量段的开头时要剥掉，
 * 否则会跟服务端已有的重复（模型看到自己重复回答 → 困惑/400）。
 *
 * 注意：function_call_output（工具结果）**不是**服务端产出的 ——
 * 它是客户端发回去的，属于真正的新内容，必须保留。
 */
function isServerGeneratedItem(item) {
  if (!item || typeof item !== 'object') return false
  if (item.type === 'function_call') return true
  if (item.type === 'reasoning') return true
  // assistant 消息是服务端生成的；user 消息一定是客户端新输入
  if (item.type === 'message' && item.role === 'assistant') return true
  return false
}

/**
 * input 项数组的指纹（增量请求的前缀校验用）。
 *
 * 只取前 maxItems 项、最多 4096 字符：目的是抓住「历史被压缩 / 换会话 /
 * 顺序重排」这几类会让 previous_response_id 错位的场景，不是做内容寻址。
 * 截断到 4096 有个已知盲区（前 50 项完全一致但第 51 项起不同），
 * 概率极低且后果只是多算一次增量——服务端会因前缀对不上而按新对话处理，
 * 比保守地每轮重发 550KB 划算。
 */
function inputFingerprint(items, totalCount) {
  try {
    const probe = Math.min(totalCount, 50)
    return `${totalCount}|${JSON.stringify(items.slice(0, probe)).slice(0, 4096)}`
  } catch {
    return null
  }
}

function normalizeToolSchema(schema) {
  // 递归复制并按键排序，确保 MCP/插件对象构造顺序不会改变请求前缀。
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]))
  }
  // 整体缺失 / 不是对象 → 给最小合法 object schema
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} }
  }
  const out = stable(schema)
  if (!out.type) out.type = 'object'
  if (out.type === 'object') {
    // properties 缺失或被写成 null/数组/标量 → 一律补成空对象
    if (!out.properties || typeof out.properties !== 'object' || Array.isArray(out.properties)) {
      out.properties = {}
    }
    // required 必须是数组，且只保留 properties 里真实存在的键；排序避免顺序抖动
    if (out.required != null) {
      const keys = Object.keys(out.properties)
      out.required = Array.isArray(out.required)
        ? out.required.filter(k => typeof k === 'string' && keys.includes(k)).sort()
        : []
      if (out.required.length === 0) delete out.required
    }
  }
  return out
}

// 集中压缩：body 中超过 MAX_JSON_DEPTH 层的子树 → JSON 字符串
// 保留 tools[*].function.parameters 原样（工具 schema，不能动）
function compressRequestBody(body) {
  return _compress(body, 0, MAX_JSON_DEPTH, new WeakSet(), null)
}

function _compress(value, depth, maxDepth, visited, protectedKey) {
  // 保护 parameters 字段：工具 schema 必须原样，不能压缩成字符串
  if (protectedKey === 'parameters') return value

  // 超过深度阈值：折叠为 JSON 字符串
  if (depth > maxDepth) {
    try {
      const s = JSON.stringify(value, null, 2)
      if (s.length > MAX_FOLDED_STRING) {
        return s.slice(0, MAX_FOLDED_STRING) + `\n... [folded-string truncated, original size ${s.length} bytes]`
      }
      return s
    } catch {
      return '[unserializable value]'
    }
  }

  if (Array.isArray(value)) {
    return value.map(item => _compress(item, depth + 1, maxDepth, visited, null))
  }
  if (typeof value === 'object' && value !== null) {
    if (visited.has(value)) return '[circular reference]'
    visited.add(value)
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = _compress(v, depth + 1, maxDepth, visited, k)
    }
    return out
  }
  return value  // string/number/boolean/null 原样
}

// 从"HTTP 200 但包体带 error"的响应里提取错误文本。
// 背景：NewAPI/one-api 这类中转在额度不足时可能返回 200，错误藏在 body.error 里；
// 正常成功响应有 choices/content，不会有 error 字段，所以以 error 存在为判据。
// 返回 null 表示这是正常响应。
function extractInBodyError(json) {
  if (!json || typeof json !== 'object') return null
  const e = json.error
  if (!e) return null
  // 有 error 但同时有有效 choices/content 的情况（极少），视为成功，避免误杀
  const hasContent = (Array.isArray(json.choices) && json.choices.length > 0)
    || (Array.isArray(json.content) && json.content.length > 0)
  if (hasContent) return null
  if (typeof e === 'string') return e
  const parts = [e.message, e.code, e.type].filter(Boolean)
  return parts.length ? JSON.stringify(e) : JSON.stringify(e)
}

// Prompt Cache 按请求前缀逐字匹配；工具注册顺序若因 MCP/插件加载时序变化，
// 会让整个 tools 前缀失配。发送前按名称排序，保持三种协议的 schema 顺序稳定。
function stableToolList(tools) {
  return Array.isArray(tools) ? [...tools].sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || ''))) : []
}

export class ApiClient {
  // KeyPool 在文件头 import（见上方），这里只做标记用途说明
  constructor({ baseUrl, apiKey, apiKeys = null, model, protocol = 'openai', fetch: customFetch, timeout = DEFAULT_TIMEOUT, maxRetries = 3, streamTimeout = DEFAULT_STREAM_TIMEOUT, thinkingConfig = null, temperature = 1, maxOutputTokens = null, noTools = false, onKeySwitch = null, onRetry = null, systemTopLevel = false, keyRotateEvery = 0, replayReasoning = false, promptCacheRetention = null, promptCacheEnabled = false }) {
    this.baseUrl = normalizeProviderUrl(baseUrl, protocol)
    // systemTopLevel: system 放顶层 body.system 而非 messages[0]
    // （sotamodel 网关对 messages[0] 大 system 间歇空流，顶层字段稳定）
    this.systemTopLevel = !!systemTopLevel
    // key 池：apiKeys 为多 key 负载均衡（额度耗尽自动切换）；apiKey 为单 key 兼容旧配置。
    // this.apiKey 是 getter，始终返回池里当前可用 key，所以下游发请求的代码不用改。
    const keyList = Array.isArray(apiKeys) && apiKeys.length ? apiKeys : (apiKey ? [apiKey] : [])
    this.keyPool = new KeyPool(keyList, { onSwitch: onKeySwitch, initialKey: apiKey, rotateEveryRequests: keyRotateEvery })
    this._fallbackKey = apiKey || keyList[0] || ''
    this.model = model
    // noTools: true 时请求剥离 tools 参数（部分网关/模型收到 tools 参数会挂起）
    this.noTools = !!noTools
    // protocol: 'openai' | 'anthropic'
    this.protocol = protocol
    this.fetch = customFetch || globalThis.fetch
    this.timeout = timeout
    this.streamTimeout = streamTimeout
    this.maxRetries = maxRetries
    // 每次 api 层内部重试时回调（让静默的 60s×3 重试对用户可见）
    this.onRetry = typeof onRetry === 'function' ? onRetry : null
    // 【连接池可疑窗口】出现连接层故障（流超时/建连失败/socket 挂断）后置为时间戳，
    // 在 CONNECTION_SUSPECT_MS 内所有请求都带 Connection: close，让池里的坏连接排空。
    // 只影响性能不影响正确性，所以窗口给得比较宽；正常路径完全不触发。
    this._connectionSuspectAt = 0
    // thinkingConfig: { enabled: bool, effort: 'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max' }
    // OpenAI/GPT 兼容 reasoning_effort；Anthropic 侧 budget_tokens = max_tokens - 1（见 buildAnthropicBody）
    this.thinkingConfig = thinkingConfig
    // 思考回传开关（/effort replay on|off，2026-09-15）。
    //
    // 关 = 历史里的思考不再发给上游 → 省上下文（实测单轮 1K-13K 字符，
    // 几十轮下来几万 token 直接吃掉）；代价是模型看不到自己上一轮想过什么
    //（关掉后让它复述自己的思考，它会说"我没想过"或直接编一个）。
    //
    // 只影响**发出去的请求**：本地照样存全文（会话文件 / 思考显示都不受影响）。
    // 默认关（2026-09-18 用户决定）：回传历史思考耗上下文且多数场景无收益；
    // 要回传必须显式 replay: true。新建 Provider / 未配置 / Web 端因此都默认省。
    this.replayReasoning = replayReasoning === true
    this.temperature = Number.isFinite(Number(temperature)) ? Number(temperature) : 1
    // ── 能力探测结论：一律按「协议|端点|模型」记录（2026-09-14 重构）──
    //
    // 这些字段记录的是「**某个端点**不支持某能力」，结论必须跟着端点走。
    // 曾经用裸布尔存（client 级全局），后果是端点 A 的结论会连坐到端点 B：
    //   切到 A 撞 400 → 置位 → 切回 B（本来支持）→ B 的功能**静默失效**，
    //   无提示、无日志，只能靠重启恢复。
    // 而 ApiClient 实例是长期存活的（切 provider 只改字段不重建），污染会一直留着。
    //
    // 现在改用 key 集合，`_visionDisabled` 之类的读写**仍保持属性写法**（走下面的
    // getter/setter），所以所有调用点无需改动，但语义变成「仅对该端点生效」。
    // 附带的正确行为：A → B → A 回到 A 时结论还在，不必重新探测。
    this._thinkingFallbackKeys = new Set()   // body 思考参数被拒（reasoning_effort 等）
    this._visionDisabledKeys = new Set()     // 图片能力不支持 → 自动省略图片
    this._reasoningHistoryKeys = new Set()   // messages[].reasoning 被拒 → 不回传思考内容
    this._incrementalKeys = new Set()        // previous_response_id 被拒 → 退回全量
    this._imageUrlStyles = new Map()         // input_image.image_url 形态：string|object
    // 模型输出上限（per-provider 可配）：有值时把 max_tokens clamp 到该值，
    // 防止中转/模型对 max_tokens 上限较小时发 8192 导致 HTTP 400（如 deepseek-v4-flash 限 [1,1024]）。
    this.maxOutputTokens = Number.isFinite(Number(maxOutputTokens)) && Number(maxOutputTokens) > 0 ? Math.floor(Number(maxOutputTokens)) : null
    // 下面这些「能力是否可用」的标志由本类尾部的 getter/setter 接管（按端点+模型存）。
    // 调用点仍写 this._visionDisabled / this._reasoningHistoryDisabled / this._imageUrlStyle，
    // 但语义已是「当前端点的结论」而非「本 client 的结论」。
    // prompt_cache_key（Responses 协议用）：Codex 拿 session_id 当缓存键。
    // 由上层在建 session/切 session 时设置；null 表示不发这个字段。
    this.sessionCacheKey = null
    // 仅在显式配置且协议支持时发送；兼容网关默认不接收 24h 扩展字段。
    this.promptCacheRetention = promptCacheRetention === '24h' ? '24h' : null
    this.promptCacheEnabled = promptCacheEnabled === true
    // ── previous_response_id 增量请求（Responses 协议）──
    //
    // 原理（对齐 Codex core/src/client.rs:1711）：服务端存有上一轮响应，
    // 客户端只发「新增的 input 项」+ previous_response_id，服务端自己把历史接上。
    // 好处：多轮工具循环的请求体从 O(n) 降到 O(1)（我们 680 条历史 ≈ 550KB → 几 KB）。
    //
    // 现实：**多数中转站不支持**（它们内部把 responses 转成 chat/completions，
    // 拒绝 stateful 字段）。实测 ai.furry.vg 返回：
    //   "responses to chat conversion does not support stateful fields"
    // 所以设计成「乐观尝试 + 失败永久降级」：
    //   1. 首次用全量请求（服务端才知道历史），记下返回的 response id
    //   2. 下一轮尝试增量；成功就继续增量
    //   3. 一旦失败 → _incrementalDisabled 置位（按端点记录），此后该端一律全量
    // 探测成本只有一次失败的请求，之后零开销。
    this._lastResponseId = null       // 上一轮响应的 id（增量请求的锚点）
    this._incrementalTried = false    // 是否已尝试过（用于日志/调试）
    this._lastInputInfo = null        // { count, responseCount, head } 上一轮发出去的全量 input
    this._lastBuiltFullInput = null   // 本次构建的完整 input（增量失败时用它重发全量）
    // ── input_image.image_url 的形态（Responses 协议）──
    //
    // 官方规范：字符串。`{type:'input_image', image_url:'data:image/png;base64,...'}`
    // 但**中转站的上游 Go 服务常按 chat 的结构解析**，期望对象：
    //   `{type:'input_image', image_url:{url:'...'}}`
    // 发字符串会 400（实测 ai.furry.vg 上游）：
    //   "Parse message failed: invalid image_url content at index N:
    //    json: cannot unmarshal string into Go value of type ***.ImageContent"
    //
    // 两种写法各有网关用，所以做成「按实测反馈学习」：
    //   默认官方 string → 撞上这类 400 → 切 object 并重发（Agent 层已有
    //   vision 降级重试机制，这里挂在同一处）。
    // （具体形态按端点存在 _imageUrlStyles，见尾部访问器）
  }

  /**
   * 会话切换时重置增量状态。
   * 换会话后 previous_response_id 指向别的对话，必须清掉 ——
   * 否则服务端会把两段不相干的历史接在一起（上下文串台）。
   */
  resetIncrementalState() {
    this._lastResponseId = null
    this._lastInputInfo = null
    this._incrementalTried = false
    // _incrementalDisabled 不重置：它是端点级结论（按 _endpointKey 存），
    // 跟会话无关；重置会导致每个新会话都白试一次。
  }

  // apiKey 读写都走 key 池，保证旧代码（this.apiKey）和新池共用一份状态。
  // 全部 key 都在冷却时回退到最后一个，让请求真实失败并报出站点原始错误，而不是发个空 key。
  get apiKey() {
    return this.keyPool.current() || this._fallbackKey
  }

  set apiKey(v) {
    this.keyPool = new KeyPool(v ? [v] : [], { onSwitch: this.keyPool?.onSwitch || null, initialKey: v })
    this._fallbackKey = v || ''
  }

  /** 切换 provider 时重建 key 池（支持多 key）；keys 为空则退回单 key */
  setKeys(keys, fallback = '') {
    const list = Array.isArray(keys) && keys.length ? keys : (fallback ? [fallback] : [])
    this.keyPool = new KeyPool(list, { onSwitch: this.keyPool?.onSwitch || null, initialKey: fallback })
    this._fallbackKey = fallback || list[0] || ''
  }

  /** key 池状态（供 /config 展示） */
  describeKeys() {
    return this.keyPool.describe()
  }

  /**
   * 主动把当前 key 标记为失效并换下一个。供 agent 层在 401/403 重试前调用。
   *
   * 为什么需要这个包装：request() 内部只在自己那一层的 while 里轮换，
   * 而 agent 层的重试是更外圈的循环 —— 401/403 走到 agent 层重试时，
   * 如果不主动换 key，就是拿同一个坏 key 重发，五次全败。
   * 返回 null 表示池子转完一圈都不可用。
   */
  rotateKey(reason = 'auth failed') {
    if (!this.keyPool?.isPool) return null
    const next = this.keyPool.markExhaustedAndRotate(reason)
    // 【池子转完一圈要返回 null】markExhaustedAndRotate 的 current() 不看冷却状态，
    // 所以它会一直吐 key、绕回起点。若不在这里判断，坏 key 会被反复重试，
    // 用户看到的还是同一个 403 —— 只是多等了几轮。
    if (this.keyPool.availableCount() <= 0) return null
    return next
  }

  /**
   * 端点标识：所有「能力探测结论」都按这个 key 存。
   *
   * 为什么必须带 model：同一端点下不同模型能力不同（一个支持思考、一个不支持），
   * 只按 URL 存会让同端点的两个模型互相污染。
   * 为什么必须带 protocol：同 URL 走不同协议时请求形状完全不同，结论不可通用。
   */
  _endpointKey() {
    return `${this.protocol}|${this.baseUrl}|${this.model}`.toLowerCase()
  }

  /** 兼容旧名（外部有调用点） */
  _thinkingCompatKey() {
    return this._endpointKey()
  }

  clearThinkingCompatibilityFallback() {
    this._thinkingFallbackKeys.delete(this._endpointKey())
  }

  // ── 能力降级标志（按端点+模型存储）──────────────────────────────
  //
  // 用访问器而不是普通字段，是为了让**所有现有调用点零改动**
  // （它们仍写 `this._visionDisabled` / `this._imageUrlStyle`）。
  // 但内部是 Set/Map，语义从「本 client 全局」变成「仅当前端点」。

  get _visionDisabled() { return this._visionDisabledKeys.has(this._endpointKey()) }
  set _visionDisabled(v) {
    const k = this._endpointKey()
    if (v) this._visionDisabledKeys.add(k); else this._visionDisabledKeys.delete(k)
  }

  get _reasoningHistoryDisabled() { return this._reasoningHistoryKeys.has(this._endpointKey()) }
  set _reasoningHistoryDisabled(v) {
    const k = this._endpointKey()
    if (v) this._reasoningHistoryKeys.add(k); else this._reasoningHistoryKeys.delete(k)
  }

  get _incrementalDisabled() { return this._incrementalKeys.has(this._endpointKey()) }
  set _incrementalDisabled(v) {
    const k = this._endpointKey()
    if (v) this._incrementalKeys.add(k); else this._incrementalKeys.delete(k)
  }

  get _imageUrlStyle() { return this._imageUrlStyles.get(this._endpointKey()) || 'string' }
  set _imageUrlStyle(v) { this._imageUrlStyles.set(this._endpointKey(), v) }

  /**
   * 是否把 reasoning 作为**明文文本**回传给上游（chat 协议的 reasoning / reasoning_content 字段）。
   *
   * 【为什么不按模型名判断】——曾经维护过一份白名单（只认 Kimi K3/K2.7），但那是错的：
   * 新模型层出不穷，白名单永远追不上；而且**同一个模型名走不同网关行为完全不同**
   * （`deepseek-v4.1-flash` 直连官方 vs 走 NewAPI 中转，字段要求就不一样）。
   * 判据放在「叫什么名字」上必然过时，放在「有没有内容」上永远成立。
   *
   * 【现在的判据】手里有思考文本就发，由上游自己决定认不认：
   *   - 不认 → 上游多半静默丢弃（NewAPI 对不认识的字段就是直接扔），无害
   *   - 明确报错 → 走 request() 里的 400/422 降级，永久去掉重发（见 _thinkingFallbackKeys）
   *
   * 【字段名为什么两个都写】上游实现分裂：
   *   - NewAPI（中转站）：请求方向只读 `reasoning`（2026-09-14 实测 5 次：
   *     `reasoning` 4/4 穿透、`reasoning_content` 0/5）
   *   - DeepSeek 官方：用 `reasoning_content`（响应方向也是这个名）
   *   双写实测不会重复计费（prompt_tokens 增量 799 vs 799，只算一次）。
   *
   * responses / anthropic 不走这里 —— 它们有原生通道
   * （`_reasoningItems` / `_anthropicThinking` 块），见各自 builder。
   */
  shouldPreserveReasoningHistory() {
    return this.protocol === 'openai'
  }

  /**
   * 把历史里的思考文本挂到 chat 协议消息对象上（双字段写）。
   *
   * 上游实现分裂，所以两个名字都写，各自认各自的：
   *   - NewAPI 等中转站：请求方向只读 `reasoning`（实测 reasoning_content 被丢弃）
   *   - DeepSeek 官方：用 `reasoning_content`
   * 双写不会重复计费（实测 prompt_tokens 增量 799 vs 799）。
   *
   * 占位符（`[thinking N K chars]`）不发 —— 回传它是噪音，不是思考内容。
   */
  attachReasoning(target, text) {
    if (!text || !this.replayReasoning || this._reasoningHistoryDisabled || !this.shouldPreserveReasoningHistory()) return target
    const t = sanitizeTextForApi(text)
    // 占位符不占带宽也没意义（save 侧在 openai 协议下已存全文，这里只防旧会话残留）
    if (/^\s*\[thinking \d+K chars\]\s*$/.test(t)) return target
    target.reasoning = t
    target.reasoning_content = t
    return target
  }

  /**
   * 是否应在**本地历史**里保留完整思考文本（供 UI 查看 / 后续轮次回看）。
   *
   * 跟 shouldPreserveReasoningHistory 是两件事：
   *   - 那个决定「发不发回上游」
   *   - 这个决定「本地存全文还是只存长度占位」
   *
   * 之前只在 responses/anthropic 存全文，openai 存占位。但占位符
   * `[thinking 13K chars]` 回传给上游毫无意义（上游拿到的是这行字，不是思考），
   * 所以「要回传」就必须「存全文」，两者配套。
   *
   * 历史教训：混在一起时 responses 下两个都 false → 只存占位符 →
   * 模型下一轮看不到自己想过什么，**只能编**（实测「琥珀」被报成「回声」）。
   */
  shouldStoreReasoningText() {
    return this.protocol === 'responses' || this.protocol === 'anthropic' || this.protocol === 'openai'
  }

  getEffectiveTemperature(requested) {
    const model = String(this.model || '').toLowerCase()
    // Kimi K3/K2.7 固定 temperature=1；K2.5/2.6 思考开启时也固定为 1。
    if (/kimi[-_/]?(?:k3\b|k2\.7)/.test(model)) return 1
    if (/kimi[-_/]?k2\.[56]/.test(model)) {
      const p = this.getThinkingPolicy()
      return p.effective === 'none' ? 0.6 : 1
    }
    return requested
  }

  /**
   * 决定发送的思考参数。
   * anthropic 原生协议：budget_tokens = max_tokens - 1（拉满，避免思考中途耗尽报错；
   *   官方约束是 ≥1024 且 <max_tokens，见 buildAnthropicBody 的注释）。
   * OpenAI 兼容协议：统一用标准字段 reasoning_effort，档位原样透传，
   *   不按模型族分派字段名、不做档位白名单夹取（那类模型表必然过期且不全，服务端才是权威）。
   * 参数被服务端整体拒绝时由 _thinkingFallbackKeys 记下并后续不再发送。
   */
  getThinkingPolicy(overrideEffort = null) {
    // 按次覆盖（如 compact 摘要固定 medium）：只换档位，不改变开关 ——
    // thinkingConfig.enabled=false 时依旧整体关闭，开关归用户。
    const VALID_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    const requested = VALID_EFFORTS.includes(overrideEffort)
      ? overrideEffort
      : (VALID_EFFORTS.includes(this.thinkingConfig?.effort) ? this.thinkingConfig.effort : 'high')
    const model = String(this.model || '').toLowerCase()
    const configured = this.thinkingConfig?.enabled === true
    const gatewayFallback = configured && this._thinkingFallbackKeys.has(this._thinkingCompatKey())
    // 【2026-08-30 移除逐模型档位白名单】原来这里维护「5.6 有 max、5.4/5.5 没有」
    // 这类 allowed 列表，把用户档位夹到最近值。三个问题：
    // 1) 服务端本来就会校验/夹取，我们抢在前面猜等于替它做决定；
    // 2) 表必然过期——新模型加了档位，代码不会自己更新，用户设了新档位反被我们悄悄降级（不报错，更难查）；
    // 3) 走中转站时请求先经中间层，它可能自己适配/透传/忽略，按「官方档位」精心映射建立在看不见的假设上。
    // 现在档位原样传，被服务端拒了才由 _thinkingFallbackKeys 记下「此端点+模型不吃思考参数」
    // 并不再传——用实际失败反馈来学，而不是靠猜。
    // 保留的仍是硬约束：字段名按协议/厂商分派（发错名字必然 400）、以及「模型无法关闭推理」这类事实。

    if (gatewayFallback) {
      return { kind:'off', requested, effective:null, family:'gateway-fallback', unsupported:true, fallback:true }
    }

    if (this.protocol === 'anthropic') {
      return configured && requested !== 'none'
        ? { kind:'anthropic_budget', requested, effective:requested }
        : { kind:'off', requested, effective:null }
    }

    // 【2026-08-30 移除逐厂商字段名分派】原来这里按模型分派 thinking / zai /
    // enable_thinking / kimi_k2_keep 等异厂字段名。这是自找报错：
    // 1) OpenAI 兼容协议的标准思考参数就是 reasoning_effort，各厂商的 OpenAI
    //    兼容端点都认它——这是「兼容」的含义；
    // 2) thinking:{type} / enable_thinking 是各家**原生协议**的字段，塞进
    //    OpenAI 格式的请求体里，网关不认识反而直接 400；
    // 3) 走中转站时更没意义：中转站按 OpenAI 协议解析，异厂字段大概率被拒或被丢。
    // 现在统一发 reasoning_effort，被拒了由 _thinkingFallbackKeys 记下并不再传。

    // 【2026-08-30 同时删掉「无法关闭推理」的模型表】
    // 那张表（kimi-k3 / k2.7 / grok-4.5 / o 系 / codex）犯的是和档位白名单
    // 完全一样的毛病：一张会过期、且必然不全的模型清单。模型迭代速度下无法维护，
    // 也无从保证正确。关闭就老实发 reasoning_effort='none'：
    // 服务端支持关闭 → 照常关；模型本身关不掉 → 由它自己忽略或夹到最低档，
    // 那是服务端的职责，不该由客户端猜。
    // 参数被整体拒绝时仍有 _thinkingFallbackKeys 兜底。
    //
    // Claude 同理不做特殊处理：OpenAI 协议下 Claude 也支持 reasoning_effort，
    // 网关（LiteLLM / NewAPI 等）会自动翻译成 Claude 的 thinking budget。
    if (!configured) {
      return { kind:'reasoning_effort', requested:'off', effective:'none', family:'openai-compat' }
    }
    return { kind:'reasoning_effort', requested, effective:requested, family:'openai-compat' }
  }

  describeThinkingPolicy() {
    const p = this.getThinkingPolicy()
    if (p.kind === 'off') return p.fallback
      ? `当前网关拒绝思考参数，已自动降级省略（${this.model}）`
      : p.unsupported
        ? `当前模型 ${this.model} 未识别为兼容思考参数，已安全省略`
        : '不发送思考参数'
    if (p.kind === 'reasoning_effort') {
      // Responses 协议发的是 body.reasoning = { effort }（嵌套对象），
      // 显示时标明实际字段名，免得 /config 看到 reasoning_effort 却对不上请求
      return this.protocol === 'responses'
        ? `reasoning.effort=${p.effective}`
        : `reasoning_effort=${p.effective}`
    }
    if (p.kind === 'anthropic_budget') return `Anthropic thinking budget（${p.effective}）`
    return p.kind
  }

  async createMessage({ system, messages, tools, maxTokens = DEFAULT_MAX_OUTPUT_TOKENS, temperature = this.temperature, signal = null, abortSignal = null, thinkingEffort = null }) {
    if (!signal && abortSignal) signal = abortSignal
    let body = this.buildRequestBody({ system, messages, tools, maxTokens, temperature, stream: false, thinkingEffort })
    // NewAPI 这类网关的额度不足可能返回 HTTP 200，错误藏在包体里（code=pre_consume_token_quota_failed）。
    // 只看 response.ok 会把它当成功，导致 key 池永远不触发轮换 → 这里做一次包体级检查。
    for (let bodyAttempt = 0; ; bodyAttempt++) {
      let response
      try {
        response = await this.request(body, false, signal)
      } catch (e) {
        // 网关拒绝增量字段 → 降级重发全量（只此一次）
        if (this._isIncrementalRejection(e)) {
          this._incrementalDisabled = true
          const full = this._fullBodyFrom(body)
          if (full) { body = full; continue }
        }
        // image_url 形态不对 → 用新形态重建 body 再发（只此一次）
        if (e.isImageUrlStyleRetry) {
          body = this.buildRequestBody({ system, messages, tools, maxTokens, temperature, stream: false, thinkingEffort })
          continue
        }
        throw e
      }
      const json = await response.json()
      const inBodyError = extractInBodyError(json)
      if (!inBodyError) {
        // 记下响应 id + 服务端新增的 output 项数，供下一轮算增量
        if (this.protocol === 'responses') {
          this._rememberRequestForIncremental(
            { input: this._lastBuiltFullInput || [] },
            json?.id,
            Array.isArray(json?.output) ? json.output.length : 0,
          )
        }
        return this.protocol === 'anthropic' ? this.normalizeAnthropicResponse(json)
          : this.protocol === 'responses' ? this.normalizeResponsesResponse(json)
          : json
      }
      // 包体里报了错：判断是否该换 key
      if (this.keyPool.isPool && isKeyExhaustedError(200, inBodyError) && bodyAttempt < this.keyPool.size - 1) {
        const failedKey = maskKey(this.apiKey)
        const next = this.keyPool.markExhaustedAndRotate(`包体错误: ${inBodyError.slice(0, 80)}`)
        if (next) continue
        const err = new Error(`所有 ${this.keyPool.size} 个 API key 均不可用（最后失败: ${failedKey}）\n${inBodyError.slice(0, 300)}`)
        err.allKeysExhausted = true
        err.responseBody = inBodyError
        throw err
      }
      const err = new Error(inBodyError.slice(0, 500))
      err.responseBody = inBodyError
      err.inBodyError = true
      throw err
    }
  }

  normalizeAnthropicResponse(json) {
    // Anthropic → OpenAI 兼容格式
    const out = { choices: [{ message: { role: 'assistant' }, finish_reason: null }], usage: json.usage || null }
    const message = out.choices[0].message
    const contentBlocks = json.content || []
    const textParts = []
    const reasoningParts = []
    const toolCalls = []
    // 【thinking 块要留给历史回传】
    //
    // Anthropic 的硬性要求：assistant 轮次里若含 tool_use，且当时开了 extended
    // thinking，那这条 assistant 消息的 thinking 块必须**原样**（含 signature）
    // 出现在下一轮请求里。缺了会 400：
    //   "messages.N.content.0.type: Expected `thinking` ... but found `text`"
    // （中转站常把它翻译成更含糊的 "thinking block missing"）。
    //
    // 所以这里除了抽成 reasoning_content 给 UI 显示，还额外存一份原始块
    // 挂在 message 上，buildAnthropicBody 回传时优先用它。
    const thinkingBlocks = []
    for (const block of contentBlocks) {
      if (block.type === 'text' && block.text) textParts.push(block.text)
      else if (block.type === 'thinking') {
        if (block.thinking) reasoningParts.push(block.thinking)
        thinkingBlocks.push(block)
      } else if (block.type === 'redacted_thinking') {
        // 加密思考（安全策略触发时出现）：内容不可读但必须原样回传
        thinkingBlocks.push(block)
      } else if (block.type === 'tool_use') {
        toolCalls.push({ id: normalizeToolCallId(block.id), type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input || {}) } })
      }
    }
    if (thinkingBlocks.length > 0) message._anthropicThinking = thinkingBlocks
    if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join('\n')
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls
      message.content = textParts.join('\n') || null
      out.choices[0].finish_reason = 'tool_calls'
    } else {
      message.content = textParts.join('\n') || null
      out.choices[0].finish_reason = mapAnthropicStopReason(json.stop_reason)
    }
    // 保留 model / id 便于调试
    out.model = json.model
    out.id = json.id
    return out
  }

  async *createMessageStream({ system, messages, tools, maxTokens = DEFAULT_MAX_OUTPUT_TOKENS, temperature = this.temperature, signal = null, thinkingEffort = null }) {
    let body = this.buildRequestBody({ system, messages, tools, maxTokens, temperature, stream: true, thinkingEffort })
    // 流式请求用更短的首字节超时（streamTimeout），收到响应后由 agent.mjs 的 stream watchdog 继续看护
    let response
    try {
      response = await this.request(body, true, signal)
    } catch (e) {
      // 网关拒绝增量字段 → 降级重发全量（只此一次）。
      // ⚠ 必须在**开始解析流之前**重发：SSE 一旦开始 yield，
      //   上游就再也收不回来了（调用方已经在消费事件）。
      if (this._isIncrementalRejection(e)) {
        this._incrementalDisabled = true
        const full = this._fullBodyFrom(body)
        if (full) { body = full; response = await this.request(body, true, signal) }
        else throw e
      } else if (e.isImageUrlStyleRetry) {
        // image_url 形态不对 → 新形态重建再发（同样必须在解析流之前）
        body = this.buildRequestBody({ system, messages, tools, maxTokens, temperature, stream: true, thinkingEffort })
        response = await this.request(body, true, signal)
      } else throw e
    }
    // 流式记账：id 和 output 项数都在事件里，边解析边攒，
    // 流结束（正常或中断）时落账 —— 只有拿到 id 才算数。
    const meta = { id: null, outputCount: 0 }
    for await (const e of this.parseStreamResponse(response)) {
      if (e.type === '_response_meta') { meta.id = e.id; continue }  // 内部事件不外传
      if (e.type === '_output_index') { meta.outputCount = Math.max(meta.outputCount, (e.index ?? 0) + 1); continue }
      yield e
    }
    if (this.protocol === 'responses' && meta.id) {
      this._rememberRequestForIncremental(
        { input: this._lastBuiltFullInput || [] },
        meta.id,
        meta.outputCount,
      )
    }
  }

  buildRequestBody({ system, messages, tools, maxTokens, temperature, stream, thinkingEffort = null }) {
    // max_tokens 输出上限保护：模型/中转有上限时 clamp，避免 400（max_tokens 参数非法）。
    if (this.maxOutputTokens && (!maxTokens || maxTokens > this.maxOutputTokens)) {
      maxTokens = this.maxOutputTokens
    }
    // noTools: 剥离 tools 参数（部分网关/模型收到 tools 参数会挂起）。
    // 注意：消息历史里如果含 tool_use/tool_result 也必须清洗，否则模型看到孤立 tool 块会报错。
    let effectiveMessages = messages
    if (this.noTools) {
      effectiveMessages = (messages || []).map(m => {
        if (!m || !Array.isArray(m.content)) return m
        // 去掉 content 里的 tool_use / tool_result 块，保留 text / image
        const kept = m.content.filter(b => b && b.type !== 'tool_use' && b.type !== 'tool_result')
        return { ...m, content: kept.length ? kept : [{ type: 'text', text: '(工具调用结果已省略)' }] }
      })
      tools = []
    }
    // microcompact：削减较早的工具结果，但**不做全量销毁**。
    // 旧实现把 >400 字符的结果整体换成占位符，代价是模型丢失依据后只能重新调工具——
    // 重调的输入+输出+又一轮完整历史，净消耗比当初省下的几百字符更多。
    // 现在按两个维度收敛：① 只清可再生工具（重调便宜、结果稳定）；
    // ② 清也只做「掐中间、留头尾」的截断，让模型能凭头尾判断需不需要重调。
    if (this.microcompactEnabled !== false && Array.isArray(effectiveMessages) && effectiveMessages.length > 12) {
      const KEEP_RECENT = this.microcompactKeepRecent ?? 8   // 最近 N 条消息不清理
      const threshold = this.microcompactMaxResultChars ?? MICRO_LIMITS.threshold
      // tool_result 里只有 tool_use_id，工具名要反查 assistant 的 tool_use / tool_calls
      const toolNameById = new Map()
      for (const m of effectiveMessages) {
        if (m?.role !== 'assistant') continue
        if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b?.type === 'tool_use' && b.id) toolNameById.set(String(b.id), b.name)
          }
        }
        if (Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) {
            if (tc?.id) toolNameById.set(String(tc.id), tc.function?.name || tc.name)
          }
        }
      }
      const cutoff = Math.max(0, effectiveMessages.length - KEEP_RECENT)
      effectiveMessages = effectiveMessages.map((m, idx) => {
        if (idx >= cutoff || m?.role !== 'user' || !Array.isArray(m.content)) return m
        let changed = false
        const content = m.content.map(b => {
          if (b?.type !== 'tool_result' || b._microcompacted) return b
          const name = toolNameById.get(String(b.tool_use_id || ''))
          // 元信息类豁免：任务要求、队友消息、子 Agent 产出、多模态注入——清了拿不回来
          if (name && MICRO_PROTECTED_TOOLS.has(name)) return b
          // ⚠ 带 instanceof String：工具结果是 new String(...) 包装对象时
          // typeof 是 'object'，只判 typeof 会 JSON 化出带引号的转义串。
          const text = (typeof b.content === 'string' || b.content instanceof String)
            ? String(b.content)
            : JSON.stringify(b.content)
          if (!text) return b
          // 已知可再生 → 4KB 起截；工具名未知 → 只处理超大结果，宁可留着
          const known = name && MICRO_REGENERABLE_TOOLS.has(name)
          const limit = known ? threshold : Math.max(threshold, MICRO_LIMITS.unknownThreshold)
          if (text.length <= limit) return b
          const head = text.slice(0, MICRO_LIMITS.keepHead)
          const tail = text.slice(-MICRO_LIMITS.keepTail)
          const omitted = text.length - MICRO_LIMITS.keepHead - MICRO_LIMITS.keepTail
          changed = true
          return {
            ...b,
            _microcompacted: true,
            content: `${head}\n\n[…中间 ${omitted} 字符已省略（原 ${text.length} 字符${name ? `，${name}` : ''}）；`
              + `需要完整内容请重新调用该工具…]\n\n${tail}`,
          }
        })
        return changed ? { ...m, content } : m
      })
    }
    // 先在内部 block 格式上做协议无关清洗，OpenAI/Anthropic 都不会收到残缺工具轮次。
    let sanitizedMessages = this.sanitizeInternalToolPairs(effectiveMessages)
    // 空白 text block 清洗：Anthropic 硬性拒绝（"text content blocks must contain
    // non-whitespace text" → HTTP 400），而空块的来源很日常：回复被 max_tokens 截断、
    // 只发了个标点、工具输出为空。一旦落进历史，后面每一轮都会 400，越用越频繁。
    // 这里统一丢弃纯空白块；整条消息被清空则给一个占位符，避免出现空 content 数组。
    sanitizedMessages = this.dropBlankTextBlocks(sanitizedMessages)
    if (this.protocol === 'anthropic') {
      return this.buildAnthropicBody({ system, messages: sanitizedMessages, tools, maxTokens, temperature, stream, thinkingEffort })
    }
    if (this.protocol === 'responses') {
      const body = this.buildResponsesBody({ system, messages: sanitizedMessages, tools, maxTokens, temperature, stream, thinkingEffort })
      // 增量请求（previous_response_id）：仅 responses 协议，且网关没拒绝过
      this._applyIncremental(body)
      return body
    }
    return this.buildOpenAIBody({ system, messages: sanitizedMessages, tools, maxTokens, temperature, stream, thinkingEffort })
  }

  /**
   * 把全量 body 改写成增量请求（Responses 的 previous_response_id）。
   *
   * 算法对齐 Codex 的 get_incremental_items（core/src/client.rs:1244）：
   *   服务端历史 = 上次请求的 input + 上次响应的 output 项
   *   → 客户端只需发 `这次完整 input` 里跳过这个长度的尾部
   *   → skipTo = logicalCount（上次完整 input 长度）+ responseCount（上次输出项数）
   *
   * 【为什么必须知道 responseCount】服务端把「它自己生成的那些项」（assistant 文本、
   * function_call、reasoning）也算进历史。客户端下次构建的 input 里同样包含这些
   * （从 messages 重放），所以跳过长度要含它们，否则会重复发送 → 400 或内容重复。
   *
   * 【安全检查】前缀指纹不一致（压缩/换会话/重排/length 变短）→ 退回全量并清锚点。
   * 宁可多发几十 KB，也不能让服务端把两段不相干的历史接起来（上下文串台）。
   *
   * 【失败兜底】网关不支持时（多数中转站转 chat 时会拒 stateful 字段）返回 400。
   * 调用方识别后置 _incrementalDisabled 并**自动重发全量**，此后不再尝试。
   */
  _applyIncremental(body) {
    if (this.protocol !== 'responses') return
    if (!Array.isArray(body.input)) return
    // 【必须先存全量快照】body.input 马上可能被换成裁剪版（slice 出新数组），
    // 而「失败重发全量」「下一轮算跳过长度」都要用完整那一个。
    this._lastBuiltFullInput = body.input
    if (this._incrementalDisabled) return
    if (!this._lastResponseId) return          // 没有锚点（首轮/已重置）
    if (body.input.length === 0) return
    const prev = this._lastInputInfo
    if (!prev || typeof prev.count !== 'number') return

    if (body.input.length <= prev.count) {
      // 没有新增项。顺手校验前缀：如果历史被换掉/压缩了，锚点已失效，清掉。
      const head = inputFingerprint(body.input, Math.min(prev.count, body.input.length))
      if (!head || head !== prev.head) { this._lastResponseId = null; this._lastInputInfo = null }
      return
    }

    // 前缀指纹校验：这次 input 的前 prev.count 项必须与上次发的完整 input 一致
    const nowHead = inputFingerprint(body.input, prev.count)
    if (!nowHead || nowHead !== prev.head) {
      // 前缀变了（压缩/换会话/重排）→ 锚点作废，退回全量
      this._lastResponseId = null
      this._lastInputInfo = null
      return
    }

    // ── 客户端侧的增量：先切掉自己发过的，再剥掉「服务端自己生成的项」──
    //
    // ⚠ 这里**不能**用「prev.count + 服务端 output 项数」当切片位置。
    //   服务端生成的一些项（reasoning，常带 encrypted_content）我们客户端
    //   **不重放**，所以两侧的项数根本对不齐：
    //     服务端历史：[u1, reasoning, a1]（3 项）
    //     客户端重放：[u1, a1, u2]（3 项，缺 reasoning、多 u2）
    //   按位置切 3 项 → 空增量，新消息 u2 永远发不出去（实测卡死在这：
    //   三轮全是"全量"，增量一次没生效）。
    //
    // 正确做法：
    //   1. 切掉前 prev.count 项（那些都发过）
    //   2. 剥掉开头连续的「服务端产出的项」—— assistant 文本、function_call、
    //      reasoning。这些服务端自己的历史里已经有了，重发会造成重复回合。
    //   3. 剩下的是真正的新内容（新 user 消息、tool_result……）
    let delta = body.input.slice(prev.count)
    while (delta.length > 0 && isServerGeneratedItem(delta[0])) delta = delta.slice(1)
    if (delta.length === 0) return   // 没有真正的新内容，这轮老老实实全量

    body.previous_response_id = this._lastResponseId
    body.input = delta
  }

  /**
   * 重组出「全量版」请求体 —— 增量被网关拒绝时用它重发。
   * 返回 null 表示当前 body 本来就是全量。
   */
  _fullBodyFrom(body) {
    if (!body?.previous_response_id || !Array.isArray(this._lastBuiltFullInput)) return null
    const full = { ...body, input: this._lastBuiltFullInput }
    delete full.previous_response_id
    return full
  }

  /**
   * 判断一个错误是否「网关拒绝 stateful 字段」。
   * 命中后置 _incrementalDisabled 并永久退回全量（探测成本只一次）。
   *
   * 实测 ai.furry.vg 的报错（2026-09-14）：
   *   "responses to chat conversion does not support stateful fields:
   *    previous_response_id"
   */
  _isIncrementalRejection(err) {
    const text = `${err?.message || ''}\n${err?.responseBody || ''}`
    return /previous_response_id|stateful\s+fields?/i.test(text)
  }

  /**
   * 生成一个 input_image 内容项。
   * _imageUrlStyle 决定 image_url 是字符串（官方）还是 {url}（部分中转上游）。
   */
  _makeInputImage(url, detail) {
    const it = this._imageUrlStyle === 'object'
      ? { type: 'input_image', image_url: { url } }
      : { type: 'input_image', image_url: url }
    if (detail) it.detail = detail
    return it
  }

  /**
   * 判断错误是否「网关不接受字符串形态的 image_url」。
   * 命中后切到 object 形态并重发（见构造函数里的说明）。
   *
   * 实测报错（ai.furry.vg 上游，2026-09-14）：
   *   "invalid image_url content at index 1:
   *    json: cannot unmarshal string into Go value of type ***.ImageContent"
   */
  _isImageUrlStyleError(err) {
    const text = `${err?.message || ''}\n${err?.responseBody || ''}`
    if (!/input_image|image_url|ImageContent/i.test(text)) return false
    return /cannot\s+unmarshal|invalid\s+image_url|expected\s+object|unmarshal\s+string/i.test(text)
  }

  /**
   * 记录本次请求（供下一轮做增量判定）。必须在请求**成功后**调用 ——
   * 失败时服务端没存历史，记了会让下一轮算错跳过长度。
   *
   * @param {object} body     完整全量 body（裁剪前的快照）
   * @param {string} responseId 服务端返回的响应 id（无则清锚点）
   * @param {number} responseItemCount 服务端本次新增的 output 项数
   */
  _rememberRequestForIncremental(body, responseId, responseItemCount = 0) {
    if (this.protocol !== 'responses') return
    if (!responseId) { this._lastResponseId = null; this._lastInputInfo = null; return }
    const items = Array.isArray(body?.input) ? body.input : []
    this._lastResponseId = responseId
    this._lastInputInfo = {
      count: items.length,
      responseCount: Number.isFinite(responseItemCount) && responseItemCount > 0 ? responseItemCount : 0,
      head: inputFingerprint(items, items.length),
    }
  }

  sanitizeInternalToolPairs(messages) {
    const out = []
    for (let i = 0; i < (messages || []).length; i++) {
      const msg = messages[i]
      const toolUses = msg?.role === 'assistant' && Array.isArray(msg.content)
        ? msg.content.filter(block => block?.type === 'tool_use')
        : []
      if (toolUses.length === 0) {
        // 无前置 tool_use 的孤立 tool_result 也要剔除，但保留同一 user 消息中的文本/图片。
        if (msg?.role === 'user' && Array.isArray(msg.content)) {
          const kept = msg.content.filter(block => block?.type !== 'tool_result')
          if (kept.length > 0) out.push({ ...msg, content: kept })
        } else out.push(msg)
        continue
      }

      const expected = new Set(toolUses.map(block => block?.id).filter(Boolean))
      const next = messages[i + 1]
      const results = next?.role === 'user' && Array.isArray(next.content)
        ? next.content.filter(block => block?.type === 'tool_result' && expected.has(block.tool_use_id))
        : []
      const answered = new Set(results.map(block => block.tool_use_id))
      const complete = expected.size === toolUses.length
        && results.length === expected.size
        && answered.size === expected.size
      if (complete) {
        out.push(msg, next)
        i++
        continue
      }

      const assistantKept = msg.content.filter(block => block?.type !== 'tool_use')
      if (assistantKept.length > 0) out.push({ ...msg, content: assistantKept })
      if (next?.role === 'user' && Array.isArray(next.content)) {
        const userKept = next.content.filter(block => block?.type !== 'tool_result')
        if (userKept.length > 0) out.push({ ...next, content: userKept })
        i++
      }
    }
    // 角色交替校验（Aider ensure_alternating_roles）：相邻同 role 自动插空消息修复，防 400
    return this.ensureAlternatingRoles(out)
  }

  // 丢弃纯空白的 text block。Anthropic 对空/纯空白 text 直接 400；OpenAI 虽然宽容，
  // 但空块也没有信息量，统一清掉。tool_use/tool_result/image 等非 text 块一律保留。
  dropBlankTextBlocks(messages) {
    return (messages || []).map((m) => {
      if (!m) return m
      if (typeof m.content === 'string') {
        // 字符串内容为空白：给占位符（直接删消息会破坏 role 交替和工具配对）
        return m.content.trim() ? m : { ...m, content: '(empty)' }
      }
      if (!Array.isArray(m.content)) return m
      const kept = m.content.filter((b) => {
        if (!b || typeof b !== 'object') return false
        if (b.type !== 'text') return true          // 非文本块原样保留
        return typeof b.text === 'string' && b.text.trim().length > 0
      })
      if (kept.length === m.content.length) return m
      // 全被清空：留一个占位文本块，避免 content: [] 触发另一类 400
      if (kept.length === 0) return { ...m, content: [{ type: 'text', text: '(empty)' }] }
      return { ...m, content: kept }
    })
  }

  // 确保 assistant/user 交替出现；相邻同 role 时插入最小占位（OpenAI 不接受相邻同 role）
  ensureAlternatingRoles(messages) {
    const out = []
    for (const msg of messages || []) {
      const last = out[out.length - 1]
      if (last && last.role === msg.role) {
        if (msg.role === 'assistant') {
          // 相邻两个 assistant：插入空 user 占位
          out.push({ role: 'user', content: '(continue)' })
        } else {
          // 相邻两个 user：合并内容（保留后者的文本）
          const lastContent = typeof last.content === 'string' ? last.content : ''
          const curContent = typeof msg.content === 'string' ? msg.content : ''
          if (Array.isArray(last.content) || Array.isArray(msg.content)) {
            // 结构消息不合并，插入空 assistant 占位
            out.push({ role: 'assistant', content: '(continue)' })
            out.push(msg)
            continue
          }
          out[out.length - 1] = { ...last, content: [lastContent, curContent].filter(Boolean).join('\n') }
          continue
        }
      }
      out.push(msg)
    }
    return out
  }

  buildOpenAIBody({ system, messages, tools, maxTokens, temperature, stream, thinkingEffort = null }) {
    const openaiMessages = []
    // systemTopLevel: 实测 sotamodel 网关对 messages[0] 里的大 system 间歇性返回空流
    // （A/B 对照：messages[0] 40% 空，顶层字段 0% 空）。开启时 system 放 body.system。
    if (system && !this.systemTopLevel) {
      openaiMessages.push({ role: 'system', content: system })
    }
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        const om = { role: msg.role, content: sanitizeTextForApi(msg.content) }
        if (msg.role === 'assistant' && msg.reasoning_content) this.attachReasoning(om, msg.reasoning_content)
        openaiMessages.push(om)
      } else if (Array.isArray(msg.content)) {
        if (msg.role === 'user' && msg.content.some(b => b && b.type === 'image_url')) {
          const parts = []
          for (const b of msg.content) {
            if (!b || typeof b !== 'object') continue
            if (b.type === 'text' && b.text) parts.push({ type: 'text', text: sanitizeTextForApi(b.text) })
            else if (b.type === 'image_url' && b.image_url?.url) {
              if (this._visionDisabled) {
                const path = msg.content.find(x => x?.type === 'web_attachment' && x?.file_type === 'image' && x?.path)?.path
                parts.push({ type: 'text', text: path ? `${IMAGE_OMITTED} 图片本地路径：${path}。请调用 ViewImage 工具读取后再回答。` : IMAGE_OMITTED })
              } else parts.push({ type: 'image_url', image_url: { url: b.image_url.url } })
            }
          }
          if (parts.length > 0) openaiMessages.push({ role: 'user', content: parts })
        } else {
          this.convertContentBlocks(msg, openaiMessages)
        }
      }
    }
    const sanitizedMessages = this.sanitizeOpenAIToolPairs(openaiMessages)
    if (this.maxOutputTokens && (!maxTokens || maxTokens > this.maxOutputTokens)) maxTokens = this.maxOutputTokens
    const body = { model: this.model, messages: sanitizedMessages, max_tokens: maxTokens, temperature:this.getEffectiveTemperature(temperature), stream }
    if (this.systemTopLevel && system) body.system = system
    // OpenAI 兼容端点也支持这两个缓存字段；未配置时完全不发送，兼容旧网关。
    if (this.promptCacheEnabled && this.sessionCacheKey) body.prompt_cache_key = this.sessionCacheKey
    if (this.promptCacheEnabled && this.promptCacheRetention) body.prompt_cache_retention = this.promptCacheRetention
    const thinkingPolicy = this.getThinkingPolicy(thinkingEffort)
    // OpenAI 兼容协议只发标准字段 reasoning_effort（异厂原生字段已移除，见 getThinkingPolicy 注释）
    if (thinkingPolicy.kind === 'reasoning_effort' && thinkingPolicy.effective) {
      body.reasoning_effort = thinkingPolicy.effective
    }
    const stableTools = stableToolList(tools)
    if (stableTools.length > 0) {
      body.tools = stableTools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: normalizeToolSchema(t.input_schema) },
      }))
    }
    return body
  }

  // ══ Responses API（OpenAI /v1/responses）══════════════════════════════
  //
  // 【和 chat/completions 的区别】字段名和结构都不同，不能复用：
  //   消息：messages[{role,content}]      → input[{type:'message',role,content[]}]
  //   system：messages[0]                 → instructions（顶层字符串）
  //   工具：{type:'function',function:{}} → {type:'function',name,parameters}（扁一层）
  //   工具结果：role:'tool'               → {type:'function_call_output',call_id,output}
  //   工具调用：role:'assistant'+tool_calls → {type:'function_call',call_id,name,arguments}
  //   输出上限：max_tokens                → max_output_tokens
  //   思考：reasoning_effort              → reasoning:{effort}
  //   流式：chat.completion.chunk        → response.output_text.delta 等事件
  //
  // 目标：让上层（agent.mjs）完全无感 —— 进来和出去都是 OpenAI 兼容形状。

  buildResponsesBody({ system, messages, tools, maxTokens, temperature, stream, thinkingEffort = null }) {
    const input = []
    // 工具结果 → function_call_output 的 output。
    // 对齐 Codex 的 FunctionCallOutputBody（protocol/src/models.rs:2078）：
    // 可以是纯字符串，也可以是内容项数组 [{type:'input_text'},{type:'input_image',image_url}]。
    // 内容项形式支持**图片结果**——我们的识图工具（ViewImage/截图分析）返回的
    // base64 图片以前只能塞进文本（模型看不到），现在能作为真正的图片输入。
    const toCallOutput = (content) => {
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return JSON.stringify(content ?? '')
      const items = []
      for (const b of content) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'text' && typeof b.text === 'string') {
          items.push({ type: 'input_text', text: b.text })
        } else if (b.type === 'image_url' && b.image_url?.url) {
          // vision 降级时不发图（与消息路径同一开关）
          if (this._visionDisabled) { items.push({ type: 'input_text', text: IMAGE_OMITTED }); continue }
          items.push(this._makeInputImage(b.image_url.url, b.image_url.detail))
        }
      }
      // 元素全是文本时退化成纯字符串（更小的 payload，且部分网关只认字符串形式）
      if (items.length > 0 && items.every(i => i.type === 'input_text')) {
        return items.map(i => i.text).join('\n')
      }
      return items.length > 0 ? items : ''
    }
    for (const msg of messages || []) {
      if (!msg) continue
      if (msg.role === 'tool') {
        // 工具结果 → function_call_output（顶层项，不是包在 message 里）
        input.push({
          type: 'function_call_output',
          call_id: normalizeToolCallId(msg.tool_call_id),
          output: toCallOutput(msg.content),
        })
        continue
      }

      // assistant 的 tool_calls 要拆成独立的 function_call 项（Responses 的模型）
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        // 【推理项必须先回传】stateless 模式下，上一轮的 reasoning items
        // （含 encrypted_content）要原样放回，否则模型丢掉自己的推理链。
        // 顺序上官方要求它们排在对应 function_call 之前。
        // replayReasoning=false（/effort replay off）时不回传 —— 省上下文
        if (this.replayReasoning && Array.isArray(msg._reasoningItems)) {
          for (const it of msg._reasoningItems) {
            if (it?.type !== 'reasoning') continue
            // 有加密体最好（服务端能完整还原推理），没有就发明文摘要 —— 实测两者都收
            const hasEnc = !!it.encrypted_content
            const hasSummary = Array.isArray(it.summary) && it.summary.length > 0
            if (!hasEnc && !hasSummary) continue
            input.push({
              type: 'reasoning',
              ...(hasEnc ? { encrypted_content: it.encrypted_content } : {}),
              ...(hasSummary ? { summary: it.summary } : {}),
            })
          }
        }
        const textParts = []
        const calls = []
        for (const b of msg.content) {
          if (!b || typeof b !== 'object') continue
          if (b.type === 'text' && b.text) textParts.push(sanitizeTextForApi(b.text))
          else if (b.type === 'tool_use') calls.push(b)
        }
        // 【顺序：message 必须排在 function_call 之前，不能反】
        //
        // Responses 要求每个 function_call 之后**紧跟**它的 function_call_output。
        // 原来这里先 push call、循环完再 push message，产生的序列是：
        //     CALL_A, MESSAGE(文本), OUTPUT_A
        // —— message 夹在 call 和 output 中间，网关判定「call 没有紧跟的结果」，
        // 直接 400：tool_call_sequence_broken /
        // "tool calls and tool results do not match"（2026-09-13 实测复现，
        // 中转站 ai.furry.vg 上游就是这条规则；错误文案会包装成
        // 「工具调用记录不完整，请重新发起对话」，看着像会话坏了，其实是顺序错）。
        //
        // 正确序列：
        //     MESSAGE(文本), CALL_A, CALL_B, OUTPUT_A, OUTPUT_B
        // 多个并行调用时，call 们连续、output 们连续，是官方文档给出的形式。
        if (textParts.length > 0) {
          input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: textParts.join('\n') }] })
        }
        for (const b of calls) {
          input.push({
            type: 'function_call',
            call_id: normalizeToolCallId(b.id),
            name: b.name,
            arguments: JSON.stringify(b.input || {}),
          })
        }
        continue
      }

      // user 消息：文本 + 图片 + tool_result（内部 block 格式）
      const content = []
      const callOutputs = []   // tool_result 单独收集，保证排在 message 之后
      const parts = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : (msg.content || [])
      for (const b of parts) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'text' && b.text) {
          content.push({ type: 'input_text', text: sanitizeTextForApi(b.text) })
        } else if (b.type === 'image_url' && b.image_url?.url) {
          if (this._visionDisabled) {
            const path = Array.isArray(msg.content) ? msg.content.find(x => x?.type === 'web_attachment' && x?.file_type === 'image' && x?.path)?.path : null
            content.push({ type: 'input_text', text: path ? `${IMAGE_OMITTED} 图片本地路径：${path}。请调用 ViewImage 工具读取后再回答。` : IMAGE_OMITTED })
          } else {
            content.push(this._makeInputImage(b.image_url.url, b.image_url.detail))
          }
        } else if (b.type === 'tool_result') {
          // 某些历史消息把 tool_result 塞在 user content 里（内部 block 格式）。
          // ⚠ 顺序：function_call_output 必须**紧跟**它对应的 function_call。
          //   如果这条 user 消息同时含文本（罕见但可能：工具结果 + 用户追问），
          //   文本要排前面、outputs 排后面，不能反 —— 反了就成 M O C 顺序，网关 400。
          callOutputs.push({ type: 'function_call_output', call_id: normalizeToolCallId(b.tool_use_id), output: toCallOutput(b.content) })
        }
      }
      if (content.length > 0) {
        input.push({ type: 'message', role: msg.role === 'assistant' ? 'assistant' : 'user', content })
      }
      for (const o of callOutputs) input.push(o)
    }

    if (this.maxOutputTokens && (!maxTokens || maxTokens > this.maxOutputTokens)) maxTokens = this.maxOutputTokens
    const body = { model: this.model, input, max_output_tokens: maxTokens, stream }
    // store:false —— 我们每轮自带完整历史（stateless），不靠服务端会话。
    // include 里要 encrypted_content：多轮工具调用时模型需要回看自己上一轮的推理，
    // 而 stateless 模式下这份推理只能由客户端回传（官方 reasoning items 机制）。
    body.store = false
    body.include = ['reasoning.encrypted_content']
    if (system) body.instructions = system
    // ── 以下字段对齐 Codex 官方实现（openai/codex · codex-rs/core/src/client.rs
    //    build_responses_request，2026-09-13 逐字段比对）──
    //
    // tool_choice / parallel_tool_calls：Codex 无条件发 `"auto"` / `true`。
    // 不发的话服务端按默认走，行为不一定一致（部分网关默认串行执行工具）。
    // parallel=true 与我们的实现相符：agent 的 _partitionToolCalls 本来就把
    // 只读工具并发跑。
    body.tool_choice = 'auto'
    body.parallel_tool_calls = true
    // prompt_cache_key：Codex 用 session_id 当缓存键（client.rs:485 prompt_cache_key()）。
    // 这是**缓存命中的关键** —— 服务端靠它把同一会话的请求路由到同一缓存分片。
    // 不传的话每轮可能落到不同分片，命中率上不去（我们之前实测 99.7% 是靠
    // 前缀稳定+端侧缓存，但跨会话/长间隔后的首轮命中会差）。
    if (this.promptCacheEnabled && this.sessionCacheKey) body.prompt_cache_key = this.sessionCacheKey
    if (this.promptCacheEnabled && this.promptCacheRetention) body.prompt_cache_retention = this.promptCacheRetention
    // Responses 的 temperature 与 reasoning 互斥（开了推理就不接受 temperature）
    const thinkingPolicy = this.getThinkingPolicy(thinkingEffort)
    if (thinkingPolicy.kind === 'reasoning_effort' && thinkingPolicy.effective) {
      // summary 字段：Codex 发 summary:'auto'（ReasoningSummary 默认值）。
      // 要求服务端返回推理摘要 —— 这正是我们 UI 上「思考中…」那段文字的来源。
      // 只在网关支持时才有意义；不支持的网关会忽略未知字段（不影响请求）。
      body.reasoning = { effort: thinkingPolicy.effective, summary: 'auto' }
    } else if (temperature !== undefined && temperature !== null) {
      body.temperature = this.getEffectiveTemperature(temperature)
    }
    const stableTools = stableToolList(tools)
    if (stableTools.length > 0) {
      // 扁平结构：没有 function 包一层（Codex 的 create_tools_raw_json_for_responses_api）
      body.tools = stableTools.map(t => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: normalizeToolSchema(t.input_schema),
        strict: false,
      }))
    }
    return body
  }

  /**
   * Responses 响应 → OpenAI chat.completion 形状。
   * 让 agent 的 parseResponse 不用改一行。
   *
   * Responses 的 output 是异构数组：
   *   {type:'reasoning', summary:[{type:'summary_text',text}]}
   *   {type:'message', content:[{type:'output_text',text}]}
   *   {type:'function_call', call_id, name, arguments}
   */
  normalizeResponsesResponse(json) {
    const message = { role: 'assistant' }
    const textParts = []
    const reasoningParts = []
    const toolCalls = []
    for (const item of json.output || []) {
      if (!item || typeof item !== 'object') continue
      if (item.type === 'message') {
        for (const c of item.content || []) {
          if (c?.type === 'output_text' && c.text) textParts.push(c.text)
          else if (c?.type === 'refusal') textParts.push(c.refusal || '')
        }
      } else if (item.type === 'reasoning') {
        let summaryText = ''
        for (const s of item.summary || []) {
          if (s?.type === 'summary_text' && s.text) { reasoningParts.push(s.text); summaryText += s.text }
        }
        // 【有文本就留着回传】不强制要求 encrypted_content。
        //
        // 之前只收带 encrypted_content 的项，结果在「只给明文摘要」的网关上
        // _reasoningItems 永远为空 → 思考进不了历史 → 模型下一轮看不到自己想过什么。
        // 实测（2026-09-14）：发回带 summary 但无 encrypted_content 的 reasoning 项，
        // 网关 200 接受 —— 所以有文本就该回传。
        if (summaryText || item.encrypted_content) {
          const keep = { type: 'reasoning' }
          if (summaryText) keep.summary = [{ type: 'summary_text', text: summaryText }]
          if (item.encrypted_content) keep.encrypted_content = item.encrypted_content
          ;(message._reasoningItems ||= []).push(keep)
        }
      } else if (item.type === 'function_call') {
        toolCalls.push({
          id: normalizeToolCallId(item.call_id || item.id),
          type: 'function',
          function: { name: item.name, arguments: item.arguments || '{}' },
        })
      }
    }
    if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join('\n')
    message.content = textParts.join('\n') || null
    if (toolCalls.length > 0) message.tool_calls = toolCalls

    // 状态映射：completed → stop；incomplete 视原因而定
    let finish = 'stop'
    if (toolCalls.length > 0) finish = 'tool_calls'
    else if (json.status === 'incomplete') {
      finish = json.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'stop'
    } else if (json.status === 'failed') {
      finish = 'stop'
    }

    // usage 改名：Responses 用 input_tokens/output_tokens（OpenAI 旧名），
    // 缓存明细在 input_tokens_details.cached_tokens —— agent 的 pickCache 正好认这个
    const u = json.usage || {}
    const usage = {
      prompt_tokens: u.input_tokens ?? 0,
      completion_tokens: u.output_tokens ?? 0,
      ...(u.input_tokens_details ? { prompt_tokens_details: u.input_tokens_details } : {}),
      ...(u.output_tokens_details ? { completion_tokens_details: u.output_tokens_details } : {}),
    }

    return {
      id: json.id,
      model: json.model,
      choices: [{ message, finish_reason: finish }],
      usage,
    }
  }

  /**
   * Responses SSE → 内部流事件。
   *
   * 关键事件（官方 events 参考）：
   *   response.output_item.added          output_index → item（function_call 出生）
   *   response.output_text.delta          正文增量
   *   response.reasoning_summary_text.delta 思考摘要增量
   *   response.function_call_arguments.delta 工具参数增量
   *   response.output_item.done            item 完成（拿完整 arguments）
   *   response.completed                   整体完成（含 usage）
   *
   * 与 chat/completions 的最大区别：工具调用没有 index 概念，用 output_index
   * 和 item_id 双坐标。这里统一映射成数字 index，让 agent 的 tcs[idx] 照旧工作。
   */
  *parseResponsesSSELine(line, state) {
    const trimmed = String(line || '').trim()
    if (!trimmed.startsWith('data:')) return
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') return
    let j
    try {
      j = JSON.parse(data)
    } catch (e) {
      yield { type: 'parse_error', protocol: 'responses', error: e.message || 'invalid SSE JSON', data: data.slice(0, 200) }
      return
    }
    const type = j.type
    switch (type) {
      case 'response.created':
        // 抓 response id：增量请求（previous_response_id）的锚点。
        // 流式的 id 只在这里和 completed 里出现，先到先记。
        if (j.response?.id) {
          state.responseId = j.response.id
          yield { type: '_response_meta', id: j.response.id }
        }
        break
      case 'response.output_item.added': {
        const item = j.item
        // 服务端新增的 output 项数 = max(output_index)+1。
        // 下一轮算增量跳过长度要用它（服务端把生成的项也算进历史）。
        // 每一项都会先发 added（text/function_call/reasoning 都算），
        // 所以这个计数是完整的。
        yield { type: '_output_index', index: j.output_index ?? 0 }
        if (item?.type === 'function_call') {
          yield { type: 'tool_call_start', id: item.call_id || item.id, name: item.name, index: j.output_index }
        } else if (item?.type === 'reasoning') {
          // 记下 item id → 后面 delta 事件靠 item_id 找回 index
          state.reasoningItemId = item.id
          yield { type: 'thinking_block_start', index: j.output_index }
        }
        break
      }
      case 'response.output_text.delta':
        if (j.delta) yield { type: 'text', text: j.delta }
        break
      case 'response.reasoning_summary_text.delta':
        if (j.delta) {
          yield { type: 'reasoning', text: j.delta }
          // 用 output_index 定位（找不到时退回记录的那个 reasoning 槽）
          yield { type: 'thinking_block_delta', index: j.output_index ?? state.reasoningIndex, text: j.delta }
        }
        break
      case 'response.function_call_arguments.delta':
        if (j.delta) yield { type: 'tool_call_delta', index: j.output_index, arguments: j.delta }
        break
      case 'response.output_item.done': {
        const item = j.item
        if (item?.type === 'function_call') {
          // done 事件的 arguments 是完整的 —— 用它兜底覆盖累积值，
          // 防止某些网关的 delta 丢片导致 JSON 拼不完整
          yield { type: 'tool_call_end', index: j.output_index }
          if (item.arguments) yield { type: 'tool_call_delta', index: j.output_index, arguments: item.arguments, _authoritative: true }
        } else if (item?.type === 'reasoning') {
          yield { type: 'block_stop', index: j.output_index }
          // encrypted_content 要在下一轮回传（状态无记忆时必须）
          if (item.encrypted_content) {
            yield { type: 'thinking_block_signature', index: j.output_index, signature: item.encrypted_content }
          }
        }
        break
      }
      case 'response.completed': {
        const r = j.response || {}
        // 把 Responses 的 usage 换算成 OpenAI 形状再上报
        const u = r.usage || {}
        const usage = {
          prompt_tokens: u.input_tokens ?? 0,
          completion_tokens: u.output_tokens ?? 0,
          ...(u.input_tokens_details ? { prompt_tokens_details: u.input_tokens_details } : {}),
        }
        yield { type: 'usage', usage }
        const reason = r.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'stop'
        yield { type: 'done', reason, usage }
        break
      }
      case 'response.failed':
      case 'response.incomplete': {
        const r = j.response || {}
        const reason = r.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'stop'
        yield { type: 'done', reason, usage: r.usage || null }
        break
      }
      case 'error': {
        // 流里报错（配额、内容策略…）→ 交给 agent 的分类重试
        const msg = j.error?.message || j.message || 'responses stream error'
        yield { type: 'parse_error', protocol: 'responses', error: msg, data: data.slice(0, 200) }
        break
      }
      default:
        break
    }
  }

  async *parseResponsesStream(response) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const state = { reasoningItemId: null, reasoningIndex: null }
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) yield* this.parseResponsesSSELine(line, state)
      }
      buffer += decoder.decode()
      if (buffer.trim()) yield* this.parseResponsesSSELine(buffer, state)
    } finally {
      try { await reader.cancel() } catch {}
      try { reader.releaseLock() } catch {}
    }
  }

  /**
   * OpenAI 要求 assistant.tool_calls 后必须紧跟每个 call_id 的 tool 消息。
   * 会话恢复、压缩边界或中断可能留下半截工具轮次；发送前保留 assistant 文本，
   * 但剔除不完整的 tool_calls 和其孤立 tool 消息，避免整段历史永久污染。
   */
  sanitizeOpenAIToolPairs(messages) {
    const out = []
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (msg?.role !== 'assistant' || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
        if (msg?.role !== 'tool') out.push(msg)
        continue
      }

      const expected = new Set(msg.tool_calls.map(tc => tc?.id).filter(Boolean))
      const toolMessages = []
      let j = i + 1
      while (j < messages.length && messages[j]?.role === 'tool') {
        const toolMsg = messages[j]
        if (toolMsg.tool_call_id && expected.has(toolMsg.tool_call_id)) toolMessages.push(toolMsg)
        j++
      }
      const answered = new Set(toolMessages.map(m => m.tool_call_id))
      const complete = expected.size === msg.tool_calls.length
        && toolMessages.length === expected.size
        && answered.size === expected.size

      if (complete) {
        out.push(msg, ...toolMessages)
      } else if (msg.content != null && String(msg.content).trim()) {
        const textOnly = { role: 'assistant', content: msg.content }
        if (msg.reasoning_content) this.attachReasoning(textOnly, msg.reasoning_content)
        out.push(textOnly)
      }
      i = j - 1
    }
    return out
  }

  /**
   * 剥离历史消息中的图片块（内部 block 格式），图片替换为 [图片已省略] 文本。
   * 用于 vision 能力 400 后自动恢复：不动其他内容，模型可继续正常回复，
   * 用户无需再靠 /compact 清掉带图历史。
   */
  stripImagesFromHistory(messages) {
    return (messages || []).map(msg => {
      if (!msg || typeof msg !== 'object') return msg
      if (!Array.isArray(msg.content)) return msg
      // Web 图片消息会同时存 web_attachment（含真实文件路径）。vision 400 后不能只塞
      // 「[图片已省略]」——模型会以为图片不可访问；保留路径并明确要求用 ViewImage。
      const attachmentPaths = msg.content
        .filter(block => block?.type === 'web_attachment' && block?.file_type === 'image' && block?.path)
        .map(block => String(block.path))
      let changed = false
      const newContent = msg.content.map(block => {
        if (block && block.type === 'image_url') {
          changed = true
          const pathHint = attachmentPaths.length
            ? ` 图片仍可读取：请调用 ViewImage 工具，file_path 必须使用 ${attachmentPaths.join(' 或 ')}。`
            : ' 图片视觉输入已移除；若用户需要读图，请说明当前模型不支持直接视觉输入。'
          return { type: 'text', text: `${IMAGE_OMITTED}${pathHint}` }
        }
        return block
      })
      return changed ? { ...msg, content: newContent } : msg
    })
  }

  buildAnthropicBody({ system, messages, tools, maxTokens, temperature, stream, thinkingEffort = null }) {
    const anthropicMessages = []
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        // Anthropic 没有 tool 角色：tool_result 合并进 user 消息
        if (msg.role === 'tool') {
          const last = anthropicMessages[anthropicMessages.length - 1]
          if (last && last.role === 'user' && Array.isArray(last.content)) {
            last.content.push({ type: 'tool_result', tool_use_id: normalizeToolCallId(msg.tool_call_id), content: sanitizeTextForApi(msg.content) })
          } else {
            anthropicMessages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: normalizeToolCallId(msg.tool_call_id), content: sanitizeTextForApi(msg.content) }] })
          }
        } else {
          anthropicMessages.push({ role: msg.role, content: sanitizeTextForApi(msg.content) })
        }
      } else if (Array.isArray(msg.content)) {
        const blocks = this.convertBlocksToAnthropic(msg)
        if (blocks) anthropicMessages.push(blocks)
      }
    }
    if (this.maxOutputTokens && (!maxTokens || maxTokens > this.maxOutputTokens)) maxTokens = this.maxOutputTokens
    const body = { model: this.model, messages: anthropicMessages, max_tokens: maxTokens, temperature:this.getEffectiveTemperature(temperature), stream }
    if (system) body.system = system
    const thinkingPolicy = this.getThinkingPolicy(thinkingEffort)
    if (thinkingPolicy.kind === 'anthropic_budget') {
      // 【2026-09-20 用户拍板：budget_tokens = max_tokens - 1】
      //
      // 用户原话：「thinking 预算这个东西反人类，调大 maxtoken 本来就是 token 被思考吃光。
      // 不传这个字段」→ 我核实后他补充：「如果思考预算设 2000，模型思考到一半直接报错，
      // 不会吐出一点正文。设了 64k-1 也不是强制它吐那么多字，这还是取决于任务难度，
      // 64k 是兜底，设小了就报错」。
      //
      // 【我一开始理解错了两点，记下来免得再犯】
      //   1. budget_tokens 是**上限**不是配额 —— 模型按任务难度自己决定用多少，
      //      设 64k 不会强制它思考 64k；
      //   2. 设小了不是"思考少一点"，而是**思考到一半预算耗尽直接报错**，
      //      正文一个字都出不来。所以宁可给大，不能给小。
      //
      // 【官方硬约束】budget_tokens 必须 ≥1024 且 **严格小于** max_tokens。
      // （多个独立来源一致：Anthropic 文档 / Bedrock 文档 / Vertex 文档）
      // 所以能取的最大值就是 max_tokens - 1 —— 这既满足约束，又把预算拉到最宽，
      // 最大化"思考不会中途失败"的概率。
      //
      // 【为什么不再用档位映射表】原来硬编码 { medium:8192, high:16000, max:32000 }，
      // 问题：max_tokens 调大时思考并不等比放宽，且那张表与模型实际能力脱节。
      // 现在预算直接跟随 max_tokens，用户调 max_tokens 就是唯一旋钮，语义清晰。
      // （/effort 档位在 anthropic 协议下不再影响 budget；openai 协议的
      //  reasoning_effort 仍然照常按档位发，那边没有这个约束。）
      const MIN_BUDGET = 1024
      if (maxTokens > MIN_BUDGET) {
        body.thinking = { type: 'enabled', budget_tokens: maxTokens - 1 }
      }
      // max_tokens 太小（≤1024）时放不下合法 budget → 干脆不发 thinking，
      // 让请求能成功。此时思考被关掉是唯一可行解（否则必然 400）。
    }
    const stableTools = stableToolList(tools)
    if (stableTools.length > 0) {
      // eager_input_streaming: Anthropic 的 fine-grained tool streaming 开关。
      // 不开时 partial_json 会先在服务端积累再成批推；开了才逐片立即下发，
      // 这是「文件内容随模型书写逐行出现」的前提（官方文档 fine-grained-tool-streaming）。
      // 对不认识这个字段的中转/兼容端点是无害的额外属性。
      body.tools = stableTools.map(t => ({
        name: t.name, description: t.description, input_schema: normalizeToolSchema(t.input_schema),
        eager_input_streaming: true,
      }))
    }
    return body
  }

  convertBlocksToAnthropic(msg) {
    const blocks = []
    let textParts = []
    for (const block of msg.content) {
      if (block.type === 'text') textParts.push(sanitizeTextForApi(block.text))
      else if (block.type === 'image_url' && block.image_url?.url) {
        if (this._visionDisabled) {
          textParts.push(imageOmittedText(msg.content))
          continue
        }
        const url = block.image_url.url
        if (url.startsWith('data:')) {
          const m = url.match(/^data:([^;]+);base64,(.+)$/)
          if (m) blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } })
        } else {
          blocks.push({ type: 'image', source: { type: 'url', url } })
        }
      } else if (block.type === 'tool_use') {
        blocks.push({ type: 'tool_use', id: normalizeToolCallId(block.id), name: block.name, input: block.input || {} })
      } else if (block.type === 'tool_result') {
        let c = block.content
        if (Array.isArray(c)) {
          const parts = []
          for (const p of c) {
            if (!p || typeof p !== 'object') continue
            if (p.type === 'text' && p.text) parts.push({ type: 'text', text: sanitizeTextForApi(p.text) })
            else if (p.type === 'image_url' && p.image_url?.url) {
              if (this._visionDisabled) {
                parts.push({ type: 'text', text: IMAGE_OMITTED })
                continue
              }
              const u = p.image_url.url
              if (u.startsWith('data:')) {
                const m = u.match(/^data:([^;]+);base64,(.+)$/)
                if (m) parts.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } })
              } else parts.push({ type: 'image', source: { type: 'url', url: u } })
            } else parts.push({ type: 'text', text: JSON.stringify(p) })
          }
          c = parts
        } else if (typeof c !== 'string') {
          c = JSON.stringify(c)
        }
        blocks.push({ type: 'tool_result', tool_use_id: normalizeToolCallId(block.tool_use_id), content: c })
      }
    }
    if (msg.role === 'assistant') {
      // 文本块 + tool_use 块
      const out = []
      // 【thinking 必须排最前】
      // Anthropic 规定 assistant 消息里 thinking 块要在 text/tool_use 之前，
      // 且内容与 signature 必须与当初返回的完全一致（重新拼装就 400）。
      // agent 在收到响应时已把原始块存在 msg._anthropicThinking 上，这里原样放回。
      // replayReasoning=false 时不回放 thinking 块。
      // ⚠ Anthropic 对带 tool_use 的轮次**要求**保留 thinking 块（含 signature），
      //   关掉可能触发 400（thinking blocks must be preserved）。其余场景省上下文有效。
      if (this.replayReasoning && Array.isArray(msg._anthropicThinking)) {
        for (const b of msg._anthropicThinking) {
          if (b?.type === 'thinking' && b.thinking && b.signature) out.push({ type: 'thinking', thinking: b.thinking, signature: b.signature })
          else if (b?.type === 'redacted_thinking' && b.data) out.push({ type: 'redacted_thinking', data: b.data })
        }
      }
      if (textParts.length > 0) out.push({ type: 'text', text: textParts.join('\n') })
      for (const b of blocks) out.push(b)
      return { role: 'assistant', content: out }
    } else if (msg.role === 'user') {
      const out = []
      if (textParts.length > 0) out.push({ type: 'text', text: textParts.join('\n') })
      for (const b of blocks) out.push(b)
      return { role: 'user', content: out }
    }
    return null
  }

  convertContentBlocks(msg, openaiMessages) {
    const blocks = msg.content
    const textParts = [], toolCalls = [], toolResults = [], imageParts = []
    for (const block of blocks) {
      if (block.type === 'text') textParts.push(sanitizeTextForApi(block.text))
      else if (block.type === 'image_url' && block.image_url?.url) {
        if (this._visionDisabled) textParts.push(imageOmittedText(blocks))
        else imageParts.push({ type: 'image_url', image_url: { url: block.image_url.url } })
      }
      else if (block.type === 'tool_use') {
        toolCalls.push({ id: normalizeToolCallId(block.id), type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input || {}) } })
      } else if (block.type === 'tool_result') {
        // content 可以是 string，或 OpenAI/Anthropic 风格的多段（含 image_url）
        let c = block.content
        if (Array.isArray(c)) {
          // 保留 text + image_url；其它块 JSON 化
          const parts = []
          for (const p of c) {
            if (!p || typeof p !== 'object') continue
            if (p.type === 'text' && p.text) parts.push({ type: 'text', text: sanitizeTextForApi(p.text) })
            else if (p.type === 'image_url' && p.image_url?.url) {
              if (this._visionDisabled) parts.push({ type: 'text', text: IMAGE_OMITTED })
              else parts.push({ type: 'image_url', image_url: { url: p.image_url.url } })
            }
            else parts.push({ type: 'text', text: JSON.stringify(p) })
          }
          c = parts.length ? parts : JSON.stringify(block.content)
        } else if (typeof c !== 'string') {
          c = JSON.stringify(c)
        }
        toolResults.push({ tool_call_id: normalizeToolCallId(block.tool_use_id), content: c })
      }
    }
    if (msg.role === 'assistant') {
      const om = { role: 'assistant' }
      if (textParts.length > 0) om.content = textParts.join('\n')
      if (toolCalls.length > 0) om.tool_calls = toolCalls
      if (om.content != null || om.tool_calls) {
        if (msg.reasoning_content) this.attachReasoning(om, msg.reasoning_content)
        openaiMessages.push(om)
      }
    } else if (msg.role === 'user') {
      const lastAssistant = openaiMessages[openaiMessages.length - 1]
      const validToolCallIds = new Set(Array.isArray(lastAssistant?.tool_calls)
        ? lastAssistant.tool_calls.map(tc => tc?.id).filter(Boolean)
        : [])
      for (const tr of toolResults) {
        // OpenAI tool 消息必须直接响应前一个 assistant.tool_calls 里的 id
        if (!tr.tool_call_id || !validToolCallIds.has(tr.tool_call_id)) continue
        const tc = typeof tr.content === 'string' ? sanitizeTextForApi(tr.content)
          : Array.isArray(tr.content)
            ? tr.content.map(p => (p?.type === 'text' ? sanitizeTextForApi(p.text) : '[image]')).join('\n')
            : JSON.stringify(tr.content)
        openaiMessages.push({ role: 'tool', tool_call_id: tr.tool_call_id, content: tc })
      }
      if (imageParts.length > 0) {
        const parts = []
        if (textParts.length > 0) parts.push({ type: 'text', text: textParts.join('\n') })
        parts.push(...imageParts)
        openaiMessages.push({ role: 'user', content: parts })
      } else if (textParts.length > 0) {
        openaiMessages.push({ role: 'user', content: textParts.join('\n') })
      }
    }
  }

  /**
   * 标记「连接池可能已被污染」。
   * 由外部（agent 的 stream watchdog）或内部（建连失败/socket 挂断）调用。
   *
   * 触发后 CONNECTION_SUSPECT_MS 内所有请求都带 Connection: close ——
   * 包括非流式。这是为了修「一次流超时之后连 /config test 也一直卡、
   * 重启才好」：流式本来就弃池不受影响，非流式复用池时会捡到那条半开连接。
   * @param {string} [reason] 只用于可观测（写进 trace / 状态行）
   */
  markConnectionSuspect(reason = '') {
    this._connectionSuspectAt = Date.now()
    this._connectionSuspectReason = String(reason || '')
  }

  /** 当前是否处于「不复用连接」窗口内 */
  _shouldAvoidConnectionReuse() {
    if (!this._connectionSuspectAt) return false
    if (Date.now() - this._connectionSuspectAt < CONNECTION_SUSPECT_MS) return true
    // 窗口过期，自动恢复复用（不需要重启）
    this._connectionSuspectAt = 0
    this._connectionSuspectReason = ''
    return false
  }

  /** 供 /config test、状态行等查询当前连接健康状态 */
  describeConnectionHealth() {
    if (!this._shouldAvoidConnectionReuse()) return null
    const leftMs = CONNECTION_SUSPECT_MS - (Date.now() - this._connectionSuspectAt)
    return {
      suspect: true,
      reason: this._connectionSuspectReason || 'unknown',
      remainingSec: Math.max(0, Math.round(leftMs / 1000)),
    }
  }

  async request(body, stream, signal = null) {
    // 每次请求开始先清掉上一轮的阶段记录，否则 watchdog 读到的是旧值（误导排查）
    this._lastPhase = { phase: 'request_start', at: Date.now() }
    const isAnthropic = this.protocol === 'anthropic'
    const isResponses = this.protocol === 'responses'
    // 路径按协议分派：
    //   openai    → {base}/chat/completions   （base 以 /v1 结尾）
    //   anthropic → {base}/v1/messages        （base 不带 /v1）
    //   responses → {base}/responses          （base 以 /v1 结尾，OpenAI 官方 /v1/responses）
    const url = isAnthropic
      ? `${this.baseUrl}/v1/messages`
      : isResponses
        ? `${this.baseUrl}/responses`
        : `${this.baseUrl}/chat/completions`
    // 【流式不设 fetch 超时 —— 与 agent watchdog 二选一，只留 watchdog】
    //
    // 这两层必须删掉一个，否则永远在打架：
    //   - api 层的 timer 在 finally 就被 clearTimeout，只覆盖「发请求→拿响应头」，
    //     管不到 body 阶段；而且它一响就走内层 for 的重试（同一份大 body 再发一遍）。
    //   - watchdog 覆盖整个流、且每收到数据就 reset，只在「真的持续无数据」时才响。
    // 留 watchdog 的理由：它是唯一能覆盖 body 阶段的，也不会误杀慢首字节。
    //
    // 删掉 api 层这一层不会失去兜底：下面 946 行把 agent 传进来的 signal
    // （= streamSignal）挂到了 controller 上，watchdog 触发 streamController.abort()
    // 时会经 onExternalAbort 传导到这个 fetch，请求照样被中断。
    // 曾经的 300s+300s 双层就是「建连超时(150s)重试」紧跟「Stream timeout(300s)」
    // 这种报错来源说不清的根源。
    const timeout = stream ? 0 : this.timeout
    let lastError
    // 【为什么需要这个通知】api 层的重试原来完全静默：一次建连超时实际是
    // 60s×3+退避 ≈ 181 秒，期间用户只看到 spinner 转，不知道已经失败重试了两次。
    // 把每次失败往外报一声，用户才知道「不是卡住，是在重试」。
    const notifyRetry = (info) => {
      if (typeof this.onRetry !== 'function') return
      try { this.onRetry(info) } catch {}
    }
    let consecutive529 = 0
    let requestBody = body
    let thinkingFallbackUsed = false
    let reasoningHistoryFallbackUsed = false
    let keyRotations = 0  // 已轮换过多少个 key（上限 = 池大小，防止绕圈重复试）
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      if (signal?.aborted) throw interruptedError()
      let controller = null
      let timer = null
      let externalAbort = false
      let onExternalAbort = null
      try {
        controller = new AbortController()
        onExternalAbort = () => {
          externalAbort = true
          controller.abort()
        }
        if (signal) {
          signal.addEventListener('abort', onExternalAbort, { once: true })
          if (signal.aborted) onExternalAbort()
        }
        // timeout <= 0 表示「不在这一层设超时」（流式：交给 agent watchdog）
        if (timeout > 0) timer = setTimeout(() => controller.abort(), timeout)
        const headers = { 'Content-Type': 'application/json' }
        if (isAnthropic) {
          headers['x-api-key'] = this.apiKey
          headers['anthropic-version'] = '2023-06-01'
        } else {
          headers['Authorization'] = `Bearer ${this.apiKey}`
        }
        // 【流式请求不复用连接 —— 修「一次超时后所有请求都卡、重启才恢复」】
        //
        // 症状：某次流式请求超时后，同进程内后续请求全部卡住，连 body 只有几十字节的
        // /config test 也卡，而同一时刻 curl 秒回；Ctrl+X 重启（换进程）立刻恢复。
        //
        // 根因：流式超时时底层连接往往处于半开状态，客户端 abort / reader.cancel()
        // 都不保证它被立即销毁（实测本地复现：泄漏 3 个卡住的流之后，小请求就再也发不出去）。
        // 这些坏连接留在 Node 内置 fetch 的连接池里被后续请求复用/排队，
        // 于是"什么都卡"。重启之所以有效，只是因为进程销毁把整个池清空了。
        //
        // Node 内置的 undici 无法 import（ERR_UNKNOWN_BUILTIN_MODULE），
        // 所以配不了 dispatcher 的 keepAliveTimeout。可行的等效手段就是这一行：
        // 让流式连接用完即弃、不进池，坏连接自然无法污染下一个请求。
        // 实测对真实网关无副作用（首字节 6.1s vs 默认 8.9s，chunks 正常）。
        //
        // 【2026-09-05 补：非流式也要能弃池】
        // 上一版这里只给流式加，理由是「非流式短平快，保持复用更快」。
        // 但那个理由只在连接池干净时成立 —— 用户报「配置二超时一次之后，
        // 连 /config test 也一直超时，重启才好」，trace 证据：
        //   last_phase=fetch_sent · http_status=null · fetch_ms=null · 卡 299.7s
        // 即请求发出、响应头永不返回，这条半开连接留在池里。
        // 流式带 close 用完即弃、不受影响（所以 agent 的 trace 看着正常），
        // 而 /config test 走非流式复用池 → 正好捡到那条坏连接 → 一起卡。
        //
        // 修法不是无条件给非流式也加（会牺牲正常时的复用性能），
        // 而是【出过连接层故障就进入弃池模式】：由 markConnectionSuspect()
        // 在流超时/建连失败时置位，一段时间内所有请求都不复用，让池自然排空。
        if (stream || this._shouldAvoidConnectionReuse()) headers['Connection'] = 'close'
        // 【分阶段埋点：定位"卡住"到底卡在哪一段】
        // 排查"超时后持续超时、重启才恢复"时反复卡在无法定位：日志只有一条
        // "Stream timeout"，看不出是序列化慢、fetch 发不出去、还是响应头不来。
        // 这三段耗时各自记下来，卡住时看 phase 就知道方向，不用再靠猜。
        const tSerStart = Date.now()
        const payload = JSON.stringify(compressRequestBody(requestBody))
        const serMs = Date.now() - tSerStart
        this._lastPhase = { phase: 'fetch_sent', at: Date.now(), serMs, bytes: payload.length }
        const tFetch = Date.now()
        const response = await this.fetch(url, {
          method: 'POST',
          headers,
          body: payload,
          signal: controller.signal,
        })
        this._lastPhase = {
          phase: 'headers_received', at: Date.now(), serMs,
          bytes: payload.length, fetchMs: Date.now() - tFetch, status: response.status,
        }
        if (!response.ok) {
          // 读错误响应体时可能失败（服务端 403 后立即断连/body 流异常）。
          // 绝不能把异常抛到外层被当成网络错误 → 最终只报 fetch failed 丢失真实状态码。
          let errorBody = ''
          try {
            errorBody = await response.text()
          } catch (bodyErr) {
            errorBody = `[body read failed: ${bodyErr?.message || bodyErr}]`
          }
          const status = response.status
          // 上下文超限无论被包装成哪一种 HTTP 状态，都不要在 API 层重复发送同一份大请求。
          if (isContextOverflowText(errorBody)) {
            const overflow = new Error(`HTTP ${status}: ${errorBody.slice(0, 500)}`)
            overflow.statusCode = status
            overflow.responseBody = errorBody
            overflow.isContextOverflow = true
            throw overflow
          }
          // 网关拒绝增量字段（previous_response_id）：**立刻放弃增量、重发全量**。
          //
          // 必须放在所有其它重试分支之前：这一条跟思考参数/限流无关，
          // 走后面的分支会白等退避、甚至被当成「可重试错误」重试 3 次同一个坏请求
          //（每次都是 400，用户白等几十秒）。
          //
          // 典型报错（ai.furry.vg 实测）：
          //   "responses to chat conversion does not support stateful fields"
          if (status === 400 && requestBody?.previous_response_id
              && /previous_response_id|stateful\s+fields?/i.test(errorBody)) {
            this._incrementalDisabled = true
            const err = new Error(`HTTP ${status}: ${errorBody.slice(0, 300)}`)
            err.statusCode = status
            err.responseBody = errorBody
            err.isIncrementalRejection = true
            throw err
          }
          // 部分中转把不支持的思考参数包装成 400/422，甚至 429 invalid_request。
          // 仅当本次请求确实带了思考字段时，自动去掉这些字段重试一次；真正限流不会触发。
          // reasoning：Responses 协议的思考字段名（body.reasoning = {effort}），
          // 漏了它的话 responses 端点拒绝思考参数时不会触发降级重试。
          const hasThinkingParams = ['reasoning_effort', 'thinking', 'enable_thinking', 'reasoning'].some(key => Object.prototype.hasOwnProperty.call(requestBody, key))
          const parameterError = status === 400 || status === 422
            || (status === 429 && /invalid[_\s-]?request|参数|model config|unsupported|reasoning|thinking/i.test(errorBody))
          if (!thinkingFallbackUsed && hasThinkingParams && parameterError) {
            requestBody = { ...requestBody }
            delete requestBody.reasoning_effort
            delete requestBody.thinking
            delete requestBody.enable_thinking
            delete requestBody.reasoning
            thinkingFallbackUsed = true
            this._thinkingFallbackKeys.add(this._thinkingCompatKey())
            attempt-- // 兼容降级不消耗正常网络重试次数
            continue
          }
          // 上游不接受历史消息里的 reasoning / reasoning_content 字段（400/422）→
          // 就地剥掉所有 message 上的这两个字段重发一次，并永久停发。
          //
          // 跟上面那段的分工：上面管 body 顶层的思考**参数**（reasoning_effort 等），
          // 这一段管 messages[].reasoning* 思考**内容**。两件事，都会独立触发。
          //
          // 为什么默认发、被拒才降级：字段对上游是「认就用、不认就扔」，发错了无害；
          // 但不能因为某个上游拒绝就永久不发 —— 那会让思考永远进不了上下文。
          const hasMsgReasoning = Array.isArray(requestBody?.messages)
            && requestBody.messages.some(m => m && (m.reasoning || m.reasoning_content))
          if (!reasoningHistoryFallbackUsed && hasMsgReasoning && parameterError) {
            requestBody = {
              ...requestBody,
              messages: requestBody.messages.map(m => {
                if (!m || (!m.reasoning && !m.reasoning_content)) return m
                const { reasoning, reasoning_content, ...rest } = m
                return rest
              }),
            }
            reasoningHistoryFallbackUsed = true
            this._reasoningHistoryDisabled = true
            attempt-- // 兼容降级不消耗正常网络重试次数
            continue
          }
          // 模型能力不支持（最常见：非 vision 模型收到图片 → MODEL_CAPABILITY_NOT_SUPPORTED: vision）。
          // 标记降级 + 抛带 isVisionCapabilityError 的错误；Agent 会剥离历史图片后自动重试，
          // 用户无需再靠 /compact 清掉污染历史。
          if (isVisionCapabilityError(errorBody, status)) {
            this._visionDisabled = true
            const err = new Error(`HTTP ${status}: ${errorBody.slice(0, 300)}`)
            err.statusCode = status
            err.responseBody = errorBody
            err.isVisionCapabilityError = true
            throw err
          }
          // 【image_url 形态不对 → 切形态交给调用方重建重发】
          //
          // 官方规范是字符串，但中转上游的 Go 服务常按 chat 结构期望对象。
          // 两种都真实存在，所以「发错形态」不该让用户看到 400。
          //
          // ⚠ 这里**不能就地重建 body**：形态在 buildResponsesBody 里固化，
          //   而 request() 只拿到已构建好的 body，拿不到原始 messages。
          //   所以只切状态 + 抛标记错误，由 createMessage/createMessageStream
          //   捕获后重新 buildRequestBody 再调一次（它们手上有 messages）。
          //
          // 只切一次：string → object。再失败就说明不是形态问题，照常抛出。
          if (status === 400 && this._imageUrlStyle === 'string' && this._isImageUrlStyleError({ responseBody: errorBody })) {
            this._imageUrlStyle = 'object'
            const err = new Error(`HTTP ${status}: ${errorBody.slice(0, 300)}`)
            err.statusCode = status
            err.responseBody = errorBody
            err.isImageUrlStyleRetry = true
            throw err
          }
          // key 池轮换：余额耗尽 / key 失效 / 账号被禁 → 换下一个 key 重试。
          // 只在池里真有备用 key 时才做，单 key 时行为与原来完全一致。
          if (this.keyPool.isPool && isKeyExhaustedError(status, errorBody)) {
            const failedKey = maskKey(this.apiKey)
            const next = this.keyPool.markExhaustedAndRotate(`HTTP ${status}: ${errorBody.slice(0, 80)}`)
            if (next) {
              lastError = new Error(`HTTP ${status}: ${errorBody.slice(0, 200)}`)
              // 换 key 不消耗网络重试配额，但要有独立上限：
              // 最多轮换 keyPool.size 次，避免 attempt-- 把 attempt 变负导致循环超跑。
              keyRotations++
              if (keyRotations < this.keyPool.size) {
                attempt = -1  // 下一轮 attempt++ 后回到 0，重试配额重新开始
                continue
              }
            }
            // 所有 key 都试过了 → 直接报错，把原始状态码和 body 带出去
            const err = new Error(
              `所有 ${this.keyPool.size} 个 API key 均不可用（最后失败: ${failedKey}）\n`
              + `HTTP ${status}: ${errorBody.slice(0, 300)}`
            )
            err.statusCode = status
            err.responseBody = errorBody
            err.allKeysExhausted = true
            throw err
          }
          if (status === 429) {
            lastError = new Error(`HTTP 429: ${errorBody.slice(0, 200)}`)
            // 池模式：429 是「这个账号当下被限流」，换下一个 key 立刻能活。
            // 轮换在退避重试之前先试——限流按账号维度算，换号比重试等脖子快得多。
            // 冷却用短时长（5分钟，由 markRateLimitedAndRotate 内部定），
            // 不进 24h 长冷宫：限流几分钟就缓过来，和余额耗尽性质不同。
            if (this.keyPool.isPool) {
              const next = this.keyPool.markRateLimitedAndRotate(errorBody.slice(0, 80))
              if (next) {
                keyRotations++
                if (keyRotations < this.keyPool.size) {
                  attempt = -1
                  continue
                }
              }
            }
            if (attempt < this.maxRetries - 1) {
              const delay = this._backoff(attempt)
              await delayWithSignal(delay, signal)
              continue
            }
            // 【标记「本层已重试穷尽」—— 2026-09-26】
            //
            // 不加这个标记的话，agent 层看到 "HTTP 429" 会**再**判 retry:true，
            // 于是总请求数 = api层(3次×key池) × agent层(4轮)，用户看到的是
            // 「同一个 429 报两次」（其实底层打了十几次）。
            // 这正是 CLAUDE.md 记过的「重试三层嵌套放大失败」——
            // 当时修了 connect_timeout，429 这条漏了。
            lastError.retriesExhausted = true
            lastError.statusCode = status
            throw lastError
          }
          if (status === 529) {
            consecutive529++
            lastError = new Error(`HTTP 529: ${errorBody.slice(0, 200)}`)
            if (consecutive529 >= 3) throw new Error(`HTTP 529: 服务连续过载，请稍后重试`)
            if (attempt < this.maxRetries - 1) {
              const delay = this._backoff(attempt)
              await delayWithSignal(delay, signal)
              continue
            }
            throw lastError
          }
          if (status >= 500 && status < 600) {
            lastError = new Error(`HTTP ${status}: ${errorBody.slice(0, 200)}`)
            if (attempt < this.maxRetries - 1) {
              const delay = this._backoff(attempt)
              await delayWithSignal(delay, signal)
              continue
            }
            throw lastError
          }
          throw new Error(`HTTP ${status}: ${errorBody.slice(0, 500)}`)
        }
        this.keyPool.markSuccess()
        return response
      } catch (e) {
        if (externalAbort || signal?.aborted) throw interruptedError()
        if (e.name === 'AbortError') {
          // 流式下 timeout=0（本层不计时），watchdog 的 abort 已在上一行被
          // signal?.aborted 拦成 interruptedError，所以这里只会是网络级 abort。
          // 消息不能写成 "after 0ms"，那会让人以为超时阈值配错了。
          lastError = new Error(timeout > 0
            ? `Request timeout after ${timeout}ms`
            : 'Request aborted by transport (no api-level timeout for stream)')
          if (attempt < this.maxRetries - 1) {
            const delay = this._backoff(attempt)
            notifyRetry({
              kind: 'timeout', attempt: attempt + 1, maxRetries: this.maxRetries,
              timeoutMs: timeout, delayMs: delay, stream,
            })
            await delayWithSignal(delay, signal)
            continue
          }
          throw lastError
        }
        if (e.message?.startsWith('HTTP ')) throw e
        // 所有 key 都耗尽属于终态：消息不以 "HTTP " 开头，若不在这里放行会被当成
        // 普通网络错误继续重试，导致用回退 key 多发几次无效请求。
        if (e.allKeysExhausted || e.isContextOverflow || e.isVisionCapabilityError) throw e
        // 【连接层错误 → 弃用连接池一段时间】
        // socket 挂断 / 建连失败 / fetch 层异常都可能在池里留下坏连接，
        // 后续复用它的请求（尤其非流式的 /config test）会跟着卡。
        // 只认真正的连接类错误，业务错误（4xx/5xx）不算 —— 那些上面已 throw。
        if (/socket|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|network|fetch failed|terminated/i.test(String(e.message || ''))) {
          this.markConnectionSuspect(`net:${String(e.message).slice(0, 40)}`)
        }
        lastError = e
        if (attempt < this.maxRetries - 1) {
          const delay = this._backoff(attempt)
          await delayWithSignal(delay, signal)
          continue
        }
      } finally {
        if (timer) clearTimeout(timer)
        if (signal && onExternalAbort) signal.removeEventListener('abort', onExternalAbort)
      }
    }
    throw lastError
  }

  // 指数退避：base * 2^attempt + 25% jitter，上限 32s
  _backoff(attempt) {
    const base = 500
    const max = 32000
    const exp = base * Math.pow(2, attempt)
    const jitter = exp * 0.25 * (Math.random() * 2 - 1)  // ±25%
    return Math.min(max, Math.round(exp + jitter))
  }

  async *parseStreamResponse(response) {
    if (this.protocol === 'anthropic') {
      yield* this.parseAnthropicStream(response)
      return
    }
    if (this.protocol === 'responses') {
      yield* this.parseResponsesStream(response)
      return
    }
    yield* this.parseOpenAIStream(response)
  }

  *parseOpenAISSELine(line) {
    const trimmed = String(line || '').trim()
    if (!trimmed || !trimmed.startsWith('data:')) return
    const data = trimmed.slice(5).trim()
    if (data === '[DONE]') return
    try {
      const chunk = JSON.parse(data)
      yield* this.parseOpenAIChunk(chunk)
    } catch (e) {
      yield { type: 'parse_error', protocol: 'openai', error: e.message || 'invalid SSE JSON', data: data.slice(0, 200) }
    }
  }

  async *parseOpenAIStream(response) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) yield* this.parseOpenAISSELine(line)
      }
      // SSE 服务端有时在最后一帧后直接 EOF；不能丢掉未遇到换行的 buffer。
      buffer += decoder.decode()
      if (buffer.trim()) yield* this.parseOpenAISSELine(buffer)
    } finally {
      try { await reader.cancel() } catch {}
      try { reader.releaseLock() } catch {}
    }
  }

  *parseOpenAIChunk(chunk) {
    if (chunk.usage) yield { type: 'usage', usage: chunk.usage }
    const choice = chunk.choices?.[0]; if (!choice) return
    const delta = choice.delta || {}
    const reasoningText = delta.reasoning_content || delta.reasoning || null
    if (reasoningText) yield { type: 'reasoning', text: reasoningText }
    if (delta.content) yield { type: 'text', text: delta.content }
    if (delta.tool_calls) for (const tc of delta.tool_calls) yield { type: 'tool_call_delta', index: tc.index, id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments }
    if (choice.finish_reason) yield { type: 'done', reason: choice.finish_reason, usage: chunk.usage || null }
  }

  *parseAnthropicSSELine(line, state) {
    const trimmed = String(line || '').trim()
    if (trimmed === '') {
      state.currentEvent = ''
      return
    }
    if (trimmed.startsWith('event:')) {
      state.currentEvent = trimmed.slice(6).trim()
      return
    }
    if (!trimmed.startsWith('data:')) return
    const data = trimmed.slice(5).trim()
    try {
      const j = JSON.parse(data)
      yield* this.parseAnthropicEvent(state.currentEvent, j)
    } catch (e) {
      yield { type: 'parse_error', protocol: 'anthropic', error: e.message || 'invalid SSE JSON', data: data.slice(0, 200) }
    }
  }

  async *parseAnthropicStream(response) {
    // Anthropic 流式：每行 "event: xxx\ndata: {...}"
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const state = { currentEvent: '' }
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) yield* this.parseAnthropicSSELine(line, state)
      }
      // 同样处理没有换行的最后 data 行。
      buffer += decoder.decode()
      if (buffer.trim()) yield* this.parseAnthropicSSELine(buffer, state)
    } finally {
      try { await reader.cancel() } catch {}
      try { reader.releaseLock() } catch {}
    }
  }

  *parseAnthropicEvent(event, j) {
    switch (event) {
      case 'message_start':
        if (j.message?.usage) yield { type: 'usage', usage: j.message.usage }
        break
      case 'content_block_start':
        // 官方教训：start 事件只落结构、不取内容。
        // SDK 有时在 start 和 delta 里重复发同一段 text，
        // 把 start 的 text 当内容收会导致重复。这里只做 tool_use 结构。
        if (j.content_block?.type === 'tool_use') {
          yield { type: 'tool_call_start', id: j.content_block.id, name: j.content_block.name, index: j.index }
        } else if (j.content_block?.type === 'thinking') {
          // 开一个 thinking 槽：后续 thinking_delta / signature_delta 都往这里攒。
          // 必须记 index —— 一条消息里正文、思考、工具块是并列的，靠 index 区分。
          yield { type: 'thinking_block_start', index: j.index }
        }
        break
      case 'content_block_delta': {
        const d = j.delta
        if (d?.type === 'text_delta') yield { type: 'text', text: d.text }
        else if (d?.type === 'thinking_delta') {
          yield { type: 'reasoning', text: d.thinking }
          // 同一份内容再报一次「归属哪个块」，供上层攒原始块回传历史
          yield { type: 'thinking_block_delta', index: j.index, text: d.thinking }
        }
        else if (d?.type === 'signature_delta') {
          // signature 是 thinking 块的完整性凭据，回传时缺了它 Anthropic 会 400
          yield { type: 'thinking_block_signature', index: j.index, signature: d.signature }
        }
        else if (d?.type === 'input_json_delta') yield { type: 'tool_call_delta', index: j.index, arguments: d.partial_json }
        break
      }
      case 'content_block_stop':
        yield { type: 'block_stop', index: j.index }
        break
      case 'message_delta':
        // stop_reason 要过映射：非流式路径在 normalizeAnthropicResponse 里映射了，
        // 流式这里原来直接透传 —— 两条路径的 finish_reason 必须一致，
        // 否则 agent 的「截断检测」（=== 'length'）只在非流式下有效。
        if (j.delta?.stop_reason) yield { type: 'done', reason: mapAnthropicStopReason(j.delta.stop_reason), usage: j.usage || null }
        break
      case 'message_stop':
        break
    }
  }

  async testConnection(timeout = 5000) {
    let timer = null
    try {
      const controller = new AbortController()
      timer = setTimeout(() => controller.abort(), timeout)
      const isAnthropic = this.protocol === 'anthropic'
      const isResponses = this.protocol === 'responses'
      // 端点分派必须跟 request() 完全一致，否则 /config test 会打到错的路径上
      //（responses 漏掉时曾经打到 /chat/completions → 404，用户以为配置坏了）
      const url = isAnthropic
        ? `${this.baseUrl}/v1/messages`
        : isResponses
          ? `${this.baseUrl}/responses`
          : `${this.baseUrl}/chat/completions`
      const headers = { 'Content-Type': 'application/json' }
      if (isAnthropic) {
        headers['x-api-key'] = this.apiKey
        headers['anthropic-version'] = '2023-06-01'
      } else {
        headers['Authorization'] = `Bearer ${this.apiKey}`
      }
      // 复用真实请求构造，确保 /config test 能发现 thinking/reasoning 参数兼容错误。
      const body = this.buildRequestBody({
        system: '',
        messages: [{ role: 'user', content: 'Say OK' }],
        tools: [],
        maxTokens: 5,
        temperature: this.temperature,
        stream: false,
      })
      const response = await this.fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        return { ok: false, error: `HTTP ${response.status}: ${text.slice(0, 120)}` }
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e.name === 'AbortError' ? `连接超时 (${timeout}ms)` : (e.message || String(e)) }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 测试**指定 Provider**的连通性（不切换当前配置）：/config [ID] test 用。
   *
   * 用一次性 ApiClient 探测，而不是临时改 this 上的字段 —— 后者一旦有请求在途
   *（心跳、后台任务、QQ 桥）会把真实请求打到错误的端点/key 上。
   * fetch / 思考配置 / 温度继承当前实例：探测复用真实请求构造（同 testConnection
   * 的注释，能发现 thinking/reasoning 参数兼容错误），测试里注入的 fetch stub 也能生效。
   */
  async testProviderConnection(provider, timeout = 10000) {
    try {
      const keyList = Array.isArray(provider.apiKeys) && provider.apiKeys.length
        ? provider.apiKeys
        : (provider.apiKey ? [provider.apiKey] : [])
      const probe = new ApiClient({
        baseUrl: provider.url,
        apiKey: provider.apiKey || keyList[0] || '',
        apiKeys: keyList.length ? keyList : null,
        model: provider.model,
        protocol: provider.protocol || 'openai',
        fetch: this.fetch,
        thinkingConfig: this.thinkingConfig,
        temperature: this.temperature,
        maxOutputTokens: provider.maxOutputTokens ?? null,
        systemTopLevel: !!provider.systemTopLevel,
        noTools: !!provider.noTools,
      })
      return await probe.testConnection(timeout)
    } catch (e) {
      return { ok: false, error: e?.message || String(e) }
    }
  }
}
