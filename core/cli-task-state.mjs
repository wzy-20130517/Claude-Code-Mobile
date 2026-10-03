// Claude Code Mobile - CLI 任务状态与结果卡片
// 纯逻辑模块：不依赖终端、Agent 或 API，便于离线测试。

export const CLI_TASK_STATUSES = Object.freeze([
  'idle',
  'running',
  'waiting_for_user',
  'completed',
  'failed',
  'cancelled',
])

const MAX_TOOLS = 100
const MAX_EVENTS = 200

function text(value, max = 240) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function inputSummary(input = {}) {
  if (!input || typeof input !== 'object') return ''
  return text(
    input.file_path || input.path || input.command || input.pattern || input.query ||
    input.description || input.question || input.task_id || '',
    180,
  )
}

function isCheckTool(name, input = {}) {
  const n = String(name || '')
  const command = String(input.command || '').toLowerCase()
  return n === 'Test' || n === 'Diagnostics' || n === 'LSP' ||
    // 跑 tests/ 目录下的脚本也算检查（`\btest\b` 匹配不到 tests/key-pool.mjs，
    // 因为那里的词是 tests 不是 test，会漏统计）
    /(^|\s|\/)tests?\//.test(command) ||
    /\b(test|pytest|jest|vitest|mocha|npm\s+test|pnpm\s+test|yarn\s+test|cargo\s+test|lint|eslint|tsc|typecheck|mypy|ruff|build|compile|node\s+--check|playwright|cypress)\b/.test(command)
}

