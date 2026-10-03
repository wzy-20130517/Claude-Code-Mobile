// Claude Code Mobile - Goal 运行时
//
// 分三块，都只读 snapshot()，自己不算任何派生量（见 goal.mjs 顶部纪律 A）：
//   1) 提示词构造：把契约变成模型每轮看得见的约束
//   2) 窄屏渲染：40 列也能看清进度
//   3) 驱动器 runGoalLoop：跨轮自动推进 + 终止判定
//
// 驱动器为什么不写进 core/agent.mjs：
//   agent 已经有 watchMode（无限续轮、无终止条件）。goal 的续轮语义完全不同：
//   它要在每轮之间做终止判定、算预算、可能改状态。塞进 agent 主循环等于让
//   agent 同时懂两套续轮规则，以后改一个必然碰坏另一个。
//   所以 goal 在 agent.run **之外**循环：每次 run 是一个 goal turn，
//   run 返回后由驱动器决定要不要再 run 一次。agent 完全不知道 goal 存在。

import { strWidth, truncTo } from './width.mjs'
import {
  snapshot, recordGoalTurn, setGoalStatus, loadGoal,
  formatElapsed, formatCount, BLOCKED_STREAK_THRESHOLD, CONVERGE_FRACTION,
} from './goal.mjs'

// ── 1) 提示词 ──────────────────────────────────────────────────────

/** 预算一行文本（提示词和 UI 都用这一份口径） */
export function budgetLine(s) {
  const parts = [`轮次 ${s.turnsUsed}/${s.turnBudget}`]
  if (s.wallClockBudgetMs) parts.push(`时间 ${formatElapsed(s.elapsedMs)}/${formatElapsed(s.wallClockBudgetMs)}`)
  else parts.push(`已用时 ${formatElapsed(s.elapsedMs)}`)
  if (s.tokenBudget) parts.push(`token ${formatCount(s.tokensUsed)}/${formatCount(s.tokenBudget)}`)
  return parts.join(' · ')
}

/**
 * 每个 goal turn 注入的契约提醒。
 * 这段是整个功能的灵魂：它把"四要素"重复摆在模型面前，
 * 并明确写清什么时候**不准**宣布完成、什么时候**不准**宣布阻塞。
 * 没有这些负向约束，模型会在第一轮写个计划就 complete。
 */
export function buildGoalContract(s) {
  const L = []
  L.push('# 当前目标（完成契约 · 非普通待办）')
  L.push(`目标：${s.objective}`)
  L.push(`完成判据：${s.completion || '(未指定 —— 你必须先把它明确成一个可检查的判据，并在回复里告诉用户你采用了什么判据)'}`)
  if (s.boundaries.length) {
    L.push('边界（不得越界）：')
    for (const b of s.boundaries) L.push(`  - ${b}`)
  } else {
    L.push('边界：未显式限定。但不得改动与目标无关的文件，不得扩大范围。')
  }
  L.push(`预算：${budgetLine(s)}`)
  L.push('')
  L.push('## 本轮怎么做')
  L.push('- 先对照目标和完成判据，看已完成到哪，然后挑**一个有界、有用的切片**推进，不要试图一轮做完。')
  L.push('- 自查要简短。不要反复重述目标、不要探索与目标无关的解读。')
  L.push('- 目标之外的东西不要动。越界比慢更严重。')
  L.push('')
  L.push('## 怎么结束（只有这三条路）')
  L.push('- **还有实质工作** → 正常结束本轮，不要调 GoalStatus。runtime 会自动给你下一轮，你不需要请示用户。')
  L.push('- **真的做完了** → 调 GoalStatus(status:"complete")，并在同一轮回复里写清：做了什么、完成判据如何被验证通过的（贴证据：命令、输出、测试结果）。')
  L.push('- **真的卡死了** → 调 GoalStatus(status:"blocked", reason:"..."）。')
  L.push('')
  L.push('## 完成审计（调 complete 前必须过）')
  L.push('- 逐条对照目标里的**每一项显式要求**，不是只对照你自己挑的那部分。')
  L.push('- 间接证据、"应该没问题"、"看起来对" = **未完成**。要有实际跑过的验证。')
  L.push('- 只产出了计划 / 摘要 / 初稿 / 部分结果 → **未完成**，不许 complete。')
  L.push('- **预算快用完不是完成的理由**。预算耗尽由 runtime 处理，不要为了收尾谎报完成。')
  L.push('')
  L.push('## 阻塞审计（调 blocked 前必须过）')
  L.push(`- 第一次遇到障碍**不准**判 blocked。同一个障碍必须连续 ${BLOCKED_STREAK_THRESHOLD} 个 goal turn 复现才算。当前该障碍已连续 ${s.blockedStreak} 轮${s.canDeclareBlocked ? '（已达阈值，可以判 blocked）' : `（未达 ${BLOCKED_STREAK_THRESHOLD}，继续想别的办法）`}。`)
  L.push('- 只有这些算真阻塞：缺凭据/权限、必须用户拍板、外部条件不满足、同一技术故障反复失败。')
  L.push('- **不算阻塞**：活儿大、活儿难、慢、还没验证、不确定、想要更多轮次、想找用户确认一下。这些一律继续干。')
  L.push('- 但如果目标本身**不可能、自相矛盾、或不安全**，当轮直接判 blocked，不要白烧预算。')
  L.push('')
  L.push(s.converging
    ? `预算提示：已用掉 ${Math.round(s.maxFraction * 100)}%，接近上限。收敛到目标本身，不要再开新的可选工作。`
    : '预算提示：预算充裕，稳步推进即可。')
  return L.join('\n')
}

