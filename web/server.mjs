#!/usr/bin/env node
// web/server.mjs — 轻量 HTTP + SSE 后端服务于 React 前端
// 【2026-09-24】标记这是 Web 服务进程 —— 供 core/qq-config.mjs 的 detectEndpoint()
// 区分「CLI / Web / CCM」三个端。不能靠 cwd 或文件名判断：
// CLI 和 Web 的代码在同一目录下，只有进程级的标记才准。
// CCM 那边由 ccm-start.mjs 设 CCM_MODE，优先级更高（见 detectEndpoint）。
process.env.CCM_WEB = '1'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, realpathSync, mkdirSync, unlinkSync, appendFileSync } from 'node:fs'
import { getImageGenConfig, setImageGenConfig } from '../core/tools/tools-imagegen.mjs'
import { join, extname, resolve, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { Agent } from '../core/agent/agent.mjs'
import { ApiClient } from '../core/api/api.mjs'
import { createEngineToolkit } from '../core/infra/engine-setup.mjs'
import { setPhoneModePrompter, setPhoneFinishAction } from '../core/tools/tools-phone.mjs'
// 【2026-10-10】device.json 读写（设置页「手机操作」区块用）——
// 顶层静态 import：/api/config 处理器不在 getWebCtxDeps 的作用域里，
// 用不了那里的动态 deviceMod。
import { loadDeviceConfig, saveDeviceConfig } from '../core/phone/device.mjs'
import { startKeepalive, stopKeepalive, keepaliveStatus } from '../core/infra/web-keepalive.mjs'
import { SessionStore, ClaudeMdLoader } from '../core/session/persistence.mjs'
import { MCPClient } from '../core/integrations/mcp-client.mjs'
import { CompactService } from '../core/session/compact.mjs'
import { CustomCommandLoader } from '../core/commands/custom-commands.mjs'
import { SkillLoader, expandActiveSkill, globalSkillsDir } from '../core/commands/skills.mjs'
// 【2026-10-03】backup 模块已删除（自动备份功能下线）
import { backupBeforeCompact } from '../core/session/compact-trash.mjs'
import { listTrash, restoreTrash, clearTrash } from '../core/session/trash.mjs'
import { MultiUndoStore } from '../core/session/undo-multi.mjs'
import { PresentTool } from '../core/tools/present-tool.mjs'
import { HookManager } from '../core/infra/hooks.mjs'
// 轮数上限从单一真值源取，避免 Web 侧硬编码数字漂移
import { NORMAL_MAX_TURNS } from '../core/agent/plan.mjs'
import { normalizeProviderUrl, providerEndpointPreview } from '../core/api/provider-url.mjs'
import { handleGoalCommand } from '../core/commands/cmd-goal.mjs'
import { atomicWrite } from '../core/infra/atomic.mjs'
import { InputHistory } from '../core/agent/agent-tools.mjs'
import { extractAtRefs, buildAtContext } from '../core/infra/at-refs.mjs'
import { setVisionConfig } from '../core/phone/ocr.mjs'
import { WEB_SYSTEM_PROMPT, WEB_SESSION_START_PROMPT } from './prompts.mjs'
import { buildCommandTable } from '../core/commands/cmd-registry.mjs'
// 【2026-10-05】命令列表改从 catalog 取（与 CLI 同一份真值源）——
// 原来用本文件硬编码的 48 条静态列表，与 CLI 的 94 条严重脱节。
import { listCommandEntries } from '../core/commands/command-catalog.mjs'
import { buildWebCtx, runWebCommand, WizardRequired, SelectRequired } from './command-adapter.mjs'
import { ProjectStore } from './projects.mjs'
import { getTavilyKey } from '../core/tools/tavily.mjs'
// 【2026-10-03】卡死检测（freeze-detector）已按用户要求整体删除。
import { DATA_DIR, resolveConfigPath, WEB_CONFIG_PATH, HOOKS_PATH, MCP_PATH } from '../core/infra/paths.mjs'
import { startWebQqBridge, loadQqConfig, saveQqConfig } from './qq-integration.mjs'
import { listEndpoints as listQqEndpoints, detectEndpoint, endpointLabelOf } from '../core/integrations/qq-config.mjs'
import { QQPushTool, QQRecallTool } from '../core/integrations/qq-tools.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// 目标契约快照。放在这里而不是 sessionPayload 里直接 import，
// 是为了让命令模块（ESM 动态导入）和 payload 生成共用一条路径。
let _goalSnapshotFn = null
async function _loadGoalSnapshot() {
  if (!_goalSnapshotFn) {
    const m = await import('../core/agent/goal.mjs')
    _goalSnapshotFn = m.snapshot
  }
  return _goalSnapshotFn
}
/** 同步版：只在已加载过时返回数据（sessionPayload 是同步函数，不能 await） */
function goalSnapshotFor(sessionId) {
  try {
    if (!_goalSnapshotFn) {
      // 首次调用：后台预热，本次返回 null；下一次请求就能拿到
      _loadGoalSnapshot().catch(() => {})
      return null
    }
    const s = _goalSnapshotFn(sessionId)
    if (!s) return null
    return { objective: s.objective, status: s.status, turnsUsed: s.turnsUsed, turnBudget: s.budget?.turns || null, completion: s.completion || null, boundaries: s.boundaries || [] }
  } catch { return null }
}
// 【2026-10-03】配置属用户数据，统一放 ~/.claude-code-mobile/
const CLI_CONFIG_PATH = resolveConfigPath('config.json')
const SESSION_ROOT = join(DATA_DIR, 'web-sessions')
const WEB_SETTINGS_PATH = join(DATA_DIR, 'web-settings.json')
const WEB_HISTORY_PATH = join(DATA_DIR, 'web-input-history.json')
const WEB_CONTEXT_PATH = join(ROOT, 'web', 'CLAUDE.md')
const WEB_MEMORY_PATH = join(DATA_DIR, 'web-memory.md')
const WEB_PROFILE_PATH = join(DATA_DIR, 'web-profile.json')
// 【2026-09-19】QQ 桥配置是**与 CLI 共享的同一份文件**（CLI 侧 index.mjs:1803 定义）。
// 原来 Web 把 qq 状态存进 web-config.json 的 qq 字段，而真实的 QQ 桥只读
// ~/.claude-code-mobile/qq-config.json —— 两套文件互不相通，于是 Web 里 /qq on
// 界面上说「已启用」，桥那边根本没收到，开关是假的。
const QQ_CONFIG_PATH = join(DATA_DIR, 'qq-config.json')
const DIST = join(ROOT, 'web', 'dist')
const WEB_UPLOAD_ROOT = join(DATA_DIR, 'web-uploads')
// 默认只允许本机访问；仅在明确以 WEB_HOST=0.0.0.0 启动时对局域网开放。
const HOST = process.env.WEB_HOST || '127.0.0.1'
const PORT = 3456
const store = new SessionStore(SESSION_ROOT)
// 项目（Projects）：知识容器 + 项目指令。数据与 sessions 同级，
// 便于一起备份；文件落 project-files/<projectId>/ 下。见 web/projects.mjs。
const projectStore = new ProjectStore(DATA_DIR)
// Web 自己的输入历史：HTTP 层捕获 slash / 普通消息，UserInputHistory 工具读同一份。
const webInputHistory = new InputHistory(100, WEB_HISTORY_PATH, SESSION_ROOT)
const runtimes = new Map()
/**
 * QQ 桥实例（server.listen 里异步启动，所以先声明成 let）。
 *
 * 【为什么是模块级】buildAgent 每次新建 toolkit 时要把 QQPush/QQRecall
 * 塞进 extraTools —— 那发生在任意时刻，桥可能已经起来了也可能还没有。
 * 用一个共享引用，工具内部每次调用时现取（`() => qqBridgeRef`），
 * 这样桥后启动也能被已经建好的 agent 用上。
 */
let qqBridgeRef = null
// Hooks：与 CLI 共用项目根的 hooks.json。
// Web 触发 SessionStart / SessionEnd / UserPromptSubmit / PreCompact / PostCompact / Stop，
// PreToolUse / PostToolUse 由 agent.hookManager 在工具层触发（见 buildAgent）。
const hookManager = new HookManager(HOOKS_PATH)
hookManager.trigger('SessionStart', { event: 'SessionStart', matcher: 'web' }).catch(() => { })
const uploads = new Map()
const UPLOAD_META_PATH = join(DATA_DIR, 'web-uploads.json')
function loadUploadMeta() { try { return JSON.parse(readFileSync(UPLOAD_META_PATH, 'utf8')) } catch { return {} } }
function saveUploadMeta(meta) { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(UPLOAD_META_PATH, JSON.stringify(meta, null, 2), 'utf8') }
const uploadMeta = loadUploadMeta()
const MCP_CONFIG_PATH = MCP_PATH
const mcpClient = new MCPClient()
let sharedMcpTools = []
const mcpReady = mcpClient.loadConfig(MCP_CONFIG_PATH)
  .then(() => { sharedMcpTools = mcpClient.createToolAdapters() })
  .catch(error => console.error('[web] MCP load failed:', error?.message || error))
// 命令列表 —— 【2026-10-05 改为从 catalog 动态取】
//
// 【为什么改】
// 用户指出「web 端其实有点落后了」。排查发现这里是**硬编码的 48 条静态列表**，
// 而 CLI 侧命令早已 94 个（且注册表是动态的）—— 结果 25 个命令
// （/plugin /mem /new /resume /style /update /device …）在 Web 上
// 「敲了能跑、但补全面板里不显示」，用户根本不知道它们存在。
//
// 同时这里曾经手写的描述（如「查看 Web 命令帮助」）与 CLI 侧
// commandDescriptions 各说各话，同一条命令两端描述不一致。
//
// 现在改为复用 core/commands/command-catalog.mjs 的单一真值源：
//   · 描述自动与 CLI 一致（同一份 COMMAND_DESCRIPTIONS）
//   · 加新命令只需改 catalog 一处，Web 自动跟上
//
// 【保留的 Web 特有项】
// WEB_ONLY_COMMANDS 是「CLI 没有、只有 Web 有」的命令（当前只有 /restart：
// Web 的重载说明）。它们不进 catalog（catalog 是两端共用的内置命令表）。
const WEB_ONLY_COMMANDS = [
  ['restart', '说明如何重载 Web 服务（Web 不重启 CLI）'],
]
const WORKSPACE_ROOTS = [...new Set([homedir(), '/sdcard'].flatMap(path => {
  const resolved = resolve(path)
  try { return [resolved, realpathSync(resolved)] } catch { return [resolved] }
}))]

function isAllowedWorkspace(path) {
  const target = resolve(String(path || ''))
  return WORKSPACE_ROOTS.some(root => target === root || !relative(root, target).startsWith('..'))
}
function normalizeWorkspace(path) {
  const target = resolve(String(path || ROOT))
  if (!isAllowedWorkspace(target)) throw Object.assign(new Error('工作目录必须位于 Termux 主目录或 SD 卡内'), { status: 400 })
  if (!existsSync(target) || !statSync(target).isDirectory()) throw Object.assign(new Error('工作目录不存在或不是文件夹'), { status: 400 })
  const realPath = realpathSync(target)
  if (!isAllowedWorkspace(realPath)) throw Object.assign(new Error('工作目录不能通过符号链接离开允许范围'), { status: 400 })
  return realPath
}
function loadWebSettings() {
  try {
    const config = loadWebConfig()
    const configured = config.web?.workspacePath
    if (configured) return { workspacePath: normalizeWorkspace(configured) }
  } catch {}
  try {
    const value = JSON.parse(readFileSync(WEB_SETTINGS_PATH, 'utf8'))
    return { workspacePath: normalizeWorkspace(value.workspacePath || ROOT) }
  } catch {
    return { workspacePath: ROOT }
  }
}
function saveWebSettings(workspacePath) {
  const value = { workspacePath: normalizeWorkspace(workspacePath) }
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(WEB_SETTINGS_PATH, JSON.stringify(value, null, 2), 'utf8')
  const config = loadWebConfig()
  config.web = { ...(config.web || {}), workspacePath: value.workspacePath }
  saveWebConfig(config)
  return value
}
function listDirectories(path) {
  const currentPath = normalizeWorkspace(path)
  const entries = readdirSync(currentPath, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .slice(0, 200)
    .map(entry => ({ name: entry.name, path: join(currentPath, entry.name) }))
  const candidateParent = resolve(currentPath, '..')
  const parentPath = candidateParent !== currentPath && isAllowedWorkspace(candidateParent) ? candidateParent : null
  return { path: currentPath, parentPath, entries }
}

function loadWebConfig() {
  // Web 与 CLI 共用一份 providers（config.json），current 与 Web 设置分开存（web-config.json）。
  let web
  try {
    web = JSON.parse(readFileSync(WEB_CONFIG_PATH, 'utf8'))
  } catch {
    web = {}
  }
  // CLI config.json 是 providers 的唯一来源
  let cli
  try {
    cli = JSON.parse(readFileSync(CLI_CONFIG_PATH, 'utf8'))
  } catch (e) {
    throw new Error(`config.json 读取失败: ${e.message}`)
  }
  if (!cli?.providers || typeof cli.providers !== 'object') throw new Error('config.json 缺少 providers')
  // 合并：providers 来自 CLI，current/设置来自 web（缺省回退 CLI）
  const config = { ...cli, ...web }
  config.providers = cli.providers
  if (!config.current || !config.providers[config.current]) config.current = Object.keys(config.providers)[0]
  return config
}
function saveWebConfig(config) {
  if (!config?.providers || typeof config.providers !== 'object') throw new Error('config.json 缺少 providers')
  // providers 写回 CLI config.json（共用一份）
  const cli = JSON.parse(readFileSync(CLI_CONFIG_PATH, 'utf8'))
  cli.providers = config.providers
  atomicWrite(CLI_CONFIG_PATH, JSON.stringify(cli, null, 2), 'utf8')
  // current 与 Web 设置写回 web-config.json（不含 providers）
  const { providers, ...webOnly } = config
  atomicWrite(WEB_CONFIG_PATH, JSON.stringify(webOnly, null, 2), 'utf8')
  return config
}

// ---- 用户 profile（称呼 / 职业 / 回复偏好 / 主题 / 字体）----
// 这些字段原来只写进浏览器 localStorage，服务端完全看不到，等于填了不生效。
// 现在落到 web-profile.json，并在组装 systemPrompt 时注入，让模型真正读到。
const PROFILE_FIELDS = ['full_name', 'display_name', 'work_function', 'personal_preferences', 'theme', 'chat_font']
function loadWebProfile() {
  try {
    const raw = JSON.parse(readFileSync(WEB_PROFILE_PATH, 'utf8'))
    if (!raw || typeof raw !== 'object') return {}
    const out = {}
    for (const k of PROFILE_FIELDS) if (typeof raw[k] === 'string') out[k] = raw[k]
    return out
  } catch { return {} }
}
function saveWebProfile(patch) {
  const current = loadWebProfile()
  for (const k of PROFILE_FIELDS) {
    if (patch?.[k] == null) continue
    current[k] = String(patch[k]).slice(0, 2000)
  }
  try { mkdirSync(DATA_DIR, { recursive: true }) } catch { }
  atomicWrite(WEB_PROFILE_PATH, JSON.stringify(current, null, 2), 'utf8')
  return current
}
/** 把 profile 渲染成注入 systemPrompt 的一段；没有任何有效字段时返回空串。 */
function buildProfilePrompt(profile) {
  const name = (profile.display_name || profile.full_name || '').trim()
  const job = (profile.work_function || '').trim()
  const prefs = (profile.personal_preferences || '').trim()
  // 【2026-10-08 合并】原「输出风格」（/style + config.outputStyle）已并入
  // 回复偏好 —— 两者都回答「希望 AI 怎么回复我」，同时注入会让模型收到两份
  // 可能矛盾的指令（2026-09-20 就发现过这个冲突，当时的处理是废掉回复偏好注入、
  // 保留 /style；现在统一到回复偏好这条：自由文本更通用，CLI/APK 也都是它）。
  // 所以这里恢复 prefs 的注入，outputStyleSection 注入已删（见下方 sessionPrompt）。
  if (!name && !job && !prefs) return ''
  const lines = ['\n# 用户资料（来自 Web 设置页，用户主动填写）']
  if (name) lines.push(`- 称呼用户为：${name}`)
  if (job) lines.push(`- 用户职业：${job}（可据此调整术语深度与举例领域）`)
  if (prefs) lines.push(`- 用户的回复偏好（必须遵守）：${prefs}`)
  return lines.join('\n') + '\n'
}
// 只做「精确解析」：解析不出来返回 null，绝不静默落到 config.current。
// 早期实现在找不到时回退 config.current，导致 `/model 任意名` 被当成切 Provider → 跳回配置 1。
function matchProviderId(config, requested) {
  const value = String(requested || '').trim()
  if (!value) return null
  if (config.providers[value]) return value
  const base = value.replace(/-thinking$/, '')
  const exact = Object.entries(config.providers).find(([id, provider]) => (
    id === value || provider?.name === value || provider?.model === value
  ))
  if (exact) return exact[0]
  const baseMatch = Object.entries(config.providers).find(([id, provider]) => (
    id === base || provider?.name === base || provider?.model === base
  ))
  return baseMatch?.[0] || null
}
// 兼容旧调用：需要一个可用 Provider 时才回退默认值。
function resolveProviderId(config, requested, fallback = config.current) {
  return matchProviderId(config, requested) || fallback
}
// 在当前会话 Provider 的模型清单里找模型（供 /model 与下拉框使用）。
function findProviderModel(provider, requested) {
  const value = String(requested || '').trim()
  if (!value) return null
  const base = value.replace(/-thinking$/, '')
  const list = Array.isArray(provider?.models) ? provider.models : []
  const hit = list.find(model => model?.id === value || model?.name === value || model?.thinkingId === value)
    || list.find(model => model?.id === base || model?.name === base)
  if (hit) return hit.id === base && value !== base ? value : (hit.thinkingId === value ? value : hit.id)
  if (provider?.model === value || provider?.model === base) return value
  return null
}
function providerForRuntime(runtime) {
  const config = loadWebConfig()
  const providerId = resolveProviderId(config, runtime.providerId)
  if (runtime.providerId !== providerId) runtime.providerId = providerId
  return { config, providerId, provider: config.providers[providerId] }
}
// 会话可以覆盖 Provider 默认模型；未覆盖时用 Provider 自身 model。
// 扩展思考：用会话开关 + thinking 参数控制，不拼 -thinking 模型名。
function thinkingConfigForRuntime(runtime, config) {
  // provider.thinking 优先（每配置独立），fallback 全局 config.thinking
  const provider = config.providers?.[runtime.providerId] || config.providers?.[config.current]
  const pThinking = provider?.thinking && typeof provider.thinking === 'object' ? provider.thinking : null
  const base = pThinking || config.thinking || {}
  const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(runtime.thinkingEffort) ? runtime.thinkingEffort : (base.effort || 'xhigh')
  if (runtime.thinking === true) return { ...base, enabled: true, effort }
  if (runtime.thinking === false) return { ...base, enabled: false, effort }
  return { ...base, effort }
}
function modelForRuntime(runtime, provider) {
  const resolved = provider || providerForRuntime(runtime).provider
  return runtime.model || resolved?.model || ''
}
function sanitizeHistoryForStorage(history = []) {
  const replace = value => {
    if (Array.isArray(value)) return value.map(replace)
    if (!value || typeof value !== 'object') return value
    if (value.type === 'image_url' && value.image_url?.url?.startsWith('data:')) {
      return { type: 'text', text: '[图片已上传，刷新后不重复注入图片数据]' }
    }
    const output = {}
    for (const [key, child] of Object.entries(value)) output[key] = replace(child)
    return output
  }
  return replace(history)
}

// 兼容修复前写入磁盘的 base64 图片会话：服务启动时一次性瘦身，避免刷新/侧栏读历史直接卡住。
function normalizeStoredModel(model) {
  const value = String(model || '')
  return value.endsWith('-thinking') ? value.slice(0, -9) : (value || null)
}

function migrateStoredImageSessions() {
  for (const id of store.list()) {
    const session = store.load(id)
    if (!session?.messages) continue
    const clean = sanitizeHistoryForStorage(session.messages)
    if (JSON.stringify(clean).length >= JSON.stringify(session.messages).length) continue
    session.messages = clean
    try { store.save(id, session) } catch (error) { console.error('[web] 图片会话迁移失败:', id, error?.message || error) }
  }
}
migrateStoredImageSessions()

function saveRuntime(runtime) {
  // 真实 prompt_tokens 也一起存：会话从磁盘恢复后无需先发一轮请求就能显示准确上下文
  const livePromptTokens = runtime.agent?.getLastPromptTokens?.() || 0
  if (livePromptTokens > 0) runtime.lastPromptTokens = livePromptTokens
  store.save(runtime.id, {
    sessionId: runtime.id,
    title: runtime.title,
    providerId: runtime.providerId,
    model: runtime.model || null,
    thinking: runtime.thinking === undefined ? null : !!runtime.thinking,
    workspacePath: runtime.workspacePath,
    research_mode: runtime.researchMode,
    lastPromptTokens: Number(runtime.lastPromptTokens) || 0,
    createdAt: runtime.createdAt,
    updatedAt: runtime.updatedAt || new Date().toISOString(),
    messages: sanitizeHistoryForStorage(runtime.history),
    display: {},
  })
}

/**
 * 运行期落盘（**事件驱动**，不是定时器）。
 *
 * 【为什么不用定时器】任何"固定时间保存"的方案都有同一个毛病：崩溃发生在
 * 两次 tick 之间时，中间产出的东西全丢。间隔调小只是把损失从「一整轮」缩小到
 * 「几秒」，但 agent 几秒能吐上千字正文 —— 用户的观感依然是「内容没了」。
 *
 * 【正确模型】agent 自己就有明确的**检查点**：一次响应结束、一批工具跑完，
 * 这才是一条完整可落盘的数据。在这些边界上同步落盘：
 *   · onToolResult —— 每个工具结果后（工具批量执行时逐个出发）
 *   · onTurnEnd    —— 每个 turn 结束（响应 + 工具都完成）
 *   · onText 节流   —— 长正文流式期间每 300ms 兜一次底（避免"一整段长文只出现在
 *                     最后一个检查点之前"的极端情况）
 * 这样「丢」的上界是「最后一句话还没写完」，而不是「整轮」。
 *
 * 落盘内容 = agent 当前历史 + 本轮进行中的正文（runSnapshot），
 * 后者在 agent 下一次 push 之前必须补上，否则崩溃时那一段缺失。
 */
const INFLIGHT_FLUSH_MS = 300
function startRunAutosave(runtime, getAgent) {
  let inflightTimer = null
  let lastFlushAt = 0

  const flush = () => {
    try {
      const agent = getAgent()
      const history = agent?.getHistory?.()
      if (!Array.isArray(history) || !history.length) return
      // 克隆（agent 后续还会改这些对象），把「进行中的正文」并入快照
      const snapshot = history.map(m => ({ ...m, content: Array.isArray(m.content) ? [...m.content] : m.content }))
      const inflight = runtime.runSnapshot?.text
      const inflightThinking = runtime.runSnapshot?.thinking
      if (inflight || inflightThinking) {
        const blocks = []
        if (inflightThinking) blocks.push({ type: 'thinking', thinking: inflightThinking })
        if (inflight) blocks.push({ type: 'text', text: inflight })
        const last = snapshot[snapshot.length - 1]
        if (last && last.role === 'assistant' && !last.hidden) {
          last.content = Array.isArray(last.content) ? [...last.content, ...blocks] : blocks
        } else {
          snapshot.push({ role: 'assistant', content: blocks, _inflight: true })
        }
      }
      runtime.history = snapshot
      runtime.updatedAt = new Date().toISOString()
      saveRuntime(runtime)
      lastFlushAt = Date.now()
    } catch { /* 落盘失败不能影响正在跑的任务 */ }
  }

  return {
    /** agent 检查点（工具结果 / turn 结束）立刻落盘 */
    checkpoint: flush,
    /** 流式正文：节流调用（300ms 内多次只落一次，避免高频写盘） */
    throttled: () => {
      const now = Date.now()
      if (now - lastFlushAt < INFLIGHT_FLUSH_MS) {
        if (!inflightTimer) {
          inflightTimer = setTimeout(() => { inflightTimer = null; flush() }, INFLIGHT_FLUSH_MS)
        }
        return
      }
      flush()
    },
    stop: () => { if (inflightTimer) { clearTimeout(inflightTimer); inflightTimer = null } },
  }
}
// 切换 Provider / URL / Key / 模型后必须丢弃已构建的 Agent，否则仍用旧 ApiClient。
function invalidateRuntimeEngine(runtime, { extensions = false } = {}) {
  runtime.agent = null
  runtime.toolkit = null
  runtime.compactService = null
  if (extensions) {
    runtime.skillLoader = null
    runtime.commandLoader = null
  }
}
function captureWebInput(type, content) {
  const text = String(content || '')
  if (!text.trim()) return
  try {
    // 去重：HTTP 层捕获与 session 扇扫可能重复记录同一条命令。
    if (type === 'command' && webInputHistory.recentCommands(100).some(entry => entry.content === text)) return
    webInputHistory.add(type, text)
  }
  catch (error) { console.error('[web] 输入历史捕获失败:', error?.message || error) }
}
// @路径 引用：内容只进本轮模型上下文，不回显气泡，也不写回历史（避免每轮重复注入与快照过期）。
function prepareWebModelText(text, workspacePath) {
  const value = String(text || '')
  try {
    const { refs } = extractAtRefs(value)
    if (!refs.length) return { modelText: value, refs: [] }
    const { block, loaded, missing } = buildAtContext(refs, workspacePath || loadWebSettings().workspacePath)
    return {
      modelText: block ? `${value}${block}` : value,
      refs: loaded || [],
      missing: missing || [],
    }
  } catch (error) {
    console.error('[web] @ 引用展开失败:', error?.message || error)
    return { modelText: value, refs: [] }
  }
}
function json(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}
async function readBody(req, maxBytes = 12 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw Object.assign(new Error('请求体过大'), { status: 413 })
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
}
function safeUploadName(name) {
  const base = String(name || 'file').split(/[\\\\/]/).pop() || 'file'
  return base.replace(/[^\w.\-\u4e00-\u9fa5 ]/g, '_').slice(0, 120) || 'file'
}
function uploadPath(fileId, name) {
  return join(WEB_UPLOAD_ROOT, `${fileId}-${safeUploadName(name)}`)
}
function getUpload(fileId, hint = {}) {
  const id = String(fileId || '')
  if (!/^[a-f0-9-]{20,80}$/i.test(id)) return null
  const cached = uploads.get(id)
  if (cached && existsSync(cached.path)) return cached
  try {
    const file = readdirSync(WEB_UPLOAD_ROOT).find(name => name.startsWith(`${id}-`))
    if (!file) return null
    const path = join(WEB_UPLOAD_ROOT, file)
    const name = file.slice(id.length + 1)
    const stat = statSync(path)
    const mimeType = cached?.mimeType || hint.mimeType || 'application/octet-stream'
    const saved = uploadMeta[id] || {}
    const meta = { fileId: id, fileName: hint.fileName || saved.fileName || name, fileType: hint.fileType || saved.fileType || (/^image\//.test(mimeType) ? 'image' : 'document'), mimeType: hint.mimeType || saved.mimeType || mimeType, size: stat.size, path }
    uploads.set(id, meta)
    return meta
  } catch { return null }
}
function attachmentText(meta) {
  return `[Web 附件: ${meta.fileName}]\n已保存到: ${meta.path}`
}
// 注入给模型的 @文件内容、附件正文、隐藏上下文不应重载后出现在用户气泡里。
function sanitizeUiUserText(text) {
  const value = String(text || '')
  const markers = [
    '\n\n<!-- @ 引用的文件内容 -->',
    '\n\n[Web 附件:',
    '\n\n[图片附件：',
    '\n\n[系统自动记录 · 非用户输入]',
    '\n\n<!-- web slash recent -->',
  ]
  const cut = markers.reduce((min, marker) => {
    const index = value.indexOf(marker)
    return index >= 0 && index < min ? index : min
  }, value.length)
  return value.slice(0, cut).replace(/\n<文件内容>[\s\S]*$/, '').trimEnd()
}
function buildUserContent(text, attachmentList = []) {
  const attachments = (Array.isArray(attachmentList) ? attachmentList : []).map(item => getUpload(item?.fileId || item?.id, item)).filter(Boolean)
  if (!attachments.length) return String(text || '')
  const blocks = [{ type: 'text', text: String(text || '') }]
  for (const meta of attachments) {
    const attachmentBlock = { type: 'web_attachment', id: meta.fileId, file_name: meta.fileName, file_type: meta.fileType, mime_type: meta.mimeType, file_size: meta.size, path: meta.path }
    if (meta.fileType === 'image') {
      // 无论是否内联给模型，都把路径与动作指令放进 text：
      // Provider 不支持 vision 时 api.mjs 会剥掉 image_url；没有这段模型只能看到「图片已省略」，
      // 现在仍能明确调用 ViewImage 读取原图（而不是假装看到了图片）。
      blocks[0].text += `\n\n[图片附件：${meta.fileName}\n本地路径：${meta.path}\n若你不能直接看到图片，必须调用 ViewImage 工具并传入上面的本地路径；不要只说「图片已省略」。]`
      // 大图不内联 base64：内联内容会进入历史并在刷新时重新加载，易把页面卡死。
      if (meta.size <= 1.5 * 1024 * 1024) {
        const data = readFileSync(meta.path).toString('base64')
        blocks.push({ type: 'image_url', image_url: { url: `data:${meta.mimeType};base64,${data}` } })
      }
    } else if (/^(text\/|application\/(json|javascript|xml))/.test(meta.mimeType) || /\.(txt|md|csv|json|xml|yaml|yml|js|jsx|ts|tsx|py|java|cpp|c|h|cs|go|rs|rb|php|swift|kt|scala|html|css|scss|less|sql|sh|bash|vue|svelte|lua|r|m|pl|ex|exs)$/i.test(meta.fileName)) {
      const content = readFileSync(meta.path, 'utf8').slice(0, 2 * 1024 * 1024)
      blocks[0].text += `\n\n${attachmentText(meta)}\n<文件内容>\n${content}\n</文件内容>`
    } else {
      blocks[0].text += `\n\n${attachmentText(meta)}\n请在需要时使用 Read 等工具读取该文件。`
    }
    blocks.push(attachmentBlock)
  }
  return blocks
}
/**
 * 给设置页回显用的脱敏 key。
 * 只留前 8 后 4，中间用 · 占位 —— 足够用户认出「是哪一个」，
 * 又不至于在截图/录屏里泄露完整值。
 */
function maskKeyForDisplay(key) {
  const k = String(key || '')
  if (!k) return ''
  if (k.includes('${')) return k          // 环境变量引用（${VAR}）原样返回，它本来就不是秘密
  if (k.length <= 12) return `${k.slice(0, 2)}···${k.slice(-2)}`
  return `${k.slice(0, 8)}···${k.slice(-4)}`
}

function publicProviders(config) {
  return Object.entries(config.providers).map(([id, provider]) => ({
    id,
    name: provider.name || id,
    model: provider.model || '',
    protocol: provider.protocol || 'openai',
    vision: !!provider.vision,
    url: provider.url || '',
    // models 数组为空时的兜底。
    // 【为什么之前删掉、现在又加回来】早先无条件塞一条 `{id: 主模型名, name: 主模型名}`，
    // 导致设置页里「模型」输入框和下面的模型列表显示同一个名字（看起来像重复），
    // 所以改成返回空数组。但那又带来另一个问题：输入栏的模型下拉是拿所有 provider
    // 的 models 汇总出来的 —— 4 个 Provider 的 models 都是空，下拉里就只剩 1 个模型。
    // 正确做法是**只在有主 model 时才补这一条**，并标记来源（primary），
    // 让设置页可以用不同文案区分（而不是看起来重复）：
    models: (() => {
      if (Array.isArray(provider.models) && provider.models.length) {
        return provider.models.map(model => ({ id: model.id, name: model.name || model.id, enabled: model.enabled !== false, tier: model.tier || 'extra', thinkingId: model.thinkingId }))
      }
      // 没配 models 列表 → 用主 model 兜底，保证下拉里能看到这个 Provider 的模型
      return provider.model
        ? [{ id: provider.model, name: provider.model, enabled: true, tier: 'extra', primary: true }]
        : []
    })(),
    supportsWebSearch: provider.supportsWebSearch !== false,
    webSearchStrategy: provider.webSearchStrategy || 'tavily',
    maxOutputTokens: provider.maxOutputTokens,
    systemTopLevel: provider.systemTopLevel === true,
    // 设置页要回显这些，否则「改了保存成功但界面还是旧的」
    thinking: provider.thinking || null,
    temperature: provider.temperature,
    // ── Key 的回显（2026-09-20 用户要求）──
    // 用户报：「配置页里没显示 key，那里是空的」「按了小眼睛也不展示」。
    // 根因：这里原来只下发 hasTavilyKey 布尔值、完全不下发 apiKey，
    // 前端输入框的 value 恒为空 → 眼睛点了也是空框。
    //
    // 【2026-09-20 用户拍板：全部下发明文，不脱敏】
    // 原话：「那其他配置的key也都显示，不要脱敏」。
    // 背景：这是自部署、单用户、本机访问（127.0.0.1）的 Web 界面，
    // 与 CLI 的 /config list 显示明文行为一致（用户明确说过不介意）。
    // 脱敏只带来困惑 ——「点眼睛也看不到真 key，那这个按钮是干嘛的」。
    //
    // 保留 apiKeyMasked / hasApiKey / keyCount 三个字段：老前端和别处还在读，
    // 但新增 apiKey（明文）供设置页直接显示。
    apiKey: provider.apiKey || (Array.isArray(provider.apiKeys) && provider.apiKeys[0]) || '',
    apiKeys: Array.isArray(provider.apiKeys) ? provider.apiKeys : undefined,
    apiKeyMasked: maskKeyForDisplay(provider.apiKey || (Array.isArray(provider.apiKeys) && provider.apiKeys[0]) || ''),
    hasApiKey: !!(provider.apiKey || (Array.isArray(provider.apiKeys) && provider.apiKeys.length)),
    keyCount: Array.isArray(provider.apiKeys) ? provider.apiKeys.length : (provider.apiKey ? 1 : 0),
    // 搜索引擎 key（Tavily）：Web Agent 的 WebSearch 工具用它。
    //
    // 【2026-09-20 修：用户报「搜索 API key 点了小眼睛也显示不出来」】
    // 根因是**读写位置不一致**：
    //   · WebSearch 实际读的是 core/tavily.mjs → .env 的 TAVILY_API_KEY（key 一直在，功能正常）
    //   · 但这里回显只认 provider.tavilyApiKey / 顶层 tavilyKey（config.json 里），两者都是空
    //   → 设置页永远显示空框，点眼睛也是空的。用户看着像「key 没配置」，其实配了。
    //
    // 现在直接复用 core/tavily.mjs 的 getTavilyKey() —— 它就是搜索实际用的那条取值链
    // （含 .env 加载、${VAR} 解析、环境变量优先）。**同一份实现**，不会再漂移。
    // 注意：这里绝不能自己读 process.env，因为 server.mjs 启动时没加载 .env。
    ...(() => {
      let real = ''
      try { real = getTavilyKey() || '' } catch {}
      return {
        tavilyApiKey: real,                          // 明文（用户要求）
        tavilyApiKeyMasked: maskKeyForDisplay(real), // 兼容老前端
        hasTavilyKey: !!real,
      }
    })(),
    visionProviderId: config.visionProviderId || null,
  }))
}
function isInternalAgentHistoryMessage(entry) {
  const text = Array.isArray(entry?.content)
    ? entry.content.filter(b => b?.type === 'text').map(b => String(b.text || '')).join('')
    : String(entry?.content || '')
  // 旧会话在 hidden 标记引入之前已经把这些内部重试指令落盘了；
  // 精确过滤它们，避免 Web 把「系统提示：上一次响应为空」显示成用户说的话。
  return text === '（空响应）'
    || /^（系统提示：上一次响应为空，请重新回复）$/.test(text)
    || /^（系统提示：你发起了 \d+ 个工具调用，但参数不完整/.test(text)
    || /^（系统提示：当前模型不支持图片，已把历史中的图片替换为/.test(text)
    || /^（持续模式：继续执行当前任务，如无新任务则保持监听，不要停止回复）$/.test(text)
    // goal 模式的续轮 prompt：整段是给模型的执行指令（含目标/预算/审计清单），
    // 刷新页面后不该出现在用户气泡里。它由 goal runtime 内部注入，不是用户说的话。
    || /^（goal mode 启动/.test(text)
    || /^（goal mode 自动续轮/.test(text)
    || /^# 当前目标（完成契约/.test(text)
    // mid-turn steering 注入格式：用户的话本身单独有气泡，这层包装是给模型看的
    || /^（执行中补充指令 \/ mid-turn steering）/.test(text)
}
function toUiMessages(history = [], workspaceForPresent = '') {
  const output = []
  const getBlocks = entry => Array.isArray(entry?.content) ? entry.content : []
  const getUiAttachments = entry => getBlocks(entry).filter(block => block?.type === 'web_attachment').map(block => ({ id: block.id, fileId: block.id, file_name: block.file_name, fileName: block.file_name, file_type: block.file_type, fileType: block.file_type, mime_type: block.mime_type, mimeType: block.mime_type, file_size: block.file_size, size: block.file_size }))
  for (let index = 0; index < history.length; index++) {
    const entry = history[index]
    if (entry.role === 'user') {
      // hidden 消息（系统注入 / 内部提示）和旧版已落盘的内部提示均不进气泡
      if (entry.hidden || isInternalAgentHistoryMessage(entry)) continue
      // 图片占位符（sanitizeHistoryForStorage 把 base64 换成的说明文字）不是用户说的话，
      // 它只是「这里原本有张图」的标记。留着会让气泡里冒出无关说明。
      const rawText = Array.isArray(entry.content)
        ? entry.content.filter(b => b?.type === 'text').map(b => b.text).filter(t => !/^\[图片已上传，刷新后不重复注入图片数据\]$/.test(String(t || '').trim())).join('')
        : String(entry.content || '')
      const text = entry.uiText != null ? String(entry.uiText) : sanitizeUiUserText(rawText)
      const attachments = getUiAttachments(entry)
      if (text.trim() || attachments.length) output.push({ id: `m-${index}`, role: 'user', content: text, attachments, has_attachments: attachments.length ? 1 : 0, historyIndex: index })
    } else if (entry.role === 'assistant') {
      // hidden：agent 内部为维持 role 交替写入的占位（如「（空响应）」），不进气泡
      if (entry.hidden || isInternalAgentHistoryMessage(entry)) continue
      const blocks = Array.isArray(entry.content) ? entry.content : []
      const text = blocks.filter(b => b?.type === 'text').map(b => b.text).join('')
      // 【按 block 顺序还原 textBefore】history 里 assistant 的 content 是
      // [text, tool_use, text, tool_use, ...] 的有序数组 —— 顺序信息一直在，
      // 原来 toUiMessages 把所有 text 拼成一个字符串、所有 tool_use 另开一个数组，
      // 分段信息就被抹平了（刷新后整轮文字挤成一坨）。
      // 这里让每个 tool_use 记住「它之前累计的正文」，前端按长度切分即可复原。
      let consumed = ''
      const tools = blocks.map(b => {
        if (!b) return null
        if (b.type === 'text') { consumed += String(b.text || ''); return null }
        if (b.type !== 'tool_use') return null
        return { id: b.id, name: b.name || 'Tool', input: JSON.stringify(b.input || {}, null, 2), result: '', status: 'done', textBefore: consumed }
      }).filter(Boolean)
      // Present 工具调用本身就落在 history 的 tool_use 里，重载会话时反解出来，
      // 这样刷新页面后内联展示（SVG/图片等）依然存在，不用额外存一份。
      const presents = blocks
        .filter(b => b?.type === 'tool_use' && b.name === 'Present' && b.input && b.input.kind)
        .map(b => ({
          kind: String(b.input.kind),
          title: b.input.title ? String(b.input.title) : '',
          caption: b.input.caption ? String(b.input.caption) : '',
          content: b.input.content ? String(b.input.content) : '',
          // 落盘的 input.paths 是原始路径；前端只需要 path/name 两个字段
          files: Array.isArray(b.input.paths)
            ? b.input.paths.map(p => {
              const raw = String(p)
              // Agent 可能传相对路径；present-file 接口要绝对路径，用 workspace 补全
              const abs = raw.startsWith('/') ? raw : (workspaceForPresent ? resolve(workspaceForPresent, raw) : raw)
              return { path: abs, name: abs.split('/').pop() || abs }
            })
            : [],
          params: Array.isArray(b.input.params) ? b.input.params : [],
          at: index * 1000 + 1,
        }))
      if (text.trim() || tools.length > 0 || entry.reasoning_content || presents.length) {
        // isCommandOutput：slash 命令的输出（终端风格纯文本，靠缩进对齐）。
        // 必须带到前端 —— 它决定用 <pre> 还是 Markdown 渲染。
        // 不带的话刷新页面后缩进又丢了，用户会看到「刚敲完是对的，刷新就乱了」。
        output.push({ id: `m-${index}`, role: 'assistant', content: text, reasoning: String(entry.reasoning_content || ''), tools, presents, historyIndex: index, isCommandOutput: entry.isCommandOutput === true })
      }
    }
  }
  for (let i = 0; i < output.length; i++) {
    const msg = output[i]
    if (msg.role === 'assistant' && msg.tools) {
      for (const tool of msg.tools) {
        const nextUser = history[msg.historyIndex + 1]
        if (nextUser && nextUser.role === 'user' && Array.isArray(nextUser.content)) {
          const resultBlock = nextUser.content.find(b => b?.type === 'tool_result' && b.tool_use_id === tool.id)
          if (resultBlock) {
            tool.status = resultBlock.is_error ? 'error' : 'done'
            tool.result = typeof resultBlock.content === 'string' ? resultBlock.content : JSON.stringify(resultBlock.content || '', null, 2)
          }
        }
      }
    }
  }
  return output
}
function sessionPayload(runtime) {
  const history = runtime.agent?.getHistory?.() || runtime.history || []
  const { providerId, provider } = providerForRuntime(runtime)
  // 上下文用量：优先用 API 返回的真实 prompt_tokens（和 CLI 的 /context 同源），
  // 没有真实值时（会话刚从磁盘恢复、还没发过请求）退回字符估算。
  const config = loadWebConfig()
  const livePromptTokens = runtime.agent?.getLastPromptTokens?.() || 0
  const persistedPromptTokens = Number(runtime.lastPromptTokens) || 0
  const realTokens = livePromptTokens || persistedPromptTokens
  const estimatedTokens = Math.ceil(JSON.stringify(history || []).length / 4)
  return {
    id: runtime.id, title: runtime.title || '新对话', providerId, model: modelForRuntime(runtime, provider), providerModel: provider?.model || '',
    workspacePath: runtime.workspacePath || loadWebSettings().workspacePath,
    research_mode: !!runtime.researchMode,
    thinking: runtime.thinking === undefined ? null : !!runtime.thinking,
    thinkingEffort: runtime.thinkingEffort || null,
    contextTokens: realTokens || estimatedTokens,
    contextTokensExact: realTokens > 0,
    contextLimit: config.maxContextTokens || 1000000,
    createdAt: runtime.createdAt || null, updatedAt: runtime.updatedAt || null, running: !!runtime.running, messages: toUiMessages(history, runtime.workspacePath || ''),
    // 中断残局：前端据此显示「上一轮被打断，点此继续」
    interrupted: runtime.interruptedRun || null,
    // 运行时指标：轮数/首字延迟/吞吐/耗时构成。**直接复用 CLI 的 agent.getMetrics()**，
    // 保证两端口径完全一致（用户明确要求「和我们 cli 的一样计算」）。
    metrics: (() => { try { return runtime.agent?.getMetrics?.() || null } catch { return null } })(),
    // 目标契约（跨轮推进时前端要显示目标与预算进度）。
    goal: goalSnapshotFor(runtime.id),
  }
}
// 列表只需要元信息；带图片的会话历史很大，不能在列表里展开。
/**
 * 新建一个会话 runtime（不落盘）。
 *
 * 【为什么抽出来】原来是内联在 POST /api/sessions 里的 12 行对象字面量。
 * QQ 桥需要一个「没有活跃会话时新建一个」的入口 —— 内联写法没法复用，
 * 照抄一份又会两处漂移（改字段时漏一边）。
 *
 * 调用方负责 store.save() 落盘（POST 处理器会做；QQ 桥那条路径也会）。
 */
function createRuntime({ title = '新对话', workspacePath, providerId, model, thinking, thinkingEffort, researchMode = false } = {}) {
  const config = loadWebConfig()
  const pid = resolveProviderId(config, providerId || config.current)
  const id = randomUUID()
  return {
    id,
    title,
    providerId: pid,
    model: model || findProviderModel(config.providers[pid], model) || null,
    thinking: typeof thinking === 'boolean' ? thinking : undefined,
    thinkingEffort: thinkingEffort || undefined,
    workspacePath: workspacePath ? normalizeWorkspace(workspacePath) : loadWebSettings().workspacePath,
    researchMode: !!researchMode,
    history: [],
    createdAt: new Date().toISOString(),
    updatedAt: null,
    events: new Set(),
    running: false,
    agent: null,
    controller: null,
    toolkit: null,
    pendingQuestions: new Map(),
    steeringQueue: [],
    commandLoader: null,
    skillLoader: null,
    compactService: null,
    eventSeq: 0,
    eventLog: [],
    lastActiveAt: Date.now(),
  }
}

/** 建会话并落盘（POST /api/sessions 与 QQ 桥共用） */
function createAndSaveRuntime(opts = {}) {
  const runtime = createRuntime(opts)
  runtimes.set(runtime.id, runtime)
  store.save(runtime.id, {
    sessionId: runtime.id, title: runtime.title, providerId: runtime.providerId,
    model: runtime.model,
    thinking: runtime.thinking === undefined ? null : runtime.thinking,
    thinkingEffort: runtime.thinkingEffort || null,
    workspacePath: runtime.workspacePath, research_mode: runtime.researchMode,
    createdAt: runtime.createdAt, updatedAt: runtime.updatedAt,
    messages: [], display: {},
  })
  return runtime
}

function listSessions({ withMessages = false } = {}) {
  return store.list().map(id => {
    const runtime = runtimes.get(id)
    if (runtime) {
      if (withMessages) return sessionPayload(runtime)
      const { providerId, provider } = providerForRuntime(runtime)
      const history = runtime.agent?.getHistory?.() || runtime.history || []
      return {
        id: runtime.id,
        title: runtime.title || '新对话',
        providerId,
        model: modelForRuntime(runtime, provider),
        providerModel: provider?.model || '',
        workspacePath: runtime.workspacePath || loadWebSettings().workspacePath,
        createdAt: runtime.createdAt || null,
        updatedAt: runtime.updatedAt || null,
        running: !!runtime.running,
        messageCount: history.length,
      }
    }
    const data = store.load(id)
    if (!data) return null
    const config = loadWebConfig()
    const providerId = resolveProviderId(config, data.providerId)
    const base = {
      id, title: data.title || '新对话', providerId, model: normalizeStoredModel(data.model) || config.providers[providerId]?.model || '', providerModel: config.providers[providerId]?.model || '',
      workspacePath: data.workspacePath || loadWebSettings().workspacePath,
      createdAt: data.createdAt || null, updatedAt: data.updatedAt || null, running: false,
    }
    if (!withMessages) return { ...base, messageCount: Array.isArray(data.messages) ? data.messages.length : 0 }
    return { ...base, messages: toUiMessages(data.messages || [], base.workspacePath || '') }
  }).filter(Boolean).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
}
/**
 * runtime 空闲淘汰。每个 runtime 持有 agent、toolkit、history、事件缓冲，
 * 原来只在删除会话时清理，长期开着会单向增长（手机内存下是真实压力）。
 * 空闲超过 IDLE_MS 且没有在跑、没有 SSE 连接、没有待回答提问的，从内存里移除；
 * 会话数据已落盘，下次访问由 getRuntime 从 store 重建，用户无感。
 */
const RUNTIME_IDLE_MS = 30 * 60 * 1000
const RUNTIME_SWEEP_MS = 5 * 60 * 1000
function sweepIdleRuntimes() {
  const now = Date.now()
  for (const [id, runtime] of [...runtimes]) {
    if (runtime.running) continue
    if (runtime.events?.size) continue
    if (runtime.pendingQuestions?.size) continue
    const idle = now - (runtime.lastActiveAt || 0)
    if (idle < RUNTIME_IDLE_MS) continue
    try { saveRuntime(runtime) } catch { }
    // 显式断链，帮 GC 尽快回收 toolkit 里挂的 api/工具闭包
    runtime.agent = null
    runtime.toolkit = null
    runtime.compactService = null
    runtime.eventLog = []
    runtimes.delete(id)
  }
}
const runtimeSweepTimer = setInterval(sweepIdleRuntimes, RUNTIME_SWEEP_MS)
if (runtimeSweepTimer.unref) runtimeSweepTimer.unref()

function getRuntime(id) {
  if (runtimes.has(id)) {
    const cached = runtimes.get(id)
    cached.lastActiveAt = Date.now()
    return cached
  }
  const data = store.load(id)
  if (!data) throw Object.assign(new Error('会话不存在'), { status: 404 })
  const runtime = {
    id, title: data.title || '新对话', providerId: resolveProviderId(loadWebConfig(), data.providerId),
    model: normalizeStoredModel(data.model),
    thinking: typeof data.thinking === 'boolean' ? data.thinking : undefined,
    thinkingEffort: data.thinkingEffort || undefined,
    workspacePath: data.workspacePath ? normalizeWorkspace(data.workspacePath) : loadWebSettings().workspacePath,
    researchMode: !!data.research_mode,
    history: sanitizeHistoryForStorage(data.messages || []), createdAt: data.createdAt || new Date().toISOString(), updatedAt: data.updatedAt || null,
    events: new Set(), running: false, agent: null, controller: null, toolkit: null,
    pendingQuestions: new Map(), steeringQueue: [], commandLoader: null, skillLoader: null, compactService: null,
    // SSE 断线补发用：自增序号 + 环形缓冲；lastActiveAt 供空闲淘汰判断
    eventSeq: 0, eventLog: [], lastActiveAt: Date.now(),
    lastPromptTokens: Number(data.lastPromptTokens) || 0,
  }
  // 【断连/重启后的残局识别】从磁盘恢复的会话没有活着的 agent（进程重启过，
  // 或者服务端被回收过）。但如果 history 末尾停在 tool_result / 半截 assistant 上，
  // 说明那一轮没跑完 —— 用户切回来的感受就是「任务跑到一半，回来啥都没了」。
  // 这里显式标记，前端会显示一条可点的「继续」提示，而不是静默装正常。
  try {
    const hist = runtime.history || []
    const lastUser = [...hist].reverse().find(m => m.role === 'user' && !m.hidden)
    let lastAssistantText = ''
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i].role !== 'assistant' || hist[i].hidden) continue
      const blocks = Array.isArray(hist[i].content) ? hist[i].content : []
      lastAssistantText = blocks.filter(b => b?.type === 'text').map(b => b.text).join('')
      const hasToolUse = blocks.some(b => b?.type === 'tool_use')
      if (hasToolUse || lastAssistantText.trim()) { runtime.interruptedRun = { detected: true, reason: '任务在服务端中断前未产出结束标记' } }
      break
    }
    // history 末尾是 user(tool_result) 形态 = agent 工具跑完了但没接着说话
    const tail = hist[hist.length - 1]
    if (tail && tail.role === 'user' && Array.isArray(tail.content) && tail.content.some(b => b?.type === 'tool_result')) {
      runtime.interruptedRun = { detected: true, reason: '上一轮工具执行完但模型没继续（进程中断/断连）' }
    }
  } catch {}
  runtimes.set(id, runtime)
  return runtime
}
/**
 * SSE 事件缓冲上限。手机切后台被冻结、WiFi 切换都会断开 SSE，
 * 原来断开期间的事件永久丢失（流式中间态断在半截）。
 * 现在每个事件带自增 id，客户端重连时用 Last-Event-ID 补发缺口。
 * 200 条足够覆盖一次典型的短暂断连；超出则由客户端整体重新拉会话。
 */
const SSE_BUFFER_LIMIT = 200
function emit(runtime, type, data = {}) {
  // 【性能埋点 2026-09-24】Web（APK）侧的渲染热点。
  //
  // 为什么这里需要埋点：fullscreen-adapter.mjs 里的 refreshInput 埋点是给
  // 终端全屏用的，APK 的 WebView 根本不走那条路 —— 也就是 APK 上卡死时
  // 那套埋点一无所获。Web 侧真正可能慢的是这段：
  //   · JSON.stringify(data)：会话快照可能很大（含完整 history）
  //   · eventLog.push + splice：长会话下事件日志会涨到 SSE_BUFFER_LIMIT
  //   · res.write 循环：多个 SSE 连接时逐个写
  //
  // 阈值：单次 >50ms 记一行（正常应 <2ms）。
  const _t0 = process.hrtime.bigint()
  const _bytesHint = (() => { try { return JSON.stringify(data)?.length ?? 0 } catch { return -1 } })()
  try {
  if (!Number.isFinite(runtime.eventSeq)) runtime.eventSeq = 0
  if (!Array.isArray(runtime.eventLog)) runtime.eventLog = []
  const id = ++runtime.eventSeq
  // 记「本轮起点」= 本轮第一次 emit 的 id。
  // 用途：前端每次发消息都新建 SSE consumer（lastEventId 从 0 开始），
  // 服务端必须能区分「这是新连上的新请求」和「这是断线重连」——
  // 前者只该收到**本轮**的事件，后者才需要补发缺口。
  if (!runtime.turnStartSeq) runtime.turnStartSeq = id
  const payload = `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  runtime.eventLog.push({ id, payload })
  if (runtime.eventLog.length > SSE_BUFFER_LIMIT) {
    runtime.eventLog.splice(0, runtime.eventLog.length - SSE_BUFFER_LIMIT)
  }
  for (const res of [...runtime.events]) { try { res.write(payload) } catch { runtime.events.delete(res) } }
  } finally {
    try {
      const ms = Number(process.hrtime.bigint() - _t0) / 1e6
      if (ms > 50) {
        const line = `[${new Date().toISOString()}] emit ${type} 慢 ${ms.toFixed(0)}ms` +
          ` payload=${payload.length}B data≈${_bytesHint}B` +
          ` eventLog=${runtime.eventLog?.length || 0} conns=${runtime.events?.size || 0}` +
          ` history=${runtime.history?.length || 0}\n`
        appendFileSync(join(DATA_DIR, 'web-emit-slow.log'), line)
      }
    } catch {}
  }
}
/** 重连时补发 afterId 之后的事件。返回是否完整补上（false = 缺口太大，客户端应整体重载）。 */
function replayEvents(runtime, res, afterId) {
  const log = Array.isArray(runtime.eventLog) ? runtime.eventLog : []
  if (!Number.isFinite(afterId)) return true
  // 【2026-09-19 二次修】afterId<=0 的语义要分两种情况，之前混为一谈了。
  //
  // 场景 A（新请求）：前端 POST /messages → 服务端**立刻**执行命令并 emit(command_result)
  //   → 前端**然后**才连 SSE。命令执行极快，连上时事件已过去，不补发就永远转圈。
  //   这种需要补发。
  // 场景 B（重连）：同一次生成中途断线，客户端手里有 lastEventId，走的是 afterId>0 分支。
  //
  // 我上一轮把 afterId<=0 一律改成「补发全部 log」来修场景 A —— 修是修好了，
  // 但 eventLog 是**整个会话**的历史（跨轮次累积，上限 SSE_BUFFER_LIMIT 条）。
  // 于是每次发新消息，前端都会把**之前每一轮**的 command_result 全部重放一遍，
  // 界面尾部堆满旧命令的结果 —— 用户看到的现象是「不管发 /url 还是 /config list，
  // 回复都是同一条（其实是最早那条）」，命令看起来完全不可用。
  //
  // 正确做法：afterId<=0 时只补发**本轮**（turnStartSeq 起）的事件。
  // 本轮之前的历史早就渲染在界面上了，重放它们纯属污染。
  if (afterId <= 0) {
    const from = runtime.turnStartSeq || log[0]?.id || 1
    for (const entry of log) {
      if (entry.id < from) continue
      try { res.write(entry.payload) } catch { return false }
    }
    return true
  }
  // 客户端 id 超过服务端当前序号：服务端重启过、序号已重置，
  // 客户端手里的位置无意义，必须让它整体重载而不是静默跳过。
  if (afterId > (runtime.eventSeq || 0)) return false
  if (!log.length) return afterId >= (runtime.eventSeq || 0)
  // 缓冲区最旧的事件已经超过客户端的位置 → 中间有缺口
  if (log[0].id > afterId + 1) return false
  for (const entry of log) {
    if (entry.id <= afterId) continue
    try { res.write(entry.payload) } catch { return false }
  }
  return true
}
/**
 * Web 端命令的子命令提示（供补全面板显示）。
 *
 * 【2026-09-19 加】Web 原来完全没传子命令，用户敲「/config 」空格什么都不出，
 * 只能靠记忆手打 /config test、/config vision set 2 …（实测用户为此敲了几十次，
 * 还把 /config vision off 打成无效命令）。CLI 早就有这张表，Web 补上。
 *
 * 这里只列 **web/server.mjs 里真正实现了的分支**，不照抄 CLI 的完整表 ——
 * 列了但没实现，用户按提示敲照样失败，比不提示更糟（幽灵条目）。
 */
const WEB_SUBCOMMANDS = {
  config: {
    // list 排最前：CLI 里它就是第一个候选（最常用的「看配置」入口）。
    // 上一轮我误以为它无效而删掉，导致面板里看不到、手敲又报错。
    candidates: ['list', 'show', 'test', 'vision', 'provider', 'stream', 'maxctx', 'greeting', 'profile'],
    desc: {
      list: '看详情：全字段 + key 池 + 可用列表',
      show: '看全部配置详情（Provider、模型、Key、路径等）',
      test: '测真实连通性，可带 [ID]（省略=当前）',
      vision: '识图路由：on | off | set <备用id>',
      provider: '增删/重命名：add | rm | rename | list',
      stream: '流式输出：on | off',
      maxctx: '设上下文窗口上限：maxctx <token 数>',
      greeting: '开场白：on | off',
      profile: '整套配置：save | load | delete | list',
    },
    // 三级：/config vision <on|off|set>、/config provider <add|rm|...>
    // 没有这层的话，敲完「/config vision 」面板还是列 config 的一级候选，等于没提示。
    nested: {
      vision: {
        candidates: ['on', 'off', 'set'],
        desc: {
          on: '本模型识图（图片直接交给当前模型）',
          off: '关闭本模型识图，改用备用 Provider 兜底',
          set: 'set <ProviderID>：指定备用识图 Provider',
        },
      },
      provider: {
        candidates: ['add', 'rm', 'rename', 'list'],
        desc: {
          add: '新增：add name=xxx url=xxx model=xxx [key=...]',
          rm: '删除：rm <id>（不能删当前使用中的）',
          rename: '改名：rename [旧ID] <新ID>',
          list: '列出全部 Provider',
        },
      },
      profile: {
        candidates: ['save', 'load', 'delete', 'list'],
        desc: { save: '保存当前配置为 profile', load: '载入 profile', delete: '删除 profile', list: '列出 profile' },
      },
      stream: {
        candidates: ['on', 'off'],
        desc: { on: '启用流式（边生成边显示）', off: '非流式（等完整回复）' },
      },
      greeting: {
        candidates: ['on', 'off'],
        desc: { on: '开启开场白', off: '关闭开场白' },
      },
    },
  },
  compact: {
    candidates: ['micro', 'status', 'force'],
    desc: {
      micro: '无损回收（零 API）；加 dry 只预览',
      status: '只看上下文压力与建议，不执行压缩',
      force: '强制压缩：force [保留条数]',
    },
  },
  goal: {
    candidates: ['status', 'proof', 'bound', 'budget', 'pause', 'resume', 'replace', 'clear', 'list', 'help'],
    desc: {
      status: '看目标、判据、边界、预算用了多少',
      proof: '设完成判据（怎么算做完）',
      bound: '设边界（不许碰什么）',
      budget: '改预算：12 轮 | 30m | 200k',
      pause: '暂停推进，保留进度',
      resume: '继续推进已暂停的目标',
      replace: '换成新目标（旧的丢掉）',
      clear: '放弃当前目标',
      list: '列出历史目标记录',
      help: '完整用法与四要素说明',
    },
  },
  effort: {
    candidates: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'off', 'show', 'hide', 'replay'],
    desc: {
      none: '关闭思考', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最大',
      off: '停用思考功能', show: '显示思考过程', hide: '隐藏思考过程',
      replay: 'replay on|off 历史思考回传',
    },
  },
  imagegen: {
    candidates: ['url', 'key', 'model', 'size', 'dir', 'clear', 'test'],
    desc: {
      url: '设生图 API 地址', key: '设生图 API Key', model: '设生图模型',
      size: '设默认尺寸', dir: '设保存目录', clear: '清空生图配置', test: '测生图连通性',
    },
  },
  model: {
    candidates: ['list'],
    desc: { list: '列出当前 Provider 的模型' },
  },
  key: {
    candidates: ['pool', 'set', 'setenv', 'clear'],
    desc: {
      pool: '多 key 轮换：无参进向导', set: '设单 key',
      setenv: '引用环境变量', clear: '清空这个 Provider 的 key',
    },
  },
  url: {
    candidates: ['set', 'clear'],
    desc: { set: '设 URL', clear: '清空 URL' },
  },
  tasks: {
    candidates: ['list', 'add', 'done', 'rm'],
    desc: { list: '列出任务', add: '新增任务', done: '标记完成', rm: '删除任务' },
  },
  watch: {
    candidates: ['list', 'add', 'rm'],
    desc: { list: '列出监视项', add: '添加监视', rm: '删除监视' },
  },
  trash: {
    candidates: ['list', 'restore', 'clear'],
    desc: { list: '列出回收站', restore: '恢复文件', clear: '清空回收站' },
  },
  team: {
    candidates: ['status', 'list', 'disband'],
    desc: { status: '看团队状态', list: '列出团队', disband: '解散团队' },
  },
}

function getSlashCommands(runtime) {
  ensureRuntimeExtensions(runtime)
  const custom = runtime?.commandLoader?.list?.() || []
  // 内置命令来自 catalog（与 CLI 同一份真值源），Web 特有命令追加在后面。
  // 【2026-10-05】原来这里用本文件硬编码的 BUILTIN_SLASH_COMMANDS（48 条），
  // 与 CLI 的 94 条严重脱节 —— 详见文件顶部 WEB_ONLY_COMMANDS 的注释。
  const builtin = listCommandEntries()
  const webOnly = WEB_ONLY_COMMANDS.map(([name, description]) => ({ name, description, builtin: true }))
  return [...builtin, ...webOnly, ...custom.map(c => ({ ...c, builtin: false }))]
    .sort((a, b) => a.name.localeCompare(b.name))
}
function getSkillEntries(runtime) {
  ensureRuntimeExtensions(runtime)
  return runtime.skillLoader.list().map(s => ({ name: s.name, description: s.description, scope: s.scope, passive: s.passive }))
}

function createExtensionLoaders(workspacePath) {
  const root = workspacePath || loadWebSettings().workspacePath
  return {
    skillLoader: new SkillLoader([join(root, 'skills'), join(ROOT, 'skills'), globalSkillsDir()]),
    commandLoader: new CustomCommandLoader([join(root, '.claude', 'commands'), join(ROOT, '.claude', 'commands'), join(homedir(), '.claude', 'commands')]),
  }
}
function ensureRuntimeExtensions(runtime) {
  if (!runtime.skillLoader || !runtime.commandLoader) {
    const loaders = createExtensionLoaders(runtime.workspacePath)
    runtime.skillLoader = loaders.skillLoader
    runtime.commandLoader = loaders.commandLoader
  }
  return runtime
}
function formatCommandResult(name, runtime, args = []) {
  if (name === 'help') return `**可用 Web 命令**\n\n${getSlashCommands(runtime).map(c => `- /${c.name} — ${c.description || ''}`).join('\n')}`
  if (name === 'tools') return `**当前可用工具**\n\n${(runtime.toolkit?.tools?.() || []).map(t => `- **${t.name}** — ${t.description || ''}`).join('\n') || '（尚未初始化 Agent）'}`
  if (name === 'skills') return `**可用 Skills**\n\n${getSkillEntries(runtime).map(s => `- /${s.name}${s.passive ? ' [passive]' : ''} — ${s.description || '无描述'}`).join('\n') || '没有可用 Skill'}`
  if (name === 'mcp') return `**MCP 状态**\n\n${[...mcpClient.servers.entries()].map(([server, state]) => `- **${server}**：${state.tools.length} 个工具`).join('\n') || '没有已连接 MCP 服务器'}`
  if (name === 'restart') return '**Web 重启说明**\n\nWeb 不重启 CLI。修改 Web 代码后请执行 `web/reload.sh` 单独重载 Web 服务；CLI 会话不受影响。'
  if (name === 'cost') {
    const usage = runtime.agent?.getTokenUsage?.() || { input: 0, output: 0, cacheRead: 0 }
    const lastPrompt = runtime.agent?.getLastPromptTokens?.() || 0
    return [
      '**Token 使用量**', '',
      `- 当前上下文：${lastPrompt}`,
      `- 累计输入：${usage.input || 0}`,
      `- 累计输出：${usage.output || 0}`,
      `- 缓存读取：${usage.cacheRead || 0}`,
    ].join('\n')
  }
  if (name === 'permissions') return '**Web 权限**\n\nWeb Agent 已开放 Termux API 工具；仅隔离 `Restart` 和 `Screencap`。文件访问不限制在当前 workspace。调用 Toast、通知、震动、朗读、剪贴板、定位、电量或打开 URL 等有外部副作用的工具前，应确认任务确实需要。'
  if (name === 'keepalive') {
    const st = keepaliveStatus()
    const audioLabel = { running: '运行中 ✓', stopped: '未运行 ✗', missing: '脚本缺失', unknown: '未知' }[st.audio] || st.audio
    return [
      '**保活状态**', '',
      `- Web 保活：${st.started ? '已启用（wake-lock + 常驻通知）' : '未启用'}`,
      `- 静音音频：${audioLabel}`,
      '',
      '静音音频与 CLI 的 `/keepalive` 共用同一进程，任一侧开启即生效。',
      '关闭请在 CLI 执行 `/keepalive off`（Web 退出不会自动停，避免影响 CLI 挂机）。',
    ].join('\n')
  }
  // /imagegen：与 CLI 共用 config.json 的 imageGen 字段（同一份磁盘状态）
  if (name === 'imagegen') {
    const maskKey = (k) => k ? k.slice(0, 8) + '...' + k.slice(-4) : '(未设置)'
    if (!args[0]) {
      const c = getImageGenConfig()
      const raw = (() => { try { return JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf-8')).imageGen || {} } catch { return {} } })()
      if (!c || (!raw.url && !raw.apiKey && !raw.model)) return '生图未配置。用法:\n- /imagegen url <https://中转站/v1>\n- /imagegen key <密钥或${ENV}>\n- /imagegen model <模型名>\n- /imagegen size <宽x高|auto>\n- /imagegen dir <保存目录>\n- /imagegen clear'
      return `**生图配置** (config.json imageGen)\n\n- URL: ${c.url || '(未设置)'}\n- Key: ${maskKey(raw.apiKey)}\n- Model: ${c.model || '(未设置)'}\n- Size: ${c.size}\n- SaveDir: ${c.saveDir}\n\n配置好后在对话里直接说「画一张…」即可。`
    }
    const [sub, ...rest] = args
    const val = rest.join(' ').trim()
    if (sub === 'clear') { setImageGenConfig({ url: '', apiKey: '', model: '' }); return '生图配置已清空' }
    if (!val) return `用法: /imagegen ${sub} <值>`
    switch (sub) {
      case 'url': {
        const v = val.replace(/\/+$/, '')
        setImageGenConfig({ url: v })
        return `生图 URL 已设置: ${v}\n(文生图: ${v}/images/generations)\n(图生图: ${v}/images/edits，给出参考图路径时自动切换)`
      }
      case 'key':
        setImageGenConfig({ apiKey: val })
        return `生图 Key 已设置: ${maskKey(val)}${val.includes('${') ? ' (环境变量引用)' : ''}`
      case 'model':
        setImageGenConfig({ model: val })
        return `生图模型已设置: ${val}`
      case 'size': {
        if (val !== 'auto' && !/^\d{3,4}x\d{3,4}$/.test(val)) return '尺寸格式应为 宽x高（如 1024x1024）或 auto'
        setImageGenConfig({ size: val })
        return `生图默认尺寸已设置: ${val}`
      }
      case 'dir': {
        setImageGenConfig({ saveDir: val.startsWith('~') ? val.replace(/^~/, homedir()) : val })
        return `生图保存目录已设置: ${val}`
      }
      default:
        return `未知子命令: ${sub}\n用法: /imagegen url|key|model|size|dir|clear`
    }
  }
  // undo / trash：与 CLI 共用底层实现（MultiUndoStore 与 core/trash.mjs），
  // 作用于同一份磁盘状态，因此 Web 撤销的也是真实文件改动。
  if (name === 'undo') {
    // toolkit 还没建时（会话刚恢复/未发消息）直接开一个共享存储实例：
    // MultiUndoStore 的快照索引在磁盘上，与 CLI 同一份，读出来即可撤销。
    const store_ = runtime.toolkit?.multiUndo || new MultiUndoStore()
    const results = store_.undo()
    return results.length ? `**已撤销**\n\n${results.map(r => `- ${r}`).join('\n')}` : '**撤销**\n\n没有可撤销的操作。'
  }
  if (name === 'trash') {
    const sub = String(args[0] || '').toLowerCase()
    if (sub === 'clear') return `**回收站**\n\n${clearTrash()}`
    if (sub === 'restore') return `**回收站**\n\n${restoreTrash(args[1] || 0)}`
    return `**回收站**\n\n${listTrash()}\n\n用法：\`/trash restore <序号>\` 恢复，\`/trash clear\` 清空。`
  }
  if (name === 'hooks') {
    const events = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'PostCompact', 'Stop']
    const config = hookManager.hooks || {}
    const lines = events.map(ev => {
      const entries = config[ev] || []
      const count = entries.reduce((n, e) => n + (e.hooks?.length || 0), 0)
      return `- **${ev}**：${count ? `${count} 个` : '—'}`
    })
    return [
      '**Hooks**', '',
      `配置文件：\`${join(ROOT, 'hooks.json')}\`（与 CLI 共用）`, '',
      ...lines, '',
      'Web 已接通：SessionStart / SessionEnd / UserPromptSubmit / PreToolUse / PostToolUse / PreCompact / PostCompact',
      'Stop hook 在 CLI 与 Web 均未接入执行点。',
    ].join('\n')
  }
  if (name === 'status') return `**Web 状态**\n\n- 服务：\`${HOST}:${PORT}\`\n- MCP：${mcpClient.servers.size} 个服务器\n- 工具：${runtime.toolkit?.tools?.().length || 0} 个\n- 工作目录：\`${runtime.workspacePath}\``
  if (name === 'model') {
    const { providerId, provider } = providerForRuntime(runtime)
    const activeModel = modelForRuntime(runtime, provider)
    const available = Array.isArray(provider?.models) && provider.models.length
      ? provider.models.map(model => `  - \`${model.id}\`${model.id === activeModel ? ' ← 当前' : ''}`).join('\n')
      : `  - \`${provider?.model || '(unknown)'}\``
    return [
      '**当前会话模型**', '',
      `- Provider：\`${providerId}\`（${provider?.name || '未命名'}）`,
      `- Model：\`${activeModel || '(unknown)'}\`${runtime.model ? '（会话覆盖）' : '（Provider 默认）'}`,
      `- Protocol：\`${provider?.protocol || 'openai'}\``, '',
      '**当前 Provider 可用模型**',
      available, '',
      '用法：`/model <模型名>` 只改当前会话模型，不会切 Provider；切 Provider 用 `/config <id>`。',
    ].join('\n')
  }
  // ── /protocol：切换 Provider 的 API 协议 ──────────────────────────────
  //
  // 【2026-09-19 补】Web 原来**完全没有**切协议的入口：/protocol 不在
  // 当时的静态命令列表里，而 /config protocol 已被 CLI 明确废弃
  //（core/cmd-extensions.mjs:898 只回一句「已移除」）—— 形成死角。
  // 【2026-10-05】命令列表已改为从 catalog 动态取，/protocol 现在
  // 天然出现在补全面板里，死角不复存在（本分支保留作为 Web 侧实现）。
  // 协议选错会导致端点路径拼错（anthropic 不带 /v1，openai/responses 要带），
  // 表现为 404，用户很难自己查出来。
  if (name === 'protocol') {
    const VALID = ['openai', 'anthropic', 'responses']
    if (runtime.running) return { kind: 'output', text: '当前会话正在生成，完成后再改协议。' }
    const config = loadWebConfig()
    const providers = config.providers || {}
    // 与 CLI 一致：第一个参数若是已存在的 Provider ID 且不是协议名，则作为目标
    let provId = runtime.providerId || config.current
    const rest = [...args]
    if (rest.length && providers[rest[0]] && !VALID.includes(String(rest[0]).toLowerCase())) provId = rest.shift()
    const prov = providers[provId]
    if (!prov) return { kind: 'output', text: `Provider ${provId} 不存在。可用：${Object.keys(providers).join(', ')}` }
    const cur = prov.protocol || 'openai'

    if (!rest.length) {
      return { kind: 'output', text: [
        `Provider \`${provId}\`（${prov.name || '未命名'}）`,
        `协议：${cur}`,
        `实际请求端点：${providerEndpointPreview(prov.url, cur)}`, '',
        `用法：\`/protocol [id] <openai|anthropic|responses>\``,
        '  openai    /chat/completions  最通用，中转站基本都认',
        '  anthropic /v1/messages       Claude 原生（thinking/cache 语义最准）',
        '  responses /responses         OpenAI 新协议（o 系/GPT-5 原生；网关不支持会 404）',
      ].join('\n') }
    }

    const next = String(rest[0]).toLowerCase()
    if (!VALID.includes(next)) return { kind: 'output', text: `不认识的协议「${rest[0]}」。可选：${VALID.join(' / ')}` }
    if (next === cur) return { kind: 'output', text: `Provider ${provId} 协议已经是 ${cur}，未改动。` }

    prov.protocol = next
    // 切协议必须重新规范化 URL：三种协议的 canonical base 规则不同，
    // 原样留着会拼错端点（这正是本命令存在的主要理由）。
    prov.url = normalizeProviderUrl(prov.url, next)
    saveWebConfig(config)
    // 会话绑定的就是这个 Provider 时，让引擎缓存失效，下一轮用新协议
    invalidateRuntimeEngine(runtime, { extensions: true })
    return { kind: 'output', text: `Provider \`${provId}\` 协议已切换：${cur} → ${next}\n`
      + `实际请求端点：${providerEndpointPreview(prov.url, next)}\n`
      + (provId === runtime.providerId ? '已生效（下一个请求就用新协议）' : '切换到该 Provider 时生效') }
  }

  if (name === 'config') {
    const config = loadWebConfig()
    const current = providerForRuntime(runtime)
    return [
      '**Web 配置**', '',
      `- 当前会话 Provider：\`${current.providerId}\`（${current.provider?.name || '未命名'}）`,
      `- 当前会话 Model：\`${current.provider?.model || '(unknown)'}\``,
      `- Web 默认 Provider：\`${config.current}\``,
      '- CLI `config.json` 的 `current`：与 Web 独立，不会覆盖当前 Web 会话。', '',
      '**可用 Provider**',
      ...publicProviders(config).map(p => `- \`${p.id}\` **${p.name}** · ${p.model} · ${p.protocol}${p.id === current.providerId ? ' ← 当前会话' : ''}${p.id === config.current ? ' · Web 默认' : ''}`),
      '',
      '**Key / Provider 管理**：请到侧栏用户菜单 → 设置 → Provider 页操作（Web 不提供 CLI 的 /config key|provider 子命令）。',
    ].join('\n')
  }
  if (name === 'context') return `最近上下文 tokens: ${runtime.agent?.getLastPromptTokens?.() || 0}`
  if (name === 'url') {
    const { providerId, provider } = providerForRuntime(runtime)
    return `当前会话 Provider：\`${providerId}\`（${provider?.name || '未命名'}）\n当前 URL：${provider?.url || '(未配置)'}\n用法：/url <https://中转站地址/v1>（只作用于当前会话 Provider）`
  }
  if (name === 'name') {
    const { providerId, provider } = providerForRuntime(runtime)
    return `当前会话 Provider：\`${providerId}\`\n显示名：${provider?.name || '(未设置)'}\n用法：/name <显示名>（只作用于当前会话 Provider；只改显示名，不动编号）`
  }
  if (name === 'key') {
    const { providerId, provider } = providerForRuntime(runtime)
    const key = String(provider?.apiKey || '')
    const pool = Array.isArray(provider?.apiKeys) ? provider.apiKeys.length : 0
    return [
      `当前会话 Provider：\`${providerId}\`（${provider?.name || '未命名'}）`,
      `当前 API Key：${key ? `${key.slice(0, 8)}...${key.slice(-4)}` : '(未配置)'}`,
      pool ? `Key 池：${pool} 个（执行 /key 会改为单一 key 并清空池）` : null,
      '用法：/key <密钥>（只作用于当前会话 Provider）',
    ].filter(Boolean).join('\n')
  }
  if (name === 'memory') {
    const action = args[0] || 'show'
    const memoryPath = WEB_MEMORY_PATH
    if (action === 'show') return existsSync(memoryPath) ? readFileSync(memoryPath, 'utf8') : 'Web Memory 不存在'
    if (action === 'init') {
      if (existsSync(memoryPath)) return 'Web Memory 已存在，用 /memory append <内容> 追加'
      mkdirSync(DATA_DIR, { recursive: true })
      writeFileSync(memoryPath, '# Web Memory\n\n', 'utf8')
      return '已创建 Web Memory'
    }
    if (action === 'append') {
      const text = args.slice(1).join(' ').trim()
      if (!text) return '用法：/memory append <要记住的内容>'
      mkdirSync(DATA_DIR, { recursive: true })
      const current = existsSync(memoryPath) ? readFileSync(memoryPath, 'utf8') : '# Web Memory\n\n'
      writeFileSync(memoryPath, current + (current.endsWith('\n') ? '' : '\n') + text + '\n', 'utf8')
      return `已写入 Web Memory（追加 ${text.length} 字符）`
    }
    return '用法：/memory [show|init|append <内容>]'
  }
  return null
}
/**
 * 需要刷新模型下拉框的命令（执行后前端要重新拉 /api/models）。
 * 这些命令会改 Provider 的 model / models 字段。
 */
