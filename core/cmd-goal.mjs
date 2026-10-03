// Claude Code Mobile - /goal 命令
//
// 只负责「解析 + 落盘 + 生成给用户看的文本」。**不负责跑目标** ——
// 真正的跨轮推进由 index.mjs 拿到 __startGoal 信号后走 runGoalLoop。
// 分开的原因：slash 命令处理器是同步返回一段字符串的语境，
// 在里面 await 一个可能跑 15 轮的循环会把 UI 状态机（processing / promptCleared /
// spinner）全部搞乱。命令只表态"该开跑了"，由主循环负责跑。

import {
  createGoal, clearGoal, reviseGoal, setGoalStatus, snapshot, listAllGoals,
  parseDuration, parseCount, DEFAULT_TURN_BUDGET,
} from './goal.mjs'
import { renderGoalCard, buildGoalContract, budgetLine } from './goal-runtime.mjs'

const HELP = `/goal — 完成契约（目标模式）

和 todo 的区别：todo 是清单，goal 是**契约**，会自动跨轮推进直到达成或预算用尽。

  /goal <目标描述>            设定目标并立即开始推进
  /goal                       看当前目标与进度
  /goal status                同上
  /goal proof <如何验证>      设/改完成判据（怎么证明"做完了"）
  /goal bound <禁区>          追加边界（可多次；如 "不许改 tests/"）
  /goal budget <预算>         改预算：12 / 30m / 200k（轮数/时间/token）
  /goal pause                 暂停（进度保留）
  /goal resume                恢复并继续推进
  /goal replace <新目标>      放弃当前目标换新的
  /goal clear                 放弃当前目标
  /goal list                  所有会话的目标

设定时可内联写契约（推荐，一次说清四要素）：
  /goal 把 core/x.mjs 的错误处理补全 --proof "node --check 通过且 tests/x 全绿"
        --bound "只改 core/x.mjs" --budget 10

不写 --proof 时会提醒你补：没有判据的目标无法判定完成，只能烧到预算耗尽。
不写 --budget 默认 ${DEFAULT_TURN_BUDGET} 轮（手机上不给无上限自动推进）。`

/** 从目标描述里抽 --proof / --bound / --budget，剩下的是 objective */
function parseFlags(text) {
  const out = { objective: '', proof: null, bounds: [], budget: [] }
  // 支持 --key "带空格的值" 或 --key 单词
  const re = /--(proof|bound|budget|boundary)(?:\s+|=)("([^"]*)"|'([^']*)'|\S+)/g
  let rest = String(text || '')
  let m
  const hits = []
  while ((m = re.exec(rest)) !== null) {
    const val = m[3] ?? m[4] ?? m[2]
    hits.push({ start: m.index, end: m.index + m[0].length })
    if (m[1] === 'proof') out.proof = val
    else if (m[1] === 'budget') out.budget.push(val)
    else out.bounds.push(val)
  }
  // 从后往前删，避免前面的删除改变后面的下标
  for (const h of hits.reverse()) rest = rest.slice(0, h.start) + rest.slice(h.end)
  out.objective = rest.replace(/\s+/g, ' ').trim()
  return out
}

/** 预算串 → {turns|wallClockMs|tokens}。纯数字=轮数；带 s/m/h=时间；带 k/m=token */
export function parseBudgetToken(raw) {
  const t = String(raw || '').trim().toLowerCase()
  if (!t) return {}
  // 判定顺序是刻意的，别改：先无歧义的，最后才处理有歧义的 'm'。
  // 1) 纯整数 → 轮数（最常用）
  if (/^\d+$/.test(t)) return { turns: parseInt(t, 10) }
  // 2) 显式轮数后缀
  if (/^\d+(?:\.\d+)?\s*(?:turns?|轮)$/.test(t)) return { turns: Math.floor(parseFloat(t)) }
  // 3) 无歧义时间后缀：ms / s / h / min / 分（不含裸 m）
  if (/^\d+(?:\.\d+)?\s*(?:ms|s|h|min|分钟|分)$/.test(t)) {
    const ms = parseDuration(t)
    if (ms) return { wallClockMs: ms }
  }
  // 4) k 一律是 token（没人写 "5k 分钟"）
  if (/^\d+(?:\.\d+)?\s*k$/.test(t)) {
    const n = parseCount(t)
    if (n) return { tokens: n }
  }
  // 5) 裸 'm' 有歧义：30m 是分钟、1.5m 是 150 万 token。
  //    约定：整数且 ≤600 视为分钟（600 分钟 = 10 小时，够长了），其余视为 token。
  const mMatch = /^(\d+(?:\.\d+)?)\s*m$/.exec(t)
  if (mMatch) {
    const n = parseFloat(mMatch[1])
    if (Number.isInteger(n) && n <= 600) return { wallClockMs: n * 60000 }
    return { tokens: parseCount(t) }
  }
  // 6) 兜底：交给两个解析器，时间优先（复合式如 "1h30m"）
  const ms = parseDuration(t)
  if (ms) return { wallClockMs: ms }
  const n = parseCount(t)
  if (n) return { tokens: n }
  return {}
}