/** 非活动态（paused / blocked / complete）时给模型的说明，避免它继续自动干活 */
export function buildGoalStateNote(s) {
  if (s.status === 'paused') {
    return `# 目标已暂停\n目标：${s.objective}\n进度：${budgetLine(s)}\n除非用户明确要求继续推进这个目标，不要主动做目标相关的工作。用户可用 /goal resume 恢复。`
  }
  if (s.status === 'blocked') {
    return `# 目标已阻塞\n目标：${s.objective}\n阻塞原因：${s.terminalReason || s.lastBlocker || '(未记录)'}\n不要自动重试。等用户处理阻塞或用 /goal resume 恢复后再继续。`
  }
  if (s.status === 'complete') {
    return `# 目标已完成\n目标：${s.objective}\n${s.terminalReason ? `收尾说明：${s.terminalReason}\n` : ''}不要再做这个目标的工作。新目标用 /goal <描述>。`
  }
  return ''
}

/** 后续 goal turn 的续跑指令（首轮用用户原话，后续用这个） */
export function buildContinuationPrompt(s) {
  return [
    '（goal mode 自动续轮 · 非用户发言）',
    `继续推进当前目标，这是第 ${s.turnsUsed + 1} 个 goal turn（预算 ${s.turnBudget}）。`,
    '',
    buildGoalContract(s),
  ].join('\n')
}

/** 预算耗尽时注入的收尾指令：要求交接，不许静默中断 */
export function buildBudgetStopPrompt(s) {
  const which = s.exhausted === 'turns' ? `轮次预算（${s.turnBudget} 轮）`
    : s.exhausted === 'time' ? `时间预算（${formatElapsed(s.wallClockBudgetMs)}）`
    : `token 预算（${formatCount(s.tokenBudget)}）`
  return [
    '（goal mode · 预算耗尽，本轮是最后一轮 · 非用户发言）',
    `${which}已用尽，目标未达成。现在**只做交接，不要再改任何文件、不要再调工具**。`,
    '',
    `目标：${s.objective}`,
    `完成判据：${s.completion || '(未指定)'}`,
    '',
    '用这四段写一份交接（简短，不要客套）：',
    '1. 已完成：哪些部分真的做完了，证据是什么',
    '2. 未完成：还差什么，具体到文件/函数',
    '3. 下一步：如果继续，第一件该做的事是什么',
    '4. 建议：追加预算继续（/goal budget），还是拆小目标重设',
  ].join('\n')
}

// ── 2) 渲染（窄屏优先，40 列可读）─────────────────────────────────

const BAR_CHARS = ['░', '█']

/** 进度条。宽度自适应，最少 6 格 */
export function progressBar(fraction, width = 10) {
  const w = Math.max(6, Math.floor(width) || 10)
  const f = Math.max(0, Math.min(1, Number(fraction) || 0))
  const filled = Math.round(f * w)
  return BAR_CHARS[1].repeat(filled) + BAR_CHARS[0].repeat(w - filled)
}

const STATUS_ICON = { active: '◆', paused: '⏸', blocked: '⛔', complete: '✓' }
const STATUS_TEXT = { active: '进行中', paused: '已暂停', blocked: '已阻塞', complete: '已完成' }

const NO_COLOR = { dim: '', reset: '', bold: '', green: '', yellow: '', red: '', cyan: '' }
/**
 * 色板归一化。必须做：调用方常传部分色板（测试里传 {}、别处传只有 dim 的对象），
 * 缺项时模板字符串会把字面量 "undefined" 打进终端 —— 这类 bug 只在特定调用方出现，
 * 极难在开发时发现。所以在入口一次补齐，而不是在每个插值点写 `|| ''`（迟早漏一个）。
 */
