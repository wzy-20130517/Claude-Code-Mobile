// Claude Code Mobile - Tool 抽象 + 工厂模式
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 默认工具配置（安全优先）
const TOOL_DEFAULTS = {
  isReadOnly: () => false,           // 只读工具（Read/Grep/Glob 等标记为 true）
  isDestructive: () => false,        // 破坏性操作（Bash rm 等标记为 true）
  isConcurrencySafe: () => false,    // 可并行执行
  // 超过此大小时截断（保头尾 + 完整结果写盘）。
  // 不写死 30000：跟官方一样允许 BASH_MAX_OUTPUT_LENGTH 覆盖。
  maxResultSizeChars: null,
  validateInput: null,               // 参数校验函数 (input) => { valid: bool, errors?: [] }
  // 权限检查（默认允许）
  checkPermissions: (input) => ({ behavior: 'allow', updatedInput: input }),
}

// buildTool 工厂：合并默认值
export function buildTool(def) {
  return { ...TOOL_DEFAULTS, ...def }
}

// 输出检查器：超过限制时把完整结果写磁盘，返回摘要
const TOOL_OUTPUT_DIR = join(homedir(), '.claude-code-mobile', 'tool-output')

/**
 * 输出上限。官方用 BASH_MAX_OUTPUT_LENGTH 环境变量覆盖，
 * 默认 30000、上限 150000（src/utils/shell/outputLimits.ts）。这里对齐同名变量。
 */
export const TOOL_OUTPUT_DEFAULT = 30000
export const TOOL_OUTPUT_UPPER_LIMIT = 150000
// 落盘文件硬上限：对标官方 2.1.265（1 GB cap on tool results saved to disk）。
// 超过即截断写入，防失控任务（cat 超大文件/无限循环日志）写满手机磁盘。
export const TOOL_SAVED_FILE_MAX_BYTES = 1024 * 1024 * 1024
export function getMaxOutputLength(fallback = TOOL_OUTPUT_DEFAULT) {
  const raw = process.env.BASH_MAX_OUTPUT_LENGTH
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(n, TOOL_OUTPUT_UPPER_LIMIT)
}

function truncateResult(content, maxChars, toolName, toolId = '') {
  // ⚠️ 对象**不能**在这里 String()。
  //
  // 【踩过的坑】原实现开头是 `if (typeof content !== 'string') content = String(content)`，
  // 于是任何返回对象的工具（最典型：phone_screenshot / ViewImage 的
  // `{__type:'vision', text, path, images}`）到这里就变成 "[object Object]" ——
  // 而且它只有 15 个字符，**长度远小于 maxChars，会原样返回**，
  // 所以连「截断」的日志都不会有，看着像工具自己返回了这个诡异的字符串。
  //
  // 后果不只是显示难看：`__type:'vision'` 被抹掉后，agent 的识图旁路
  // （把图片作为多模态 user 消息注入）永远不触发 —— 截图功能整个失效，
  // 但调用方看到的是 ok:true，没有任何报错。
  //
  // 【为什么结构化结果直接放行】`maxChars` 是给**文本**输出用的预算
  // （默认 30000 字符）。图片 base64 动辄几百 KB，拿同一把尺子量必然超，
  // 然后就被"截断"成字符串 —— 等于又把这个功能毁掉。
  // 这类结果由 agent 按 `__type` 分派（vision 走多模态注入、其它走各自的
  // 渲染通道），体积控制是它们各自的责任，不该在这里二次处理。
  if (typeof content !== 'string') {
    if (content && typeof content === 'object' && content.__type) return content
    // 其它普通对象：用 JSON 量体积，超了才降级（保留 JSON 形态，别用 String() 毁结构）
    let serialized
    try { serialized = JSON.stringify(content) } catch { return content }
    if (serialized === undefined || serialized.length <= maxChars) return content
    content = serialized
  }
  if (content.length <= maxChars) return content
  // 写完整结果到磁盘（~/.claude-code-mobile/tool-output/，可读可写）
  try { if (!existsSync(TOOL_OUTPUT_DIR)) mkdirSync(TOOL_OUTPUT_DIR, { recursive: true }) } catch {}
  const filePath = join(TOOL_OUTPUT_DIR, `tool-${toolName}-${Date.now() % 100000}${toolId || ''}.txt`)
  // 1GB 硬上限：只写前 1GB，多余部分丢弃。模型上下文拿到的本来只有摘要，
  // 截断不影响对话；目的是保住手机存储不被单任务写满。
  let savedFull = true
  try {
    if (Buffer.byteLength(content) > TOOL_SAVED_FILE_MAX_BYTES) {
      const buf = Buffer.from(content, 'utf-8')
      writeFileSync(filePath, buf.subarray(0, TOOL_SAVED_FILE_MAX_BYTES))
      savedFull = false
    } else {
      writeFileSync(filePath, content)
    }
  } catch {}
  // 保留前 maxChars*0.5 和后 maxChars*0.3，中间省略号
  const headLen = Math.floor(maxChars * 0.5)
  const tailLen = Math.floor(maxChars * 0.3)
  const head = content.slice(0, headLen)
  // 文件被 1GB 截断时尾部不在磁盘上，tail 只在完整写入时才有意义
  const tail = savedFull ? content.slice(-tailLen) : ''
  // 官方会标出省略了多少行（`... [N lines truncated] ...`）——只说字符数的话，
  // 模型不知道自己漏看了多大一块。这里两个都给。
  const omitted = content.slice(headLen, savedFull ? content.length - tailLen : content.length)
  const omittedLines = omitted ? omitted.split('\n').length : 0
  const note = `... [内容超限，省略 ${omittedLines} 行 / 共 ${content.length} 字符，完整结果已写 ${filePath}${savedFull ? '' : '（超过 1GB 上限，仅前 1GB 落盘）'}] ...`
  return `${head}\n\n${note}\n\n${tail}`
}

