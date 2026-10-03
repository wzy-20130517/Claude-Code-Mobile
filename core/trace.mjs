// Claude Code Mobile - Agent trace/replay
// 轻量 JSONL 事件记录：用于定位超时、重试、工具调用和子 Agent 生命周期。
// 默认只保存脱敏后的元数据；正文/工具结果仅保留短预览。
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const TRACE_DIR = join(homedir(), '.claude-code-mobile', 'traces')
const MAX_PREVIEW = 500
const MAX_FIELD_CHARS = 4000
const MAX_FILE_BYTES = 8 * 1024 * 1024
/** 单条 trace 事件的字节上限（超过就只留摘要，不写正文） */
const MAX_EVENT_BYTES = 64 * 1024
const SECRET_KEY_RE = /^(?:authorization|api[_-]?key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|cookie|set-cookie|private[_-]?key|client[_-]?secret)$/i
const SECRET_VALUE_RE = /(?:sk-[A-Za-z0-9_-]{8,}|ctx7sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}|AKIA[0-9A-Z]{16})/g

function ensureDir() {
  try { if (!existsSync(TRACE_DIR)) mkdirSync(TRACE_DIR, { recursive: true }) } catch {}
  return TRACE_DIR
}

function truncate(value, max = MAX_PREVIEW) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max)}…[${text.length} chars]` : text
}

/**
 * 单次 redact 调用的「预算」—— 迭代节点数上限。
 *
 * ═══════════════════════════════════════════════════════════════
 * 【为什么必须有 —— 2026-09-26 定位到「Responding… 永久卡死」的真凶】
 *
 * 症状：run 结束后或流式输出开始时，终端彻底冻住，Ctrl+C 无效，
 * 只能大退；用户报告「放学回来发现已经卡了几小时」。trace 里能
 * 看到某个 tool_result 之后再无任何事件。
 *
 * 根因就在本文件的 redact()：它是**递归 + 扇出**的，
 * 而原来的约束只有「深度 ≤ 5」「数组取前 30」「对象取前 80」。
 * 这三条组合起来的最坏情况是 30^5 = 2430 万次迭代，**没有总量闸门**。
 *
 * 实测（~/t-explode.mjs）指数增长确认：
 *   深度 1 × 宽度 5 →    20ms
 *   深度 2 × 宽度 5 →    68ms   (×3.4)
 *   深度 3 × 宽度 5 →   322ms   (×4.7)
 *   深度 4 × 宽度 5 →  1579ms   (×4.9)  ← 每层 ×5
 * 到第 5 层就是 8 秒级；若每层节点本身更大（工具返回的嵌套对象），
 * 几十秒到几分钟完全可能。而这是**同步**执行的，事件循环全程被占死。
 *
 * 【第二个放大器：String 包装对象】
 * `typeof new String('x') === 'object'` —— 于是它掉进对象分支，
 * `Object.entries()` 会返回 **每个字符一个键** 的数组：
 *   new String('abc') → [['0','a'],['1','b'],['2','c']]
 * 实测：5 万字符的包装对象，单次 Object.entries 就要 120ms（10 万字符 412ms）。
 * 而 Bash 工具历史上会用 `new String(...)` 包 __ok 标记（见 agent.mjs:932 的注释），
 * 一旦这种值进了 trace 参数，就是「大字符串 × 逐字符展开 × 递归」三重叠加。
 *
 * 【修法】加一个节点计数器，超预算立刻返回占位符。
 * 这样把「最坏情况」从「30^5 次迭代」压到「固定 N 次」，与输入形状无关。
 * ═══════════════════════════════════════════════════════════════
 */
const REDACT_MAX_NODES = 2000

/**
 * 单次 redact 的**字节预算**。
 *
 * 光有节点上限不够：2000 个节点如果每个都带一段长字符串，
 * 序列化后仍是几百 KB（实测 27000 节点输入 → 输出被限到 2053 节点，
 * 但因为叶子是 200 字的字符串，JSON 仍有 383KB）。
 * trace 是**每轮、每个工具调用都写**的，几百 KB 的量级会拖慢磁盘、
 * 也会让 jsonl 迅速吃满 MAX_FILE_BYTES 而停记。
 *
 * 所以再加一道按字符计的预算：累加所有字符串片段的长度，
 * 超了就把后续字符串换成占位符。两道闸门一起把 trace 事件压到
 * 「与输入形状和大小都无关」的固定上界。
 */
const REDACT_MAX_CHARS = 60000

export function redact(value, depth = 0) {
  // 计数器挂在闭包外的模块级变量上会有重入问题（多 agent 并发），
  // 所以用「入口建计数对象、内部传引用」的写法。
  return _redact(value, depth, { n: 0, chars: 0 })
}

function _redact(value, depth, budget) {
  if (++budget.n > REDACT_MAX_NODES) return '[truncated]'
  if (depth > 5) return '[depth omitted]'
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const clean = value.replace(SECRET_VALUE_RE, '[REDACTED]')
    if (budget.chars > REDACT_MAX_CHARS) return `[${clean.length} chars omitted]`
    const room = REDACT_MAX_CHARS - budget.chars
    const capped = clean.length > Math.min(MAX_FIELD_CHARS, room)
      ? `${clean.slice(0, Math.min(MAX_FIELD_CHARS, room))}…[${clean.length} chars]`
      : clean
    budget.chars += capped.length
    return capped
  }
  // 【String / Number / Boolean 包装对象必须先拆箱】
  // typeof 它们是 'object'，会掉进下面的对象分支被 Object.entries 逐字符展开。
  if (value instanceof String) {
    const s = String(value)
    const clean = s.replace(SECRET_VALUE_RE, '[REDACTED]')
    if (budget.chars > REDACT_MAX_CHARS) return `[${clean.length} chars omitted]`
    const room = REDACT_MAX_CHARS - budget.chars
    const capped = clean.length > Math.min(MAX_FIELD_CHARS, room)
      ? `${clean.slice(0, Math.min(MAX_FIELD_CHARS, room))}…[${clean.length} chars]`
      : clean
    budget.chars += capped.length
    return capped
  }
  if (value instanceof Number || value instanceof Boolean) return value.valueOf()
  // 其他内置对象（Date/RegExp/Error/Buffer...）没有可枚举的自有属性，
  // 走对象分支只会得到 {} 或巨大的数组。统一转成短字符串。
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) return `[Error] ${value.message}`.slice(0, 500)
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `[Binary ${value.byteLength ?? 0}B]`
  }
  if (Array.isArray(value)) {
    // 数组：先按预算砍长度，再逐个进来。原来只 slice(0,30)，
    // 30 个子节点各自还能再扇出 30^4 —— 闸门虽在，但要跑满 2000 节点才停。
    const room = REDACT_MAX_NODES - budget.n
    if (room <= 0) return '[truncated]'
    const cap = Math.min(value.length, 30, Math.max(1, room))
    const out = new Array(cap)
    for (let i = 0; i < cap; i++) out[i] = _redact(value[i], depth + 1, budget)
    if (value.length > cap) out.push(`…[${value.length - cap} more]`)
    return out
  }
  if (typeof value === 'object') {
    const out = {}
    const room = REDACT_MAX_NODES - budget.n
    if (room <= 0) return '[truncated]'
    // Object.entries 本身在超大对象上就是 O(n) 分配，先拿到键再按预算取，
    // 避免为了 slice(0,80) 先建一个几万项的数组（String 包装对象的坑正是这个）。
    let keys
    try { keys = Object.keys(value) } catch { return '[unreadable]' }
    const cap = Math.min(keys.length, 80, Math.max(1, room))
    for (let i = 0; i < cap; i++) {
      const key = keys[i]
      if (budget.n > REDACT_MAX_NODES) { out['…'] = '[truncated]'; break }
      let item
      try { item = value[key] } catch { item = '[unreadable]' }
      out[key] = SECRET_KEY_RE.test(key) ? '[REDACTED]' : _redact(item, depth + 1, budget)
    }
    if (keys.length > cap) out['…'] = `[${keys.length - cap} more]`
    return out
  }
  return String(value)
}

export function preview(value, max = MAX_PREVIEW) {
  // 【顺序很关键：先截断、后脱敏】
  //
  // 原实现是 truncate(redact(value), max) —— 先对**整个对象树**做 redact，
  // 再截断到 500 字。于是「截断」这一步省下的开销完全没意义：
  // 一个 5 万字符的工具结果会先被完整遍历（String 包装对象时是逐字符），
  // 最后才砍成 500 字。修 redact 的预算闸门后不会卡死了，
  // 但也没必要白跑那几千次迭代 —— 先 stringify 成文本、砍到 max，
  // 再对这小段文本做脱敏，成本从「与输入成正比」降到「常数」。
  //
  // ⚠️ 但不能反过来完全跳过 redact：trace 里绝不能出现明文 key。
  //    所以是「先 stringify → 截断 → 对截断后的文本脱敏」。
  let text
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    // 循环引用、BigInt 等 stringify 会抛 —— 退化成兜底描述，
    // 不能让它冒泡（trace 是诊断设施，不该反过来搞崩主流程）
    try { text = String(value) } catch { text = '[unserializable]' }
  }
  if (!text) return ''
  if (typeof text !== 'string') text = String(text)
  const cut = text.length > max ? `${text.slice(0, max)}…[${text.length} chars]` : text
  // 截断后的短文本再脱敏（成本 O(max)，与输入规模无关）
  return cut.replace(SECRET_VALUE_RE, '[REDACTED]')
}

function safeRunId() {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

export class TraceStore {
  constructor({ enabled = true, dir = TRACE_DIR, runId = null, maxFileBytes = MAX_FILE_BYTES, logger = null } = {}) {
    this.enabled = enabled !== false
    this.dir = dir
    this.runId = runId || safeRunId()
    this.file = join(dir, `${this.runId}.jsonl`)
    this.maxFileBytes = maxFileBytes
    this.logger = logger
    this.seq = 0
    this.startedAt = Date.now()
    if (this.enabled) {
      try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch (e) { this.enabled = false; logger?.warn?.(`[Trace] 初始化失败: ${e.message}`) }
    }
  }

  emit(type, data = {}) {
    if (!this.enabled) return null
    const event = {
      seq: ++this.seq,
      ts: new Date().toISOString(),
      elapsed_ms: Date.now() - this.startedAt,
      run_id: this.runId,
      type,
      data: redact(data),
    }
    try {
      if (existsSync(this.file) && statSync(this.file).size >= this.maxFileBytes) {
        this.enabled = false
        this.logger?.warn?.(`[Trace] 文件达到上限，停止记录: ${this.file}`)
        return event
      }
      // 【写盘前的最后一道闸门】redact 已经限制了节点数和字符数，
      // 但序列化本身仍可能因为形状怪异（超长单键名、深层嵌套）而变大。
      // 这里再兜一次：超过 MAX_EVENT_BYTES 就不写 data，只留类型和摘要 ——
      // trace 是诊断设施，宁可丢一条详情，也不能写爆磁盘或拖慢主流程。
      let line = JSON.stringify(event)
      if (line.length > MAX_EVENT_BYTES) {
        const brief = { ...event, data: { _oversized: true, bytes: line.length, keys: Object.keys(event.data || {}).slice(0, 20) } }
        line = JSON.stringify(brief)
      }
      appendFileSync(this.file, line + '\n', 'utf-8')
    } catch (e) {
      this.logger?.warn?.(`[Trace] 写入失败: ${e.message}`)
    }
    return event
  }

  child(label, data = {}) {
    const child = new TraceStore({ enabled: this.enabled, dir: this.dir, maxFileBytes: this.maxFileBytes, logger: this.logger })
    child.parentRunId = this.runId
    child.emit('child_start', { label, parent_run_id: this.runId, ...data })
    return child
  }

  end(data = {}) {
    this.emit('run_end', { duration_ms: Date.now() - this.startedAt, ...data })
  }
}

export function listTraces({ dir = TRACE_DIR, limit = 20 } = {}) {
  try {
    return readdirSync(dir)
      .filter(name => name.endsWith('.jsonl'))
      .map(name => {
        const file = join(dir, name)
        let first = null
        try { first = JSON.parse(readFileSync(file, 'utf-8').split('\n').find(Boolean) || 'null') } catch {}
        const st = statSync(file)
        return { runId: name.slice(0, -6), file, size: st.size, mtime: st.mtime.toISOString(), first }
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime))
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
  } catch { return [] }
}

export function readTrace(runId, { dir = TRACE_DIR, limit = 200 } = {}) {
  if (!/^[a-z0-9-]+$/i.test(String(runId || ''))) return []
  const file = join(dir, `${runId}.jsonl`)
  try {
    return readFileSync(file, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(2000, Number(limit) || 200)))
      .map(line => { try { return JSON.parse(line) } catch { return { type: 'parse_error', raw: line.slice(0, MAX_PREVIEW) } } })
  } catch { return [] }
}

export function formatTraceList(items) {
  if (!items.length) return `暂无 trace。目录: ${TRACE_DIR}`
  return `最近 trace（${items.length} 个）:\n` + items.map((item, i) => {
    const first = item.first
    const type = first?.data?.kind || first?.type || '?'
    return `  ${i + 1}. ${item.runId} · ${type} · ${(item.size / 1024).toFixed(1)}KB · ${item.mtime}`
  }).join('\n')
}

export function formatTraceEvents(events) {
  if (!events.length) return '没有找到 trace 事件。'
  return events.map(e => {
    const data = e.data && typeof e.data === 'object' ? e.data : {}
    const detail = data.tool || data.name || data.error || data.status || data.message || data.kind || ''
    return `${String(e.seq).padStart(4)} ${e.ts} ${e.type}${detail ? ` · ${preview(detail, 180)}` : ''}`
  }).join('\n')
}

// 离线回放只读取 JSONL，不调用模型、不执行工具；用于复盘一次 run 的时间线。
export function formatTraceReplay(events) {
  if (!events.length) return '没有找到可回放的 trace 事件。'
  const first = events[0]
  const last = events[events.length - 1]
  const errors = events.filter(e => /error/i.test(e.type))
  const tools = events.filter(e => e.type === 'tool_start').map(e => e.data?.tool).filter(Boolean)
  return [
    `离线 Trace Replay: ${first.run_id || '?'}`,
    `事件: ${events.length} · 时间: ${first.ts || '?'} → ${last.ts || '?'}`,
    `工具: ${tools.length ? [...new Set(tools)].join(', ') : '(无)'}`,
    `错误事件: ${errors.length}`,
    '',
    formatTraceEvents(events),
  ].join('\n')
}

export { TRACE_DIR }