function isSuccessfulResult(result) {
  if (result && typeof result === 'object') {
    if (result.__ok === false) return false
    if (result.__ok === true) return true
    if (result.ok === false || result.success === false || result.exitCode > 0) return false
    if (result.ok === true || result.success === true || result.exitCode === 0) return true
  }
  const raw = (typeof result === 'string' || result instanceof String) ? String(result) : String(result ?? '')

  // 只认"工具自己报错"的固定前缀，不再扫全文关键词。
  // 旧实现用 /\b(error|failed|...)\b/ 扫整个输出，于是 grep 到一行
  // `throw new Error('...')`、读到含 errorMsg 的源码、搜索结果里带"失败"
  // 的日志，全都被标成红色 Error —— 命令其实退出码 0。
  // 判成败是状态问题，不能靠读内容猜；有真实状态的工具走 __ok。
  if (/^\s*(?:错误|Error)\s*[:：]/i.test(raw)) return false
  if (/^\s*\((?:超时|已取消)/.test(raw)) return false
  if (/\bexit code [1-9]/i.test(raw)) return false
  return true
}

function isEditTool(name, input = {}) {
  const n = String(name || '')
  return /(?:Write|Edit|Patch|Rename|mkdir|rm|delete)/i.test(n) ||
    ['FileWrite', 'FileEdit', 'MultiEdit', 'HashlineEdit', 'ApplyPatch', 'SafeRename'].includes(n) ||
    Boolean(input.file_path && /write|edit|patch|rename/i.test(n))
}

export class CliTaskState {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now
    this.reset()
  }

  reset() {
    this.id = null
    this.status = 'idle'
    this.goal = ''
    this.startedAt = null
    this.endedAt = null
    this.lastError = null
    this.tools = []
    this.events = []
    this.files = []
    this.checks = []
    this.currentTool = null
    this.lastText = ''
    this.queueLength = 0
  }

  begin(goal = '', { id = null } = {}) {
    this.reset()
    this.id = id || `cli-${this.now()}`
    this.status = 'running'
    this.goal = text(goal, 500)
    this.startedAt = this.now()
    this.addEvent('run_start', { goal: this.goal })
    return this.snapshot()
  }

  setQueueLength(length) {
    this.queueLength = Math.max(0, Number(length) || 0)
    return this.snapshot()
  }

  setWaiting(question = '') {
    this.status = 'waiting_for_user'
    this.addEvent('waiting_for_user', { question: text(question, 500) })
    return this.snapshot()
  }

  addEvent(type, payload = {}) {
    this.events.push({ type: String(type || 'event'), at: this.now(), ...payload })
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)
  }

  startTool(name, input = {}, toolCallId = null) {
    const row = {
      id: toolCallId || `tool-${this.now()}-${this.tools.length}`,
      name: String(name || 'unknown'),
      summary: inputSummary(input),
      input: input && typeof input === 'object' ? { ...input } : {},
      startedAt: this.now(),
      endedAt: null,
      durationMs: null,
      ok: null,
      result: '',
    }
    this.tools.push(row)
    if (this.tools.length > MAX_TOOLS) this.tools.shift()
    this.currentTool = row
    this.addEvent('tool_start', { name: row.name, summary: row.summary, toolCallId: row.id })
    if (isEditTool(row.name, row.input)) {
      const path = row.input.file_path || row.input.path
      if (typeof path === 'string' && path.trim() && !this.files.includes(path)) this.files.push(path)
    }
    if (isCheckTool(row.name, row.input)) {
      this.checks.push({ id: row.id, name: row.name, command: text(row.input.command || row.summary, 240), status: 'running', ok: null })
    }
    return row
  }

  finishTool(name, result, { toolCallId = null, error = false, ok = undefined } = {}) {
    let row = toolCallId ? this.tools.find(t => t.id === toolCallId) : null
    if (!row) {
      for (let i = this.tools.length - 1; i >= 0; i--) {
        if (this.tools[i].name === String(name || 'unknown') && this.tools[i].endedAt == null) {
          row = this.tools[i]
          break
        }
      }
    }
    if (!row) {
      row = this.startTool(name, {}, toolCallId)
    }
    row.endedAt = this.now()
    row.durationMs = Math.max(0, row.endedAt - row.startedAt)
    // ok 为显式声明（Bash 传真实 exitCode）时直接采信，只有没人声明才回落到猜内容
    row.ok = typeof ok === 'boolean' ? ok : (!error && isSuccessfulResult(result))
    // String 包装对象要走 toString，否则 JSON.stringify 出 {"0":"h","1":"i"...}
    row.result = text(
      (typeof result === 'string' || result instanceof String) ? String(result) : JSON.stringify(result ?? ''),
      300
    )
    if (isCheckTool(row.name, row.input)) {
      const check = this.checks.find(c => c.id === row.id)
      if (check) {
        check.status = row.ok ? 'passed' : 'failed'
        check.ok = row.ok
      }
    }
    if (this.currentTool?.id === row.id) this.currentTool = null
    this.addEvent('tool_result', { name: row.name, ok: row.ok, durationMs: row.durationMs, toolCallId: row.id })
    return row
  }

  recordText(value) {
    const body = text(value, 500)
    if (body) this.lastText = body
  }

  fail(error) {
    this.status = 'failed'
    this.lastError = text(error, 1000)
    this.endedAt = this.now()
    this.addEvent('run_end', { status: this.status, error: this.lastError })
    return this.snapshot()
  }

  cancel(reason = '用户中断') {
    this.status = 'cancelled'
    this.lastError = text(reason, 500)
    this.endedAt = this.now()
    this.addEvent('run_end', { status: this.status, reason: this.lastError })
    return this.snapshot()
  }

  complete(summary = '') {
    this.status = 'completed'
    this.endedAt = this.now()
    this.recordText(summary)
    this.addEvent('run_end', { status: this.status })
    return this.snapshot()
  }

  snapshot() {
    return {
      id: this.id,
      status: this.status,
      goal: this.goal,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      elapsedMs: this.startedAt == null ? 0 : Math.max(0, (this.endedAt ?? this.now()) - this.startedAt),
      lastError: this.lastError,
      currentTool: this.currentTool ? { ...this.currentTool } : null,
      toolCount: this.tools.length,
      tools: this.tools.map(t => ({ ...t, input: undefined })),
      files: [...this.files],
      checks: this.checks.map(c => ({ ...c })),
      queueLength: this.queueLength,
      events: this.events.map(e => ({ ...e })),
    }
  }

  resultCard() {
    const completedTools = this.tools.filter(t => t.endedAt != null)
    const failedTools = completedTools.filter(t => !t.ok)
    return {
      status: this.status,
      elapsedMs: this.startedAt == null ? 0 : Math.max(0, (this.endedAt ?? this.now()) - this.startedAt),
      goal: this.goal,
      toolCount: completedTools.length,
      toolNames: [...new Set(completedTools.map(t => t.name))],
      files: [...this.files],
      checks: this.checks.map(c => ({ ...c })),
      failedTools: failedTools.map(t => ({ name: t.name, summary: t.summary, result: t.result })),
      lastError: this.lastError,
      queueLength: this.queueLength,
    }
  }
}

