// Team 工具集：把 core/teams.mjs 暴露给 Agent，实现真正的多 Agent 协作。
//
// 协作范式（Team 与 TaskList 同名，二者是一体的）：
//   1) TeamCreate 建组 → 2) 各 Agent TeamJoin 报到
//   3) TaskCreate 派活（用 tasks 工具，list 填团队名）
//   4) TaskClaim 领活 → 5) SendMessage 沟通阻塞点
//   6) CheckMessages 收消息 → 7) TaskUpdate 交付
//
// 为什么消息不是「实时推送」：
//   Agent 是回合制的，没有中断机制。消息进对方 inbox 文件，
//   对方下一轮主动 CheckMessages 时取走。所以 prompt 里要提醒：
//   长任务中途定期 CheckMessages，否则协作方的消息会一直堆着。

import { Tool } from './tools.mjs'
import {
  createTeam, joinTeam, getTeam, listTeams, sendMessage, readInbox,
  teamOverview, formatTeamOverview, deleteTeam, setMemberStatus, teamExists,
} from './teams.mjs'

const teamProp = { type: 'string', description: '团队名（同时也是任务列表名，Task 工具的 list 参数填同一个值）' }

export class TeamCreateTool extends Tool {
  constructor() {
    super({
      name: 'TeamCreate',
      description: '创建协作团队。团队名同时是任务列表名——建完用 TaskCreate（list 填团队名）派活。需要多个子 Agent 分工并互相沟通时用；单个 Agent 干活不需要建团队。',
      input_schema: {
        type: 'object',
        properties: {
          team: teamProp,
          description: { type: 'string', description: '可选：这个团队要完成什么' },
        },
        required: ['team'],
      },
      maxResultSizeChars: 1000,
      validateInput(input) {
        const errors = []
        if (!input.team || !String(input.team).trim()) errors.push('team is required')
        return { valid: errors.length === 0, errors }
      },
    })
  }

  async execute(input) {
    const r = createTeam(input.team, { description: input.description })
    if (!r.ok && r.reason === 'exists') return `团队 [${input.team}] 已存在，直接 TeamJoin 加入即可`
    return `已创建团队 [${r.team.name}]。用 TaskCreate 派活时 list 填 ${r.team.name}`
  }
}

export class TeamJoinTool extends Tool {
  constructor() {
    super({
      name: 'TeamJoin',
      description: '以某个身份加入团队，之后才能收发消息。同一身份重复加入不会报错。子 Agent 开工第一步就该 join。',
      input_schema: {
        type: 'object',
        properties: {
          team: teamProp,
          agent: { type: 'string', description: '自己的身份标识，如 planner / worker-1 / reviewer' },
          role: { type: 'string', description: '可选：职责说明，如「负责 core/ 目录重构」' },
        },
        required: ['team', 'agent'],
      },
      maxResultSizeChars: 1000,
    })
  }

  async execute(input) {
    const r = joinTeam(input.team, input.agent, { role: input.role })
    if (!r.ok) return `加入失败：团队 [${input.team}] 不存在，先 TeamCreate`
    const others = r.team.members.filter(m => m.name !== input.agent).map(m => m.name)
    return `${input.agent} 已加入 [${input.team}]` +
      (others.length ? `。当前队友: ${others.join(', ')}` : '。目前只有你一个成员')
  }
}