function palette(color) {
  if (!color) return NO_COLOR
  const out = { ...NO_COLOR }
  for (const k of Object.keys(NO_COLOR)) if (typeof color[k] === 'string') out[k] = color[k]
  return out
}

/**
 * 目标卡片。cols 是可用列宽；窄屏（<52）自动改成每项单独一行。
 * 用 core/width.mjs 的 strWidth/truncTo —— 中文是双宽，padEnd/slice 必然算错。
 */
export function renderGoalCard(s, { cols = 60, color = null } = {}) {
  if (!s) return '当前没有目标。用 /goal <目标描述> 设一个。'
  const C = palette(color)
  const w = Math.max(28, Math.floor(cols) || 60)
  const narrow = w < 52
  const inner = w - 2
  const L = []
  const icon = STATUS_ICON[s.status] || '·'
  const stColor = s.status === 'complete' ? C.green : s.status === 'blocked' ? C.red : s.status === 'paused' ? C.yellow : C.cyan
  L.push(`${stColor}${icon} 目标 · ${STATUS_TEXT[s.status] || s.status}${C.reset}`)

  // 目标文本：宽字符安全折行（不用 padEnd/slice）
  for (const line of softWrap(s.objective, inner)) L.push(`  ${line}`)

  if (s.completion) {
    L.push(`${C.dim}  判据${C.reset}`)
    for (const line of softWrap(s.completion, inner - 2)) L.push(`    ${line}`)
  } else {
    L.push(`${C.yellow}  ⚠ 未设完成判据${C.reset}${C.dim}（/goal proof <如何验证>）${C.reset}`)
  }
  if (s.boundaries.length) {
    L.push(`${C.dim}  边界${C.reset}`)
    for (const b of s.boundaries) {
      for (const line of softWrap(`· ${b}`, inner - 2)) L.push(`    ${line}`)
    }
  }

  // 预算：宽屏一行带进度条，窄屏拆成纵向
  const barW = narrow ? 8 : 12
  const pct = Math.round(s.maxFraction * 100)
  const barColor = s.maxFraction >= 1 ? C.red : s.converging ? C.yellow : C.green
  if (narrow) {
    L.push(`${C.dim}  预算 ${barColor}${progressBar(s.maxFraction, barW)}${C.reset} ${pct}%`)
    L.push(`${C.dim}    轮次 ${s.turnsUsed}/${s.turnBudget}${C.reset}`)
    L.push(`${C.dim}    用时 ${formatElapsed(s.elapsedMs)}${s.wallClockBudgetMs ? `/${formatElapsed(s.wallClockBudgetMs)}` : ''}${C.reset}`)
    if (s.tokenBudget) L.push(`${C.dim}    token ${formatCount(s.tokensUsed)}/${formatCount(s.tokenBudget)}${C.reset}`)
  } else {
    L.push(`  ${barColor}${progressBar(s.maxFraction, barW)}${C.reset} ${pct}%  ${C.dim}${budgetLine(s)}${C.reset}`)
  }
  if (s.terminalReason) {
    for (const line of softWrap(s.terminalReason, inner - 2)) L.push(`  ${C.dim}${line}${C.reset}`)
  }
  if (s.status === 'active' && s.blockedStreak > 0) {
    L.push(`${C.dim}  阻塞计数 ${s.blockedStreak}/${s.blockedThreshold}${s.lastBlocker ? `：${truncTo(s.lastBlocker, Math.max(10, inner - 16), '…')}` : ''}${C.reset}`)
  }
  return L.join('\n')
}

/** 按显示宽度折行（中文双宽安全）。不引入新算法：宽度一律问 width.mjs */
function softWrap(text, cols) {
  const w = Math.max(8, Math.floor(cols) || 40)
  const out = []
  let cur = ''
  for (const ch of String(text ?? '')) {
    if (ch === '\n') { out.push(cur); cur = ''; continue }
    if (strWidth(cur + ch) > w) { out.push(cur); cur = ch }
    else cur += ch
  }
  if (cur || !out.length) out.push(cur)
  return out
}

/** 终态一行摘要（收尾报告用） */
export function renderGoalOutcome(s, color = {}) {
  const C = palette(color)
  const dim = C.dim; const reset = C.reset
  const head = s.status === 'complete'
    ? `${C.green}✓ 目标完成${reset}`
    : s.status === 'blocked'
      ? `${C.red}⛔ 目标阻塞${reset}`
      : `${C.yellow}⏸ 目标停止（${s.status}）${reset}`
  const why = s.terminalReason ? ` — ${s.terminalReason}` : ''
  return `${head}${why}\n${dim}${budgetLine(s)}${reset}`
}