const WEB_REFRESH_MODELS = new Set(['model', 'config', 'key', 'url'])

/**
 * Web 端 ctx 依赖注入。
 *
 * 【设计】只注入 Web **真正拥有**的能力；拿不到的给 undefined，
 * 对应命令自然不可用（注册表会跳过缺依赖的模块，见 cmd-registry.mjs）。
 * 这样不会为了"让表看起来完整"而伪造一堆空实现 ——
 * 那种做法会让命令看起来存在、调用时才炸，比直接没有更糟。
 *
 * 【惰性】这些能力大多来自 core 模块，用函数返回而不是顶层 import，
 * 避免 server.mjs 启动时就拉起一堆只在特定命令用到的依赖。
 */
async function getWebCtxDeps() {
  // 一次性把要用的 core 模块拉进来。它们都是纯函数/轻量模块，
  // 动态 import 有缓存，重复调用不会重复求值。
  const [
    autoMem, compactTrash, ext, contextFiles,
    imagegen, memdir, voice, traceMod, teamMod, taskMod,
    markdownMod, modelListMod, keyPoolMod, deviceMod,
  ] = await Promise.all([
    import('../core/agent/auto-memory.mjs').catch(() => null),
    import('../core/session/compact-trash.mjs').catch(() => null),
    import('../core/commands/cmd-extensions.mjs').catch(() => null),
    import('../core/session/context-files.mjs').catch(() => null),
    import('../core/tools/tools-imagegen.mjs').catch(() => null),
    import('../core/infra/memdir.mjs').catch(() => null),
    import('../core/phone/voice-read.mjs').catch(() => null),
    import('../core/api/trace.mjs').catch(() => null),
    // 【2026-10-05 修】原来引用 ../core/team-store.mjs 和 ../core/mcp-config.mjs，
    // 这两个文件从来不存在（历史遗留），靠 .catch(() => null) 静默兜底成 null。
    // 真实来源：listTeams 在 agent/teams.mjs、listTasks 在 agent/tasks.mjs、
    // MCP_CONFIG_PATH 本文件顶部已有（第 120 行），不需要额外模块。
    import('../core/agent/teams.mjs').catch(() => null),
    import('../core/agent/tasks.mjs').catch(() => null),
    import('../core/ui/markdown.mjs').catch(() => null),
    import('../core/api/model-list.mjs').catch(() => null),
    import('../core/commands/cmd-key-pool.mjs').catch(() => null),
    import('../core/phone/device.mjs').catch(() => null),
  ])

  return {
    // 版本号从 package.json 读（别硬编码，也别引用 CLI 的局部变量 ——
    // 我一开始写 CLI_VERSION 直接导致所有注册表命令抛 ReferenceError、
    // 静默回退到手写分支，表现是「改了等于没改」）。
    cliVersion: (() => {
      try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version } catch { return 'web' }
    })(),

    // ── /style（回复偏好）──
    // Web 的资料读写走 web-profile.json（与 CLI 的 cli-profile.json 分开）。
    // cmd-style.mjs 通过 ctx.getProfile / ctx.setProfile 使用它们。
    getProfile: () => (loadWebProfile().personal_preferences || '').trim(),
    setProfile: (v) => {
      try { saveWebProfile({ personal_preferences: String(v ?? '') }); return { ok: true } }
      catch (e) { return { ok: false, error: `写入失败: ${e.message}` } }
    },

    // ── 设备 shell 通道（/device）──
    device: deviceMod || null,

    // ── 自动记忆 ──
    setAutoMemEnabled: autoMem?.setAutoMemEnabled,
    getAutoMemStatus: autoMem?.getAutoMemStatus,

    // ── 备份 ──

    // ── compact 回收站 ──
    listCompactTrash: compactTrash?.listCompactTrash,
    readCompactTrash: compactTrash?.readCompactTrash,
    restoreCompactTrash: compactTrash?.restoreCompactTrash,
    deleteCompactTrash: compactTrash?.deleteCompactTrash,
    backupBeforeCompact: compactTrash?.backupBeforeCompact,

    // ── 上下文 ──
    cmdContext: ext?.cmdContext,
    formatContextFiles: contextFiles?.formatContextFiles,
    getMaxContext: () => {
      try { return loadWebConfig().maxContextTokens || 200000 } catch { return 200000 }
    },
    setMaxContext: (n) => {
      const config = loadWebConfig()
      config.maxContextTokens = n
      saveWebConfig(config)
    },

    // ── 生图 ──
    getImageGenConfig: imagegen?.getImageGenConfig,
    setImageGenConfig: imagegen?.setImageGenConfig,

    // ── 记忆目录 ──
    getMemoryDir: memdir?.getMemoryDir,
    listMemories: memdir?.listMemories,
    formatMemoryList: memdir?.formatMemoryList,
    findRelevantMemories: memdir?.findRelevantMemories,
    saveMemory: memdir?.saveMemory,
    deleteMemory: memdir?.deleteMemory,

    // ── 语音（Web 端由渲染层 /voice 控制，这里只读状态）──
    voiceStatus: voice?.voiceStatus,
    getVoice: voice?.getVoice,
    isVoiceEnabled: voice?.isVoiceEnabled,

    // ── 追踪 ──
    trace: traceMod ? {
      listTraces: traceMod.listTraces,
      readTrace: traceMod.readTrace,
      formatTraceList: traceMod.formatTraceList,
      formatTraceEvents: traceMod.formatTraceEvents,
      formatTraceReplay: traceMod.formatTraceReplay,
      TRACE_DIR: traceMod.TRACE_DIR,
    } : undefined,

    // ── 统计 ──
    cmdStats: ext?.cmdStats,
    cmdTemperature: ext?.cmdTemperature,

    // ── 团队 / 任务 ──
    listTeams: teamMod?.listTeams,
    listTasks: taskMod?.listTasks,
    listTaskLists: taskMod?.listTaskLists,
    teamOverview: teamMod?.teamOverview,
    formatTeamOverview: teamMod?.formatTeamOverview,
    inboxCounts: teamMod?.inboxCounts,
    deleteTeam: teamMod?.deleteTeam,
    resetTaskList: taskMod?.resetTaskList,

    // ── 权限 ──
    cmdPermissions: ext?.cmdPermissions,

    // ── MCP ──
    mcpConfigPath: MCP_CONFIG_PATH,

    // ── 其他命令模块要的（2026-09-24 批量补）──
    //
    // 【为什么之前没有】这些字段是「命令模块要用、但适配层和 deps 都没接通」的
    // 黑洞。实测受影响的命令：/backup /imagegen /pexels /permissions /mcp
    // ——注册表执行失败后静默回退手写分支，用户看到的是「命令没反应」。
    //
    // 原则：能提供真实实现就提供；Web 上确实没有的给安全降级值（不是 undefined，
    // 否则命令里一次方法调用就崩）。绝不写 `deps.x ?? undefined`——
    // 那和不写没区别。
    maskKey: maskKeyForDisplay,          // server.mjs 已有（558 行），直接复用

    // ── QQ 桥（/qq 用）──
    // getter 形式：桥异步启动，deps 可能是它存在之前构造的。
    getQqBridge: () => qqBridgeRef,
    listQqEndpoints,
    detectQqEndpoint: detectEndpoint,
    labelQqEndpoint: endpointLabelOf,
    saveQqConfig,
    loadQqConfig,
    startQqBridge: (opts) => startQqBridgeIfNeeded({ ...opts, force: true }),
    stopQqBridge: () => { try { qqBridgeRef?.stop() } catch {} qqBridgeRef = null; for (const rt of runtimes.values()) invalidateRuntimeEngine(rt) },
    PROJECT_CONFIG_PATH: join(ROOT, 'config.json'),
    getMarkdownTheme: markdownMod?.getMarkdownTheme,
    markdownThemeNames: markdownMod?.markdownThemeNames,
    setMarkdownTheme: markdownMod?.setMarkdownTheme,
    keyPoolDescribe: null,   // cmd-key-pool.mjs 没有这个导出（只有 renderPoolStatus）
    keyPoolNonInteractiveHint: keyPoolMod?.keyPoolNonInteractiveHint,
    renderModelList: modelListMod?.renderModelList,
    renderPoolStatus: keyPoolMod?.renderPoolStatus,
    // 向导类：Web 侧的 runSelect 会抛 SelectRequired 让前端弹列表，
    // 所以这里不需要 Termux 的终端向导 —— 给 null 让命令走非交互路径。
    runModelWizard: null,
    runKeyPoolWizard: null,
    onReload: () => {},                  // /agents 改配置后让 agent 重载；Web 每次命令都新建 ctx，不需额外动作
    isProtectedPath: () => false,        // /add-dir 的 incognito 保护；Web 侧无此概念
    cols: () => 60,                      // /goal 卡片宽度（与 1830 行的调用点一致）
    getTokens: () => 0,                  // /goal 的 token 预算显示；Web 侧由 server 统计，命令层暂不需要
    recordError: (kind, err) => {
      // /errors 显示本进程最近错误。Web 侧没有 index.mjs 那种错误收集器，
      // 这里最小实现：只往 console 记，让 /errors 至少有东西可返回。
      try { console.warn(`[web:error] ${kind}:`, err?.message || err) } catch {}
    },
    HIDDEN_COMMANDS: new Set(),          // /help 用它过滤；Web 无隐藏命令

    // ── 会话存储 ──
    // 【2026-09-23 修】原来没传，导致 Web 上 /load /delete 直接崩
    // （ctx.sessionStore 是 undefined → "Cannot read properties of undefined"），
    // /save 则是假成功（saveSession 是空实现，什么都没存）。
    // 诊断方式：用 buildWebCtx 不带 deps 跑一遍注册表命令，看哪些抛错。
    sessionStore: store,
    saveSession: (rt) => saveRuntime(rt),
    // /resume 无参时用：取最近一次保存的会话。
    // Web 没有 index.mjs 的 setupAutoSession（那是终端专用的自动保存），
    // 所以这里直接问 store —— 逻辑与 core/session-auto.mjs 的 tryResume 一致：
    // 文件能解析就恢复指针，历史为空时单纯不 setHistory（不返回 null）。
    tryResume: () => {
      const latest = store.latest?.()
      if (!latest) return null
      const data = store.load(latest)
      if (!data) return null
      const msgs = Array.isArray(data.messages) ? data.messages : []
      return { ...data, messages: msgs, sessionId: latest, empty: msgs.length === 0 }
    },

    // ── 系统配置命令（/cache /compact-threshold /workspace /me /check /context7）──
    // 【2026-10-05 加】这批命令原来只在 index.mjs 手写，Web 拿不到。
    // 拆进 core/commands/cmd-system-config.mjs 后两端共用，这里补依赖。
    //
    // 工作区：必须给真实现 —— Web 有 /api/workspace 端点，是真实功能
    // （/workspace 命令只是它的 slash 入口）。
    normalizeWorkspace,
    saveWebSettings,
    workspacePath: () => loadWebSettings().workspacePath,
    // /check 的工作目录：源码根（预检扫的是项目 .mjs，不是用户工作区）
    sourceRoot: ROOT,
    // /context7 用
    mcpPath: MCP_PATH,
  }
}

