// Claude Code Mobile - Goal 工具集
//
// 只给模型三个工具，刻意**不给** CreateGoal：
//   目标由用户用 /goal 设定。让模型自己造目标 = 它可以给自己发无人监督的
//   长跑许可（还带预算），这是权限放大，不是功能。Kimi 有 TUI 能随时看住它，
//   我们是手机终端 + 自动续轮，不给这个口子。
//   模型要建议目标就用文字建议，用户敲 /goal 拍板。
//
//   GetGoal       —— 读当前契约与预算（决定还要不要继续干）
//   GoalStatus    —— 唯一的收尾出口：complete / blocked（也可 paused）
//   SetGoalBudget —— 申请追加预算（只增不减，且要给理由）

import { Tool } from './tools.mjs'
import {
  snapshot, setGoalStatus, reviseGoal, noteBlocker,
  parseDuration, parseCount, BLOCKED_STREAK_THRESHOLD,
} from './goal.mjs'
import { budgetLine, buildGoalContract } from './goal-runtime.mjs'

// sessionId 必须是 getter：CLI 里 /new /resume 会换 session，
// 构造时快照会让工具永远读旧会话的目标（这类 bug 极难查）。
function resolveSid(getSessionId) {
  try {
    const v = typeof getSessionId === 'function' ? getSessionId() : getSessionId
    return String(v || 'default')
  } catch { return 'default' }
}

export class GetGoalTool extends Tool {
  constructor(getSessionId) {
    super({
      name: 'GetGoal',
      description: '读取当前目标（完成契约）：目标、完成判据、边界、预算余量、阻塞计数。决定"继续干 / 宣布完成 / 报阻塞"之前先看它。没有目标时返回 no_goal。',
      input_schema: { type: 'object', properties: {} },
      maxResultSizeChars: 4000,
    })
    this.getSessionId = getSessionId
  }
  isConcurrencySafe() { return true }
  async execute() {
    const s = snapshot(resolveSid(this.getSessionId))
    if (!s) return '{"goal": null}  当前没有目标。目标由用户用 /goal <描述> 设定；你不能自己创建目标，只能建议。'
    return [
      `状态：${s.status}${s.terminalReason ? `（${s.terminalReason}）` : ''}`,
      buildGoalContract(s),
      '',
      `阻塞计数：${s.blockedStreak}/${s.blockedThreshold}（未达阈值不准判 blocked）`,
    ].join('\n')
  }
}

export class GoalStatusTool extends Tool {
  constructor(getSessionId) {
    super({
      name: 'GoalStatus',
      description: `设置当前目标的终态。这是目标唯一的正式出口。
- complete：完成判据已被**实际验证**通过。只有计划/摘要/初稿/部分结果 → 不许用。预算快用完也不是完成的理由。
- blocked：真正的僵局（缺凭据/权限、必须用户拍板、外部条件不满足、同一技术故障反复失败）。同一障碍需连续 ${BLOCKED_STREAK_THRESHOLD} 个 goal turn 复现才允许；未达阈值调用会被拒绝并告知还差几轮。目标本身不可能/矛盾/不安全则可当轮直接 blocked（用 impossible:true）。
- paused：需要用户参与、暂时挂起。
多数 goal turn **不该调这个工具**：还有实质工作就正常结束本轮，runtime 会自动给你下一轮。`,
      input_schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['complete', 'blocked', 'paused'], description: '要设置的终态' },
          reason: { type: 'string', description: 'complete 时写完成判据如何被验证通过（贴证据）；blocked 时写具体障碍' },
          impossible: { type: 'boolean', description: '仅 blocked 用：目标本身不可能/自相矛盾/不安全，跳过连续轮次阈值当轮终止' },
        },
        required: ['status'],
      },
      maxResultSizeChars: 2000,
      validateInput(input) {
        const errors = []
        if (!input.status) errors.push('status is required')
        if (input.status === 'blocked' && !String(input.reason || '').trim()) {
          errors.push('blocked 必须写 reason（具体障碍是什么）')
        }
        return { valid: errors.length === 0, errors }
      },
    })
    this.getSessionId = getSessionId
  }
  async execute(input) {
    const sid = resolveSid(this.getSessionId)
    const s = snapshot(sid)
    if (!s) return '当前没有目标，无法设置状态。'
    if (s.isTerminal) return `目标已是终态（${s.status}），无需再设。`

    if (input.status === 'blocked' && !input.impossible) {
      // 阻塞审计在这里强制，不靠模型自觉。
      // 只写提示词的话，模型第一次遇到困难就会宣布卡住然后躺平。
      const streak = noteBlocker(sid, input.reason)
      if (streak < BLOCKED_STREAK_THRESHOLD) {
        return [
          `拒绝：阻塞审计未通过。该障碍已连续 ${streak}/${BLOCKED_STREAK_THRESHOLD} 轮。`,
          '这不是错误，是设计如此：第一次遇到障碍不算僵局。',
          '继续换办法推进（换思路 / 换工具 / 绕开 / 先做目标里别的部分），正常结束本轮即可，runtime 会给你下一轮。',
          `如果目标本身不可能、自相矛盾或不安全，用 impossible:true 当轮终止。`,
          '',
          `当前预算：${budgetLine(s)}`,
        ].join('\n')
      }
    }
    const reason = input.impossible && input.status === 'blocked'
      ? `目标不可行：${input.reason}`
      : (input.reason || null)
    const r = setGoalStatus(sid, input.status, reason)
    if (!r.ok) return `设置失败：${r.error}`
    const after = snapshot(sid)
    if (input.status === 'complete') {
      return `已标记目标完成。${budgetLine(after)}\n现在在回复里写清：做了什么、完成判据如何被验证通过（贴证据）。不要再调 goal 工具。`
    }
    if (input.status === 'blocked') {
      return `已标记目标阻塞。${budgetLine(after)}\n现在在回复里说清障碍、你试过什么、需要用户做什么。不要再调 goal 工具。`
    }
    return `已暂停目标。${budgetLine(after)}\n用户可用 /goal resume 恢复。`
  }
}

