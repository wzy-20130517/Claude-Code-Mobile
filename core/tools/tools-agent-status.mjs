// Agent 侧后台子 Agent 观察工具：不依赖 BashOutput 或用户手动 slash。
import { Tool } from './tools.mjs'
import { getBackgroundTaskStatus, listBackgroundTasks, killBackgroundTask } from '../agent/bg-tasks.mjs'
import { listTraces, formatTraceList } from '../api/trace.mjs'

const STATUS_ICON = {
  pending: '○ 排队中', running: '→ 运行中',
  completed: '✓ 已完成', failed: '✗ 失败', killed: '⊘ 已中止',
}

function formatTask(id, task, detail = false) {
  const label = STATUS_ICON[task.status] || task.status
  const bits = [label, task.duration_human]
  // turns 现在是实时值。0 轮且已跑了一会儿 = 还在等第一次模型响应，
  // 不是卡死；写清楚免得又误判（上次就因为恒显示 0 以为郡守挂了）。
  if (task.turns > 0) bits.push(`${task.turns} turns`)
  else if (task.status === 'running') bits.push('尚未完成首轮')
  if (task.messages) bits.push(`${task.messages} 条上下文`)

  const nameTag = task.agentName ? `「${task.agentName}」` : ''
  const typeTag = task.agentType ? ` [${task.agentType}]` : ''
  const head = `子 Agent ${id}${nameTag}${typeTag}\n  ${bits.join(' · ')}\n  任务: ${task.description || '(无描述)'}`

  if (!detail) return head

  const parts = [head]
  // 失败/中止时把原因摆在最前面：这是唯一需要立刻看到的东西
  if (task.status === 'failed' || task.status === 'killed') {
    parts.push(`\n【${task.status === 'failed' ? '失败原因' : '中止原因'}】\n${task.error || task.result_preview || '(未记录原因)'}`)
  }
  parts.push(`\n最近输出:\n${task.output_preview || '(暂无输出)'}`)
  if (task.status === 'completed') {
    parts.push(`\n最终结果:\n${task.result_preview || '(空)'}`)
  } else if (task.status === 'running' || task.status === 'pending') {
    parts.push(`\n(仍在运行，尚无最终结果)`)
  }
  // 按状态给出下一步该干什么，而不是让调用方自己猜
  const advice = {
    running: '仍在跑。别急着重复查询——隔一段时间再看，或用 AgentStop 中止它。',
    pending: '排队中（可能撞上并发上限）。等前面的完成即可。',
    failed: '已失败。若给过 agent_name，可用 SendMessage(to:该名, wake:true) 唤醒它带上下文重试。',
    killed: '已被中止。同样可用 SendMessage(wake:true) 唤醒重来。',
    completed: '已完成。要它返工/补做，用 SendMessage(to:agent_name, wake:true) 而不是重新 spawn。',
  }[task.status]
  if (advice) parts.push(`\n→ ${advice}`)
  return parts.join('\n')
}