export function formatDuration(ms = 0) {
  const n = Math.max(0, Number(ms) || 0)
  if (n < 1000) return `${n}ms`
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`
  return `${(n / 60000).toFixed(1)}m`
}

export function formatTaskStatus(snapshot, { turns = 0 } = {}) {
  const s = snapshot || {}
  const icon = s.status === 'running' ? '⠋' : s.status === 'waiting_for_user' ? '？' : s.status === 'completed' ? '✓' : s.status === 'failed' ? '✗' : s.status === 'cancelled' ? '■' : '·'
  const label = s.status === 'running' ? '执行中' : s.status === 'waiting_for_user' ? '等待输入' : s.status === 'completed' ? '已完成' : s.status === 'failed' ? '失败' : s.status === 'cancelled' ? '已取消' : '空闲'
  const current = s.currentTool ? ` · ${s.currentTool.name}${s.currentTool.summary ? ` ${s.currentTool.summary}` : ''}` : ''
  const turnText = Number(turns) > 0 ? ` · 第 ${turns} 轮` : ''
  const queueText = Number(s.queueLength) > 0 ? ` · 已排队 ${s.queueLength}` : ''
  return `${icon} ${label} · ${formatDuration(s.elapsedMs)} · 工具 ${s.toolCount}${turnText}${current}${queueText}`
}

/**
 * 把检查项按「同一类操作」归并计数。
 * 目的是让结果卡片不被几十行 node --check 刷屏。
 *
 * 归类只看命令的语义前缀，不看具体文件：
 *   node --check a.mjs / node --check b.mjs   → 「语法检查 ×2」
 *   node tests/x.test.mjs / node tests/y.mjs  → 「测试 ×2」
 * @returns {Array<[string, number]>} [[标签, 次数]]，按次数降序
 */
export function groupChecks(checks = []) {
  const counts = new Map()
  for (const k of checks) {
    const label = classifyCheck(k)
    counts.set(label, (counts.get(label) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/** 判断一条检查属于哪类（标签是给人看的中文） */
function classifyCheck(check) {
  const cmd = String(check?.command || '').trim()
  const name = String(check?.name || '')
  if (!cmd) {
    // 没有命令的走工具名（Test / Diagnostics / LSP）
    if (name === 'Diagnostics') return '代码诊断'
    if (name === 'LSP') return 'LSP 检查'
    if (name === 'Test') return '测试'
    return name || '检查'
  }
  if (/node\s+--check/.test(cmd)) return '语法检查'
  if (/\b(tsc|typecheck)\b/.test(cmd)) return '类型检查'
  if (/\b(eslint|biome|lint)\b/.test(cmd)) return '代码风格'
  if (/\b(pytest|mypy|ruff)\b/.test(cmd)) return 'Python 检查'
  if (/\b(cargo\s+test)\b/.test(cmd)) return 'Rust 测试'
  if (/\b(npm|pnpm|yarn)\s+(run\s+)?test\b/.test(cmd)) return '测试'
  if (/\b(jest|vitest|mocha|playwright|cypress)\b/.test(cmd)) return '测试'
  if (/node\s+\S*tests?\//.test(cmd)) return '测试'
  if (/\b(build|compile)\b/.test(cmd)) return '构建'
  // 认不出来就用命令首词，避免把不同东西混成一类
  return cmd.split(/\s+/)[0] || '检查'
}

/**
 * 按目录归并文件列表。文件多的时候比平铺更好读 ——
 * 「core/ 6 个」+ 文件名列表，比 6 行重复的 core/ 前缀清楚。
 * @returns {Array<[string, string[]]>} [[目录, [文件名...]]]，按数量降序
 */
export function groupFilesByDir(files = []) {
  const groups = new Map()
  for (const f of files) {
    const path = String(f || '')
    const idx = path.lastIndexOf('/')
    const dir = idx === -1 ? './' : `${path.slice(0, idx)}/`
    const base = idx === -1 ? path : path.slice(idx + 1)
    if (!groups.has(dir)) groups.set(dir, [])
    groups.get(dir).push(base)
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
}

export function formatResultCard(card, { color = null } = {}) {
  const c = card || {}
  const statusLine = c.status === 'completed'
    ? '✓ 已完成'
    : c.status === 'cancelled'
      ? '■ 已取消'
      : c.status === 'failed'
        ? '✗ 执行失败'
        : `· ${c.status || '结束'}`
  const lines = [`\n结果`, `${statusLine} · ${formatDuration(c.elapsedMs)} · 工具 ${c.toolCount || 0} 次`]
  if (c.toolNames?.length) lines.push(`工具: ${c.toolNames.join(', ')}`)
  if (c.files?.length) {
    lines.push('改动')
    // 文件名是有用信息（要知道到底动了哪些），所以少量时逐个列出。
    // 但一轮改十几个文件时列表太长，改成按目录归并 —— 仍能看出改了哪几块。
    if (c.files.length <= 8) {
      for (const file of c.files) lines.push(`- ${file}`)
    } else {
      for (const [dir, names] of groupFilesByDir(c.files)) {
        lines.push(`- ${dir}  ${names.length} 个`)
        // 文件名列表要限长：手机屏幕窄，一行 9 个文件名会折成三四行，
        // 反而比平铺更难读。超出就截断 + 标剩余数量。
        const shown = []
        let width = 0
        for (const n of names) {
          if (width + n.length + 2 > 52 && shown.length) break
          shown.push(n)
          width += n.length + 2
        }
        const rest = names.length - shown.length
        lines.push(`    ${shown.join(', ')}${rest > 0 ? ` …+${rest}` : ''}`)
      }
    }
  }
  if (c.checks?.length) {
    lines.push('检查')
    // 按类合并：一轮里 node --check 可能跑几十次，逐条列出会把屏幕刷满，
    // 而「第 17 个文件语法也通过」这种信息量为零。
    // 规则：全通过的同类折成一行 + 计数；失败的一定单独列出（那才是要看的）。
    const failed = c.checks.filter(k => k.ok === false)
    const passed = c.checks.filter(k => k.ok !== false)
    for (const [label, n] of groupChecks(passed)) {
      lines.push(`✓ ${label}${n > 1 ? ` ×${n}` : ''}`)
    }
    for (const k of failed.slice(-10)) lines.push(`✗ ${k.command || k.name}`)
    if (failed.length > 10) lines.push(`✗ …另有 ${failed.length - 10} 项失败`)
  }
  if (c.lastError) lines.push(`未完成: ${c.lastError}`)
  if (c.queueLength) lines.push(`后续输入: ${c.queueLength} 条已排队`)
  const body = lines.join('\n')
  return color ? `${color}${body}\x1b[0m` : body
}