/** 同步取 core 模块的辅助（这些模块体积小、纯函数多，同步 require 可接受）。 */
function require_core(name) {
  // ESM 没有同步 require，这里只作占位 —— 真正需要时改为异步。
  throw new Error(`core/${name}.mjs 需要异步加载`)
}

async function executeSlashCommand(runtime, raw) {
  const match = String(raw || '').trim().match(/^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  const [, name, argText = ''] = match
  ensureRuntimeExtensions(runtime)
  if (runtime.commandLoader?.has(name)) return { kind: 'prompt', content: runtime.commandLoader.expand(name, argText)?.content || '' }
  const skill = runtime.skillLoader ? expandActiveSkill(runtime.skillLoader, name, argText) : null
  if (skill) return skill.error ? { kind: 'output', text: skill.message } : { kind: 'prompt', content: skill.content }
  const args = argText.trim() ? argText.trim().split(/\s+/) : []

  // ═══════════════════════════════════════════════════════════════════
  // 【2026-09-19】注册表优先 —— 复用 CLI 的命令实现，不再各写一套。
  //
  // 用户要求：「不在 web 搞另一套 slash 了，复用 cli。有向导的也复用」。
  //
  // 流程：先用 buildWebCtx 把 web runtime 翻译成 CLI 模块认识的 ctx，
  // 查 core/cmd-registry.mjs 的表；命中就执行并返回。
  // 下面保留的手写分支只剩「web 特有、CLI 没有对应实现」的部分
  // （如 /config 的会话级 Provider 覆盖、/deep /watch 这类 web 运行时开关）。
  //
  // 用 runWebCommand 包一层的原因见 command-adapter.mjs：
  // web 是非交互环境，向导类命令要短路成文本提示而不是崩在 rl=null。
  // ═══════════════════════════════════════════════════════════════════
  try {
    // 【2026-09-24】有些命令一上来就要用 agent，但 Web 的 agent 是懒建的
    // （只有 buildAgent(runtime) 被调过才有）。
    // 后果：新建会话后立刻敲 /branch → `cmdBranch(..., ctx.agent, ...)` 收到 null
    // → "Cannot read properties of null (reading 'getHistory')"。
    //
    // 下面这几个命令在实现里直接读 ctx.agent，先在分发前把 agent 建好。
    // 不在列表里的命令（/model、/url、/config 这些）**不该**建 agent ——
    // 建 agent 要读系统提示词、装配工具集，有明显开销，
    // 而这些命令只是改配置，不需要 agent。
    // 只有**真的读 ctx.agent** 的命令才放这里。
    // /load /save /rename /resume /delete 是纯会话元数据操作，不需要 agent
    // —— 放进来会让它们白白等一次 buildAgent（实测首次 28 秒）。
    const NEEDS_AGENT = new Set(['branch', 'rewind', 'copy'])
    if (NEEDS_AGENT.has(name)) {
      try { await buildAgent(runtime) } catch (e) {
        console.warn(`[web slash] /${name} 预备 agent 失败:`, e?.message || e)
      }
    }

    const ctx = buildWebCtx(runtime, await getWebCtxDeps())
    const { table } = buildCommandTable(ctx, { platform: 'web' })
    const handler = table.get(name)
    if (handler) {
      const out = await runWebCommand(handler, args)
      // __wizard 信号：命令需要交互式向导（如 /config provider add 无参）。
      // CLI 侧 index.mjs 收到这个信号会调 runWizard 画终端界面；
      // Web 侧转成 { kind:'wizard' }，前端弹表单。
      // 两边最终都调用 core/wizard-steps.mjs 里**同一份** apply 落盘。
      if (out && typeof out === 'object' && out.__wizard) {
        const { getWizard } = await import('../core/commands/wizard-steps.mjs')
        const wizard = getWizard(out.__wizard)
        if (wizard) {
          const config = loadWebConfig()
          return {
            kind: 'wizard',
            wizardId: out.__wizard,
            title: wizard.title,
            steps: wizard.steps({ config }),
          }
        }
      }
      if (out != null) {
        // 命令能跑但改了不影响 Web 的（如 /font 只影响终端字体）→ 追加说明。
        // 用户要求：「有些只修改 cli，对 web 无效」—— 不说明的话用户会以为改坏了。
        const { appendWebNoEffectNote } = await import('../core/commands/cmd-registry.mjs')
        return {
          kind: 'output',
          text: appendWebNoEffectNote(name, String(out)),
          refreshModels: WEB_REFRESH_MODELS.has(name),
        }
      }
      // handler 返回 null 表示"我不处理这个形态"，落到下面的手写分支
    }
  } catch (error) {
    // WizardRequired：命令需要交互，转成前端可渲染的弹窗请求
    if (error instanceof WizardRequired) {
      return { kind: 'wizard', wizardId: error.wizardId, title: error.title, steps: error.steps }
    }
    // SelectRequired：命令要用户「从一批里挑一个」（如 /model 无参拉模型列表）。
    // 【2026-09-20 新增】原来 runSelect 被实现成抛空的 WizardRequired，
    // 列表被丢弃，前端弹不出东西。现在原样把 items 交给前端渲染成可滚动列表。
    if (error instanceof SelectRequired) {
      return {
        kind: 'select',
        title: error.title,
        items: error.items,
        initial: error.initial,
        footer: error.footer,
        multi: error.multi,
        // 选中后服务端要执行什么 —— 见 SelectRequired 的注释
        action: error.action,
        meta: error.meta,
      }
    }
    // 注册表里的命令抛错不该让整个命令失效 —— 记下来继续走手写分支兜底，
    // 这样即使某个 CLI 模块在 web 环境下有 bug，用户仍能用原来的实现。
    // 【2026-09-24 加统计】把降级记下来 —— 只打 console 的话，
  // 用户在手机上永远看不到（logcat 门槛高），于是「命令静默失败」被当成「没反应」。
  // 现在累计到 runtime.slashFallbacks，/doctor 会显示，并在界面提示。
  //
  // 为什么不全改成报错：注册表里的命令抛错**不该让整个命令失效** ——
  // 手写分支兜底能让用户在 bug 修复前继续用。这是有意的容错设计。
  // 但容错必须**可见**，否则就变成掩盖问题。
  try {
    const msg = String(error?.message || error)
    console.error(`[web slash] 注册表执行 ${name} 失败，回退手写分支:`, msg)
    if (!Array.isArray(runtime.slashFallbacks)) runtime.slashFallbacks = []
    // 同一命令只记一条（记次数），避免刷屏
    const hit = runtime.slashFallbacks.find(x => x.name === name)
    if (hit) { hit.count++; hit.lastAt = new Date().toISOString(); hit.msg = msg }
    else runtime.slashFallbacks.push({ name, msg, count: 1, lastAt: new Date().toISOString() })
    // 上限保护：长会话里可能积累很多
    if (runtime.slashFallbacks.length > 50) runtime.slashFallbacks.splice(0, runtime.slashFallbacks.length - 50)
    emit(runtime, 'slash_fallback', { name, msg })
  } catch {}
  }

  // /model 只切当前会话模型；/config 切 Provider（排在后，避免被模型名匹配）。
  if (name === 'model') {
    let requested = argText.trim()
    if (requested) {
      if (runtime.running) return { kind: 'output', text: '当前会话正在生成，完成后再切换模型。' }
      const config = loadWebConfig()
      // 与 CLI 统一语法：第一个参数若命中 Provider ID 则指定目标。
      const firstTok = requested.split(/\s+/)[0]
      const providerId = config.providers[firstTok] ? firstTok : resolveProviderId(config, runtime.providerId)
      if (config.providers[firstTok]) requested = requested.slice(firstTok.length).trim()
      const provider = config.providers[providerId]
      if (!provider) return { kind: 'output', text: `当前会话 Provider 不存在：${providerId}` }
      if (!requested) return { kind: 'output', text: `用法：/model [id] <模型名>（id 省略 = 当前会话 Provider）` }
      const previous = provider.model || '(unknown)'
      // 与 CLI /model 一致：直接修改当前会话绑定的 Web Provider，允许任意模型名。
      provider.model = requested
      // 同时写入 models 清单，下拉框才能立即出现新模型。
      const models = Array.isArray(provider.models) ? provider.models : []
      if (!models.some(model => model?.id === requested)) models.push({ id: requested, name: requested, enabled: true, tier: 'extra' })
      provider.models = models
      runtime.model = null
      saveWebConfig(config)
      invalidateRuntimeEngine(runtime)
      runtime.updatedAt = new Date().toISOString()
      saveRuntime(runtime)
      return { kind: 'output', text: `Provider \`${providerId}\`（${provider.name || providerId}）模型已切换：${previous} → ${requested}\n已保存到 web-config.json；未切换 Provider。下拉框已同步。`, refreshModels: true }
    }
  }
  if (name === 'config') {
    const requested = argText.trim()
    // /config test [ProviderID|Provider名]：和 CLI 一样发真实的最小请求。
    // 这会消耗供应商额度；目的是验证 URL、Key、模型、协议和思考参数确实可用。
    if (args[0]?.toLowerCase() === 'test') {
      if (runtime.running) return { kind: 'output', text: '当前会话正在生成，完成后再测试 Provider。' }
      const config = loadWebConfig()
      const requestedId = args[1] || runtime.providerId || config.current
      const providerId = config.providers[requestedId]
        ? requestedId
        : Object.entries(config.providers).find(([id, p]) => p.name === requestedId)?.[0]
      if (!providerId || !config.providers[providerId]) {
        return { kind: 'output', text: `Provider 不存在：${requestedId}\n用法：/config test [Provider ID 或名称]` }
      }
      const provider = config.providers[providerId]
      const model = runtime.model && providerId === runtime.providerId ? runtime.model : (provider.model || '')
      if (!provider.url || !(provider.apiKey || (Array.isArray(provider.apiKeys) && provider.apiKeys.length))) {
        return { kind: 'output', text: `Provider ${providerId} 配置不完整：缺少 URL 或 API Key。` }
      }
      const testApi = new ApiClient({
        baseUrl: provider.url,
        apiKey: provider.apiKey,
        apiKeys: provider.apiKeys,
        model,
        protocol: provider.protocol || 'openai',
        temperature: Number(provider.temperature) || 1,
        maxOutputTokens: provider.maxOutputTokens || null,
        thinkingConfig: thinkingConfigForRuntime({ ...runtime, providerId }, config),
        systemTopLevel: !!provider.systemTopLevel,
      })
      const startedAt = Date.now()
      const result = await testApi.testConnection(10000)
      const elapsed = Date.now() - startedAt
      return { kind: 'output', text: result.ok
        ? `Provider ${providerId} 连接正常（${provider.name || providerId}）\n模型：${model || '(unknown)'}\n耗时：${elapsed}ms\n实际请求：${testApi.describeThinkingPolicy?.() || '(unknown)'}\n注意：以上为真实 API 探测请求，可能计费。`
        : `Provider ${providerId} 连接失败（${provider.name || providerId}）\n模型：${model || '(unknown)'}\n耗时：${elapsed}ms\n错误：${result.error}\n实际请求：${testApi.describeThinkingPolicy?.() || '(unknown)'}` }
    }
    // ═══════════════════════════════════════════════════════════════════
    // 子命令补全（2026-09-19）
    //
    // 【为什么必须补】Web 端的 /config 原来只有 test 和「切 Provider」两条路，
    // 其余一律掉进「Provider 不存在」——用户敲 /config vision off 想关识图路由，
    // 得到的是「Provider 不存在：vision off」，识图一直开着，图片一直发给
    // 不支持识图的模型，于是反复报 image_url / 无可用账号。
    // 用户为此敲了几十次 /config vision set N 都没用。
    //
    // 这里复用 core/cmd-extensions.mjs 的 cmdConfig —— CLI 已经实现得很完整
    // （vision / provider add|rm|rename|list / stream / maxctx / profile …），
    // 重写一遍必然两边漂移。Web 只需要换掉「config 从哪来、存到哪」。
    // ═══════════════════════════════════════════════════════════════════
    // 注意：不含 'list'（CLI 的 cmdConfig 也不认它；Provider 列表是 /config provider list）
    // `show` 必须在这里：CLI 的 cmdConfig 有 `if (!args[0] || args[0] === 'show')` 分支，
    // 但 Web 的白名单漏了它 → 敲 /config show 掉进「切 Provider」分支报
    // 「Provider 不存在：show」，而补全面板里却明明白白列着它（自相矛盾）。
    // 【2026-09-19 修正】之前这里把 `list` 排除在外，理由是「CLI 的 cmdConfig 不认它」——
    // **那是错的**。index.mjs:4198 的 config 子命令 candidates 第一个就是 'list'，
    // cmd-extensions.mjs:427 也有 `if (args[0] === 'list' || !args[0])` 分支。
    // 排除的结果：用户在 Web 敲 /config list（最常用的「看配置」入口，CLI 里排第一）
    // 掉进「切 Provider」分支，报「Provider 不存在：list」—— 命令看起来是坏的。
    const SUBCOMMANDS = ['list', 'show', 'vision', 'provider', 'stream', 'maxctx', 'greeting', 'profile']
    let sub = args[0]?.toLowerCase()
    // `list` 是 `show` 的同义词：CLI 的补全面板把 list 排在第一位（用户习惯敲它），
    // 但 cmdConfig 只实现了 show 分支 —— 直接透传会得到「未知配置项: list」。
    // 这里做一次别名映射，让两条路都能用（CLI 侧的 list 仍是幽灵条目，那边没管）。
    if (sub === 'list') {
      sub = 'show'
      args[0] = 'show'
    }
    if (sub && SUBCOMMANDS.includes(sub)) {
      if (runtime.running) return { kind: 'output', text: '当前会话正在生成，完成后再改配置。' }
      const config = loadWebConfig()
      // Provider ID 是字符串键（可能是 '1' 这种数字形态），cmdConfig 用 config.current
      // 定位「当前 Provider」，Web 里对应的其实是 runtime.providerId（会话级）。
      // 临时对齐，执行完还原，绝不让 cmdConfig 把会话的 Provider 写回全局。
      const sessionProviderId = runtime.providerId
      const savedCurrent = config.current
      config.current = sessionProviderId || config.current
      const { cmdConfig } = await import('../core/commands/cmd-extensions.mjs')
      let output
      try {
        output = await cmdConfig(args, config, runtime.agent?.api || null,
          (c) => saveWebConfig(c),
          // onVisionConfig：CLI 用它重建 api 实例的识图配置。Web 的引擎按 Provider
          // 懒建，这里只需让缓存的引擎失效，下一轮会带着新 vision 设置重建。
          () => invalidateRuntimeEngine(runtime, { extensions: true }))
      } catch (e) {
        return { kind: 'output', text: `命令执行失败：${e?.message || e}` }
      }
      // 还原全局 current：cmdConfig 内部可能改过它（如 /config list 不会，
      // 但 provider rename 会同步引用）。Web 的默认 Provider 由设置页管理，
      // 不该被一条命令顺手改掉。
      if (loadWebConfig().current === sessionProviderId && savedCurrent !== sessionProviderId) {
        const c2 = loadWebConfig(); c2.current = savedCurrent; saveWebConfig(c2)
      }
      // 切 Provider 类的子命令（如 /config provider rm 当前项）要让会话跟上
      const after = loadWebConfig()
      if (after.current && after.providers?.[after.current] && after.current !== sessionProviderId && sub === 'provider') {
        runtime.providerId = after.current
        runtime.model = null
        saveRuntime(runtime)
      }
      // 【2026-09-19】__wizard 信号：cmdConfig 对「需要交互」的子命令（如
      // /config provider add 无参）返回 { __wizard: 'provider-add' }，
      // 由调用方去跑向导。CLI 侧 index.mjs 收到就调 runWizard 画终端界面；
      // Web 侧转成 { kind:'wizard' } 让前端弹表单。
      //
      // 原来这里写的是 `typeof output === 'string' ? output : '(无输出)'` ——
      // 对象被吞成"(无输出)"，用户敲 /config provider add 得到一句莫名其妙的话。
      if (output && typeof output === 'object' && output.__wizard) {
        const { getWizard } = await import('../core/commands/wizard-steps.mjs')
        const wizard = getWizard(output.__wizard)
        if (wizard) {
          return { kind: 'wizard', wizardId: output.__wizard, title: wizard.title, steps: wizard.steps({ config: loadWebConfig() }) }
        }
      }
      return { kind: 'output', text: typeof output === 'string' ? output : '(无输出)', refreshModels: sub === 'provider' }
    }

    if (requested) {
      if (runtime.running) return { kind: 'output', text: '当前会话正在生成，完成后再切换 Provider。' }
      const config = loadWebConfig()
      // /config 只识别 Provider ID 或 name，不识别模型名（防止歧义）。
      const providerId = requested && config.providers[requested]
        ? requested
        : Object.entries(config.providers).find(([id, provider]) => provider.name === requested)?.[0]
      if (!providerId) {
        const ids = Object.entries(config.providers).map(([id, p]) => `${id} (${p.name || id})`).join(', ')
        // 【2026-09-19】给「像子命令但不是子命令」的输入一句指路。
        // 例：用户敲 /config list 想「列出 Provider」，但正确写法是 /config provider list；
        // 原来只回一句「Provider 不存在：list」，用户不知道正确的是什么。
        const SUBCMD_HINTS = {
          list: '/config provider list',
          providers: '/config provider list',
          rm: '/config provider rm <id>',
          add: '/config provider add name=... url=... model=...',
          rename: '/config provider rename [旧ID] <新ID>',
        }
        const hint = SUBCMD_HINTS[requested.toLowerCase()]
        const hintLine = hint ? `\n你可能想用：\`${hint}\`` : ''
        const subList = SUBCOMMANDS.join(' | ')
        return { kind: 'output', text: `Provider 不存在：${requested}\n可用 Provider：${ids}${hintLine}\n\n/config 可用的子命令：${subList}\n（/config 只识别 Provider ID 或 name，不识别模型名；切模型请用 /model）` }
      }
      const provider = config.providers[providerId]
      runtime.providerId = providerId
      runtime.model = null // 切 Provider 后回到该 Provider 的默认模型
      config.current = providerId
      saveWebConfig(config)
      invalidateRuntimeEngine(runtime, { extensions: true })
      runtime.updatedAt = new Date().toISOString()
      saveRuntime(runtime)
      return { kind: 'output', text: `已切换 Provider: ${providerId} (${provider.name || providerId})\n模型: ${provider.model || '(unknown)'}` }
    }
  }
  if (name === 'url' || name === 'key' || name === 'name') {
    let requested = argText.trim()
    if (!requested) return { kind: 'output', text: formatCommandResult(name, runtime, args) }
    if (runtime.running) return { kind: 'output', text: '当前会话正在生成，完成后再修改 Provider。' }
    const config = loadWebConfig()
    // 与 CLI 统一语法：第一个参数若命中 Provider ID 则指定目标，否则操作当前会话绑定的 Provider。
    let providerId = matchProviderId(config, runtime.providerId)
    const firstTok = requested.split(/\s+/)[0]
    if (config.providers[firstTok]) {
      providerId = firstTok
      requested = requested.slice(firstTok.length).trim()
    }
    if (!providerId) return { kind: 'output', text: `当前会话绑定的 Provider 不存在：${runtime.providerId}。请先使用 /config <id> 切换 Provider。` }
    const provider = config.providers[providerId]
    if (!provider) return { kind: 'output', text: `当前会话 Provider 不存在: ${providerId}` }
    if (name === 'name') {
      const oldName = provider.name || '(未设置)'
      provider.name = requested
      saveWebConfig(config)
      return { kind: 'output', text: `Provider \`${providerId}\` 显示名已切换：\n${oldName} → ${requested}\n（只改显示名；改编号用 CLI 的 /config provider rename）` }
    }
    if (name === 'url') {
      let parsed
      try { parsed = new URL(requested) } catch { return { kind: 'output', text: 'URL 无效，必须是 http 或 https 地址。' } }
      if (!['http:', 'https:'].includes(parsed.protocol)) return { kind: 'output', text: 'URL 只允许使用 http 或 https。' }
      const oldUrl = provider.url || '(未配置)'
      provider.url = requested.replace(/\/$/, '')
      saveWebConfig(config)
      invalidateRuntimeEngine(runtime)
      return { kind: 'output', text: `Provider \`${providerId}\`（${provider.name || providerId}）的 URL 已切换：\n${oldUrl} → ${provider.url}\n已保存到 web-config.json（不影响 CLI config.json）` }
    }
    const mask = value => value ? `${value.slice(0, 8)}...${value.slice(-4)}` : '(未配置)'
    const oldKey = String(provider.apiKey || '')
    const hadPool = Array.isArray(provider.apiKeys) ? provider.apiKeys.length : 0
    provider.apiKey = requested
    delete provider.apiKeys
    saveWebConfig(config)
    invalidateRuntimeEngine(runtime)
    return {
      kind: 'output',
      text: [
        `Provider \`${providerId}\`（${provider.name || providerId}）的 API Key 已切换：`,
        `${mask(oldKey)} → ${mask(requested)}`,
        hadPool ? `原 Key 池 ${hadPool} 个已清空，改为单一 key。` : null,
        '已保存到 web-config.json（不影响 CLI config.json）',
      ].filter(Boolean).join('\n'),
      // 密钥不能进历史原文，否则会被回显并可能出现在后续 prompt 中
      historyContent: `/key [已更新 ${mask(requested)}]`,
    }
  }
  // /goal —— 目标契约。工具（GetGoal/GoalStatus/SetGoalBudget）已经注册进
  // engine-setup，但 Web 原来没有命令入口，用户没法设目标。
  // 复用 core/cmd-goal.mjs 的解析（ctx 只要 4 个字段）。
  if (name === 'goal') {
    await buildAgent(runtime)
    const result = handleGoalCommand(args, {
      // 注意：ctx.sessionId 是**函数**（模块内写法 ctx.sessionId?.()），
      // 传字符串会当场 500。cols 同理也是函数。
      sessionId: () => runtime.id,
      cols: () => 60,   // 卡片按 60 列渲染：窄屏消息气泡也能完整显示
      getTokens: () => {
        const u = runtime.agent?.getTokenUsage?.() || {}
        return (u.input || 0) + (u.output || 0)
      },
    })
    // handleGoalCommand 用 `__startGoal` 信号表示「该开跑了」——
    // Web 里由 runMessage 的 goalDrive 分支接手，这里只把文本还回去。
    if (result && typeof result === 'object' && result.__startGoal) {
      // __startGoal = 契约已落盘，接下来该「跑」。Web 没有 CLI 那种 runGoalLoop 常驻循环，
      // 但可以让首个 goal turn 直接开跑：把契约文本作为本轮 prompt 交给 agent，
      // 之后的续轮由 GetGoal/GoalStatus 工具 + 用户「继续」驱动。
      const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '')
      return { kind: 'prompt', content: result.message || result.text, text: stripAnsi(result.text) }
    }
    const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '')
    return { kind: 'output', text: stripAnsi(String(result || '')) }
  }
  // ── 查看类命令（复用 core 的现成实现，零逻辑重复）──
  if (name === 'todos') {
    const todos = runtime.lastTodos || []
    if (!todos.length) return { kind: 'output', text: '当前没有待办。AI 用 TodoWrite 建清单后这里能看到。' }
    const lines = todos.map(t => `- [${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '→' : '○'}] ${t.content || t.subject || ''}`)
    return { kind: 'output', text: `**待办清单**\n\n${lines.join('\n')}` }
  }
  if (name === 'tasks' || name === 'team') {
    const [{ listTasks, listTaskLists }, team] = await Promise.all([
      import('../core/agent/tasks.mjs'), import('../core/agent/teams.mjs'),
    ])
    if (name === 'tasks') {
      const lists = listTaskLists()
      if (!lists.length) return { kind: 'output', text: '没有任务列表。提示 AI「用 TaskCreate 建个任务」即可。' }
      const lines = []
      for (const listName of lists) {
        const tasks = listTasks(listName)
        lines.push(`**${listName}**（${tasks.length} 个）`)
        for (const t of tasks) {
          lines.push(`- [${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '→' : '○'}] ${t.subject}${t.owner ? ` @${t.owner}` : ''}${(t.blockedBy || []).length ? ` ⟵${t.blockedBy.join(',')}` : ''}`)
        }
      }
      return { kind: 'output', text: lines.join('\n') }
    }
    const teams = team.listTeams()
    if (!teams.length) return { kind: 'output', text: '没有活跃团队。提示 AI「用 TeamCreate 组个队」即可。' }
    const out = []
    for (const t of teams) {
      const ov = team.teamOverview(t.name)
      out.push(`**${t.name}** — ${(ov?.members || []).length} 名成员`)
      for (const m of (ov?.members || [])) out.push(`- @${m.name}${m.role ? ` — ${m.role}` : ''}${m.status === 'inactive' ? '（已收工）' : ''}${m.owned ? ` · ${m.owned} 个任务` : ''}`)
    }
    return { kind: 'output', text: out.join('\n') }
  }
  if (name === 'effort') {
    await buildAgent(runtime)
    const config = loadWebConfig()
    const provider = config.providers[runtime.providerId] || config.providers[config.current] || {}
    const cur = provider.thinking || config.thinking || {}
    const sub = String(args[0] || '').toLowerCase()
    const levels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    if (!sub) {
      return { kind: 'output', text: `**思考强度**（Provider \`${runtime.providerId}\`）\n\n- 开关：${cur.enabled ? '开' : '关'}\n- 档位：${cur.effort || '(未设)'}\n- 显示：${cur.show === false ? '隐藏' : '显示'}\n- 回传历史思考：${cur.replay ? 'on' : 'off'}\n\n用法：\`/effort <档位>\`（${levels.join(' | ')}）\n\`/effort on|off\` 开关 · \`/effort show|hide\` 显示 · \`/effort replay on|off\` 回传` }
    }
    if (sub === 'on' || sub === 'off') { provider.thinking = { ...cur, enabled: sub === 'on' }; saveWebConfig(config); invalidateRuntimeEngine(runtime); return { kind: 'output', text: `思考已${sub === 'on' ? '开启' : '关闭'}。下一轮生效。` } }
    if (sub === 'show' || sub === 'hide') { provider.thinking = { ...cur, show: sub === 'show' }; saveWebConfig(config); return { kind: 'output', text: `思考过程已${sub === 'show' ? '显示' : '隐藏'}。` } }
    if (sub === 'replay') {
      const v = String(args[1] || '').toLowerCase()
      if (v !== 'on' && v !== 'off') return { kind: 'output', text: '用法：/effort replay on|off' }
      provider.thinking = { ...cur, replay: v === 'on' }; saveWebConfig(config); invalidateRuntimeEngine(runtime)
      return { kind: 'output', text: `历史思考回传已${v === 'on' ? '开启（更连贯，但更费上下文）' : '关闭（默认，省上下文）'}。下一轮生效。` }
    }
    if (!levels.includes(sub)) return { kind: 'output', text: `未知档位「${sub}」。可选：${levels.join(' | ')}` }
    provider.thinking = { ...cur, enabled: true, effort: sub }; saveWebConfig(config); invalidateRuntimeEngine(runtime)
    return { kind: 'output', text: `思考强度已设为 **${sub}**。下一轮生效。` }
  }
  if (name === 'diff') {
    const { execFileSync } = await import('node:child_process')
    const ws = runtime.workspacePath || loadWebSettings().workspacePath
    // 先确认是 git 仓库：否则 git diff 会把用法说明打到 stderr，报错很难看懂
    try { execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ws, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }) }
    catch { return { kind: 'output', text: `工作目录不是 git 仓库：\`${ws}\`\n\n（/diff 只能用于 git 仓库）` } }
    try {
      // 注意：execFileSync 不经过 shell，'--no-pager' 是 git 的**全局选项**，
      // 必须紧跟 git 之后；写在子命令后面 git 会当成未知参数并打印 usage。
      const out = execFileSync('git', ['--no-pager', 'diff', '--stat'], { cwd: ws, encoding: 'utf-8', timeout: 8000 }).trim()
      if (!out) return { kind: 'output', text: '工作区没有未提交的改动。' }
      const full = execFileSync('git', ['--no-pager', 'diff'], { cwd: ws, encoding: 'utf-8', timeout: 8000 })
      return { kind: 'output', text: `${out}\n\n\`\`\`diff\n${full.slice(0, 6000)}${full.length > 6000 ? '\n…（已截断，完整内容见文件）' : ''}\n\`\`\`` }
    } catch (e) { return { kind: 'output', text: `git diff 失败：${e.message?.slice(0, 200) || e}` } }
  }
  if (name === 'errors') {
    const log = (() => { try { return readFileSync(join(DATA_DIR, 'crash.log'), 'utf-8') } catch { return '' } })()
    if (!log.trim()) return { kind: 'output', text: '没有错误记录。' }
    const lines = log.trim().split('\n').slice(-30)
    return { kind: 'output', text: `**最近错误**（crash.log 末尾 30 行）\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`` }
  }
  if (name === 'doctor') {
    const checks = []
    const config = loadWebConfig()
    checks.push(`- Provider：\`${runtime.providerId}\` → \`${(config.providers[runtime.providerId] || {}).model || '(未设)'}\``)
    checks.push(`- 工作目录：\`${runtime.workspacePath || '(未设)'}\``)
    checks.push(`- 工具数：${runtime.toolkit?.tools?.().length || '(未初始化)'}`)
    checks.push(`- MCP 服务器：${mcpClient.servers.size} 个`)
    checks.push(`- 会话消息数：${(runtime.history || []).length}`)
    checks.push(`- 运行中：${runtime.running ? '是' : '否'}`)

    // 命令降级统计（见 executeSlashCommand 的 catch 块）。
    // 有降级说明某些命令在走兜底分支 —— 这是 Web 侧的兼容问题，
    // 值得让用户/开发者看见，而不是烂在 console 里。
    const fb = runtime.slashFallbacks
    if (Array.isArray(fb) && fb.length > 0) {
      checks.push('')
      checks.push(`⚠️ 命令降级 ${fb.length} 个（注册表实现抛错，走了兜底）：`)
      for (const f of fb.slice(-8)) checks.push(`  · /${f.name} ×${f.count} — ${String(f.msg).slice(0, 60)}`)
    }
    return { kind: 'output', text: `**自检**\n\n${checks.join('\n')}` }
  }
  if (name === 'stats') {
    const usage = runtime.agent?.getTokenUsage?.() || {}
    const hist = runtime.history || []
    return { kind: 'output', text: `**使用统计**\n\n- 消息数：${hist.length}\n- 累计输入 token：${usage.input || 0}\n- 累计输出 token：${usage.output || 0}\n- 缓存读取：${usage.cacheRead || 0}\n- 工具调用：${(hist.filter(m => Array.isArray(m.content) && m.content.some(b => b?.type === 'tool_use')).length)} 轮` }
  }
  if (name === 'summary') {
    const hist = runtime.history || []
    const userMsgs = hist.filter(m => m.role === 'user' && !m.hidden)
    return { kind: 'output', text: `**会话摘要**\n\n- 标题：${runtime.title || '新对话'}\n- 用户消息：${userMsgs.length} 条\n- 总消息：${hist.length} 条\n- 创建：${runtime.createdAt || '—'}\n- 最后活动：${runtime.updatedAt || '—'}\n\n最近几条：\n${userMsgs.slice(-5).map(m => `- ${String(m.uiText || m.content || '').slice(0, 60)}`).join('\n') || '（无）'}` }
  }
  if (name === 'compact-trash') {
    const { listCompactTrash } = await import('../core/session/compact-trash.mjs')
    const items = listCompactTrash()
    if (!items.length) return { kind: 'output', text: '压缩回收站是空的。' }
    return { kind: 'output', text: `**压缩回收站**（${items.length} 项）\n\n${items.slice(0, 20).map((it, i) => `${i}. ${it.name || it.file} — ${it.size || ''} ${it.time || ''}`).join('\n')}` }
  }
  if (name === 'watch') {
    await buildAgent(runtime)
    const sub = String(args[0] || '').toLowerCase()
    if (sub === 'on') runtime.agent.watchMode = true
    else if (sub === 'off') runtime.agent.watchMode = false
    else runtime.agent.watchMode = !runtime.agent.watchMode
    return { kind: 'output', text: runtime.agent.watchMode
      ? '**持续模式已开启** — 我不再主动结束，会一直盯着队列继续做，直到你手动停止。'
      : '**持续模式已关闭** — 恢复正常：完成一轮就交还控制权。' }
  }
  if (name === 'incognito') {
    runtime.incognito = !runtime.incognito
    return { kind: 'output', text: runtime.incognito
      ? '**隐私模式已开启** — 本轮不写会话历史、不记记忆。'
      : '**隐私模式已关闭** — 恢复正常记录。' }
  }
  if (name === 'export') {
    const hist = runtime.history || []
    const md = hist.map(m => {
      const text = Array.isArray(m.content) ? m.content.filter(b => b?.type === 'text').map(b => b.text).join('') : String(m.content || '')
      return `## ${m.role === 'user' ? '用户' : 'AI'}\n\n${text}`
    }).join('\n\n')
    const outPath = join(homedir(), 'storage', 'downloads', `web-export-${runtime.id.slice(0, 8)}.md`)
    try {
      const dir = join(homedir(), 'storage', 'downloads')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(outPath, `# ${runtime.title || '会话导出'}\n\n${md}`, 'utf-8')
      return { kind: 'output', text: `已导出 ${hist.length} 条消息到：\n\`${outPath}\`` }
    } catch (e) { return { kind: 'output', text: `导出失败：${e.message}` } }
  }

  // ── 配置类命令（与 CLI 共享同一份磁盘配置）──
  if (name === 'pexels') {
    const { makeIntegrationCommands } = await import('../core/commands/cmd-integrations.mjs')
    const integ = makeIntegrationCommands({ maskKey: (k) => k ? k.slice(0, 8) + '...' + k.slice(-4) : '(未配置)' })
    return { kind: 'output', text: String(await integ.pexels(args) || '') }
  }
  if (name === 'temperature') {
    const config = loadWebConfig()
    const provider = config.providers[runtime.providerId] || config.providers[config.current] || {}
    if (!args[0]) return { kind: 'output', text: `**温度**（Provider \`${runtime.providerId}\`）\n\n当前：${provider.temperature ?? config.temperature ?? '(默认 1)'}\n\n0 = 稳定保守，1 = 平衡，2 = 发散。改完下一轮生效。\n用法：\`/temperature <0-2>\`` }
    const t = Number(args[0])
    if (!Number.isFinite(t) || t < 0 || t > 2) return { kind: 'output', text: '温度必须在 0 到 2 之间。' }
    provider.temperature = t
    saveWebConfig(config)
    invalidateRuntimeEngine(runtime)
    return { kind: 'output', text: `温度已设为 **${t}**。下一轮生效。` }
  }
  if (name === 'voice') {
    // Web 的语音走浏览器原生 Web Speech API（见前端语音按钮），
    // 不走 CLI 那套 termux-speech-to-text，所以这里只报告状态。
    return { kind: 'output', text: '**语音输入**\n\nWeb 端用浏览器自带的语音识别（输入框旁的话筒按钮）。\n\n- 需要：浏览器有话筒权限\n- 不支持时：那个按钮会提示「当前环境无法启动语音听写」\n- CLI 侧另有 `/voice` 配置项（Termux 语音命令），与 Web 互不影响' }
  }
  if (name === 'mail') {
    // 邮箱配置存在 mail-mcp-config.mjs（MCP 邮件服务共用同一份）。
    const { mailStatus } = await import('../core/integrations/mail-mcp-config.mjs')
    const status = mailStatus() || {}
    const accounts = status.accounts || status.aliases || []
    if (!accounts.length) {
      return { kind: 'output', text: '还没有配置邮箱。\n\n配置写在 CLI 侧（连接 MCP 邮件服务），Web 里可以直接告诉 AI「帮我查最近的验证码邮件」。' }
    }
    const lines = accounts.map(a => `- ${typeof a === 'string' ? a : (a.alias || a.address || a.user)}${(a && a.isDefault) ? '（默认）' : ''}`)
    return { kind: 'output', text: `**邮件账号**（${accounts.length} 个）\n\n${lines.join('\n')}` }
  }
  // ── /qq：读写与 CLI **共享的** qq-config.json ────────────────────────
  //
  // 【2026-09-19 修】原来 Web 把状态写进 web-config.json 的 qq 字段，
  // 而真实 QQ 桥（CLI index.mjs:1803）只认 ~/.claude-code-mobile/qq-config.json。
  // 两套文件 → Web 里 /qq on 界面说「已启用」，桥那边毫无反应，开关是假的。
  // 现在统一到同一份文件，字段名也对齐（qqActive / owner / port / napcatApi）。
  // 【2026-09-24 删除】这里原来有个手写的 /qq 分支，写 qqActive 字段。
  // 它已经**永远不会执行** —— executeSlashCommand 里注册表（复用 CLI 的
  // core/cmd-qq.mjs）排在前面且总会 return，手写分支是死代码。
  //
  // 留着它还有害：两套字段名（qqActive vs endpoints.cli.enabled）并存，
  // 读代码的人分不清哪个生效。现在 QQ 桥的所有逻辑统一在 core/cmd-qq.mjs。
  if (name === 'image') {
    if (!args[0]) return { kind: 'output', text: '**查看图片**\n\n用法：\`/image <路径>\`\n\n会以内联卡片展示图片。也可以直接把图拖进对话框或粘贴上传。' }
    const p = args.join(' ').trim()
    const abs = p.startsWith('/') ? p : join(runtime.workspacePath || loadWebSettings().workspacePath, p)
    if (!existsSync(abs)) return { kind: 'output', text: `文件不存在：\`${abs}\`` }
    emit(runtime, 'present', { kind: 'image', title: p, paths: [abs] })
    return { kind: 'output', text: `已展示：\`${p}\`` }
  }
  if (name === 'files') {
    const ws = runtime.workspacePath || loadWebSettings().workspacePath
    try {
      const entries = readdirSync(ws, { withFileTypes: true }).slice(0, 60)
      const lines = entries.map(e => `${e.isDirectory() ? '📁' : '📄'} ${e.name}${e.isDirectory() ? '/' : ''}`)
      return { kind: 'output', text: `**工作目录** \`${ws}\`\n\n${lines.join('\n') || '（空）'}${entries.length >= 60 ? '\n…（只显示前 60 项）' : ''}` }
    } catch (e) { return { kind: 'output', text: `读取失败：${e.message}` } }
  }

  // /coordinate（别名 /cowork）：协调者模式。
  // 【2026-09-20】用户问「web 协作模式是不是没做」→ 核实官方有 Coordinator Mode
  //（~/cc-src/claude-code-main/coordinator/coordinatorMode.ts），就是多 Agent 编排。
  // 我们的工具层（Agent/SendMessage/AgentStop/TeamCreate）早已齐备，
  // 缺的只是「把主对话切成协调者」这个开关 —— 现在补上。
  if (name === 'coordinate' || name === 'cowork') {
    await buildAgent(runtime)
    const tk = runtime.toolkit
    if (!tk?.coordinatorMode) return { kind: 'output', text: '协调者模式不可用（toolkit 未初始化）' }
    const first = String(args[0] || '').toLowerCase()
    let taskArgs = args
    if (first === 'on' || first === 'off') {
      if (first === 'on') tk.coordinatorMode.enable()
      else tk.coordinatorMode.disable()
      taskArgs = args.slice(1)
    } else if (args.length) {
      // 【带任务形态：只开不关】
      // 原来这里跟无参形态共用 toggle()，导致「先敲 /coordinate 开了模式，
      // 再敲 /coordinate <任务>」会把模式**又关掉**，任务没接住（实测返回 output 而非 prompt）。
      // 语义上「/coordinate <任务>」的意思是「用协调者模式做这件事」，
      // 所以只 enable、不 toggle —— 与无参形态（纯切换开关）区分开。
      tk.coordinatorMode.enable()
    } else {
      tk.coordinatorMode.toggle()
    }
    const now = tk.coordinatorMode.enabled
    // 提示词里带着模式段，切换后必须刷新（与 /plan 同理）
    if (runtime.agent) runtime.agent.systemPrompt = tk.getSystemPrompt()
    emit(runtime, 'modes', { plan: !!tk.planMode?.enabled, deep: !!tk.deepMode?.enabled, coordinator: now })

    // 【带任务形态】/coordinate 补全 core/x.mjs 的错误处理
    //   → 开模式 + 立刻把任务作为用户消息跑起来（Web 的 /cowork 页面走这条）。
    // 这样用户只需一条消息就完成「进模式 + 派活」，不用先敲 /coordinate 再敲任务。
    const task = taskArgs.join(' ').trim()
    if (now && task) {
      return { kind: 'prompt', content: task }
    }
    return { kind: 'output', text: now
      ? '**协调者模式已开启** — 我只做编排（拆解任务 → 派 worker 并行 → 汇总结果），不亲自改代码。\n再次发送 `/coordinate` 或 `/coordinate off` 关闭。'
      : '**协调者模式已关闭** — 恢复正常工作方式（自己动手执行）。' }
  }
  // /deep 与 /plan：Web 里原来完全没有 —— CLI 用户最常用的两个模式开关。
  // 它们改的是 toolkit 里的全局状态，agent.maxTurns 由 buildAgent.attachAgent
  // 和 runMessage 每轮重取共同保证生效，这里只负责翻状态 + 给出反馈。
  if (name === 'deep') {
    await buildAgent(runtime)
    const next = String(args[0] || '').toLowerCase()
    const before = runtime.toolkit.deepMode.enabled
    if (next === 'on') { if (!before) runtime.toolkit.deepMode.enable() }
    else if (next === 'off') { if (before) runtime.toolkit.deepMode.disable() }
    else runtime.toolkit.deepMode.toggle()
    const now = runtime.toolkit.deepMode.enabled
    if (runtime.agent) runtime.agent.maxTurns = runtime.toolkit.deepMode.getMaxTurns()
    emit(runtime, 'modes', { plan: !!runtime.toolkit.planMode.enabled, deep: !!runtime.toolkit.deepMode.enabled, maxTurns: runtime.agent?.maxTurns || runtime.toolkit.deepMode.getMaxTurns() })
    return { kind: 'output', text: now
      ? `**深度模式已开启** — 本轮起 maxTurns 提升至 ${runtime.toolkit.deepMode.getMaxTurns()} 轮，适合多文件、反复调试的长任务。\n再次发送 \`/deep\` 或 \`/deep off\` 关闭。`
      : `**深度模式已关闭** — maxTurns 恢复为 ${runtime.toolkit.deepMode.getMaxTurns()} 轮。` }
  }
  if (name === 'plan') {
    await buildAgent(runtime)
    const next = String(args[0] || '').toLowerCase()
    const before = runtime.toolkit.planMode.enabled
    if (next === 'on') { if (!before) runtime.toolkit.planMode.enable() }
    else if (next === 'off') { if (before) runtime.toolkit.planMode.disable() }
    else runtime.toolkit.planMode.toggle()
    const now = runtime.toolkit.planMode.enabled
    // 系统提示词里带着模式段，切换后必须刷新
    if (runtime.agent) runtime.agent.systemPrompt = runtime.toolkit.getSystemPrompt()
    emit(runtime, 'modes', { plan: now, deep: !!runtime.toolkit.deepMode.enabled, maxTurns: runtime.agent?.maxTurns || null })
    return { kind: 'output', text: now
      ? '**计划模式已开启** — 我会先给出执行计划，等你确认后再动手。'
      : '**计划模式已关闭** — 恢复正常执行。' }
  }
  if (name === 'tools' || name === 'compact') await buildAgent(runtime)
  if (name === 'compact') {
    const force = args[0] === 'force' || /^\d+$/.test(args[0] || '')
    const keepLast = Math.max(1, Number(force && args[0] === 'force' ? args[1] : args[0]) || 10)
    const before = runtime.agent.getHistory()
    const tokenLimit = loadWebConfig().maxContextTokens || 1000000
    try { await hookManager.trigger('PreCompact', { event: 'PreCompact', matcher: 'web', tokenCount: runtime.agent.getLastPromptTokens?.() || 0, tokenLimit }) } catch { }
    const result = await runtime.compactService.compact(before, { keepLast, force, lastPromptTokens: runtime.agent.getLastPromptTokens?.(), maxContextTokens: tokenLimit })
    if (!result.compacted) return { kind: 'output', text: `未执行压缩：${result.analysis?.reason || '无需压缩'}` }
    const backupName = backupBeforeCompact(before, { sessionId: runtime.id, reason: 'web-manual', meta: { keepLast, strategy: result.strategy } })
    runtime.agent.setHistory(result.messages)
    runtime.history = result.messages
    try { await hookManager.trigger('PostCompact', { event: 'PostCompact', matcher: 'web', tokenCount: runtime.agent.getLastPromptTokens?.() || 0, tokenLimit }) } catch { }
    return { kind: 'output', text: `压缩完成，保留最后 ${keepLast} 条。完整会话已备份：${backupName}` }
  }
  // 【已删除 2026-10-03】/backup 命令（自动备份功能下线）
  // 会话重命名/清空在 Web 用侧栏与标题栏操作，不再提供 slash 版本。
  const text = formatCommandResult(name, runtime, args)
  return text == null ? null : { kind: 'output', text }
}