export class AgentStatusTool extends Tool {
  constructor() {
    super({
      name: 'AgentStatus',
      description: '查看由 Agent 或 AgentWorkflow 启动的后台子 Agent 状态、耗时、turn、最近输出和最终结果。不要用 BashOutput 轮询子 Agent；子 Agent 完成与否以这里的状态为准。',
      input_schema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '可选。指定后台子 Agent task_id；省略则列出全部子 Agent。' },
          include_traces: { type: 'boolean', description: '是否附带最近 Agent trace 摘要；默认 false。', default: false }
        },
        required: []
      }
    })
  }

  async execute(input = {}) {
    const traces = input.include_traces ? `\n\n${formatTraceList(listTraces({ limit: 5 }))}` : ''
    const id = String(input.task_id || '').trim()

    if (id) {
      const task = getBackgroundTaskStatus(id)
      // 【区分两种失败】原来 !task 和 type 不符共用一句"未找到"，
      // 调用方分不清是 id 打错了还是查错了工具，只能瞎试。
      if (!task) {
        const all = listBackgroundTasks().filter(t => t.type === 'local_agent')
        const avail = all.map(t => `${t.id}(${t.status})`).join(', ')
        return `没有 task_id = ${id} 的后台任务。\n`
          + (avail ? `当前子 Agent: ${avail}` : '当前没有任何后台子 Agent。')
          + `\n提示：task_id 来自 Agent 工具的返回值；不带参数调用 AgentStatus 可列出全部。`
      }
      if (task.type !== 'local_agent') {
        return `${id} 不是子 Agent，它是 ${task.type} 类型的后台任务。\n`
          + `Bash 后台任务请用 BashOutput({task_id}) 看输出、KillShell 终止。`
      }
      return formatTask(id, task, true) + traces
    }

    const tasks = listBackgroundTasks()
      .filter(t => t.type === 'local_agent')
      .map(t => ({ id: t.id, detail: getBackgroundTaskStatus(t.id) }))
      .filter(t => t.detail)
    if (!tasks.length) {
      return '暂无后台子 Agent。\n（用 Agent 工具并设 run_in_background:true 才会产生后台子 Agent；同步调用的不进这个列表。）'
    }
    // 按状态归组统计，一眼看出还剩几个在跑
    const tally = {}
    for (const { detail } of tasks) tally[detail.status] = (tally[detail.status] || 0) + 1
    const summary = Object.entries(tally).map(([s, n]) => `${STATUS_ICON[s] || s}×${n}`).join(' · ')
    const body = tasks.map(({ id: taskId, detail }) => formatTask(taskId, detail, false)).join('\n\n')
    const running = tally.running || tally.pending
    return `后台子 Agent（${tasks.length}）: ${summary}\n\n${body}\n\n`
      + (running
        ? '仍有任务在跑。completed/failed/killed 才是终态，"尚未完成首轮"不等于卡死。查详情用 AgentStatus({task_id})，中止用 AgentStop({task_id})。'
        : '全部已进入终态。要某个 Agent 返工，用 SendMessage(to:agent_name, wake:true) 复用它的上下文。')
      + traces
  }
}

/**
 * 取子 Agent 的输出，支持**阻塞等待**（对齐官方 TaskOutput 工具）。
 *
 * 【为什么需要】原来只有 AgentStatus 快照查询，模型想等子 Agent 完成只能
 * 自己写 `Bash sleep 20` + 反复 AgentStatus 轮询 —— 每轮都烧一次模型调用。
 * 实测图灵测试那局 4 个 Agent 跑 33 分钟，大量轮次耗在轮询上。
 * 这里内部用 200ms 轮询，但对模型是**一次调用**，直接省掉那些轮次。
 */
export class AgentOutputTool extends Tool {
  constructor() {
    super({
      name: 'AgentOutput',
      description: '取后台子 Agent 的输出。\n【block:true】阻塞等到它结束或产出新内容才返回——这是等子 Agent 的正确方式，别再用 Bash sleep + 反复 AgentStatus 轮询，那样每轮都白烧一次模型调用。\n配合 wait 设上限（秒，默认 120，最大 600；timeout 是兼容旧名，等价 wait）。超时不算失败，任务还在跑，可以再等一次。',
      input_schema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '后台子 Agent 的 task_id（来自 Agent 工具返回值或 AgentStatus）' },
          block: { type: 'boolean', description: 'true = 阻塞等待它结束（推荐）；false = 立刻返回当前快照' },
          wait: { type: 'number', description: '阻塞最长等多少秒，默认 120，上限 600' },
          timeout: { type: 'number', description: '（兼容旧名，等价 wait）阻塞最长等多少秒' },
        },
        required: ['task_id'],
      },
      maxResultSizeChars: 30000,
    })
  }

  // 返回框杂约定的 { valid, errors }（旧的字符串/null 风格会让 run() 里
  // v.valid 抽空弹，AgentOutput({block:true}) 当场就崩）。
  validateInput(input = {}) {
    if (!String(input.task_id || '').trim()) {
      return { valid: false, errors: ['task_id 不能为空'] }
    }
    const t = input.wait ?? input.timeout
    if (t != null && (typeof t !== 'number' || t <= 0)) {
      return { valid: false, errors: ['wait 必须是正数（秒）'] }
    }
    return { valid: true }
  }

  async execute(input = {}, ctx = {}) {
    const id = String(input.task_id).trim()
    let task = getBackgroundTaskStatus(id)
    if (!task) {
      const all = listBackgroundTasks().filter(t => t.type === 'local_agent')
      return `没有 task_id = ${id} 的后台任务。\n当前子 Agent: ${all.map(t => `${t.id}(${t.status})`).join(', ') || '(无)'}`
    }
    if (task.type !== 'local_agent') {
      return `${id} 不是子 Agent（type=${task.type}）。Bash 后台任务请用 BashOutput。`
    }

    if (input.block && !['completed', 'failed', 'killed'].includes(task.status)) {
      // 【修】原来只读 input.timeout，而工具描述推荐的是 wait（timeout 是兼容旧名）——
      // 传 wait:300 会被静默忽略、按默认 120s 走。两者都要认，wait 优先。
      const rawWait = input.wait ?? input.timeout
      const limitMs = Math.min(Math.max(Number(rawWait) || 120, 1), 600) * 1000
      const started = Date.now()
      const before = task.output_preview || ''
      // 200ms 轮询：够灵敏又不至于空转烧 CPU。手机上别调太密。
      while (Date.now() - started < limitMs) {
        if (ctx?.signal?.aborted) return `等待被取消（${id} 仍在后台运行）`
        await new Promise(r => setTimeout(r, 200))
        task = getBackgroundTaskStatus(id) || task
        if (['completed', 'failed', 'killed'].includes(task.status)) break
        // 有新输出也返回，让调用方能看到进展而不是干等到底
        if ((task.output_preview || '') !== before) break
      }
      const waited = ((Date.now() - started) / 1000).toFixed(1)
      const done = ['completed', 'failed', 'killed'].includes(task.status)
      const head = done
        ? `等待 ${waited}s 后 ${id} 已进入终态：${task.status}`
        : `等待 ${waited}s（未结束，任务仍在跑——超时不是失败，可以再等一次）`
      return `${head}\n\n${formatTask(id, task, true)}`
    }

    return formatTask(id, task, true)
  }
}