// ── 3) 驱动器 ──────────────────────────────────────────────────────

/**
 * 跨轮推进目标，直到达成 / 阻塞 / 预算耗尽 / 被打断。
 *
 * 关键约定（改这里前先读懂）：
 *  - **一次 agent.run = 一个 goal turn**。agent 内部的 maxTurns 是它自己
 *    工具循环的上限，跟 goal 预算是两个维度，不要混。
 *  - 状态只从 snapshot() 读。循环里每轮重新取，因为模型可能在轮中调
 *    GoalStatus 改了状态（工具直接写盘），驱动器必须看到。
 *  - 预算耗尽时**多跑一轮**收尾（buildBudgetStopPrompt），不静默中断 ——
 *    这是任务书第 5 条的硬要求。
 *  - Interrupted（Ctrl+C）不算失败也不算完成：转 paused 保留进度，
 *    用户能 /goal resume 接着干。
 *
 * @param {object} o
 * @param {object} o.agent
 * @param {string} o.sessionId
 * @param {string} o.firstMessage 第一个 goal turn 的输入（通常是用户原话 + 契约）
 * @param {AbortSignal} [o.signal]
 * @param {(s:object, phase:string)=>void} [o.onTurn] 每轮结束回调（UI 刷新用）
 * @param {()=>number} [o.getTokens] 取 agent 累计 token
 * @param {()=>boolean} [o.shouldStop] 外部叫停（比如用户又输入了新消息）
 * @returns {Promise<{snapshot:object|null, turns:number, reason:string}>}
 */
export async function runGoalLoop({
  agent, sessionId, firstMessage, signal,
  onTurn = () => {}, getTokens = () => 0, shouldStop = () => false,
}) {
  let turns = 0
  let next = firstMessage
  let closing = false   // 已进入收尾轮：这轮跑完无论如何都结束

  for (;;) {
    if (signal?.aborted || shouldStop()) {
      const s = snapshot(sessionId)
      if (s && s.isActive) setGoalStatus(sessionId, 'paused', '被用户打断，进度已保留（/goal resume 继续）')
      return { snapshot: snapshot(sessionId), turns, reason: 'interrupted' }
    }
    // 每轮都重新读：模型可能在上一轮用 GoalStatus 改了状态
    let s = snapshot(sessionId)
    if (!s) return { snapshot: null, turns, reason: 'gone' }        // 用户 /goal clear 了
    if (s.isTerminal) return { snapshot: s, turns, reason: s.status }
    if (s.status === 'paused') return { snapshot: s, turns, reason: 'paused' }

    try {
      await agent.run(next, { signal })
    } catch (e) {
      const msg = String(e?.message || e)
      if (msg === 'Interrupted' || /abort/i.test(msg)) {
        const cur = snapshot(sessionId)
        if (cur && cur.isActive) setGoalStatus(sessionId, 'paused', '被用户打断，进度已保留（/goal resume 继续）')
        return { snapshot: snapshot(sessionId), turns, reason: 'interrupted' }
      }
      // 真错误：转 blocked 并写清原因，不静默消失
      setGoalStatus(sessionId, 'blocked', `运行出错：${msg.slice(0, 200)}`)
      return { snapshot: snapshot(sessionId), turns, reason: 'error' }
    }

    turns += 1
    // 计一轮 + 结算 token。recordGoalTurn 返回最新 snapshot
    s = recordGoalTurn(sessionId, getTokens()) || snapshot(sessionId)
    if (!s) return { snapshot: null, turns, reason: 'gone' }
    try { onTurn(s, closing ? 'closing' : 'turn') } catch {}

    // 模型这轮已经宣布终态 → 收工
    if (s.isTerminal) return { snapshot: s, turns, reason: s.status }
    if (s.status === 'paused') return { snapshot: s, turns, reason: 'paused' }

    // 上一轮是收尾轮，交接已写完 → 落终态
    if (closing) {
      const why = s.exhausted === 'time' ? '时间预算耗尽'
        : s.exhausted === 'tokens' ? 'token 预算耗尽'
        : '轮次预算耗尽'
      setGoalStatus(sessionId, 'blocked', `${why}，目标未达成（已交接；/goal budget 可追加预算后 /goal resume）`)
      return { snapshot: snapshot(sessionId), turns, reason: 'budget' }
    }

    if (s.exhausted) {
      // 预算到头：再给一轮，只准写交接
      closing = true
      next = buildBudgetStopPrompt(s)
      continue
    }
    next = buildContinuationPrompt(s)
  }
}

export { CONVERGE_FRACTION }