async function buildAgent(runtime) {
  if (runtime.agent) return runtime.agent
  await mcpReady
  const { config, providerId, provider } = providerForRuntime(runtime)
  const activeModel = modelForRuntime(runtime, provider)
  runtime.configSnapshot = { current: config.current, providerId, model: activeModel }
  const { skillLoader, commandLoader } = createExtensionLoaders(runtime.workspacePath)
  runtime.skillLoader = skillLoader
  runtime.commandLoader = commandLoader
  if (!provider) throw new Error(`Provider不存在: ${runtime.providerId}`)
  const api = new ApiClient({ baseUrl: provider.url, apiKey: provider.apiKey, apiKeys: provider.apiKeys, model: activeModel || provider.model, protocol: provider.protocol || 'openai', temperature: Number(provider.temperature) || 1, maxOutputTokens: provider.maxOutputTokens || null, thinkingConfig: thinkingConfigForRuntime(runtime, config), systemTopLevel: !!provider.systemTopLevel })
  const isolatedTools = new Set(['Restart', 'Screencap'])
  const canRunWebTool = async (tool) => !isolatedTools.has(tool?.name || tool)
  // 【2026-10-06 加 options】前端弹窗支持选项按钮 + 自由输入框
  // （options 原来硬编码空数组 —— 前端拿不到选项，只能打字）。
  const askUser = (question, options = []) => new Promise(resolve => {
    const requestId = randomUUID()
    runtime.pendingQuestions.set(requestId, resolve)
    const opts = Array.isArray(options) ? options.filter(Boolean).slice(0, 4) : []
    emit(runtime, 'ask_user', { request_id: requestId, tool_use_id: requestId, questions: [{ question: String(question || ''), options: opts }] })
  })

  // 手机操作模式的向导 —— 首次用 phone 工具时弹，让用户自己选。
  //
  // 【为什么 Web 侧要单独接】core/tools-phone.mjs 的 setPhoneModePrompter 是
  // 模块级注入点，CLI 在 index.mjs 里用 runSelect 接了，Web 这边一直没接 ——
  // 结果是 Web 上模式永远停在 null，phone 工具静默走 idle。
  //
  // 用 ask_user 通道（前端已有对应弹窗），而不是 core/select.mjs 的委托器：
  // 这里的调用发生在**工具执行期间**，不在 slash 命令的 withDelegatedInteraction
  // 作用域里，用 select 委托会抛 SelectRequired 而没人接。
  // 【Web 端的收尾方式与 CLI 不同】—— 2026-09-26
  //
  // CLI 里一次回复结束后会把前台切回 Termux（用户就在那等着看输出）。
  // 但 Web 用户**不在 Termux 前面**，他在浏览器里看结果 ——
  // 此时把手机前台抢到 Termux 等于：顶掉他正在用的 App，且切过去也没人看。
  // 所以 Web 端改成弹 Toast（不占屏、不抢前台，哪个 App 都能看到）。
  setPhoneFinishAction('web')

  setPhoneModePrompter(async () => {
    const answer = await askUser(
      'AI 要用手机了，怎么操作？\n\n'
      + '1 = 后台（虚拟副屏，不占你屏幕）—— 固定，以后不再问\n'
      + '2 = 前台（操作主屏，你能看见）—— 固定，以后不再问\n'
      + '3 = 每次问我\n'
      + '4 = 这次不操作（不改偏好）\n\n'
      + '回复数字即可（直接回车 = 后台）'
    )
    const t = String(answer || '').trim()
    if (t === '2' || /前台|foreground/i.test(t)) return 'foreground'
    if (t === '3' || /每次|ask/i.test(t)) return 'ask'
    if (t === '4' || /idle|不操作|暂不|这次/i.test(t)) return 'idle'
    return 'background'
  })
  const workspace = runtime.workspacePath || loadWebSettings().workspacePath
  const webContext = ClaudeMdLoader.load(join(ROOT, 'web'), 1)
  if (existsSync(WEB_MEMORY_PATH)) webContext.push({ path: WEB_MEMORY_PATH, content: readFileSync(WEB_MEMORY_PATH, 'utf8').slice(0, 10000) })
  // 【2026-10-08 合并】原来这里有「输出风格（/style）注入」段（读 config.outputStyle
  // → 拼 outputStyleSection）。已删 —— 输出风格并入回复偏好，注入统一走
  // buildProfilePrompt 里的 personal_preferences（下面 toolkit.getSystemPrompt
  // 的 wrapper 里动态拼，见那段注释）。config.outputStyle 字段保留不删
  //（老配置解析不报错），但不再读取。
  //
  // ⚠️ profile 注入**不放这里**（sessionPrompt 是构造时快照，放进来改完偏好
  // 本会话内不生效 —— 正是 Web 侧一直没发现的坑）。见下方 wrapper。

  const sessionPrompt = `${WEB_SYSTEM_PROMPT}\n\n# 当前 Web session\n- sessionId: ${runtime.id}\n- workspace: ${workspace}\n- Provider: ${providerId}\n- Model: ${activeModel || provider.model || '(unknown)'}\n- Protocol: ${provider.protocol || 'openai'}`
  const toolkit = createEngineToolkit({ cwd: workspace, sessionId: runtime.id, historyFile: WEB_HISTORY_PATH, sessionsDir: SESSION_ROOT, skillsDirs: skillLoader.rootDirs, commandsDirs: commandLoader.roots, api, askUser,
  // 【2026-09-20 清理】原来这里传了 includeRestart: false —— 但 createEngineToolkit
  // 根本没有这个参数（Restart 工具 2026-08-25 就整个删了，CLI 也没有）。
  // 传一个不存在的参数会让人以为「Web 禁用了重启，CLI 有」，属于误导。
  includeTermuxTools: true, includeScreencap: false, includePhoneTools: true, contextFiles: webContext, memoryPath: WEB_MEMORY_PATH, memoryLabel: 'Web Memory', onPresent: payload => emit(runtime, 'present', payload), systemPromptBase: sessionPrompt, sessionStartPrompt: WEB_SESSION_START_PROMPT,
  // 【Web 补齐四个 CLI 工具】
  //   CommandExec  —— 包装 executeSlashCommand，模型能跑程序内命令（/cost、/context 等）。
  //                   不带 / 前缀的原始串传进去（工具描述已说明），内部自己加。
  //   watchModeSetter —— EnterWatch/ExitWatch 直接切 runtime.agent.watchMode，
  //                   与 /watch 命令同一状态源。注意 agent 可能在 setter 调用时才建好，
  //                   所以用闭包惰性取 runtime.agent。
  //   includeDshPlugin —— dsh-host 是纯 HTTP 服务，Termux 上可用，直接开。
  commandExecHandler: async (input) => {
    const raw = String(input || '').trim()
    if (!raw) return '错误: 请提供命令名称'
    const result = await executeSlashCommand(runtime, '/' + raw.replace(/^\/+/, ''))
    if (!result) return `未找到命令: ${raw}`
    if (result.kind === 'output') return String(result.text || '')
    if (result.kind === 'prompt') return String(result.content || '')
    if (result.kind === 'wizard') return `该命令需要交互式向导（${result.title || raw}），Web 里请让用户直接在输入框敲 /${raw}`
    if (result.kind === 'select') return `该命令需要用户从列表选择（${result.title || raw}），Web 里请让用户直接在输入框敲 /${raw}`
    return JSON.stringify(result)
  },
  watchModeSetter: (on) => {
    if (!runtime.agent) return   // 还没建 agent 时静默跳过（下一轮会建）
    runtime.agent.watchMode = !!on
  },
  includeDshPlugin: true,
  extraTools: [
    ...sharedMcpTools,
    new PresentTool({ cwd: workspace, onPresent: payload => emit(runtime, 'present', payload) }),
    // QQ 工具：桥没起来时**不注册** —— 否则模型看到工具名会去调，
    // 拿到「桥不可用」的错误，然后归因成自己用错了参数反复重试。
    // 工具清单里没有 = 模型不会尝试，这是更干净的失败方式。
    ...(qqBridgeRef ? [new QQPushTool(qqBridgeRef), new QQRecallTool(qqBridgeRef)] : []),
  ], systemPromptSuffix: `\n# Web 运行边界\n当前 workspace: ${workspace}\n当前 session: ${runtime.id}\n不要使用 CLI 终端语境解释 Web 交互。\n\n# 内联展示（Present）\n写完 SVG/HTML 动画、生成图表、从视频抽帧后，用 **Present** 工具把结果直接展示在对话里，用户能当场看到渲染效果，而不是读源码或文件路径。\n- SVG 动画/图形 → kind=svg，content 传源码\n- 完整 HTML（含 JS 交互）→ kind=html，沙箱 iframe 渲染\n- 流程图/时序图 → kind=mermaid\n- 图片文件（含视频抽帧）→ kind=image 单张 / kind=images 多张网格，paths 传路径\n- 视频文件 → kind=video\n- 需要用户调参时用 params 声明数值参数，前端在画面下生成滑块。拖动时热更新、动画不重启，写法优先级：\n  1) CSS 变量（最稳）：参数名 speed → content 里写 var(--speed)，例 animation-duration: calc(60s / var(--speed))\n  2) JS 回调：读 window.PARAMS.speed，并设 window.onParamChange = (name, value) => { 调整转速等 }\n  3) {{speed}} 占位符会整体重渲染（动画从头播），只用于静态图\n- 例：地球自转 → kind=svg 或 html，自转速度用 var(--speed) 驱动，params: [{ name:'speed', label:'转速', min:0.1, max:5, step:0.1, value:1 }]，用户拖条即时变速且不跳帧\n展示是额外动作，不替代文字说明：该解释的照常说。\n`, getRuntimeModelInfo: () => ({ providerId, providerName: provider.name, model: modelForRuntime(runtime, provider) || provider.model, protocol: provider.protocol || 'openai', api }), onPermissionRequest: canRunWebTool })
  toolkit.bindApi(api)

  // 识图链路：vision=true 的当前 Provider 优先；否则（或当前视觉失败）走 Web 配置 6 的 sotamodel claude-opus-5，最后 tesseract。
  // 备用 Provider 独立于当前会话 Provider，避免用户切到纯文本模型后彻底失去看图能力。
  setVisionConfig({ vision: !!provider.vision, model: activeModel || provider.model, providerId }, api, config.providers?.[config.visionProviderId || '6'] || null)
  runtime.compactService = new CompactService({ api, policy: { ...(config.compaction || {}), maxContextTokens: config.maxContextTokens || 1000000 } })
  // plan/deep 是运行时状态：systemPrompt 与 maxTurns 必须每轮重新取，
  // 否则 Agent 调了 EnterPlanMode / EnterDeepMode 也不会生效（Web 之前是静态快照）。
  runtime.toolkit = toolkit
  const baseMaxTurns = config.web?.maxTurns || NORMAL_MAX_TURNS
  toolkit.deepMode.normalMaxTurns = baseMaxTurns

  // 【2026-09-20】项目（Projects）注入：会话属于某个项目时，把该项目的
  // 「项目指令 + 知识库」追加到 systemPrompt。见 web/projects.mjs 的设计注释。
  //
  // 为什么包装 getSystemPrompt 而不是在构造 agent 时拼一次：
  // 系统提示词在运行中会被多处重新获取（模式切换、/plan、/coordinate 等都会
  // `agent.systemPrompt = toolkit.getSystemPrompt()` 重取）。若只在构造时拼一次，
  // 用户切模式后项目指令就丢了。包一层能保证**每次取都带上**，不用改那些调用点。
  //
  // 【2026-10-08 加 profile 动态注入】同理：用户资料（称呼/职业/**回复偏好**）
  // 原来拼在 sessionPrompt 里（构造时快照）—— 改了偏好后 agent.systemPrompt
  // 不会更新（agent.mjs:79 是值赋值、buildAgent 还有缓存），表现为
  // 「设置页改了回复偏好，本会话内模型看不到」。现在挪到这里每取现读：
  // 设置页保存（/api/profile）、/style 命令改完，下一轮对话即生效。
  const baseGetSystemPrompt = toolkit.getSystemPrompt.bind(toolkit)
  toolkit.getSystemPrompt = () => baseGetSystemPrompt()
    + (projectStore.buildPromptSection(runtime.id) || '')
    + (() => { try { return buildProfilePrompt(loadWebProfile()) } catch { return '' } })()

  const agent = new Agent({ api, systemPrompt: toolkit.getSystemPrompt(), tools: toolkit.tools(), useStream: () => config.stream !== false, undoStore: toolkit.multiUndo, maxTurns: config.web?.maxTurns || NORMAL_MAX_TURNS, cwd: runtime.workspacePath, sessionId: runtime.id, onPermissionRequest: canRunWebTool,
    // 【运行中插话 / mid-turn steering】agent.mjs 早就为此留了 pullSteering 钩子
    //（注释原文「Web mid-turn steering；CLI 可不传」），但 Web 服务端从没接上过 ——
    // 用户在生成中发的消息只能干等。这里把队列接上：每轮模型调用前取走全部待注入指令。
    pullSteering: () => {
      const q = runtime.steeringQueue || []
      if (!q.length) return []
      runtime.steeringQueue = []
      return q
    }, // 【断线重连快照】切页面/切后台会断开 SSE，重连时仅靠 Last-Event-ID 补发
    // 补不了超过 200 条缓冲的缺口。这里把本轮产出累积在 runtime.runSnapshot 上，
    // 重连握手（ready 事件）时直接下发，客户端立即对齐当前文本，不依赖补发。
    onText: text => {
      if (runtime.runSnapshot) runtime.runSnapshot.text += text
      // 流式正文节流落盘：长回答可能几十秒，不能等下一个检查点
      try { runtime._autosave?.throttled?.() } catch {}
      emit(runtime, 'text', { text })
      // at 必须在 emit 之后取：id 是 emit 内部才分配的，取早了会漏掉最后一条 →
      // 重连时那条事件 id > at 不被跳过，和快照叠加成重复正文。
      if (runtime.runSnapshot) runtime.runSnapshot.at = runtime.eventSeq || 0
    },
    onReasoning: text => {
      if (runtime.runSnapshot) runtime.runSnapshot.thinking += text
      try { runtime._autosave?.throttled?.() } catch {}
      emit(runtime, 'thinking', { text })
      if (runtime.runSnapshot) runtime.runSnapshot.at = runtime.eventSeq || 0
    }, onToolUse: block => {
      // 【textBefore 是消息分段的钥匙】前端按「每个工具调用前说了什么」把一轮回复
      // 切成多段：说一句 → 调工具 → 再说 → 再调。CLI 里天然是这样（终端边跑边打），
      // Web 原来只发 {id,name,input}，前端拿不到前置文字，只能把整轮文字堆到最后 ——
      // 用户看到的就是「AI 一口气把话全说完了」。
      // 这里把「到此刻为止累计的正文」作为 textBefore 发出去（前端按长度切分）。
      const textSoFar = runtime.runSnapshot?.text || ''
      emit(runtime, 'tool_start', { id: block.id, name: block.name, input: JSON.stringify(block.input || {}, null, 2), textBefore: textSoFar })
    }, onToolResult: (_tool, block, result, meta = {}) => {
      emit(runtime, 'tool_result', { id: block?.id, result: typeof result === 'string' ? result : JSON.stringify(result ?? '', null, 2), error: !!meta.error })
      // 【检查点】工具结果是天然的分段边界：这一步做完了，落一次盘
      try { runtime._autosave?.checkpoint?.() } catch {}
    }, onTodoUpdate: todos => { runtime.lastTodos = Array.isArray(todos) ? todos : []; emit(runtime, 'todos', { todos: runtime.lastTodos }) }, onUsage: usage => { const t = Number(usage?.promptTokens) || 0; if (t > 0) { runtime.lastPromptTokens = t; emit(runtime, 'context_size', { tokens: t, limit: config.maxContextTokens || 1000000, exact: true }) } } })
  // 【实时指标】CLI 状态行每轮刷新「轮/首字/吞吐」，Web 原来完全没有这个反馈。
  // 这里在每轮结束时推一次（onTurnEnd），指标本身直接取 agent.getMetrics() —— 同源同口径。
  agent.onTurnEnd = (turns) => {
    try { emit(runtime, 'metrics', { ...runtime.agent?.getMetrics?.(), turns: turns || undefined }) } catch {}
    // 【检查点】一个 turn = 一次响应 + 其工具全部完成，是最完整的落盘时机
    try { runtime._autosave?.checkpoint?.() } catch {}
  }
  agent.setHistory(runtime.history || [])
  // 【轮数提醒】agent 接近 maxTurns 时（剩 ≤10 轮）会触发一次。CLI 侧在终端打提示，
  // Web 原来完全没有 —— 用户只能等它停下来才从错误气泡里知道「到上限了」。
  // 提前上报一条事件，前端弹提示，用户可以从容决定 /deep 还是让它收尾。
  agent.onTurnLimitApproaching = (turns, max) => {
    emit(runtime, 'turn_limit', { turns, max, deep: !!runtime.toolkit?.deepMode?.enabled })
  }
  // PreToolUse / PostToolUse 由 agent 内部触发；与 CLI 同一份 hooks.json
  agent.hookManager = hookManager
  // 【自动压缩】与 CLI 同源 core/session/auto-compact.mjs。
  //
  // 2026-10-09：从「run 结束后压一次」改成「每次发 API 请求前检查」
  //（与 CLI 对齐，用户指出压缩时机应在请求前而非工具前/轮末）。
  // 原来挂在 run 结束处有两个问题：
  //   · 一次 run 几十轮，只有全部跑完才检查 —— 中途某轮就可能超上下文
  //   · 纯文本轮次（不调工具）根本不经过检查点
  // 现在每轮发请求前判定：超阈值就压，压完立刻发，判定最准。
  // agent.beforeApiRequest 由 agent.mjs 主循环调用（失败不影响请求发出）。
  agent.beforeApiRequest = async (ag) => {
    try {
      const { autoCompact } = await import('../core/session/auto-compact.mjs')
      await autoCompact(ag, runtime.compactService, {
        print: (text) => emit(runtime, 'notice', { text: String(text).replace(/\x1b\[[0-9;]*m/g, '') }),
      })
    } catch (e) {
      console.warn('[web] autoCompact 失败:', e?.message || e)
    }
  }
  // 把实例交给 toolkit：EnterDeepMode / ExitDeepMode 工具要能立刻改到它，
  // 否则模型自己开 deep 后本轮仍按旧上限被截停（CLI 侧同款 bug 已修）。
  toolkit.attachAgent?.(agent)
  runtime.toolkit = toolkit
  runtime.agent = agent
  return agent
}
async function runMessage(runtime, content, attachments = []) {
  if (runtime.running) throw Object.assign(new Error('当前会话正在生成'), { status: 409 })
  // runToken：旧任务延迟收尾时不能误清新任务的运行状态。
  const runToken = randomUUID()
  runtime.runToken = runToken
  runtime.running = true
  // 新一轮开始：快照清零（上一轮的已随 done 落盘）
  runtime.runSnapshot = { text: '', thinking: '', at: 0 }
  // 本轮事件起点清零 —— 下一个 emit 会把它设成本轮第一个事件的 id。
  // 前端新连 SSE（afterId=0）时只补发 ≥ 这个 id 的事件，不重放历史轮次。
  runtime.turnStartSeq = 0
  runtime.interruptedRun = null
  runtime.lastActiveAt = Date.now()
  runtime.controller = new AbortController()
  let agent = null
  // 事件驱动落盘（见 startRunAutosave 注释）：工具结果 / turn 结束 时同步落，
  // 流式正文期间按 300ms 节流兜底。崩溃时最多丢「最后一句话」而不是整轮。
  const autosave = startRunAutosave(runtime, () => agent)
  // 挂到 runtime 上：agent 的各个回调（onText/onToolResult/onTurnEnd）通过它触发落盘
  runtime._autosave = autosave
  try {
    agent = await buildAgent(runtime)
    const userIndex = agent.getHistory().length
    const visibleContent = String(content || '')
    captureWebInput('message', visibleContent)
    // 命令捕获：只在出现「上次注入之后的新命令」时才附带，避免每轮重复贴同一份。
    // 措辞必须明确是系统自动记录，否则模型会当成用户手动粘贴的内容。
    const recentCommands = webInputHistory.recentCommands(5).map(entry => entry.content)
    const newCommands = recentCommands.filter(command => !(runtime.injectedCommands || []).includes(command))
    const commandContext = newCommands.length
      ? `\n\n[系统自动记录 · 非用户输入] 用户在 Web 界面执行过的 slash 命令（供你了解配置变化，不需要回应）：\n${newCommands.map(command => `- ${command}`).join('\n')}`
      : ''
    if (newCommands.length) runtime.injectedCommands = recentCommands.slice(-20)
    // UserPromptSubmit hook：允许 hook 往本轮 prompt 注入额外上下文（与 CLI 一致）
    let hookInjection = ''
    try {
      const promptResult = await hookManager.trigger('UserPromptSubmit', { event: 'UserPromptSubmit', matcher: 'web', prompt: visibleContent })
      if (promptResult?.inject) hookInjection = `\n\n${promptResult.inject}`
    } catch { }
    const prepared = prepareWebModelText(`${visibleContent}${commandContext}${hookInjection}`, runtime.workspacePath)
    const modelContent = prepared.modelText
    if (!runtime.title || runtime.title === '新对话') runtime.title = visibleContent.replace(/\s+/g, ' ').trim().slice(0, 48) || '新对话'
    // 每轮重新取：Agent 上一轮调用 EnterPlanMode / EnterDeepMode 后本轮才能真正生效
    agent.systemPrompt = runtime.toolkit.getSystemPrompt()
    agent.maxTurns = runtime.toolkit.deepMode.getMaxTurns()
    emit(runtime, 'modes', { plan: !!runtime.toolkit.planMode.enabled, deep: !!runtime.toolkit.deepMode.enabled, maxTurns: agent.maxTurns })
    emit(runtime, 'run_start', { title: runtime.title, userIndex })
    await agent.run(buildUserContent(modelContent, attachments), { signal: runtime.controller.signal })
    if (runtime.runToken !== runToken) return
    runtime.history = agent.getHistory()
    // 保存后的用户块内容是注入态，另存 uiText 让刷新后气泡仍只显示用户原话。
    const historyEntry = runtime.history[userIndex]
    if (historyEntry?.role === 'user') {
      historyEntry.uiText = visibleContent
      // 引用只保留元信息；下一轮不会重复携带旧快照。
      if (prepared.refs?.length) historyEntry.webRefs = prepared.refs.map(path => ({ path, loadedAt: new Date().toISOString() }))
      if (Array.isArray(historyEntry.content)) {
        const textBlock = historyEntry.content.find(block => block?.type === 'text')
        if (textBlock) textBlock.text = sanitizeUiUserText(String(textBlock.text || ''))
      } else if (typeof historyEntry.content === 'string') {
        historyEntry.content = sanitizeUiUserText(historyEntry.content)
      }
    }
    runtime.updatedAt = new Date().toISOString()
    saveRuntime(runtime)
    emit(runtime, 'modes', { plan: !!runtime.toolkit?.planMode?.enabled, deep: !!runtime.toolkit?.deepMode?.enabled, maxTurns: runtime.toolkit?.deepMode?.getMaxTurns?.() || null })
    // 【2026-10-09 挪走】原来这里跑一次 autoCompact（run 结束后）。
    // 现在压缩统一由 agent.beforeApiRequest 负责（每轮发请求前判定，
    // 与 CLI 同源同位置）—— 这里再压一次是重复劳动，且时机更晚。
    runtime.runSnapshot = null
    emit(runtime, 'done', { session: sessionPayload(runtime), interrupted: false })
  } catch (error) {
    if (runtime.runToken !== runToken) return
    console.error(`[web] session ${runtime.id} provider ${runtime.providerId} failed:`, error?.stack || error)
    runtime.history = agent?.getHistory?.() || runtime.history || []
    runtime.updatedAt = new Date().toISOString()
    saveRuntime(runtime)
    runtime.runSnapshot = null
    emit(runtime, 'error', { message: error?.message || String(error) })
    emit(runtime, 'done', { session: sessionPayload(runtime), interrupted: !!runtime.controller?.signal.aborted, failed: true })
  } finally {
    // 先无条件停掉自动落盘：下面的 runToken 检查会提前 return，放后面会漏掉清理
    autosave.stop()
    runtime._autosave = null
    // 收尾时清掉没人消费的 steering：留着会在下一轮开头莫名注入旧指令。
    runtime.steeringQueue = []
    // 必须先释放服务端状态，再发出结束事件；否则用户立刻续发时会撞到 stale running=true。
    if (runtime.runToken !== runToken) return
    runtime.running = false
    runtime.controller = null
    runtime.updatedAt = new Date().toISOString()
    saveRuntime(runtime)
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`)
    
    // API 路由
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/config') {
        if (req.method === 'GET') {
          const config = loadWebConfig()
          // 【2026-10-08 加】压缩阈值（compactThresholdTokens/Messages）——
          // 设置页「自动压缩」区块用，与 CLI 同名同语义（0 = 关闭）。
          // 【2026-10-10 加】phoneMode —— 设置页「手机操作」区块用，
          // 存 device.json（与 CLI 的 /device mode 同一文件同一字段）。
          const devCfg = (() => { try { return loadDeviceConfig() || {} } catch { return {} } })()
          return json(res, 200, { current: config.current, defaultProviderId: config.current, source: 'web-config.json', stream: config.stream !== false, permissionMode: config.permissionMode || 'bypassPermissions', thinking: config.thinking || {}, providers: publicProviders(config), chatModels: Array.isArray(config.chatModels) ? config.chatModels : [], defaultModelId: config.defaultModelId || null, compactThresholdTokens: config.compactThresholdTokens ?? 0, compactThresholdMessages: config.compactThresholdMessages ?? 0, phoneMode: devCfg.phoneMode || null })
        }
        // 【默认 Provider 要落盘】原来前端只能把它存 localStorage ——
        // 那是浏览器本地的，换设备/清缓存就没了，用户感受就是「选了不保存，
        // 每次进去还是配置一」。这里补上服务端持久化。
        if (req.method === 'PATCH' || req.method === 'PUT' || req.method === 'POST') {
          const body = await readBody(req)
          const config = loadWebConfig()
          // chatModels：对话模型档位分配（原来只存 localStorage，换设备就丢）
          if (Array.isArray(body.chatModels)) {
            // 只保留仍然存在的 provider 的条目，避免删了 Provider 后留下孤儿
            config.chatModels = body.chatModels.filter(m => m && m.id && config.providers[m.providerId])
          }
          if (body.defaultModelId !== undefined) {
            config.defaultModelId = body.defaultModelId ? String(body.defaultModelId) : null
          }
          // current：默认 Provider（可单独提交，也可和上面一起）
          const target = String(body.current || body.defaultProviderId || '').trim()
          if (target) {
            if (!config.providers[target]) return json(res, 404, { error: `Provider 不存在：${target}` })
            config.current = target
          }
          // 【2026-10-08 加】压缩阈值：0 = 关闭（与 CLI 语义一致）。
          // 只做非负整数校验，范围检查交给 auto-compact 的 setter。
          //
          // ⚠ 这两个字段走**共享配置**（CLI config.json），不走 saveWebConfig ——
          // README：「与 CLI 共享配置与会话数据」。saveWebConfig 只把 providers
          // 写回 CLI、其余字段落 web-config.json（那是 Web 覆盖层，用于
          // current/chatModels 这类会话级字段）。压缩阈值是全局设置，
          // 必须两边一致：CLI 设的 Web 可见、Web 改的 CLI 生效。
          const cliPatch = {}
          if (body.compactThresholdTokens !== undefined) {
            const v = Number(body.compactThresholdTokens)
            if (!Number.isFinite(v) || v < 0) return json(res, 400, { error: 'compactThresholdTokens 必须是非负数' })
            cliPatch.compactThresholdTokens = Math.floor(v)
          }
          if (body.compactThresholdMessages !== undefined) {
            const v = Number(body.compactThresholdMessages)
            if (!Number.isFinite(v) || v < 0) return json(res, 400, { error: 'compactThresholdMessages 必须是非负数' })
            cliPatch.compactThresholdMessages = Math.floor(v)
          }
          if (Object.keys(cliPatch).length) {
            try {
              const cli = JSON.parse(readFileSync(CLI_CONFIG_PATH, 'utf8'))
              Object.assign(cli, cliPatch)
              atomicWrite(CLI_CONFIG_PATH, JSON.stringify(cli, null, 2), 'utf8')
            } catch (e) {
              return json(res, 500, { error: `写入共享配置失败: ${e.message}` })
            }
          }
          // 【2026-10-10 加】phoneMode —— 存 device.json（与 CLI /device mode
          // 同一文件），白名单校验三个合法值（对齐 CLI cmd-device.mjs 的 MAP）。
          let phonePatchOk = false
          if (body.phoneMode !== undefined) {
            const v = String(body.phoneMode || '')
            const VALID = new Set(['foreground', 'background', 'ask'])
            if (!VALID.has(v)) return json(res, 400, { error: `phoneMode 只能是 foreground / background / ask，收到「${v}」` })
            try {
              saveDeviceConfig({ phoneMode: v })
              phonePatchOk = true
            } catch (e) {
              return json(res, 500, { error: `写入 device.json 失败: ${e.message}` })
            }
          }
          const hasWebPatch = target || Array.isArray(body.chatModels) || body.defaultModelId !== undefined
          if (!hasWebPatch && !Object.keys(cliPatch).length && !phonePatchOk) {
            return json(res, 400, { error: '没有可保存的字段（current / chatModels / defaultModelId / compactThreshold* / phoneMode）' })
          }
          if (hasWebPatch) saveWebConfig(config)
          // 返回最新值（读共享配置，确保回显的是落盘后的真值）
          const fresh = loadWebConfig()
          const freshDev = (() => { try { return loadDeviceConfig() || {} } catch { return {} } })()
          return json(res, 200, { ok: true, current: fresh.current, chatModels: fresh.chatModels || [], defaultModelId: fresh.defaultModelId || null, compactThresholdTokens: fresh.compactThresholdTokens ?? 0, compactThresholdMessages: fresh.compactThresholdMessages ?? 0, phoneMode: freshDev.phoneMode || null })
        }
      }
      // 【2026-10-08 合并】原 /api/output-styles 端点（GET 列表 / PATCH 切换）
      // 已删 —— 输出风格并入回复偏好，设置页改走 /api/profile 的
      // personal_preferences（上面 buildProfilePrompt 注入，每轮生效）。
      // 端点删掉而不是留着：留着会让「风格还能切」的假象存在（前端已无入口），
      // 外部调用者也会以为 config.outputStyle 仍然有效。
      if (req.method === 'GET' && url.pathname === '/api/providers') return json(res, 200, publicProviders(loadWebConfig()))
      // 拉取上游模型清单（由服务端代发，避开浏览器 CORS；也不必把 key 暴露给前端）
      if (req.method === 'POST' && /^\/api\/providers\/[^/]+\/fetch-models$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split('/')[3])
        const config = loadWebConfig()
        const provider = config.providers[id]
        if (!provider) return json(res, 404, { error: 'Provider 不存在' })
        const rawUrl = String(provider.url || provider.baseUrl || '').trim()
        const apiKey = String(provider.apiKey || (Array.isArray(provider.apiKeys) ? provider.apiKeys[0] : '') || '').trim()
        if (!rawUrl) return json(res, 400, { error: '该 Provider 未配置 API 地址' })
        if (!apiKey) return json(res, 400, { error: '该 Provider 未配置 API Key' })
        let endpoint = rawUrl.replace(/\/+$/, '').replace(/\/(chat\/completions|messages)$/, '').replace(/\/+$/, '')
        if (!/\/v\d+$/.test(endpoint)) endpoint += '/v1'
        endpoint += '/models'
        const isAnthropic = (provider.protocol || 'openai') === 'anthropic'
        const headers = isAnthropic
          ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
          : { Authorization: `Bearer ${apiKey}` }
        try {
          const upstream = await fetch(endpoint, { headers, signal: AbortSignal.timeout(20000) })
          const text = await upstream.text()
          if (!upstream.ok) {
            return json(res, 200, { ok: false, status: upstream.status, endpoint, error: `上游返回 HTTP ${upstream.status}${upstream.status === 401 ? '（API Key 无效）' : upstream.status === 404 ? '（该地址没有 /models 接口）' : ''}`, body: text.slice(0, 300) })
          }
          let parsed
          try { parsed = JSON.parse(text) } catch { return json(res, 200, { ok: false, endpoint, error: '上游返回的不是合法 JSON', body: text.slice(0, 300) }) }
          const list = Array.isArray(parsed?.data) ? parsed.data : (Array.isArray(parsed?.models) ? parsed.models : [])
          const ids = [...new Set(list.map(m => (typeof m?.id === 'string' ? m.id.trim() : (typeof m?.name === 'string' ? m.name.trim() : ''))).filter(Boolean))].sort((a, b) => a.localeCompare(b))
          return json(res, 200, { ok: true, endpoint, models: ids, configured: (provider.models || []).map(m => m.id).filter(Boolean) })
        } catch (e) {
          return json(res, 200, { ok: false, endpoint, error: `请求失败：${e?.message || '网络异常'}` })
        }
      }
      // 运行健康状态：保活、内存中 runtime 数、崩溃日志是否存在
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const mem = process.memoryUsage()
        return json(res, 200, {
          ok: true,
          uptimeSec: Math.round(process.uptime()),
          pid: process.pid,
          keepalive: keepaliveStatus(),
          runtimes: runtimes.size,
          runningSessions: [...runtimes.values()].filter(r => r.running).length,
          sseClients: [...runtimes.values()].reduce((n, r) => n + (r.events?.size || 0), 0),
          rssMB: Math.round(mem.rss / 1048576),
          heapMB: Math.round(mem.heapUsed / 1048576),
          crashLog: existsSync(CRASH_LOG) ? CRASH_LOG : null,
        })
      }
      // ═══ CCM 原生环境（Android 外壳专用）═══
      //
      // 只在 CCM 模式下有意义：Kotlin 侧的桥接服务器（127.0.0.1:3457）
      // 提供 Shizuku/截图/系统能力。这里转发查询，供 Web UI 显示。
      //
      // 前端可以据此显示「手机操作已就绪」「截屏已授权」等状态，
      // 以及提示用户去开权限。
      if (url.pathname === '/api/ccm/status') {
        const bridgeUrl = `http://127.0.0.1:${process.env.CCM_BRIDGE_PORT || 3457}`
        let bridge = { ok: false, error: '未连接' }
        try {
          const ctrl = new AbortController()
          const timer = setTimeout(() => ctrl.abort(), 2500)
          const r = await fetch(`${bridgeUrl}/runtime/status`, { signal: ctrl.signal })
          clearTimeout(timer)
          if (r.ok) bridge = await r.json()
        } catch (e) {
          bridge = { ok: false, error: e.message }
        }

        // 顺便报告内核侧的环境信息
        const env = {
          mode: process.env.CCM_MODE || 'unknown',
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          home: process.env.HOME || '(unknown)',
          workspace: process.env.CCM_WORKSPACE || null,
          uptimeSec: Math.round(process.uptime()),
          bridgePort: process.env.CCM_BRIDGE_PORT || 3457,
        }

        return json(res, 200, {
          ok: true,
          ccm: process.env.CCM_MODE === 'native',
          env,
          bridge,
          // 用户友好的状态摘要
          summary: bridge.ok
            ? {
                shizuku: bridge.shizuku || '?',
                // rootfs：不只看标记文件，也看关键目录（解压错位时 /usr/bin 会缺失）
                rootfs: bridge.rootfs_installed
                  ? (bridge.rootfs_has_usr_bin === false ? '已标记但 /usr/bin 缺失（解压不完整）' : '已安装')
                  : '未安装',
                // proot：区分「二进制在」和「loader 也在」——
                // 缺 loader 时 proot 一跑就报 Function not implemented，
                // 只看 proot_exists 会误报「就绪」
                proot: !bridge.proot_exists
                  ? '缺失'
                  : (bridge.proot_loader_exists === false ? '二进制在但缺 loader（必失败）' : '就绪'),
                node: bridge.node_exists ? '已安装' : '未安装',
                kernel: bridge.kernel_installed ? '已安装' : '未安装',
                androidSdk: bridge.sdk || '?',
              }
            : null,
        })
      }

      // 用户 profile：称呼/职业/回复偏好会注入 systemPrompt，主题/字体仅前端使用
      if (url.pathname === '/api/profile') {
        if (req.method === 'GET') return json(res, 200, loadWebProfile())
        if (req.method === 'PATCH' || req.method === 'PUT' || req.method === 'POST') {
          const body = await readBody(req)
          const saved = saveWebProfile(body || {})
          // 【2026-10-08 加】profile 变了必须让 systemPrompt 跟上 ——
          // agent.systemPrompt 是**构造时快照**（agent.mjs:79 赋值，非 getter），
          // buildAgent 又有 `if (runtime.agent) return` 缓存。不处理的话
          // 「改了回复偏好，模型本会话内永远用旧的」——Web 侧一直是这个坑
          //（CLI 侧由 onProfileChanged → invalidateSystemPromptSection 解决）。
          // 修法：有活跃 agent 的 runtime 重取一次 systemPrompt（与 /plan、
          // /coordinate 切换后的处理同款），比重建整个 agent 便宜得多。
          try {
            for (const rt of runtimes.values()) {
              if (rt.toolkit && rt.agent) {
                rt.agent.systemPrompt = rt.toolkit.getSystemPrompt()
              }
            }
          } catch (e) {
            console.warn('[web profile] systemPrompt 刷新失败:', e?.message || e)
          }
          return json(res, 200, saved)
        }
      }
      const providerMatch = url.pathname.match(/^\/api\/providers\/([^/]+)(?:\/web-search-test)?$/)
      if (providerMatch && req.method === 'POST' && url.pathname.endsWith('/web-search-test')) {
        const config = loadWebConfig()
        const id = decodeURIComponent(providerMatch[1])
        const provider = config.providers[id]
        if (!provider) return json(res, 404, { error: 'Provider 不存在' })
        provider.supportsWebSearch = true
        provider.webSearchStrategy = 'tavily'
        provider.webSearchTestedAt = new Date().toISOString()
        provider.webSearchTestReason = 'Web Agent 内置 WebSearch 工具可用'
        saveWebConfig(config)
        return json(res, 200, { ok: true, strategy: 'tavily', provider: publicProviders(config).find(item => item.id === id) })
      }
      if (req.method === 'POST' && url.pathname === '/api/providers') {
        const body = await readBody(req)
        const config = loadWebConfig()
        const id = String(body.id || `web-${Date.now()}`).trim()
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return json(res, 400, { error: 'Provider ID 无效' })
        if (config.providers[id]) return json(res, 409, { error: 'Provider 已存在' })
        const baseUrl = String(body.baseUrl || body.url || '').trim().replace(/\/$/, '')
        if (!/^https?:\/\//i.test(baseUrl)) return json(res, 400, { error: 'API 地址必须是 http 或 https URL' })
        config.providers[id] = { name: String(body.name || id), url: baseUrl, apiKey: String(body.apiKey || ''), model: String(body.model || ''), protocol: body.format === 'anthropic' ? 'anthropic' : 'openai', models: Array.isArray(body.models) ? body.models : [], supportsWebSearch: body.supportsWebSearch === true }
        saveWebConfig(config)
        return json(res, 201, publicProviders(config).find(item => item.id === id))
      }
      const providerCrudMatch = url.pathname.match(/^\/api\/providers\/([^/]+)$/)
      if (providerCrudMatch && ['PATCH', 'DELETE'].includes(req.method)) {
        const id = decodeURIComponent(providerCrudMatch[1])
        const config = loadWebConfig()
        const provider = config.providers[id]
        if (!provider) return json(res, 404, { error: 'Provider 不存在' })
        const activeRuntimes = [...runtimes.values()].filter(runtime => runtime.running && runtime.providerId === id)
        if (activeRuntimes.length) return json(res, 409, { error: '该 Provider 正在被会话使用，生成结束后再修改。' })
        if (req.method === 'DELETE') {
          if (Object.keys(config.providers).length <= 1) return json(res, 400, { error: '至少保留一个 Provider' })
          delete config.providers[id]
          if (config.current === id) config.current = Object.keys(config.providers)[0]
          saveWebConfig(config)
          return json(res, 200, { ok: true })
        }
        const body = await readBody(req)
        // 【改 ID】用户要求能自己设 ID（命令行 /xxx 引用它）。
        // ID 是 providers 对象的 key，改名要连带搬 key，还得处理引用它的人：
        // config.current、会话的 providerId、chatModels 里的条目。
        if (body.newId != null || body.renameTo != null) {
          const nextId = String(body.newId ?? body.renameTo).trim()
          if (!/^[A-Za-z0-9_-]{1,80}$/.test(nextId)) return json(res, 400, { error: 'ID 只能包含字母、数字、下划线和连字符（1-80 字符）' })
          if (nextId !== id) {
            if (config.providers[nextId]) return json(res, 409, { error: `ID「${nextId}」已被占用` })
            config.providers[nextId] = provider
            delete config.providers[id]
            if (config.current === id) config.current = nextId
            // 会话里存的是旧 id，跟着改，否则那个会话会指向不存在的 Provider
            for (const rt of runtimes.values()) {
              if (rt.providerId === id) rt.providerId = nextId
            }
            // chatModels 里的 providerId 同步
            if (Array.isArray(config.chatModels)) {
              config.chatModels = config.chatModels.map(m => m && m.providerId === id ? { ...m, providerId: nextId } : m)
            }
            saveWebConfig(config)
            return json(res, 200, { ...publicProviders(config).find(item => item.id === nextId), renamedFrom: id, newId: nextId })
          }
        }
        if (body.name != null) provider.name = String(body.name)
        if (body.baseUrl != null || body.url != null) {
          const nextUrl = String(body.baseUrl || body.url).trim().replace(/\/$/, '')
          if (!/^https?:\/\//i.test(nextUrl)) return json(res, 400, { error: 'API 地址必须是 http 或 https URL' })
          provider.url = nextUrl
        }
        // 【防呆】拒绝把「脱敏回显值」当成真 key 存进去。
        // 设置页现在会显示 `sk-abc12345···WXYZ` 这种脱敏串（用户要求能看见 key），
        // 万一前端某条路径把显示值提交回来，真 key 就被这串垃圾覆盖了 —— 而且
        // 用户不会立刻发现（配置页显示的还是"已配置"）。
        // 判据：含 `···`（三个中点）就是脱敏串，一律拒绝。
        if (body.apiKey != null && String(body.apiKey).trim()) {
          const next = String(body.apiKey).trim()
          if (next.includes('···')) {
            return json(res, 400, { error: '拒绝保存：这看起来是脱敏回显值而不是真实 key。请重新输入完整 key。' })
          }
          provider.apiKey = next
        }
        if (body.model != null) provider.model = String(body.model)
        if (Array.isArray(body.models)) provider.models = body.models
        if (body.supportsWebSearch != null) provider.supportsWebSearch = !!body.supportsWebSearch
        // API 格式（protocol）：前端有 openai / anthropic / responses 三选一，
        // 但原来 PATCH 不认这个字段 —— 用户在设置页切来切去，保存后毫无变化。
        if (body.protocol != null || body.format != null) {
          const next = String(body.protocol ?? body.format).toLowerCase()
          if (!['openai', 'anthropic', 'responses'].includes(next)) return json(res, 400, { error: `不支持的 API 格式：${next}` })
          provider.protocol = next
        }
        // 搜索引擎 key（Tavily）：Web Agent 的 WebSearch 工具用它
        if (body.tavilyApiKey != null) {
          const k = String(body.tavilyApiKey).trim()
          if (k.includes('···')) {
            return json(res, 400, { error: '拒绝保存：这看起来是脱敏回显值而不是真实 key。请重新输入完整 key。' })
          }
          if (k) provider.tavilyApiKey = k
          else delete provider.tavilyApiKey
          // 【2026-09-20】core/tavily.mjs 的 getTavilyKey 有模块级缓存，
          // 不清的话本进程内一直用旧值 —— 用户改了 key 却「没生效」。
          try {
            const { resetTavilyKeyCache } = await import('../core/tools/tavily.mjs')
            resetTavilyKeyCache()
          } catch {}
        }
        if (body.temperature != null) {
          const t = Number(body.temperature)
          if (!Number.isFinite(t) || t < 0 || t > 2) return json(res, 400, { error: 'temperature 必须在 0 到 2 之间' })
          provider.temperature = t
        }
        if (body.maxOutputTokens != null) {
          const n = Number(body.maxOutputTokens)
          if (!Number.isFinite(n) || n <= 0) return json(res, 400, { error: 'maxOutputTokens 必须是正整数' })
          provider.maxOutputTokens = Math.floor(n)
        }
        if (body.systemTopLevel != null) provider.systemTopLevel = !!body.systemTopLevel
        // 识图开关：true 时 ViewImage/图片附件走当前 Provider，false 时由备用识图 Provider/tesseract 兜底
        if (body.vision != null) provider.vision = !!body.vision
        // 每 Provider 独立 thinking：body.thinking 传 { enabled, effort, show } 或 null 删除
        if (body.thinking !== undefined) {
          if (body.thinking === null) delete provider.thinking
          else if (typeof body.thinking === 'object') provider.thinking = { ...provider.thinking, ...body.thinking }
        }
        // 兜底识图 Provider：visionProviderId 存到 config 顶层（全局一个）
        if (body.visionProviderId !== undefined) {
          if (body.visionProviderId === null) delete config.visionProviderId
          else if (config.providers[String(body.visionProviderId)]) config.visionProviderId = String(body.visionProviderId)
        }
        saveWebConfig(config)
        return json(res, 200, publicProviders(config).find(item => item.id === id))
      }
      if (req.method === 'GET' && url.pathname === '/api/workspace') return json(res, 200, loadWebSettings())
      if (req.method === 'PATCH' && url.pathname === '/api/workspace') {
        const body = await readBody(req)
        return json(res, 200, saveWebSettings(body.workspacePath))
      }
      if (req.method === 'GET' && url.pathname === '/api/directories') {
        return json(res, 200, listDirectories(url.searchParams.get('path') || loadWebSettings().workspacePath))
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') return json(res, 200, { sessions: listSessions() })
      // ═══════════════════════════════════════════════════════════════
      // 向导 API —— 复用 CLI 的向导定义（core/wizard-steps.mjs）
      //
      // 用户要求「有向导的也复用，在 web 也建向导」。
      // CLI 的 runWizard 是终端交互（画 ANSI 边框 + 读 readline），Web 用不了，
      // 但向导的**内容**（steps + 落盘逻辑）是跨端的 —— 抽在 wizard-steps.mjs。
      // 这里只做「把 steps 发给前端 → 收 answers → 调同一个 apply」。
      //
      // 契约：
      //   GET  /api/wizards          列出所有可用向导（id + title）
      //   GET  /api/wizards/<id>     取某个向导的步骤定义（secret 字段不带值）
      //   POST /api/wizards/<id>     提交 answers，落盘，返回回执
      // ═══════════════════════════════════════════════════════════════
      // ═══════════════════════════════════════════════════════════════
      // 连接器状态 —— 给「连接器」页面用
      //
      // 【2026-09-19】连接器目录精简为 GitHub + QQ（原来 28 个里 26 个是
      // 上游商业版的摆设，本机一个都连不上）。既然只剩这两个真的能用的，
      // 状态就必须是真的 —— 前端原来调的 getGithubStatus() 是 stub
      // （永远返回 connected:false），所以那个「已连接」徽章从来没亮过。
      //
      // 这里直接从本地配置读：
      //   GitHub → ~/.claude-code-mobile/github.json（/github login 写入）
      //   QQ     → ~/.claude-code-mobile/qq-config.json（/qq setup 写入）
      // ═══════════════════════════════════════════════════════════════
      if (req.method === 'GET' && url.pathname === '/api/connectors/status') {
        const out = { github: { connected: false, detail: '' }, qq: { connected: false, detail: '' } }
        try {
          const { githubStatus } = await import('../core/integrations/github.mjs')
          const st = githubStatus()
          out.github = {
            connected: !!st.configured,
            // 字段名对齐 core/github.mjs 的 githubStatus()：defaultRepo / tokenFrom / masked
            detail: st.configured
              ? `${st.defaultRepo ? `仓库 ${st.defaultRepo}` : '已配置 token'} · ${st.masked}`
              : '未配置',
            defaultRepo: st.defaultRepo || null,
            tokenFrom: st.tokenFrom || 'none',
            masked: st.masked || '',
          }
        } catch (e) {
          out.github.error = e?.message || String(e)
        }
        try {
          const qq = JSON.parse(readFileSync(join(DATA_DIR, 'qq-config.json'), 'utf8'))
          out.qq = {
            connected: !!qq.qqActive,
            detail: qq.qqActive
              ? `监听中 · 主人号 ${qq.owner || '未设'} · API ${qq.napcatApi || 'http://127.0.0.1:5700'}`
              : `未开启 · 主人号 ${qq.owner || '未设'}`,
            owner: qq.owner || null,
          }
        } catch (e) {
          out.qq.error = e?.code === 'ENOENT' ? '未配置' : (e?.message || String(e))
        }
        return json(res, 200, out)
      }
      if (req.method === 'GET' && url.pathname === '/api/wizards') {
        const { wizardIds, getWizard } = await import('../core/commands/wizard-steps.mjs')
        return json(res, 200, {
          wizards: wizardIds().map(id => ({ id, title: getWizard(id)?.title || id })),
        })
      }
      const wizardMatch = url.pathname.match(/^\/api\/wizards\/([a-z0-9-]+)$/i)
      if (wizardMatch) {
        const { getWizard } = await import('../core/commands/wizard-steps.mjs')
        const wizard = getWizard(wizardMatch[1])
        if (!wizard) return json(res, 404, { error: `向导不存在: ${wizardMatch[1]}` })
        const config = loadWebConfig()
        if (req.method === 'GET') {
          const steps = wizard.steps({ config })
          // secret 步骤不回传任何已有值（本来也不该有），但保留 secret 标记
          // 让前端知道要用密码框渲染。
          return json(res, 200, { id: wizardMatch[1], title: wizard.title, steps })
        }
        if (req.method === 'POST') {
          const body = await readBody(req)
          const answers = body?.answers || {}
          // 服务端再校验一遍 —— 前端校验只是体验，不能当安全边界。
          const steps = wizard.steps({ config })
          for (const step of steps) {
            const value = answers[step.key]
            const empty = step.multi ? !Array.isArray(value) || value.length === 0 : !String(value ?? '').trim()
            if (step.required && empty) {
              return json(res, 400, { error: `${step.label} 不能为空`, field: step.key })
            }
            if (!empty && typeof step.validate === 'function') {
              const msg = step.validate(value)
              if (msg) return json(res, 400, { error: msg, field: step.key })
            }
          }
          // 缺省值补齐（前端没填的可选项走 default）
          for (const step of steps) {
            const v = answers[step.key]
            const empty = step.multi ? !Array.isArray(v) || v.length === 0 : !String(v ?? '').trim()
            if (empty && step.default !== undefined) answers[step.key] = step.default
          }
          const out = await wizard.apply(answers, { config, saveConfig: saveWebConfig, C: {} })
          return json(res, 200, { ok: true, message: String(out || '') })
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/commands') {
        const sessionId = url.searchParams.get('session')
        const runtime = sessionId ? getRuntime(sessionId) : { workspacePath: loadWebSettings().workspacePath, commandLoader: null, skillLoader: null }
        ensureRuntimeExtensions(runtime)
        // 带上子命令表：前端在「/config 」这种「命令+空格」状态下展示候选。
        return json(res, 200, { commands: getSlashCommands(runtime), skills: getSkillEntries(runtime), subcommands: WEB_SUBCOMMANDS })
      }
      // ── 项目（Projects）──────────────────────────────────────────────
      // 【2026-09-20 新增】用户反馈「web 中有"项目"这个概念，但实际没做」——
      // 核实属实：ProjectsPage.tsx（858 行 UI）+ api.ts 里 9 个函数全是 stub，
      // 服务端一个端点都没有。现在按官方语义补齐（知识库 + 项目指令 + 对话归属）。
      // 设计依据与取舍见 web/projects.mjs 顶部注释。
      if (url.pathname === '/api/projects' || url.pathname.startsWith('/api/projects/')) {
        const rest = url.pathname.replace(/^\/api\/projects\/?/, '')
        const parts = rest ? rest.split('/') : []
        const pid = parts[0] ? decodeURIComponent(parts[0]) : ''
        const sub = parts[1] || ''

        if (req.method === 'GET' && !pid) {
          return json(res, 200, { projects: projectStore.list({ includeArchived: url.searchParams.get('archived') !== 'false' }) })
        }
        if (req.method === 'POST' && !pid) {
          const body = await readBody(req)
          return json(res, 201, projectStore.create(body || {}))
        }
        if (req.method === 'GET' && pid && !sub) {
          const p = projectStore.get(pid)
          if (!p) return json(res, 404, { error: '项目不存在' })
          return json(res, 200, { ...projectStore._summary(p), conversations: p.conversations || [] })
        }
        if ((req.method === 'PATCH' || req.method === 'PUT') && pid && !sub) {
          const body = await readBody(req)
          const updated = projectStore.update(pid, body || {})
          if (!updated) return json(res, 404, { error: '项目不存在' })
          return json(res, 200, updated)
        }
        if (req.method === 'DELETE' && pid && !sub) {
          const ok = projectStore.remove(pid)
          if (!ok) return json(res, 404, { error: '项目不存在' })
          return json(res, 200, { ok: true })
        }
        // 项目文件
        if (pid && sub === 'files') {
          if (req.method === 'GET') {
            const p = projectStore.get(pid)
            if (!p) return json(res, 404, { error: '项目不存在' })
            return json(res, 200, { files: p.files || [] })
          }
          if (req.method === 'POST') {
            const body = await readBody(req)
            // 复用 uploads 机制：前端先 POST /api/uploads 拿到 fileId + 落盘路径，
            // 再把 sourcePath 传进来挂到项目下（避免这里再实现一遍 multipart 解析）。
            const sourcePath = String(body.sourcePath || body.path || '')
            if (!sourcePath || !existsSync(sourcePath)) return json(res, 400, { error: 'sourcePath 不存在' })
            const entry = projectStore.addFile(pid, {
              sourcePath,
              fileName: body.fileName || basename(sourcePath),
              mimeType: body.mimeType || '',
              size: Number(body.size) || 0,
            })
            if (!entry) return json(res, 404, { error: '项目不存在' })
            return json(res, 201, entry)
          }
          if (req.method === 'DELETE' && parts[2]) {
            const ok = projectStore.removeFile(pid, decodeURIComponent(parts[2]))
            if (!ok) return json(res, 404, { error: '文件不存在' })
            return json(res, 200, { ok: true })
          }
        }
        // 项目对话
        if (pid && sub === 'conversations') {
          if (req.method === 'GET') {
            const p = projectStore.get(pid)
            if (!p) return json(res, 404, { error: '项目不存在' })
            return json(res, 200, { conversations: p.conversations || [] })
          }
          if (req.method === 'POST') {
            const body = await readBody(req)
            const p = projectStore.get(pid)
            if (!p) return json(res, 404, { error: '项目不存在' })
            // 建会话：与 POST /api/sessions 同一套构造（保持字段一致），
            // 额外把 projectId 绑到 runtime —— buildAgent 构造 systemPrompt 时
            // 会调 projectStore.buildPromptSection(sessionId) 注入项目指令与知识库。
            const id = randomUUID()
            const config = loadWebConfig()
            const workspacePath = body.workspacePath ? normalizeWorkspace(body.workspacePath) : loadWebSettings().workspacePath
            const runtime = { id, title: body.title || p.name || '新对话', projectId: pid, providerId: resolveProviderId(config, body.providerId || config.current), model: findProviderModel(config.providers[resolveProviderId(config, body.providerId || config.current)], body.model) || null, thinking: typeof body.thinking === 'boolean' ? body.thinking : undefined, thinkingEffort: body.thinkingEffort || undefined, workspacePath, researchMode: !!body.research_mode, history: [], createdAt: new Date().toISOString(), updatedAt: null, events: new Set(), running: false, agent: null, controller: null, toolkit: null, pendingQuestions: new Map(), steeringQueue: [], commandLoader: null, skillLoader: null, compactService: null, eventSeq: 0, eventLog: [], lastActiveAt: Date.now() }
            runtimes.set(id, runtime)
            store.save(id, { sessionId: id, title: runtime.title, projectId: pid, providerId: runtime.providerId, model: runtime.model, thinking: runtime.thinking === undefined ? null : runtime.thinking, thinkingEffort: runtime.thinkingEffort || null, workspacePath, research_mode: runtime.researchMode, createdAt: runtime.createdAt, updatedAt: runtime.updatedAt, messages: [], display: {} })
            projectStore.attachConversation(pid, { conversationId: id, title: runtime.title })
            return json(res, 201, { ...sessionPayload(runtime), project_id: pid })
          }
        }
        return json(res, 404, { error: `项目接口不存在: ${url.pathname}` })
      }
      if (req.method === 'POST' && url.pathname === '/api/skills') {
        const body = await readBody(req)
        const name = String(body.name || '').trim()
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) return json(res, 400, { error: 'Skill 名称只能包含字母、数字、下划线和连字符' })
        const runtime = { workspacePath: loadWebSettings().workspacePath, skillLoader: null, commandLoader: null }
        ensureRuntimeExtensions(runtime)
        if (runtime.skillLoader.get(name)) return json(res, 409, { error: 'Skill 已存在' })
        const content = `---\ndescription: ${String(body.description || '').replace(/[\r\n]/g, ' ')}\n---\n${String(body.content || '')}`
        const file = runtime.skillLoader.write(name, content)
        return json(res, 201, { id: name, name, description: body.description || '', content: body.content || '', scope: 'project', enabled: true, path: file })
      }
      const skillMatch = url.pathname.match(/^\/api\/skills\/([^/]+)$/)
      if (skillMatch) {
        const name = decodeURIComponent(skillMatch[1])
        const runtime = { workspacePath: loadWebSettings().workspacePath, skillLoader: null, commandLoader: null }
        ensureRuntimeExtensions(runtime)
        if (req.method === 'GET') {
          const entry = runtime.skillLoader.get(name)
          if (!entry) return json(res, 404, { error: 'Skill 不存在' })
          return json(res, 200, { id: entry.name, name: entry.name, description: entry.description, scope: entry.scope, passive: entry.passive, content: entry.body || '', path: entry.path, enabled: true })
        }
        if (req.method === 'POST' && !runtime.skillLoader.get(name)) {
          const body = await readBody(req)
          const file = runtime.skillLoader.write(name, `---\ndescription: ${String(body.description || '').replace(/[\r\n]/g, ' ')}\n---\n${String(body.content || '')}`)
          return json(res, 201, { id: name, name, description: body.description || '', content: body.content || '', scope: 'project', enabled: true, path: file })
        }
        if (req.method === 'PUT') {
          const body = await readBody(req)
          const file = runtime.skillLoader.write(name, `---\ndescription: ${String(body.description || '').replace(/[\r\n]/g, ' ')}\n---\n${String(body.content || '')}`)
          return json(res, 200, { id: name, name: body.name || name, description: body.description || '', content: body.content || '', scope: 'project', enabled: true, path: file })
        }
        if (req.method === 'DELETE') { const entry = runtime.skillLoader.get(name); if (entry?.path && entry.scope !== 'global') { try { unlinkSync(entry.path) } catch {} }; return json(res, 200, { ok: true }) }
      }
      if (req.method === 'GET' && url.pathname === '/api/mcp') {
        await mcpReady
        return json(res, 200, { servers: [...mcpClient.servers.entries()].map(([name, state]) => ({ name, status: state.proc?.exitCode == null ? 'connected' : 'stopped', toolCount: state.tools.length, tools: state.tools.map(tool => tool.name) })) })
      }
      // ── 插件（DSH 插件宿主）──────────────────────────────────────────
      // 【2026-10-05 新增】对齐 CLI 的 /plugin 命令。
      //
      // 用户指出「web 端其实有点落后了」——CLI 侧 10-04 接入了 DSH 插件宿主
      // （116 个官方包 + 28 个服务），但 Web 端**一个入口都没有**：
      // CustomizePage 只有「技能 / 连接器」两个 tab，插件的装/卸/启停
      // 只能在 CLI 里敲 /plugin。
      //
      // 这里把 DSH 宿主的控制 API（127.0.0.1:8790/control/*）代理出来，
      // 前端在「定制」页加一个插件 tab 就能用。
      //
      // 【为什么不直接调宿主】
      // 浏览器不知道宿主地址（且宿主可能没启动），由服务端代理可以做
      // 「自愈拉起 + 统一错误提示」——与 CLI 的 ensureHost 同一套语义。
      if (url.pathname === '/api/plugins' || url.pathname.startsWith('/api/plugins/')) {
        const action = url.pathname.replace(/^\/api\/plugins\/?/, '') || 'status'
        const DSH_HOST = process.env.DSH_HOST_URL ?? 'http://127.0.0.1:8790'
        const ctrl = async (path, options = {}) => {
          try {
            const res = await fetch(`${DSH_HOST}/control${path}`, {
              method: options.method ?? 'GET',
              headers: options.headers,
              body: options.body,
              signal: AbortSignal.timeout(options.timeout ?? 15000),
            })
            const text = await res.text()
            try { return { ok: res.ok, status: res.status, data: JSON.parse(text) } }
            catch { return { ok: res.ok, status: res.status, data: text } }
          } catch (err) {
            return { ok: false, status: 0, error: err.message }
          }
        }
        // 宿主未运行时自动拉起（与 CLI 的 /plugin 自愈逻辑一致）。
        // 只在 GET 时自愈：POST 是用户的显式操作，拉起失败应如实报错。
        if (req.method === 'GET' && action === 'status') {
          let r = await ctrl('/status', { timeout: 3000 })
          if (!r.ok) {
            try {
              const { execFile } = await import('node:child_process')
              const { promisify } = await import('node:util')
              await promisify(execFile)('bash', [join(ROOT, 'dsh-host', 'start.sh'), 'start'], { timeout: 60000 })
              for (let i = 0; i < 5; i++) {
                r = await ctrl('/status', { timeout: 2000 })
                if (r.ok) break
                await new Promise(resolve => setTimeout(resolve, 1000))
              }
            } catch {}
          }
          if (!r.ok) {
            return json(res, 200, {
              ok: false, running: false,
              error: r.error ?? `HTTP ${r.status}`,
              hint: 'bash ~/claude-code-mobile/dsh-host/start.sh start',
            })
          }
          return json(res, 200, { ok: true, running: true, ...r.data })
        }
        if (req.method === 'GET' && action === 'providers') {
          const r = await ctrl('/providers')
          return json(res, r.ok ? 200 : 502, r.ok ? r.data : { error: r.error ?? `HTTP ${r.status}` })
        }
        if (req.method === 'GET' && action === 'bundles') {
          const r = await ctrl('/bundles')
          return json(res, r.ok ? 200 : 502, r.ok ? r.data : { error: r.error ?? `HTTP ${r.status}` })
        }
        if (req.method === 'POST' && action === 'set-plugin') {
          const body = await readBody(req)
          const r = await ctrl('/set-plugin', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target: body.target, enabled: !!body.enabled }),
            timeout: 30000,
          })
          return json(res, r.ok ? 200 : 502, r.data ?? { error: r.error })
        }
        if (req.method === 'POST' && action === 'install') {
          const body = await readBody(req)
          const r = await ctrl('/install', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target: body.target, config: body.config }),
            timeout: 120000,   // npm 装包慢，给足时间
          })
          return json(res, r.ok ? 200 : 502, r.data ?? { error: r.error })
        }
        if (req.method === 'POST' && action === 'remove') {
          const body = await readBody(req)
          const r = await ctrl('/remove', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target: body.target }),
            timeout: 60000,
          })
          return json(res, r.ok ? 200 : 502, r.data ?? { error: r.error })
        }
        return json(res, 404, { error: `未知插件操作: ${action}` })
      }
      // 【已删除 2026-10-03】/api/backup 端点（自动备份功能下线）
      // Present 工具展示的本地文件（图片/视频）读取。
      // 安全：只允许 workspace 根目录内的文件，且后缀在图片/视频白名单，防目录穿越与任意文件读取。
      if (req.method === 'GET' && url.pathname === '/api/present-file') {
        const raw = url.searchParams.get('path') || ''
        if (!raw) return json(res, 400, { error: '缺少 path' })
        const abs = resolve(raw)
        // WORKSPACE_ROOTS 是允许的根目录集合（homedir / sdcard 等），逐个比对前缀
        const allowed = WORKSPACE_ROOTS.some(root => {
          const r = resolve(root)
          return abs === r || abs.startsWith(r.endsWith('/') ? r : r + '/')
        })
        if (!allowed) return json(res, 403, { error: '只允许访问 workspace 根目录内的文件' })
        if (!existsSync(abs)) return json(res, 404, { error: '文件不存在' })
        const ext = extname(abs).toLowerCase()
        const presentMime = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
          '.gif': 'image/gif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.avif': 'image/avif',
          '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
        }
        const mime = presentMime[ext]
        if (!mime) return json(res, 415, { error: `不支持的类型 ${ext}` })
        let stat
        try { stat = statSync(abs) } catch { return json(res, 404, { error: '文件不可读' }) }
        if (!stat.isFile()) return json(res, 400, { error: '不是文件' })
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Cache-Control': 'private, max-age=600' })
        return res.end(readFileSync(abs))
      }
      const uploadMatch = url.pathname.match(/^\/api\/uploads\/([a-f0-9-]{20,80})(?:\/(raw|path))?$/i)
      if (uploadMatch) {
        const meta = getUpload(uploadMatch[1])
        if (!meta) return json(res, 404, { error: '附件不存在' })
        if (req.method === 'DELETE') { try { unlinkSync(meta.path) } catch {}; uploads.delete(meta.fileId); delete uploadMeta[meta.fileId]; saveUploadMeta(uploadMeta); return json(res, 200, { ok: true }) }
        if (uploadMatch[2] === 'path') return json(res, 200, { fileId: meta.fileId, fileName: meta.fileName, path: meta.path })
        if (req.method !== 'GET') return json(res, 405, { error: '只支持 GET' })
        res.writeHead(200, { 'Content-Type': meta.mimeType, 'Content-Length': meta.size, 'Cache-Control': 'private, max-age=3600' })
        return res.end(readFileSync(meta.path))
      }
      if (req.method === 'POST' && url.pathname === '/api/screenshot') {
        // 手机截屏转附件。原来加号菜单里的「截取屏幕」是个死按钮（onClick 只关菜单）。
        //
        // 【两条路径】
        // · CCM 模式：走原生桥（MediaProjection），Kotlin 侧截好图返回路径
        // · Termux 模式：rish（Shizuku）优先，退回系统 screencap 命令
        try {
          const outPath = join(WEB_UPLOAD_ROOT, `shot-${Date.now()}.png`)
          if (!existsSync(WEB_UPLOAD_ROOT)) mkdirSync(WEB_UPLOAD_ROOT, { recursive: true })
          let ok = false
          let lastShotErr = ''

          // ① CCM 原生桥
          if (process.env.CCM_MODE === 'native') {
            try {
              const bridgePort = process.env.CCM_BRIDGE_PORT || 3457
              const ctrl = new AbortController()
              const timer = setTimeout(() => ctrl.abort(), 20000)
              const r = await fetch(`http://127.0.0.1:${bridgePort}/native/call`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  method: 'phone.screenshot',
                  params: { save_path: outPath, quality: 90 },
                }),
                signal: ctrl.signal,
              })
              clearTimeout(timer)
              const j = await r.json()
              if (j.ok && j.path && existsSync(j.path)) {
                // 桥可能把图存到别处，复制到我们的 upload 目录
                if (j.path !== outPath) {
                  writeFileSync(outPath, readFileSync(j.path))
                }
                ok = true
              } else if (!j.ok) {
                return json(res, 500, {
                  error: `${j.error || '截屏失败'}\n（CCM 模式：请在 App 主界面点「授权截屏能力」）`,
                })
              }
            } catch (e) {
              return json(res, 500, { error: `CCM 截屏调用失败：${e.message}` })
            }
          }

          // ② 非 CCM（或 CCM 桥失败）：走 core/device.mjs 的通道层
          //     Shizuku 优先，不可用落本机 adb（adb 用 exec-out 直取，不落手机盘）
          if (!ok) {
            try {
              const { captureScreen } = await import('../core/phone/device.mjs')
              const shot = await captureScreen(outPath, 25000)
              if (shot.ok && existsSync(outPath)) ok = true
              else if (!shot.ok) {
                const hint = shot.channel === 'adb' && shot.unavailable
                  ? '（adb 未配置：跑 ~/.claude-code-mobile/adb-setup.sh）'
                  : '（检查 /device 状态）'
                lastShotErr = `${shot.err || '截屏失败'} ${hint}`
              }
            } catch (e) { lastShotErr = e.message }
          }

          if (!ok) return json(res, 500, { error: `截屏失败：${lastShotErr || '两条通道都没返回文件'}` })
          const size = statSync(outPath).size
          if (!size) return json(res, 500, { error: '截屏文件是空的' })
          // 复用 uploads 那套存储与命名，前端当作普通图片附件处理
          const fileId = randomUUID()
          const fileName = `screenshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`
          const destPath = uploadPath(fileId, fileName)
          try { writeFileSync(destPath, readFileSync(outPath)) } catch (e) { return json(res, 500, { error: `保存截图失败：${e.message}` }) }
          try { unlinkSync(outPath) } catch {}
          const meta = { fileId, fileName, fileType: 'image', mimeType: 'image/png', size, path: destPath }
          uploads.set(fileId, meta)
          uploadMeta[fileId] = { fileName, fileType: 'image', mimeType: 'image/png' }
          saveUploadMeta(uploadMeta)
          return json(res, 200, { fileId, fileName, fileType: 'image', mimeType: 'image/png', size, url: `/api/uploads/${fileId}/raw` })
        } catch (error) {
          return json(res, 500, { error: `截屏失败：${error?.message || error}` })
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/uploads') {
        const body = await readBody(req)
        if (!body.fileName || !body.data) return json(res, 400, { error: '缺少 fileName 或 data' })
        const dataUrl = String(body.data)
        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
        if (!match) return json(res, 400, { error: '附件必须是 data URL' })
        const raw = Buffer.from(match[2], 'base64')
        if (!raw.length || raw.length > 8 * 1024 * 1024) return json(res, 413, { error: '附件为空或超过 8MB' })
        mkdirSync(WEB_UPLOAD_ROOT, { recursive: true })
        const fileId = randomUUID()
        const meta = { fileId, fileName: safeUploadName(body.fileName), fileType: String(match[1]).startsWith('image/') ? 'image' : 'document', mimeType: match[1], size: raw.length, path: uploadPath(fileId, body.fileName) }
        writeFileSync(meta.path, raw)
        uploads.set(fileId, meta)
        uploadMeta[fileId] = { fileName: meta.fileName, fileType: meta.fileType, mimeType: meta.mimeType }
        saveUploadMeta(uploadMeta)
        return json(res, 201, { fileId: meta.fileId, fileName: meta.fileName, fileType: meta.fileType, mimeType: meta.mimeType, size: meta.size, url: `/api/uploads/${fileId}/raw` })
      }
      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        const body = await readBody(req)
        const runtime = createAndSaveRuntime({
          title: body.title || '新对话',
          workspacePath: body.workspacePath,
          providerId: body.providerId,
          model: body.model,
          thinking: body.thinking,
          thinkingEffort: body.thinkingEffort,
          researchMode: !!body.research_mode,
        })
        return json(res, 201, sessionPayload(runtime))
      }
      const match = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]+)(?:\/(events|messages|answer|abort|export|open-folder|command-select))?$/i)
      if (match) {
        const [, id, action] = match
        if (req.method === 'DELETE' && !action) {
          store.delete(id)
          runtimes.delete(id)
          return json(res, 200, { ok: true })
        }
        if (req.method === 'PATCH' && !action) {
          const body = await readBody(req)
          const runtime = runtimes.get(id)
          if (runtime) {
            if (body.title) runtime.title = body.title
            if (typeof body.research_mode === 'boolean') runtime.researchMode = body.research_mode
            if (typeof body.thinking === 'boolean') {
              runtime.thinking = body.thinking
              invalidateRuntimeEngine(runtime)
            }
            if (['low', 'medium', 'high', 'xhigh', 'max'].includes(body.thinkingEffort)) {
              runtime.thinkingEffort = body.thinkingEffort
              invalidateRuntimeEngine(runtime)
            }
            if (body.providerId) {
              runtime.providerId = resolveProviderId(loadWebConfig(), body.providerId)
              runtime.model = null
              invalidateRuntimeEngine(runtime, { extensions: true })
            }
            if (body.model != null) {
              const currentProvider = providerForRuntime(runtime).provider
              const resolvedModel = findProviderModel(currentProvider, body.model)
              if (!resolvedModel) return json(res, 400, { error: `模型不属于当前 Provider：${body.model}` })
              runtime.model = resolvedModel
              invalidateRuntimeEngine(runtime)
            }
            if (body.workspacePath) {
              if (runtime.running) return json(res, 409, { error: '会话运行中，不能切换工作目录' })
              runtime.workspacePath = normalizeWorkspace(body.workspacePath)
              runtime.agent = null
              runtime.toolkit = null
              runtime.skillLoader = null
              runtime.commandLoader = null
              runtime.compactService = null
            }
            store.save(id, { sessionId: id, title: runtime.title, providerId: runtime.providerId, model: runtime.model, workspacePath: runtime.workspacePath, research_mode: runtime.researchMode, createdAt: runtime.createdAt, updatedAt: runtime.updatedAt || new Date().toISOString(), messages: runtime.history, display: {} })
            return json(res, 200, sessionPayload(runtime))
          }
          const data = store.load(id)
          if (data) {
            if (body.title) data.title = body.title
            if (body.providerId) data.providerId = resolveProviderId(loadWebConfig(), body.providerId)
            if (body.model != null) {
              const provider = loadWebConfig().providers[data.providerId]
              const resolvedModel = findProviderModel(provider, body.model)
              if (!resolvedModel) return json(res, 400, { error: `模型不属于当前 Provider：${body.model}` })
              data.model = resolvedModel
            }
            if (body.workspacePath) data.workspacePath = normalizeWorkspace(body.workspacePath)
            data.providerId = resolveProviderId(loadWebConfig(), data.providerId)
            data.updatedAt = new Date().toISOString()
            store.save(id, data)
            // 【2026-09-19】原来固定返回 `messages: []`，与 GET /api/sessions/:id 的
            // 「带完整 messages」形状不一致。当前 8 个调用点只读返回值里的 model 字段，
            // 所以没出过事故；但任何新调用点若写 `setMessages(prev => [...prev, ...res.messages])`
            // 或 `{...res}`，就会**静默清空整个会话**。
            // 这里补上真实历史（与 GET 同源 toUiMessages），消除这个陷阱。
            return json(res, 200, {
              id, title: data.title, providerId: data.providerId,
              model: normalizeStoredModel(data.model) || loadWebConfig().providers[data.providerId]?.model || '',
              providerModel: loadWebConfig().providers[data.providerId]?.model || '',
              workspacePath: data.workspacePath || loadWebSettings().workspacePath,
              createdAt: data.createdAt, updatedAt: data.updatedAt, running: false,
              messages: toUiMessages(data.messages || [], data.workspacePath || loadWebSettings().workspacePath),
            })
          }
          return json(res, 404, { error: 'Session not found' })
        }
        const runtime = getRuntime(id)
        if (req.method === 'GET' && !action) return json(res, 200, sessionPayload(runtime))
        if (req.method === 'GET' && action === 'events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          })
          // 断线重连：优先用标准 Last-Event-ID 头，其次 ?lastEventId= 查询参数
          const headerId = Number(req.headers['last-event-id'])
          const queryId = Number(url.searchParams.get('lastEventId'))
          const afterId = Number.isFinite(headerId) && headerId > 0 ? headerId
            : (Number.isFinite(queryId) && queryId > 0 ? queryId : 0)
          // 【2026-09-19 补修】上一轮只把 replayEvents 内部改成「afterId<=0 时补发全部」，
          // 却漏了这个调用点 —— 这里 `afterId > 0 ? ... : true` 直接把 0 短路掉，
          // 函数根本不被调用。于是行为**完全没变**（replayed 还撒谎写死 true、
          // gap 恒 false），用户仍然「短命令发出去转圈，刷新才看到结果」。
          // 现在无条件调用，由函数自己决定（它已能正确处理 0/负数）。
          const replayed = replayEvents(runtime, res, afterId)
          // snapshot：本轮跑到现在累积的完整正文/思考。重连的客户端不管缓冲缺口多大，
          // 先拿这份对齐再续增量 —— 解决「切页面回来只见后半段」和「整体重载打断」。
          const snapshot = runtime.running && runtime.runSnapshot ? runtime.runSnapshot : null
          res.write(`event: ready\ndata: ${JSON.stringify({ running: runtime.running, lastEventId: runtime.eventSeq || 0, replayed, gap: !replayed, snapshot })}\n\n`)
          runtime.events.add(res)
          runtime.lastActiveAt = Date.now()
          const ping = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 15000)
          req.on('close', () => { clearInterval(ping); runtime.events.delete(res) })
          return
        }
        if (req.method === 'DELETE' && action === 'messages') {
          // 用户气泡的「重新发送 / 编辑」都必须真正删除该用户消息及其后续历史。
          // 原前端只做了本地 slice，后端 Agent 仍带着旧上下文，表面像分支、实际会错乱。
          if (runtime.running) return json(res, 409, { error: '当前对话正在生成，不能修改历史。' })
          const fromIndexRaw = Number(url.searchParams.get('fromIndex'))
          const tailCountRaw = Number(url.searchParams.get('tailCount'))
          let cutIndex = -1
          if (Number.isInteger(fromIndexRaw) && fromIndexRaw >= 0) {
            cutIndex = Math.min(fromIndexRaw, runtime.history.length)
          } else if (Number.isInteger(tailCountRaw) && tailCountRaw > 0) {
            cutIndex = Math.max(0, runtime.history.length - tailCountRaw)
          } else {
            return json(res, 400, { error: '需要 fromIndex 或 tailCount 参数。' })
          }
          const removed = runtime.history.length - cutIndex
          runtime.history = runtime.history.slice(0, cutIndex)
          // 已初始化 Agent 时同步其内存历史；否则下轮 buildAgent 会从 runtime.history 读取。
          runtime.agent?.setHistory?.(runtime.history)
          // 旧 prompt_tokens 对截断后的历史已无效，下次由 API usage 或字符估算重新给值。
          runtime.lastPromptTokens = 0
          runtime.updatedAt = new Date().toISOString()
          saveRuntime(runtime)
          return json(res, 200, { ok: true, removed, fromIndex: cutIndex, session: sessionPayload(runtime) })
        }
        // ── 选择列表回填 ──────────────────────────────────────────────
        // 前端在「选择列表」里点了某一项后调这里。
        //
        // 【为什么是重新执行命令，而不是直接改配置】
        // CLI 的 runSelect 只返回一个字符串，**落盘逻辑在调用方**：
        //   const picked = await runSelect({...})
        //   rest = [picked.model]        ← 塞回参数
        //   ... 走下面既有的赋值/落盘路径
        // Web 跨请求，这段调用栈没了。所以 action='rerun' 的做法是：
        // 把选中值拼成一条等价的带参命令（/model 6 deepseek-v4.1）重新执行 ——
        // 复用同一条落盘路径，配置结构必然与 CLI 一致，不会出现两套写法。
        //
        // 将来若有「选完不该重跑命令」的场景（如纯查询型选择），
        // 再加 action 分支即可（SelectRequired.action 就是为此留的）。
        if (req.method === 'POST' && action === 'command-select') {
          const body = await readBody(req)
          const { action: act, meta = {}, value } = body || {}
          if (value === undefined || value === null) return json(res, 400, { error: '缺少 value' })
          if (act !== 'rerun') return json(res, 400, { error: `未知的选择动作: ${act}` })
          const cmd = String(meta.command || '').trim()
          if (!cmd) return json(res, 400, { error: '缺少 meta.command' })
          // 组装等价命令：/model [provId] <value>
          // provId 只在「不是当前 Provider」时才需要显式带上（与 CLI 的语法一致）。
          const parts = [`/${cmd}`]
          if (meta.provId && !meta.isCurrent) parts.push(String(meta.provId))
          parts.push(String(value))
          const rebuilt = parts.join(' ')
          // runtime 从**路径**里取（/api/sessions/<id>/command-select），
          // 不依赖 body.session —— 路径才是这个端点的身份，body 传 session 是冗余且易错。
          const runtime = runtimes.get(id) || getRuntime(id)
          if (!runtime) return json(res, 404, { error: '会话不存在' })
          ensureRuntimeExtensions(runtime)
          runtime.turnStartSeq = 0
          const result = await executeSlashCommand(runtime, rebuilt)
          if (result && result.kind === 'output') {
            const output = result.text || ''
            runtime.history = [...(runtime.history || []),
              { role: 'user', content: rebuilt, hidden: true, webCommand: true },
              { role: 'assistant', content: [{ type: 'text', text: output }], isCommandOutput: true }]
            runtime.updatedAt = new Date().toISOString()
            saveRuntime(runtime)
            emit(runtime, 'command_result', { content: output, refreshModels: !!result.refreshModels, session: sessionPayload(runtime) })
            return json(res, 200, { ok: true, output, session: sessionPayload(runtime) })
          }
          // 理论上不该再要一次选择（选完就该落盘），但兜底返回给前端
          return json(res, 200, { ok: true, kind: result?.kind || 'unknown', session: sessionPayload(runtime) })
        }
        if (req.method === 'POST' && action === 'messages') {
          const body = await readBody(req)
          const rawContent = String(body.content || '')
          // 【运行中插话】正在生成时不再直接拒绝：把内容塞进 steering 队列，
          // agent 会在下一轮模型调用前把它作为「执行中补充指令」注入对话。
          // 不打断当前工具批次，用户的话也不会丢。
          // slash 命令仍然拒绝（改 Provider/清历史这类操作中途执行会出乱子）。
          if (runtime.running) {
            const trimmed = String(rawContent || '').trim()
            if (trimmed.startsWith('/')) {
              return json(res, 409, { error: '生成中不能执行命令，等这轮结束或先停止。' })
            }
            if (!trimmed && !(body.attachments || []).length) {
              return json(res, 400, { error: '内容为空' })
            }
            runtime.steeringQueue = runtime.steeringQueue || []
            runtime.steeringQueue.push(trimmed)
            // 让前端立刻看到自己的话（作为 user 气泡），不用等下一轮
            runtime.history = [...(runtime.history || []), { role: 'user', content: trimmed, steering: true }]
            runtime.lastActiveAt = Date.now()
            emit(runtime, 'steering_accepted', { content: trimmed, queued: runtime.steeringQueue.length, session: sessionPayload(runtime) })
            return json(res, 202, { accepted: true, steering: true, queued: runtime.steeringQueue.length })
          }
          if (rawContent.trim().startsWith('/')) captureWebInput('command', rawContent.trim())
          // 命令型（output）不经过 runMessage，这里同样要清本轮起点：
          // 否则 /url、/config list 这类命令的 turnStartSeq 会一直停留在
          // 上一次 runMessage 的值，SSE 补发时把那一轮的输出也一起重放出来
          // —— 表现就是「每条命令的回复都长一样」。
          runtime.turnStartSeq = 0
          const commandResult = await executeSlashCommand(runtime, rawContent)
          if (commandResult) {
            if (commandResult.kind === 'prompt') runMessage(runtime, commandResult.content, body.attachments || []).catch(error => emit(runtime, 'error', { message: error?.message || String(error) }))
            else if (commandResult.kind === 'wizard') {
              // 命令要求交互式向导（如 /config provider add 无参）。
              // 前端收到后弹表单，用户填完 POST 到 /api/wizards/<id> 落盘。
              // 向导定义来自 core/wizard-steps.mjs，与 CLI 同一份。
              emit(runtime, 'command_result', {
                content: '',
                wizard: { id: commandResult.wizardId, title: commandResult.title, steps: commandResult.steps },
                session: sessionPayload(runtime),
              })
            }
            else if (commandResult.kind === 'select') {
              // 命令要用户从一批里挑一个（/model 无参拉模型列表 → runSelect）。
              // 前端收到后渲染可滚动列表，点选完 POST /api/command-select 回填。
              emit(runtime, 'command_result', {
                content: '',
                select: {
                  title: commandResult.title,
                  items: commandResult.items,
                  initial: commandResult.initial,
                  footer: commandResult.footer,
                  multi: commandResult.multi,
                  action: commandResult.action,
                  meta: commandResult.meta,
                },
                session: sessionPayload(runtime),
              })
            }
            else {
              const output = commandResult.text || ''
              const historyInput = commandResult.historyContent || rawContent
              // slash 只用于执行/捕获，不作为用户消息气泡展示；结果仍保留为 assistant 气泡。
              // 【2026-09-20 用户反馈「web 端所有 slash 命令都比较敷衍，信息量、排版都显著不如 CLI」】
              // 真相：信息量其实一样（Web 复用 CLI 的 cmdConfig 等实现），
              // 但**排版全丢** —— 命令输出靠缩进对齐（`  Name: xxx`、`    1. key`），
              // 而前端走 MarkdownRenderer（react-markdown），连续空格被折叠成 1 个，
              // 缩进层级消失，读起来就"敷衍"了。
              // 这里打上 isCommandOutput 标记，前端据此改用 <pre> 保留原始格式。
              runtime.history = [...(runtime.history || []), { role: 'user', content: historyInput, hidden: true, webCommand: true }, { role: 'assistant', content: [{ type: 'text', text: output }], isCommandOutput: true }]
              runtime.updatedAt = new Date().toISOString()
              saveRuntime(runtime)
              emit(runtime, 'command_result', { content: output, refreshModels: !!commandResult.refreshModels, session: sessionPayload(runtime) })
            }
            return json(res, 202, { accepted: true, command: true, kind: commandResult.kind, refreshModels: !!commandResult.refreshModels })
          }
          runMessage(runtime, body.content, body.attachments || []).catch(error => emit(runtime, 'error', { message: error?.message || String(error) }))
          return json(res, 202, { accepted: true })
        }
        if (req.method === 'POST' && action === 'open-folder') {
          // 【为什么不再调 termux-open 打开文件管理器】
          // 实测在 Android 11+ 上没有任何 App 能处理「打开目录」这个 Intent：
          //   - termux-open --content-type vnd.android.document/directory → 退出码 0 但无界面
          //   - termux-open-url file:///... → "Activity not started, unable to resolve Intent"
          // 这是系统的 scoped storage 限制，不是配置问题，换参数也没用。
          // 所以改成**返回路径让前端复制到剪贴板 + 显示出来**，
          // 用户能粘到文件管理器地址栏、Termux、或任何需要的地方 —— 比"点了没反应"有用。
          const dir = runtime.workspacePath || loadWebSettings().workspacePath
          if (!dir || !existsSync(dir)) return json(res, 404, { error: `目录不存在：${dir}` })
          // 顺便尝试一下（万一某台设备恰好有 App 能处理，就打开；打不开也不影响返回值）
          try {
            const { execFileSync } = await import('node:child_process')
            execFileSync('termux-open-url', [`file://${dir}`], { timeout: 3000, stdio: 'ignore' })
          } catch {}
          return json(res, 200, { ok: true, dir, copied: false })
        }
        if (req.method === 'GET' && action === 'export') {
          // 导出会话为 Markdown。返回文件内容（前端触发下载），不落盘 ——
          // 服务端落盘在手机上用户还得再去文件管理器找，不如直接给浏览器下载。
          const hist = runtime.agent?.getHistory?.() || runtime.history || []
          const lines = [`# ${runtime.title || '会话导出'}`, '', `导出时间：${new Date().toLocaleString('zh-CN')}`, '']
          for (const m of hist) {
            if (m.hidden) continue
            const text = Array.isArray(m.content)
              ? m.content.filter(b => b?.type === 'text').map(b => b.text).join('\n')
              : String(m.content || '')
            if (!text.trim()) continue
            if (m.role === 'user') lines.push('## 用户', '', text, '')
            else if (m.role === 'assistant') {
              const tools = Array.isArray(m.content) ? m.content.filter(b => b?.type === 'tool_use') : []
              lines.push('## 助手', '', text, '')
              if (tools.length) lines.push(`> 调用工具：${tools.map(t => t.name).join(', ')}`, '')
            }
          }
          const md = lines.join('\n')
          return json(res, 200, { filename: `${(runtime.title || 'conversation').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40)}.md`, content: md })
        }
        if (req.method === 'POST' && action === 'answer') {
          const body = await readBody(req)
          const resolver = runtime.pendingQuestions?.get(body.request_id)
          if (!resolver) return json(res, 404, { error: '问题请求不存在或已过期' })
          runtime.pendingQuestions.delete(body.request_id)
          resolver(body.answers || {})
          return json(res, 200, { ok: true })
        }
        if (req.method === 'POST' && action === 'abort') {
          if (!runtime.running) return json(res, 200, { ok: true, running: false })
          runtime.controller?.abort()
          runtime.agent?.abort()
          // 等服务端真正退出 running（最多 3s），避免前端紧接着发下一条时报“当前对话正在生成”。
          const deadline = Date.now() + 3000
          while (runtime.running && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 50))
          }
          if (runtime.running) {
            // 上游忽略 abort 时，逻辑脱离旧 run；runToken 会阻止它晚到后覆盖新会话。
            //
            // 【2026-09-19 修】这里换掉 runToken 会让旧 run 的 finally 提前 return
            //（`if (runtime.runToken !== runToken) return`），于是**它永远不会 emit done**，
            // 也不会清 running。而这里虽然手动设了 running=false，却**没有通知前端** ——
            // 前端一直等 `done` 事件 → loading 永远 true → 用户看到「一直处理中」，
            // 且这一轮的产出（含已生成的回答）在前端全丢（要刷新才从服务端拉回来）。
            // 所以脱离旧 run 后必须由**这里**补发一次 done，把已经落盘的 history 带给前端。
            runtime.runToken = randomUUID()
            runtime.running = false
            runtime.controller = null
            invalidateRuntimeEngine(runtime)
            runtime.updatedAt = new Date().toISOString()
            runtime.history = runtime.agent?.getHistory?.() || runtime.history || []
            runtime.runSnapshot = null
            saveRuntime(runtime)
            emit(runtime, 'done', { session: sessionPayload(runtime), interrupted: true, detached: true })
          }
          return json(res, 200, { ok: true, running: !!runtime.running, detached: !runtime.running })
        }
      }
      return json(res, 404, { error: 'Not found' })
    }
    
    // 静态文件服务
    // 兼容旧版本 base='./' 生成的缓存资源：/chat/assets/* 也映射到 dist/assets/*。
    let assetPath = url.pathname
    const assetMarker = assetPath.indexOf('/assets/')
    if (assetMarker > 0) assetPath = assetPath.slice(assetMarker)
    if (assetPath.startsWith('/favicon')) assetPath = assetPath.replace(/^\/chat/, '')
    let filePath = assetPath === '/' ? '/index.html' : assetPath
    filePath = join(DIST, filePath)
    if (!existsSync(filePath) && /^\/assets\/index-[A-Za-z0-9_-]+\.(js|css)$/.test(assetPath)) {
      const extension = extname(assetPath)
      const currentEntry = readdirSync(join(DIST, 'assets')).find(name => /^index-[A-Za-z0-9_-]+\.(js|css)$/.test(name) && extname(name) === extension)
      if (currentEntry) filePath = join(DIST, 'assets', currentEntry)
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      filePath = join(DIST, 'index.html')
    }
    const ext = extname(filePath)
    const mimeTypes = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }
    const contentType = mimeTypes[ext] || 'application/octet-stream'
    const content = readFileSync(filePath)
    // index.html 必须禁缓存：它引用带 hash 的 assets，一旦被缓存就永远加载旧版前端。
    // assets 文件名自带内容 hash，可以放心长缓存。
    const cacheHeaders = ext === '.html'
      ? { 'Cache-Control': 'no-cache, no-store, must-revalidate', Pragma: 'no-cache', Expires: '0' }
      : (assetPath.startsWith('/assets/') ? { 'Cache-Control': 'public, max-age=31536000, immutable' } : {})
    res.writeHead(200, { 'Content-Type': contentType, ...cacheHeaders })
    res.end(content)
  } catch (error) {
    json(res, error?.status || 500, { error: error?.message || '服务器错误' })
  }
})

