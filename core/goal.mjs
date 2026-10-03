// Claude Code Mobile - Goal（完成契约）
//
// 设计参考 Kimi Code 的 goal mode。它那句定义是整个功能的核心：
//   "A goal is not a task description — it is a completion contract.
//    It says what must become *true*, how that truth is *proven*,
//    where the work may and may not *reach*, and when to *stop*."
//
// 所以一个 goal 必须回答四件事，缺一件就不是契约而是待办：
//   1) objective   —— 什么必须变成真的
//   2) completion  —— 这个"真"如何被证明（可检查的证据：测试、grep、指标）
//   3) boundaries  —— 工作可以碰到哪、不可以碰到哪
//   4) budget      —— 什么时候停（轮数 / 时间 / token）
//
// 与项目里已有的两套待办的分工（别再合并，语义不同）：
//   TodoWrite  单轮清单，给用户看进度，进程结束就没了，没有终止条件。
//   Task       多 Agent 共享的持久待办，有依赖/归属，但**不驱动执行**——
//              它记录"要做什么"，不会自己推进。
//   Goal       唯一会**主动驱动 agent 跨轮推进**的东西：一轮结束后如果契约
//              没达成且预算没用完，runtime 自己注入下一轮，不需要用户催。
//              它的存在意义就是"无人监督地推进 + 有明确终止条件"。
//
// ── 两条刻意的设计纪律（写清原因，避免以后被"优化"掉）─────────────────
//
// A) 所有派生量只在这个文件算，消费方一律读 snapshot()。
//    历史教训：core/width.mjs 之前光标 bug 反复复发，根因不是算法错，是
//    readline / fullscreen / status-report 各自算了一遍宽度，必然漂移。
//    这里同理：remaining/percent/elapsed 绝不允许在 index.mjs 或提示词里
//    重算一遍。要新数据就往 snapshot() 加字段。
//
// B) 预算不允许为空。
//    Kimi 允许 null 预算（它有 TUI 能随时打断）。我们是手机终端 + 自动续轮，
//    无上限的自动推进等于静默烧钱。所以没给预算就套 DEFAULT_TURN_BUDGET，
//    contract 里"何时停"这一项永远有值。

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { atomicWrite } from './atomic.mjs'

const ROOT = join(homedir(), '.claude-code-mobile', 'goals')

// 没给预算时的兜底轮数。宁可让用户再敲一次 /goal budget，也不要无上限自动跑。
export const DEFAULT_TURN_BUDGET = 15
// 预算用掉多少开始提醒模型收敛（Kimi 用 0.75，实测这个点比较合适）
export const CONVERGE_FRACTION = 0.75
// 阻塞审计阈值：同一个阻塞连续多少个 goal turn 复现才允许判 blocked。
// Kimi 用 3。目的是防止模型第一次遇到困难就宣布"卡住了"然后躺平。
export const BLOCKED_STREAK_THRESHOLD = 3

export const GOAL_STATUS = ['active', 'paused', 'blocked', 'complete']
const TERMINAL = new Set(['blocked', 'complete'])

function ensureRoot() {
  if (!existsSync(ROOT)) mkdirSync(ROOT, { recursive: true })
}

function fileFor(sessionId) {
  // sessionId 进文件名，做一次白名单过滤防路径穿越（对齐 core/skills.mjs 的 _safeName）
  const safe = String(sessionId || 'default').replace(/[^\w.-]/g, '_') || 'default'
  return join(ROOT, `${safe}.json`)
}

// ── 时间 / token 解析 ──────────────────────────────────────────────
// 刻意分成两个解析器：'m' 在时间里是分钟、在 token 里是百万，
// 用一个函数带 flag 迟早有人传错。类型上分开更难用错。

/** "90s" "30m" "2h" "1h30m" → ms；纯数字按分钟。非法返回 null */
export function parseDuration(s) {
  if (s == null) return null
  const t = String(s).trim().toLowerCase()
  if (!t) return null
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(parseFloat(t) * 60000)
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g
  let total = 0
  let matched = false
  let m
  while ((m = re.exec(t)) !== null) {
    matched = true
    const n = parseFloat(m[1])
    const unit = m[2]
    total += unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'm' ? n * 60000 : n * 3600000
  }
  if (!matched) return null
  return Math.round(total)
}

/** "200k" "1.5m" "50000" → 数量。非法返回 null */
export function parseCount(s) {
  if (s == null) return null
  const t = String(s).trim().toLowerCase().replace(/[_,]/g, '')
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(t)
  if (!m) return null
  const n = parseFloat(m[1])
  const mult = m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1
  return Math.round(n * mult)
}