// 工具基类
export class Tool {
  constructor(config, ...args) {
    const opts = buildTool(config)
    this.name = opts.name
    this.description = opts.description
    this.input_schema = opts.input_schema
    // 新增元数据
    this._isReadOnly = opts.isReadOnly
    this._isDestructive = opts.isDestructive
    this._isConcurrencySafe = opts.isConcurrencySafe
    // null 表示没有单独指定 → 走全局上限（可被环境变量覆盖）
    this.maxResultSizeChars = opts.maxResultSizeChars ?? null
    this._validateInput = opts.validateInput
    this._checkPermissions = opts.checkPermissions
    this.mcpServer = null
    this.mcpTool = null
    // 保留额外参数（如 undoStore）
    for (const arg of args) {
      if (typeof arg === 'object' && arg !== null) {
        Object.assign(this, arg)
      }
    }
  }

  // ctx: { signal } —— 需要支持取消的工具（如 Bash）可读取 ctx.signal 在超时/中断时杀子进程。
  // 不关心取消的工具直接忽略第二个参数，向后兼容。
  async execute(input, ctx = {}) { throw new Error('not implemented') }

  // 构造时元数据
  isReadOnly() { return this._isReadOnly() }
  isDestructive() { return this._isDestructive() }
  isConcurrencySafe() { return this._isConcurrencySafe() }

  // 参数校验：统一返回 { valid, errors }
  //
  // 【2026-08-30 加归一化，修 AgentMemory/AgentStatus 崩溃】
  // 框架约定返回 { valid, errors }，但部分工具（子类覆写 validateInput）用的是
  // 「返回字符串 = 错误信息 / 返回 null = 通过」这种更直观的风格。
  // run() 里直接访问 v.valid，遇到 null 就抛 `Cannot read properties of null
  // (reading 'valid')` —— AgentMemory 读写双向全挂、AgentStatus 同理，
  // 导致「子 Agent 分类型长期记忆」这条能力静默失效（没人发现自己没收到经验注入）。
  //
  // 根因是隐式契约没有强制：约定写在注释里，子类覆写时无人校验。
  // 这里做归一化，两种风格都接受——修的是「这类错误还会再犯」而不只是这两个工具。
  validateInput(input) {
    if (!this._validateInput) return { valid: true }
    return this._normalizeValidation(this._validateInput(input))
  }

  // 把各种返回风格归一成 { valid, errors: string[] }
  _normalizeValidation(r) {
    if (r == null) return { valid: true }                        // null/undefined = 通过
    if (typeof r === 'string') {                                  // 字符串 = 错误信息
      return r.trim() ? { valid: false, errors: [r] } : { valid: true }
    }
    if (Array.isArray(r)) {                                       // 数组 = 错误列表
      return r.length ? { valid: false, errors: r.map(String) } : { valid: true }
    }
    if (typeof r === 'boolean') return { valid: r, errors: r ? [] : ['参数校验未通过'] }
    if (typeof r === 'object') {
      // 标准风格；errors 容错单个 error 字段
      const errors = r.errors != null
        ? (Array.isArray(r.errors) ? r.errors.map(String) : [String(r.errors)])
        : (r.error != null ? [String(r.error)] : [])
      return { valid: r.valid !== false, errors }
    }
    return { valid: true }
  }

  // 权限检查
  async checkPermissions(input) {
    return this._checkPermissions(input)
  }