// ---- 进程级异常兜底 ----
// 原来一个未捕获的异步异常就能杀掉整个 Web 服务（所有会话中断且不会自动拉起）。
// unhandledRejection 多是可恢复的异步噪音 → 记录后继续跑；
// uncaughtException 进程状态已不可靠 → 记录后退出，由 start-web.sh 守护循环拉起。
const CRASH_LOG = join(DATA_DIR, 'web-crash.log')
function logFatal(kind, err) {
  const line = `[${new Date().toISOString()}] ${kind}: ${err?.stack || err?.message || String(err)}\n`
  try { console.error(line.trim()) } catch { }
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(CRASH_LOG, line, 'utf8')
  } catch { }
}
process.on('unhandledRejection', reason => logFatal('unhandledRejection', reason))
process.on('uncaughtException', err => {
  logFatal('uncaughtException', err)
  // 尽力把正在跑的会话状态刷盘，再退出
  for (const runtime of runtimes.values()) {
    try { runtime.running = false; saveRuntime(runtime) } catch { }
  }
  try { stopKeepalive() } catch { }
  process.exit(1)
})
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const runtime of runtimes.values()) {
      try { runtime.running = false; saveRuntime(runtime) } catch { }
    }
    // SessionEnd 是观察类 hook，不等它跑完（进程要立刻退）
    try { hookManager.trigger('SessionEnd', { event: 'SessionEnd', matcher: 'web', reason: sig }) } catch { }
    try { stopKeepalive() } catch { }
    process.exit(0)
  })
}