export class SendMessageTool extends Tool {
  constructor() {
    super({
      name: 'SendMessage',
      description: '给队友发消息。\n【重要】你的正文输出（说给用户听的话）**其他 Agent 看不见**——想让队友知道任何事，只能靠这个工具发过去。\n默认进对方 inbox，对方下一轮自动收到。\n【wake:true】直接唤醒一个已跑完的子 Agent（按 Agent 工具里的 agent_name），把 text 当新指令给它接着干——它保留原有上下文，还记得自己之前做过什么，不用重讲背景。适合让 worker 返工、追问细节、补做一部分。\n【request】发需要对方答复的协议请求（shutdown 收工 / plan_approval 方案审批）。\n不要用它发无信息量的寒暄或进度播报。',
      input_schema: {
        type: 'object',
        properties: {
          team: teamProp,
          from: { type: 'string', description: '自己的身份' },
          to: { type: 'string', description: '接收方身份（必须是已 join 的成员）；填 "*" = 广播给所有队友，代价随团队人数线性增长，只在人人都需要知道时用' },
          text: { type: 'string', description: '完整消息内容。写清上下文——对方看不到你的对话历史，也看不到你的正文输出' },
          summary: { type: 'string', description: '可选：一行摘要（10 字内），给人看预览' },
          wake: { type: 'boolean', description: '可选：true = 把 to 当成子 Agent 名字直接唤醒它续跑（默认后台，返回 task_id），而不是投进 inbox 等对方自己来收' },
          wait: { type: 'boolean', description: '可选：配合 wake 用。true = 同步等它跑完再返回（只适合几秒能答完的追问；长任务别用，会撞工具超时）。默认 false = 后台跑，返回 task_id 供 AgentStatus/AgentOutput 查询' },
          request: {
            type: 'string',
            enum: ['shutdown', 'plan_approval'],
            description: '可选：发一条**需要对方答复**的协议请求。shutdown=请求对方收工（对方同意即结束自己的进程）；plan_approval=请求对方审批你的方案（对方可驳回并要求修改）。收到请求的一方必须用 respond 回复。',
          },
          respond: {
            type: 'string',
            description: '可选：答复某条协议请求，填对方消息里的 request_id',
          },
          approve: {
            type: 'boolean',
            description: '配合 respond 使用：true=同意（shutdown 则对方结束 / plan 则可以开工），false=驳回（plan 被驳回时请在 text 里写清要改什么）',
          },
        },
        // team 可选（2026-09-28）：没有团队也能给**子 Agent** 发消息 ——
        // to 匹配子 Agent 名时自动走 wake/steering 通道，不必先 TeamCreate。
        required: ['from', 'to', 'text'],
      },
      maxResultSizeChars: 8000,
    })
  }