export class SetGoalBudgetTool extends Tool {
  constructor(getSessionId) {
    super({
      name: 'SetGoalBudget',
      description: '申请追加当前目标的预算（只能增加，不能减少）。仅当预算即将耗尽、且剩余工作确实必要时用；并在 reason 里说清为什么原预算不够。想提前收工不要用这个 —— 用 GoalStatus。',
      input_schema: {
        type: 'object',
        properties: {
          turns: { type: 'number', description: '新的轮次预算总数（必须大于当前值）' },
          time: { type: 'string', description: '新的时间预算，如 "30m" / "2h"（必须大于当前值）' },
          tokens: { type: 'string', description: '新的 token 预算，如 "200k"（必须大于当前值）' },
          reason: { type: 'string', description: '为什么需要追加' },
        },
        required: ['reason'],
      },
      maxResultSizeChars: 1500,
      validateInput(input) {
        const errors = []
        if (!String(input.reason || '').trim()) errors.push('reason is required（说明为什么原预算不够）')
        if (input.turns == null && input.time == null && input.tokens == null) {
          errors.push('至少给一项：turns / time / tokens')
        }
        return { valid: errors.length === 0, errors }
      },
    })
    this.getSessionId = getSessionId
  }
  async execute(input) {
    const sid = resolveSid(this.getSessionId)
    const s = snapshot(sid)
    if (!s) return '当前没有目标。'
    if (s.isTerminal) return `目标已是终态（${s.status}），改预算无效。`
    const patch = {}
    const rejected = []
    // 只增不减：否则模型可以把预算调小来"合法地"提前收工，绕过完成审计
    if (input.turns != null) {
      const n = Math.floor(Number(input.turns))
      if (Number.isFinite(n) && n > s.turnBudget) patch.turns = n
      else rejected.push(`turns 必须 > 当前 ${s.turnBudget}`)
    }
    if (input.time != null) {
      const ms = parseDuration(input.time)
      if (ms && (!s.wallClockBudgetMs || ms > s.wallClockBudgetMs)) patch.wallClockMs = ms
      else rejected.push(`time 解析失败或不大于当前值`)
    }
    if (input.tokens != null) {
      const n = parseCount(input.tokens)
      if (n && (!s.tokenBudget || n > s.tokenBudget)) patch.tokens = n
      else rejected.push('tokens 解析失败或不大于当前值')
    }
    if (!Object.keys(patch).length) {
      return `预算未改动。预算只能增加，不能减少${rejected.length ? `（${rejected.join('；')}）` : ''}。\n想提前结束目标请用 GoalStatus。\n当前：${budgetLine(s)}`
    }
    const r = reviseGoal(sid, patch)
    if (!r.ok) return `追加失败：${r.error}`
    const after = snapshot(sid)
    return `预算已追加（理由：${String(input.reason).slice(0, 200)}）。\n现在：${budgetLine(after)}${rejected.length ? `\n未采纳：${rejected.join('；')}` : ''}`
  }
}

/** 建工具实例。getSessionId 必须是函数（见 resolveSid 注释） */
export function createGoalTools(getSessionId) {
  return [
    new GetGoalTool(getSessionId),
    new GoalStatusTool(getSessionId),
    new SetGoalBudgetTool(getSessionId),
  ]
}