/**
 * 启动 QQ 桥（幂等）。
 *
 * 【为什么抽成函数】两条路径都要用它：
 *   · server.listen 时（配置里 enabled=true 才启动）
 *   · /qq on 命令（force=true，用户明确要开）
 * 返回 { ok, bridge?, reason? }。
 */
async function startQqBridgeIfNeeded({ force = false } = {}) {
  if (qqBridgeRef) return { ok: true, bridge: qqBridgeRef, reason: '已在运行' }
  const { bridge, reason } = await startWebQqBridge({
    force,
    getActiveRuntime: () => {
      let best = null
      for (const rt of runtimes.values()) {
        if (rt.running) return rt
        if (!best || (rt.lastActiveAt || 0) > (best.lastActiveAt || 0)) best = rt
      }
      if (best) return best
      try { return createAndSaveRuntime({ title: 'QQ 会话' }) } catch { return null }
    },
    runMessage,
    emit,
  })
  if (!bridge) return { ok: false, reason }
  qqBridgeRef = bridge
  // 桥启动前建的 agent 没有 QQ 工具 —— 清掉让下次 buildAgent 带上
  for (const rt of runtimes.values()) invalidateRuntimeEngine(rt)
  return { ok: true, bridge }
}

server.listen(PORT, HOST, () => {
  console.log(`Claude Code Mobile Web 后端: http://${HOST}:${PORT}`)
  // 【2026-10-08】自动压缩阈值走**共享配置**（README：「与 CLI 共享配置与会话数据」）。
  // auto-compact.mjs 读的 config.json 就是 CLI 那份 —— Web 不需要注入任何东西，
  // 两边天然一致（CLI 设的 Web 可见、Web 改的 CLI 生效）。
  // 我一度加过 setThresholdSource 注入让 Web 写 web-config.json，方向反了，已删。
  startKeepalive({ port: PORT, host: HOST }).then(({ audioStarted }) => {
    console.log(`[web] 保活: wake-lock + 常驻通知${audioStarted ? ' + 静音音频' : '（静音音频未启动）'}`)
  }).catch(() => { })

  // ── QQ 桥（可选功能）──
  //
  // 【为什么 Web 也要有】用户的用法是「人在外面用手机 QQ 下指令，回来在网页看结果」。
  // 桥本身只依赖 node:http + fetch —— NapCat 是用户自己在 Termux 跑的独立进程，
  // 两者走 127.0.0.1 通信，proot 和 Termux 共享网络命名空间，所以 CCM 里直接可用。
  // **不需要**把 NapCat 装进 proot。
  //
  // 【默认不开】配置文件里 enabled !== true 就跳过，避免用户没配过就被占用 3000 端口。
  // 用 /qq on 开启（会写进 qq-config.json，CLI 和 Web 共用同一份）。
  startQqBridgeIfNeeded().then(({ ok, bridge, reason }) => {
    if (ok) console.log(`[QQ桥] 已启动，监听 ${bridge.port}`)
    else if (reason) console.log(`[QQ桥] 未启动：${reason}`)
  }).catch(e => console.warn('[QQ桥] 启动失败:', e?.message || e))
})