  // 包装执行：校验 → 权限 → 执行 → 截断
  // ctx 透传给 execute，里面带 signal（由 Agent 在超时/中断时 abort）
  async run(input, ctx = {}) {
    // 参数校验：失败时给出清晰提示（已收到参数 vs schema 要求），引导模型修正重试而非放弃
    // 再归一化一次：子类可能整体覆写 validateInput（绕过基类的归一化），
    // 这里兜底保证 v 一定是 { valid, errors } 形状，永不出现 null.valid 崩溃。
    const v = this._normalizeValidation(this.validateInput(input))
    if (!v.valid) {
      const errors = (v.errors || []).join('; ')
      // 统计已收到的参数名
      const received = input && typeof input === 'object'
        ? Object.keys(input).filter(k => input[k] !== undefined && input[k] !== null && input[k] !== '')
        : []
      const receivedStr = received.length ? received.join(', ') : '(无)'
      // 统计 schema 要求的必填参数
      const schema = this.input_schema?.properties || {}
      const required = (this.input_schema?.required || []).filter(r => !received.includes(r))
      const requiredStr = required.length ? required.join(', ') : '(无)'
      throw new Error(
        `工具参数校验失败: ${errors}\n` +
        `  · 工具: ${this.name}\n` +
        `  · 已收到参数: ${receivedStr}\n` +
        `  · 缺失/无效的必填参数: ${requiredStr}\n` +
        `  · 修正后重试本次工具调用（不要放弃任务，流程可继续）`
      )
    }
    // 权限检查
    const perm = await this.checkPermissions(input)
    if (perm.behavior === 'deny') {
      throw new Error(`权限被拒绝: ${perm.message || '操作未获授权'}`)
    }
    // 执行
    const result = await this.execute(perm.updatedInput || input, ctx)
    // 结果截断
    return truncateResult(result, this.maxResultSizeChars ?? getMaxOutputLength(), this.name)
  }

  toSchema() {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema
    }
  }
}

export class ToolRegistry {
  constructor() {
    this.tools = new Map()
    // 小写名 → 正式名 的索引（大小写不敏感查找用）。
    // 用独立 Map 而不是遍历 this.tools：get() 在每轮工具调用都要走，
    // 遍历 100+ 个工具只为找一个名字是纯浪费。
    this._lower = new Map()
  }

  /** 内部：登记小写索引（重名时后者覆盖，与 Map.set 行为一致） */
  _indexLower(name) {
    this._lower.set(String(name).toLowerCase(), name)
  }

  register(t) {
    if (!(t instanceof Tool)) throw new Error('Must be Tool')
    this.tools.set(t.name, t)
    this._indexLower(t.name)
  }
  // 惰性注册：传工厂函数 (registry) => Tool，首次 get 时才实例化
  // 参考 OpenCode define+init：工具可声明依赖（如 undoStore/agent 服务），按需注入
  registerLazy(name, factory) {
    this.tools.set(name, { __lazy: true, name, factory })
    this._indexLower(name)
  }

  /**
   * 按名取工具。**大小写不敏感**。
   *
   * 【为什么】模型经常把工具名写错大小写（`Read` 写成 `read`、`GitStatus`
   * 写成 `gitstatus`、`WebSearch` 写成 `websearch`）。Claude 官方 API 的
   * tool_use.name 是模型生成的自由文本，各厂商模型（尤其非 Anthropic 的）
   * 大小写习惯不一致；以前这里精确匹配 → 模型明明调了正确的工具，却得到
   * `Tool "read" not found`，整轮白跑。
   *
   * 【为什么不用遍历】get() 在每次工具调用都走，100+ 工具时遍历是浪费；
   * 用 _lower 索引 O(1)。
   *
   * 精确匹配优先（避免「注册了 Read 和 read 两个工具」时的歧义）。
   */
  get(n) {
    let key = n
    let t = this.tools.get(key)
    if (t === undefined && typeof n === 'string') {
      // 大小写不敏感回退
      const canonical = this._lower.get(n.toLowerCase())
      if (canonical !== undefined) {
        key = canonical
        t = this.tools.get(key)
      }
    }
    if (t && t.__lazy) {
      const real = t.factory(this)
      if (!(real instanceof Tool)) throw new Error(`Lazy tool ${key} factory must return Tool`)
      real.__name = key
      this.tools.set(key, real)
      return real
    }
    return t
  }
  list() { return Array.from(this.tools.values()).map(t => (t && t.__lazy) ? this.get(t.name) : t) }
  toSchemas() { return this.list().map(t => t.toSchema()) }
  
  // 列出只读工具（可用于并行优化）
  listReadOnly() { return this.list().filter(t => t.isReadOnly()) }
  // 列出可并行工具
  listConcurrencySafe() { return this.list().filter(t => t.isConcurrencySafe()) }
}