/**
 * 中止跑偏的后台子 Agent（对齐官方 TaskStop 工具）。
 *
 * 【为什么需要】原来派错方向只能干等它跑完：白烧 token、白占一个并发名额，
 * 而且它可能正在改文件。KillShell 只管 Bash 后台任务，管不了子 Agent。
 * 底层能力其实一直都有（plan.mjs:360 给每个后台 task 挂了 abortController，
 * bg-tasks.killBackgroundTask 会 abort 它），只是没有工具暴露出来。
 */
export class AgentStopTool extends Tool {
  constructor() {
    super({
      name: 'AgentStop',
      description: '中止一个正在后台运行的子 Agent（按 task_id）。用于：发现派错了方向、需求变了、或它明显跑偏在浪费时间——不用干等它跑完。中止后它占的并发名额立刻释放。\n注意：如果创建时给了 agent_name，中止后仍可用 SendMessage(to:该名字, wake:true) 唤醒它带着已有上下文重新来一遍。\n这个工具只管子 Agent；Bash 后台任务用 KillShell。',
      input_schema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '要中止的后台子 Agent task_id（从 Agent 工具返回值或 AgentStatus 获取）' },
          reason: { type: 'string', description: '可选：为什么中止，会记进任务状态方便回溯' },
        },
        required: ['task_id'],
      },
    })
  }

  validateInput(input = {}) {
    if (!String(input.task_id || '').trim()) {
      return { valid: false, errors: ['task_id 不能为空'] }
    }
    return { valid: true }
  }

  async execute(input = {}) {
    const id = String(input.task_id).trim()
    const task = getBackgroundTaskStatus(id)
    if (!task) return `未找到后台任务: ${id}\n用 AgentStatus 查看当前有哪些子 Agent。`
    if (task.type !== 'local_agent') {
      return `${id} 不是子 Agent（type=${task.type}）。Bash 后台任务请用 KillShell。`
    }
    // 已是终态就别再 kill，直接告诉调用方实情，避免它以为自己救了一命
    if (task.status !== 'running' && task.status !== 'pending') {
      return `${id} 已经是终态（${task.status}），无需中止。\n最终结果:\n${task.result_preview || '(无)'}`
    }
    const ok = killBackgroundTask(id, input.reason || 'AgentStop by model')
    if (!ok) return `中止 ${id} 失败：它可能刚好已经结束。用 AgentStatus 复查。`
    return `已中止子 Agent ${id}（${task.description || '无描述'}），并发名额已释放。`
      + (input.reason ? `\n原因: ${input.reason}` : '')
  }
}