  async execute(input) {
    // 【wake 模式】唤醒已完成的子 Agent 续跑，复用它原有上下文。
    // 普通 inbox 模式是“写文件 + 对方必须还活着且主动来收”，子 Agent 跑完就销毁了，
    // 没人会再去读 —— 想让它返工只能重新 spawn 并把背景手工塞进 prompt。
    // wake 直接拿回那个实例接着跑，它还记得之前的对话。
    // 自动通道（2026-09-28）：显式 wake，或「没给 team 且 to 是已知子 Agent 名」。
    // 「给正在跑的子 Agent 补充指令」是高频需求，不该强制先 TeamCreate。
    // import 放判定前（plan.mjs 启动时常驻，这个 import 是缓存命中、无成本）。
    const { resumeSubagent, listKeptAgents, getKeptAgent } = await import('./plan.mjs')
    const autoWake = !!input.wake
      || (!input.team && input.to !== '*' && !!getKeptAgent(input.to))

    if (autoWake) {
      if (!input.wake && !getKeptAgent(input.to)) {
        return `未指定 team，且 [${input.to}] 不是已知子 Agent。\n`
          + `· 给子 Agent 发：确认它的 agent_name 后直接 to=该名（自动唤醒/执行中注入）\n`
          + `· 给队友发：传 team 参数（先 TeamCreate / TeamJoin）`
      }

      // 【默认后台续跑 —— 2026-09-27 改】
      //
      // 原来是同步 await 到底。问题是子 Agent 动辄跑几分钟，而工具调用
      // 有 60s 超时 —— 必然超时返回，且超时后拿不到任何句柄：
      //   · 拿不到结果（它还在跑，但回复没人接）
      //   · 拿不到 task_id（无法查进度，只能翻 trace 文件猜）
      //   · 主 Agent 以为"发出去了"，实际完全失控
      // 实测踩过：连续 wake 三个 agent，全都超时，只能靠 grep traces 判断死活。
      //
      // 现在默认后台：立刻返回 task_id，用 AgentStatus / AgentOutput 查。
      // 想同步等结果（比如就一句追问、几秒能答完）可以传 wait:true。
      const background = input.wait !== true
      const r = await resumeSubagent(input.to, input.text, { background })

      if (r === null) {
        const names = listKeptAgents().map(a => `${a.name}(${a.messages}条)`)
        return `无法唤醒 [${input.to}]：没有这个名字的子 Agent。\n可唤醒的: ${names.join(', ') || '(无)'}\n`
          + `提示：只有通过 Agent 工具跑过的子 Agent 能被唤醒，且创建时建议显式传 agent_name。若只是想给人类队友留言，去掉 wake 即可。`
      }
      if (r.rejected) return r.message + '\n' + r.hint
      if (!r.ok) return `唤醒 [${input.to}] 后出错：${r.error}`

      if (r.background) {
        return `已在后台唤醒 [${r.name}]（${r.type}）。\n`
          + `task_id: ${r.task_id}\n\n`
          + `用 AgentStatus({task_id:"${r.task_id}"}) 看进度，`
          + `AgentOutput({task_id:"${r.task_id}", block:true}) 等它完成并取回复。\n`
          + `（想同步等结果，下次传 wait:true）`
      }

      return `已唤醒 [${r.name}] 并跑完（${(r.duration_ms / 1000).toFixed(1)}s，上下文现 ${r.total_messages} 条）。\n\n它的回复：\n${r.result}`
    }

    // 【协议消息】对齐官方：结构化请求 + 必须答复。
    // 用途是让多 Agent 之间能做治理，而不只是单向传话：
    //   shutdown      —— worker 请求收工，lead 同意后它才结束（避免半成品就跑掉）
    //   plan_approval —— worker 提交方案，lead 可以驳回并要求修改
    let payload = { ...input }
    if (input.request) {
      const reqId = `${input.request}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const label = input.request === 'shutdown' ? '收工请求' : '方案审批请求'
      payload.summary = input.summary || label
      payload.text = `【${label}｜request_id: ${reqId}】\n${input.text}\n\n`
        + `（请用 SendMessage(respond:"${reqId}", approve:true/false, text:"理由") 答复。`
        + (input.request === 'shutdown'
          ? '同意即表示他可以结束任务。）'
          : '驳回时请在 text 里写清要改什么。）')
      payload.type = `${input.request}_request`
      payload.requestId = reqId
    } else if (input.respond) {
      const ok = input.approve !== false
      payload.summary = input.summary || (ok ? '已同意' : '已驳回')
      payload.text = `【答复 request_id: ${input.respond}｜${ok ? '同意 ✓' : '驳回 ✗'}】\n${input.text || ''}`
      payload.type = 'protocol_response'
    }

    const r = sendMessage(input.team, payload)
    if (!r.ok) {
      if (r.reason === 'no_team') return `发送失败：团队 [${input.team}] 不存在`
      if (r.reason === 'no_peers') return `广播失败：团队 [${input.team}] 里除你之外没有活跃成员`
      return `发送失败：[${input.to}] 不在团队里。现有成员: ${(r.members || []).join(', ') || '(无)'}`
    }
    if (r.broadcast) {
      return `已广播给 ${r.delivered} 人：${r.targets.join(', ')}`
    }
    if (payload.requestId) {
      return `已向 ${input.to} 发出${input.request === 'shutdown' ? '收工' : '方案审批'}请求`
        + `（request_id: ${payload.requestId}）。等对方答复后再行动，别自己先假定通过。`
    }
    if (input.respond) {
      return `已答复 ${input.to} 的请求 ${input.respond}：${input.approve !== false ? '同意' : '驳回'}`
    }
    return `已发给 ${input.to}（对方 inbox 现有 ${r.queued} 条）`
  }
}

export class CheckMessagesTool extends Tool {
  constructor() {
    super({
      name: 'CheckMessages',
      description: '查看发给自己的消息。\n【多数情况你不需要调它】TeamJoin 之后，队友发来的新消息会在下一轮自动出现在你的对话里（标注「队友消息 · 自动送达」）。所以不要写 sleep + CheckMessages 的等待循环。\n只在这些时候用：想回顾已读历史（all:true）、或想查看但不标记已读（peek:true）。',
      input_schema: {
        type: 'object',
        properties: {
          team: teamProp,
          agent: { type: 'string', description: '自己的身份' },
          all: { type: 'boolean', description: '可选：true 时连已读的一起返回（回顾历史用）' },
          peek: { type: 'boolean', description: '可选：true 时不标记已读' },
        },
        required: ['team', 'agent'],
      },
      maxResultSizeChars: 6000,
    })
  }

  async execute(input) {
    if (!teamExists(input.team)) return `团队 [${input.team}] 不存在`
    const msgs = readInbox(input.team, input.agent, {
      unreadOnly: !input.all,
      peek: !!input.peek,
    })
    if (!msgs.length) return input.all ? '(inbox 为空)' : '(没有新消息)'
    return msgs.map(m =>
      `【${m.from} → ${m.to}】${m.summary ? m.summary + ' · ' : ''}${m.timestamp.slice(11, 19)}\n${m.text}`
    ).join('\n\n')
  }
}

export class TeamStatusTool extends Tool {
  constructor() {
    super({
      name: 'TeamStatus',
      description: '查看团队全景：成员及职责、各人持有的任务数、未读消息数、任务进度统计。派活前先看谁闲着，收尾前确认没人卡住。',
      input_schema: {
        type: 'object',
        properties: {
          team: { type: 'string', description: '团队名；省略则列出所有团队' },
        },
      },
      maxResultSizeChars: 4000,
    })
  }

  async execute(input) {
    if (!input.team) {
      const all = listTeams()
      if (!all.length) return '(还没有任何团队)'
      return all.map(t => `[${t.name}] ${t.members.length} 名成员${t.description ? ' — ' + t.description : ''}`).join('\n')
    }
    return formatTeamOverview(teamOverview(input.team))
  }
}

export class TeamLeaveTool extends Tool {
  constructor() {
    super({
      name: 'TeamLeave',
      description: '标记自己退出协作（状态转 inactive，不删除消息记录）。子 Agent 完成分工、交付完成后调用，让主 Agent 知道你收工了。',
      input_schema: {
        type: 'object',
        properties: {
          team: teamProp,
          agent: { type: 'string', description: '自己的身份' },
        },
        required: ['team', 'agent'],
      },
      maxResultSizeChars: 500,
    })
  }

  async execute(input) {
    const ok = setMemberStatus(input.team, input.agent, 'inactive')
    return ok ? `${input.agent} 已退出 [${input.team}]` : `失败：团队或成员不存在`
  }
}

export class TeamDisbandTool extends Tool {
  constructor() {
    super({
      name: 'TeamDisband',
      description: '解散团队，同时清空同名任务列表（Team 与 TaskList 是一体的）。协作彻底结束、结论已汇总后才调用；想保留任务记录就设 keepTasks。',
      input_schema: {
        type: 'object',
        properties: {
          team: teamProp,
          keepTasks: { type: 'boolean', description: '可选：true 时保留任务列表，只解散团队' },
        },
        required: ['team'],
      },
      maxResultSizeChars: 500,
    })
  }

  async execute(input) {
    const r = deleteTeam(input.team, { keepTasks: !!input.keepTasks })
    if (!r.ok) return `团队 [${input.team}] 不存在`
    return `已解散 [${input.team}]` + (r.removedTasks ? `，同时清除 ${r.removedTasks} 条任务` : '（任务列表已保留）')
  }
}

export const TEAM_TOOLS = [
  new TeamCreateTool(),
  new TeamJoinTool(),
  new SendMessageTool(),
  new CheckMessagesTool(),
  new TeamStatusTool(),
  new TeamLeaveTool(),
  new TeamDisbandTool(),
]