function collectBudget(list) {
  const b = {}
  for (const raw of list || []) Object.assign(b, parseBudgetToken(raw))
  // 剔掉 <=0 的项：reviseGoal 只接受正数，留着会让 "/goal budget 0" 回一句
  // "预算已更新" 但实际没动（假反馈比报错更坏，用户会以为 0 生效了）。
  for (const k of ['turns', 'wallClockMs', 'tokens']) {
    if (b[k] !== undefined && !(Number.isFinite(b[k]) && b[k] > 0)) delete b[k]
  }
  return b
}

function card(sid, ctx) {
  return renderGoalCard(snapshot(sid), { cols: ctx.cols?.() ?? 60, color: ctx.C })
}

/**
 * 处理 /goal。
 * @param {string[]} args
 * @param {object} ctx { sessionId():string, C:colors, cols?:()=>number }
 * @returns {string | {__startGoal:true, message:string, text:string}}
 *   返回对象时表示"目标已就绪，请主循环开始推进"。
 */
export function handleGoalCommand(args = [], ctx = {}) {
  const sid = String(ctx.sessionId?.() || 'default')
  const C = ctx.C || {}
  const sub = String(args[0] || '').toLowerCase()
  const rest = args.slice(1).join(' ').trim()

  if (sub === 'help' || sub === '--help' || sub === '-h') return HELP

  // 无参：看当前目标
  if (!args.length) {
    const s = snapshot(sid)
    if (!s) return `当前没有目标。\n\n用 /goal <目标描述> 设一个，/goal help 看用法。\n${C.dim || ''}goal 会自动跨轮推进直到达成或预算用尽，和 todo 清单不同。${C.reset || ''}`
    return card(sid, ctx) + `\n\n${C.dim || ''}/goal resume 继续 · /goal pause 暂停 · /goal clear 放弃${C.reset || ''}`
  }

  if (sub === 'status') {
    const s = snapshot(sid)
    if (!s) return '当前没有目标。用 /goal <目标描述> 设一个。'
    const lines = [card(sid, ctx)]
    if (s.log?.length) {
      lines.push('', `${C.dim || ''}最近事件${C.reset || ''}`)
      for (const e of s.log.slice(-6)) {
        lines.push(`${C.dim || ''}  ${String(e.at).slice(11, 16)} ${e.event}${e.note ? ` · ${e.note.slice(0, 60)}` : ''}${C.reset || ''}`)
      }
    }
    return lines.join('\n')
  }

  if (sub === 'list') {
    const all = listAllGoals()
    if (!all.length) return '还没有任何目标记录。'
    return ['所有会话的目标', ...all.map(g =>
      `  ${g.sessionId === sid ? '▸' : ' '} [${g.status}] ${g.turnsUsed}/${g.turnBudget}轮 · ${g.objective.slice(0, 40)}${g.objective.length > 40 ? '…' : ''} ${C.dim || ''}(${g.sessionId})${C.reset || ''}`,
    )].join('\n')
  }

  if (sub === 'clear' || sub === 'abandon' || sub === 'cancel') {
    const old = clearGoal(sid)
    if (!old) return '当前没有目标，无需放弃。'
    return `已放弃目标：${old.objective}\n${C.dim || ''}（进度不再保留。新目标用 /goal <描述>）${C.reset || ''}`
  }

  if (sub === 'pause') {
    const r = setGoalStatus(sid, 'paused', '用户手动暂停')
    if (!r.ok) return r.error
    return `已暂停。${budgetLine(snapshot(sid))}\n${C.dim || ''}/goal resume 恢复推进${C.reset || ''}`
  }

  if (sub === 'proof' || sub === 'criterion') {
    if (!rest) {
      const s = snapshot(sid)
      return s?.completion ? `当前完成判据：${s.completion}` : '当前未设完成判据。用 /goal proof <如何验证> 设一个。'
    }
    const r = reviseGoal(sid, { completion: rest })
    if (!r.ok) return r.error
    return `完成判据已设为：${rest}\n\n${card(sid, ctx)}`
  }

  if (sub === 'bound' || sub === 'boundary') {
    if (!rest) {
      const s = snapshot(sid)
      return s?.boundaries?.length ? `当前边界：\n${s.boundaries.map(b => `  · ${b}`).join('\n')}` : '当前未设边界。用 /goal bound <禁区> 加一条。'
    }
    const r = reviseGoal(sid, { addBoundary: rest })
    if (!r.ok) return r.error
    return `边界已追加：${rest}\n\n${card(sid, ctx)}`
  }

  if (sub === 'budget') {
    if (!rest) {
      const s = snapshot(sid)
      return s ? `当前预算：${budgetLine(s)}` : '当前没有目标。'
    }
    const b = collectBudget(rest.split(/\s+/))
    if (!Object.keys(b).length) return `预算格式没认出来：${rest}\n可用：12（轮数）· 30m（分钟）· 2h（小时）· 200k（token）`
    const r = reviseGoal(sid, b)
    if (!r.ok) return r.error
    return `预算已更新：${budgetLine(snapshot(sid))}\n${C.dim || ''}目标处于暂停/阻塞时，改完预算记得 /goal resume${C.reset || ''}`
  }

  if (sub === 'resume' || sub === 'continue' || sub === 'next') {
    const s0 = snapshot(sid)
    if (!s0) return '当前没有目标。用 /goal <目标描述> 设一个。'
    if (s0.status === 'complete') return `目标已完成，无需恢复：${s0.objective}\n新目标用 /goal <描述>。`
    if (s0.exhausted) {
      return `预算已耗尽（${budgetLine(s0)}），无法直接恢复。\n先追加预算：/goal budget <更大的值>，再 /goal resume。`
    }
    const r = setGoalStatus(sid, 'active', null)
    if (!r.ok) return r.error
    const s = snapshot(sid)
    return {
      __startGoal: true,
      text: `${C.cyan || ''}▸ 继续推进目标${C.reset || ''}\n${card(sid, ctx)}`,
      message: [
        '（goal mode 恢复推进 · 非用户发言）',
        '用户要求继续推进这个目标。接着上次的进度往下做。',
        '',
        buildGoalContract(s),
      ].join('\n'),
    }
  }

  // 设定新目标：/goal <描述> 或 /goal replace <描述>
  const isReplace = sub === 'replace' || sub === 'new'
  const body = isReplace ? rest : args.join(' ').trim()
  if (!body) return HELP

  const f = parseFlags(body)
  if (!f.objective) return `目标描述是空的。\n\n${HELP}`
  const b = collectBudget(f.budget)
  const r = createGoal(sid, {
    objective: f.objective,
    completion: f.proof,
    boundaries: f.bounds,
    turns: b.turns ?? null,
    wallClockMs: b.wallClockMs ?? null,
    tokens: b.tokens ?? null,
    tokensAtStart: ctx.getTokens?.() || 0,
    replace: isReplace,
  })
  if (!r.ok) return r.error

  const s = snapshot(sid)
  const warn = s.completion ? '' :
    `\n${C.yellow || ''}⚠ 没有完成判据${C.reset || ''}${C.dim || ''}：无法判定"做完了"，目标只会烧到预算耗尽。建议 /goal proof <如何验证>。${C.reset || ''}`
  return {
    __startGoal: true,
    text: `${C.cyan || ''}▸ 目标已设定，开始推进${C.reset || ''}\n${card(sid, ctx)}${warn}\n${C.dim || ''}Ctrl+C 打断（进度保留，/goal resume 继续）${C.reset || ''}`,
    message: [
      '（goal mode 启动 · 用户已设定以下完成契约）',
      '这是第 1 个 goal turn。先确认理解目标与判据，然后开始做第一个有界切片。',
      '',
      buildGoalContract(s),
    ].join('\n'),
  }
}

export const GOAL_HELP = HELP