export function formatElapsed(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  if (total < 60) return `${total}s`
  const min = Math.floor(total / 60)
  const sec = total % 60
  if (min < 60) return `${min}m${String(sec).padStart(2, '0')}s`
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m`
}

export function formatCount(n) {
  const v = Number(n) || 0
  if (v < 1000) return String(v)
  if (v < 1e6) return `${(v / 1e3).toFixed(v < 1e4 ? 1 : 0)}k`
  return `${(v / 1e6).toFixed(1)}m`
}

// ── 已耗时：唯一实现 ───────────────────────────────────────────────
// 为什么不能写成 Date.now() - startedAt：goal 可以 pause。暂停期间不该计时，
// 否则挂一晚上回来预算已经过期。所以状态里存"已累计 elapsedMs" +
// "本段从 runningSince 开始跑"，只有 active 时 runningSince 有值。
// 这是个看着平凡、但有两种状态的派生量 —— 只允许这一个函数算它。
function elapsedOf(g) {
  const base = Number(g?.elapsedMs) || 0
  if (!g?.runningSince) return base
  return base + Math.max(0, Date.now() - g.runningSince)
}

function nowIso() { return new Date().toISOString() }

function pushLog(g, event, note) {
  if (!Array.isArray(g.log)) g.log = []
  g.log.push({ at: nowIso(), event, note: note ? String(note).slice(0, 400) : undefined })
  // 只留最近 60 条：日志是给人看"怎么走到这一步"的，不是审计账本
  if (g.log.length > 60) g.log = g.log.slice(-60)
}

// ── 读写 ───────────────────────────────────────────────────────────

/** 读当前会话的 goal；不存在或文件损坏返回 null（fail-open，不崩启动） */
export function loadGoal(sessionId) {
  try {
    const f = fileFor(sessionId)
    if (!existsSync(f)) return null
    const g = JSON.parse(readFileSync(f, 'utf-8'))
    if (!g || typeof g !== 'object' || !g.objective) return null
    return normalize(g)
  } catch { return null }
}

function saveGoal(sessionId, g) {
  ensureRoot()
  atomicWrite(fileFor(sessionId), JSON.stringify(g, null, 2))
  return g
}

/** 补全旧版本/手改文件缺的字段，保证后续代码不用到处判空 */
function normalize(g) {
  g.status = GOAL_STATUS.includes(g.status) ? g.status : 'active'
  g.boundaries = Array.isArray(g.boundaries) ? g.boundaries : []
  g.budget = g.budget && typeof g.budget === 'object' ? g.budget : {}
  if (!Number.isFinite(g.budget.turns) || g.budget.turns <= 0) g.budget.turns = DEFAULT_TURN_BUDGET
  if (!Number.isFinite(g.budget.wallClockMs) || g.budget.wallClockMs <= 0) g.budget.wallClockMs = null
  if (!Number.isFinite(g.budget.tokens) || g.budget.tokens <= 0) g.budget.tokens = null
  g.turnsUsed = Number.isFinite(g.turnsUsed) ? g.turnsUsed : 0
  g.elapsedMs = Number.isFinite(g.elapsedMs) ? g.elapsedMs : 0
  g.tokensAtStart = Number.isFinite(g.tokensAtStart) ? g.tokensAtStart : 0
  g.tokensUsed = Number.isFinite(g.tokensUsed) ? g.tokensUsed : 0
  g.blockedStreak = Number.isFinite(g.blockedStreak) ? g.blockedStreak : 0
  g.log = Array.isArray(g.log) ? g.log : []
  // active 但没有 runningSince（比如上次进程被杀）：从现在续上，不把宕机时间算进去
  if (g.status === 'active' && !g.runningSince) g.runningSince = Date.now()
  if (g.status !== 'active' && g.runningSince) {
    g.elapsedMs = elapsedOf(g)
    g.runningSince = null
  }
  return g
}

/**
 * 创建 goal。已存在活动 goal 时拒绝，除非 replace。
 * @returns {{ok:boolean, error?:string, goal?:object}}
 */
export function createGoal(sessionId, {
  objective, completion = null, boundaries = [],
  turns = null, wallClockMs = null, tokens = null,
  tokensAtStart = 0, replace = false,
} = {}) {
  const obj = String(objective || '').trim()
  if (!obj) return { ok: false, error: 'objective 不能为空' }
  const existing = loadGoal(sessionId)
  if (existing && !TERMINAL.has(existing.status) && !replace) {
    return { ok: false, error: `已有进行中的目标（${existing.status}）：${existing.objective}\n用 /goal replace <新目标> 换掉，或 /goal clear 先放弃它` }
  }
  const g = normalize({
    id: `g${Date.now().toString(36)}`,
    sessionId: String(sessionId || 'default'),
    objective: obj,
    completion: completion ? String(completion).trim() : null,
    boundaries: (boundaries || []).map(s => String(s).trim()).filter(Boolean),
    budget: {
      turns: Number.isFinite(turns) && turns > 0 ? Math.floor(turns) : DEFAULT_TURN_BUDGET,
      wallClockMs: Number.isFinite(wallClockMs) && wallClockMs > 0 ? wallClockMs : null,
      tokens: Number.isFinite(tokens) && tokens > 0 ? tokens : null,
    },
    status: 'active',
    terminalReason: null,
    createdAt: nowIso(),
    startedAt: nowIso(),
    runningSince: Date.now(),
    elapsedMs: 0,
    turnsUsed: 0,
    tokensAtStart: Number(tokensAtStart) || 0,
    tokensUsed: 0,
    blockedStreak: 0,
    lastBlocker: null,
    log: [],
  })
  pushLog(g, 'created', obj)
  if (existing && replace) pushLog(g, 'replaced', `旧目标：${existing.objective}`)
  return { ok: true, goal: saveGoal(sessionId, g) }
}

/** 删除 goal（放弃）。返回被删掉的那个，没有则 null */
export function clearGoal(sessionId) {
  const g = loadGoal(sessionId)
  try { unlinkSync(fileFor(sessionId)) } catch {}
  return g
}

/** 改契约字段（completion / boundaries / budget）。只允许非终态时改 */
export function reviseGoal(sessionId, patch = {}) {
  const g = loadGoal(sessionId)
  if (!g) return { ok: false, error: '当前没有目标。先用 /goal <目标描述> 设一个' }
  if (TERMINAL.has(g.status)) return { ok: false, error: `目标已${g.status === 'complete' ? '完成' : '终止'}，不能再改。用 /goal clear 后重设` }
  if (patch.completion !== undefined) {
    g.completion = patch.completion ? String(patch.completion).trim() : null
    pushLog(g, 'revise:completion', g.completion || '(清空)')
  }
  if (patch.addBoundary) {
    g.boundaries.push(String(patch.addBoundary).trim())
    pushLog(g, 'revise:boundary', patch.addBoundary)
  }
  if (patch.boundaries !== undefined) {
    g.boundaries = (patch.boundaries || []).map(s => String(s).trim()).filter(Boolean)
    pushLog(g, 'revise:boundaries', g.boundaries.join(' | '))
  }
  const b = {}
  if (Number.isFinite(patch.turns) && patch.turns > 0) b.turns = Math.floor(patch.turns)
  if (Number.isFinite(patch.wallClockMs) && patch.wallClockMs > 0) b.wallClockMs = patch.wallClockMs
  if (Number.isFinite(patch.tokens) && patch.tokens > 0) b.tokens = patch.tokens
  if (Object.keys(b).length) {
    Object.assign(g.budget, b)
    pushLog(g, 'revise:budget', JSON.stringify(b))
  }
  return { ok: true, goal: saveGoal(sessionId, normalize(g)) }
}

/**
 * 改状态。这是唯一的状态迁移入口 —— 预算终止、模型判完成、用户暂停都走这里。
 * @param {string} status active | paused | blocked | complete
 * @param {string|null} reason 终态原因（会显示在收尾报告里）
 */
export function setGoalStatus(sessionId, status, reason = null) {
  const g = loadGoal(sessionId)
  if (!g) return { ok: false, error: '当前没有目标' }
  if (!GOAL_STATUS.includes(status)) return { ok: false, error: `未知状态 ${status}` }
  if (g.status === status && status !== 'active') {
    return { ok: true, goal: g, noop: true }
  }
  // 离开 active：把这一段跑的时间结算进 elapsedMs，停止计时
  if (g.status === 'active' && status !== 'active') {
    g.elapsedMs = elapsedOf(g)
    g.runningSince = null
  }
  // 回到 active：重新起计时。blocked 恢复时重置阻塞审计
  // （Kimi 明确要求 "treat the resumed run as a fresh blocked audit"，
  //   否则一恢复就又满足 3 轮阈值、立刻再判 blocked，等于恢复不了）
  if (status === 'active' && g.status !== 'active') {
    g.runningSince = Date.now()
    g.blockedStreak = 0
    g.lastBlocker = null
    g.terminalReason = null
  }
  const prev = g.status
  g.status = status
  g.terminalReason = status === 'active' ? null : (reason ? String(reason).slice(0, 500) : g.terminalReason)
  if (TERMINAL.has(status)) g.finishedAt = nowIso()
  pushLog(g, `status:${prev}→${status}`, reason)
  return { ok: true, goal: saveGoal(sessionId, g), from: prev }
}

/**
 * 记一个 goal turn 完成。由驱动器在每轮 agent 回合结束时调用。
 * @param {number} cumulativeTokens agent 累计 token（input+output），用来算本 goal 的增量
 * @returns snapshot（含是否该终止）
 */
export function recordGoalTurn(sessionId, cumulativeTokens = 0) {
  const g = loadGoal(sessionId)
  if (!g) return null
  g.turnsUsed += 1
  // token 用量算差值：agent.tokenUsage 是整个会话累计的，不是本 goal 的。
  // 基线在 createGoal 时记下，这里只做减法，不在别处重算。
  const cum = Number(cumulativeTokens) || 0
  if (cum > 0) g.tokensUsed = Math.max(0, cum - g.tokensAtStart)
  saveGoal(sessionId, g)
  return snapshot(sessionId)
}

/** 记一次阻塞出现（同一个阻塞连续复现才累加，换了就重置）。返回当前连续次数 */
export function noteBlocker(sessionId, blocker) {
  const g = loadGoal(sessionId)
  if (!g) return 0
  const key = String(blocker || '').trim().slice(0, 200)
  if (!key) return g.blockedStreak
  g.blockedStreak = key === g.lastBlocker ? g.blockedStreak + 1 : 1
  g.lastBlocker = key
  saveGoal(sessionId, g)
  return g.blockedStreak
}

// ── snapshot：消费方唯一的数据来源 ─────────────────────────────────

/**
 * 全部派生量在这里算一次。UI、提示词、工具、驱动器都只读这个。
 * 任何地方需要新数字 → 往这里加字段，不要在消费方自己算。
 */
export function snapshot(sessionId) {
  const g = loadGoal(sessionId)
  if (!g) return null
  const b = g.budget
  const elapsed = elapsedOf(g)
  const remainingTurns = Math.max(0, b.turns - g.turnsUsed)
  const remainingMs = b.wallClockMs == null ? null : Math.max(0, b.wallClockMs - elapsed)
  const remainingTokens = b.tokens == null ? null : Math.max(0, b.tokens - g.tokensUsed)
  const fracs = [g.turnsUsed / b.turns]
  if (b.wallClockMs) fracs.push(elapsed / b.wallClockMs)
  if (b.tokens) fracs.push(g.tokensUsed / b.tokens)
  const maxFraction = Math.min(1, Math.max(...fracs))
  // 哪一项先耗尽 → 就是终止原因。null 表示还没到头。
  let exhausted = null
  if (remainingTurns <= 0) exhausted = 'turns'
  else if (remainingMs !== null && remainingMs <= 0) exhausted = 'time'
  else if (remainingTokens !== null && remainingTokens <= 0) exhausted = 'tokens'
  return {
    id: g.id,
    objective: g.objective,
    completion: g.completion,
    boundaries: g.boundaries.slice(),
    status: g.status,
    terminalReason: g.terminalReason || null,
    isTerminal: TERMINAL.has(g.status),
    isActive: g.status === 'active',
    turnsUsed: g.turnsUsed,
    turnBudget: b.turns,
    remainingTurns,
    elapsedMs: elapsed,
    wallClockBudgetMs: b.wallClockMs,
    remainingMs,
    tokensUsed: g.tokensUsed,
    tokenBudget: b.tokens,
    remainingTokens,
    maxFraction,
    exhausted,
    converging: maxFraction >= CONVERGE_FRACTION,
    blockedStreak: g.blockedStreak,
    blockedThreshold: BLOCKED_STREAK_THRESHOLD,
    canDeclareBlocked: g.blockedStreak >= BLOCKED_STREAK_THRESHOLD,
    lastBlocker: g.lastBlocker || null,
    createdAt: g.createdAt,
    finishedAt: g.finishedAt || null,
    log: g.log.slice(-12),
  }
}

/** 列出所有会话的 goal 文件（给 /goal list 用） */
export function listAllGoals() {
  try {
    ensureRoot()
    return readdirSync(ROOT).filter(f => f.endsWith('.json')).map(f => {
      try {
        const g = normalize(JSON.parse(readFileSync(join(ROOT, f), 'utf-8')))
        return { sessionId: g.sessionId, objective: g.objective, status: g.status, turnsUsed: g.turnsUsed, turnBudget: g.budget.turns }
      } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}

export const GOAL_ROOT = ROOT
