// 定时任务工具（仿官方 ScheduleCronTool）：CronCreate / CronList / CronDelete
import { Tool } from './tools.mjs'
import { addCronTask, deleteCronTask, listCronTasks, computeNextCronRun, cronToHuman } from './cron.mjs'

export class CronCreateTool extends Tool {
  constructor() {
    super({
      name: 'CronCreate',
      description: '创建一个定时任务：到点自动执行一段 prompt。cron 用标准5字段（分 时 日 月 周），如 "0 9 * * *" 每天9点。recurring=true 循环执行，durable=true 写盘持久（CLI重启后还在；只有用户明确说每天/长期才用，否则默认session级，退出即消失）。一次性任务触发后自动删除。',
      input_schema: {
        type: 'object',
        properties: {
          cron: { type: 'string', description: 'cron表达式，5字段' },
          prompt: { type: 'string', description: '到点要执行的任务描述' },
          recurring: { type: 'boolean', description: '是否循环，默认false（一次性）' },
          durable: { type: 'boolean', description: '是否持久化，默认false（session级）' },
        },
        required: ['cron', 'prompt'],
      },
      isReadOnly: () => false,
      isDestructive: () => false,
      isConcurrencySafe: () => true,
    })
  }
  async execute(input) {
    try {
      const t = addCronTask({ cron: input.cron, prompt: input.prompt, recurring: !!input.recurring, durable: !!input.durable })
      const where = t.durable ? '已持久化（重启后还在）' : 'session级（退出即消失）'
      const kind = t.recurring ? `循环任务，每次触发后重算下次` : `一次性任务，触发后自动删除`
      return `已创建定时任务 ${t.id}（${t.human}）。${where}。${kind}。下次触发：${new Date(t.nextRun).toLocaleString('zh-CN')}。用 CronDelete 取消。`
    } catch (e) {
      return `创建失败：${e.message}`
    }
  }
}

export class CronListTool extends Tool {
  constructor() {
    super({
      name: 'CronList',
      description: '列出所有定时任务（含下次触发时间）。',
      input_schema: { type: 'object', properties: {} },
      isReadOnly: () => true,
      isDestructive: () => false,
      isConcurrencySafe: () => true,
    })
  }
  async execute() {
    const tasks = listCronTasks()
    if (!tasks.length) return '暂无定时任务'
    const lines = tasks.map(t => {
      const next = computeNextCronRun(t.cron, t.recurring ? (t.lastFiredAt ?? t.createdAt) : t.createdAt)
      return `- ${t.id} [${t.recurring ? '循环' : '一次'}|${t.durable ? '持久' : 'session'}] ${cronToHuman(t.cron)} → 下次 ${next ? new Date(next).toLocaleString('zh-CN') : '无'}\n  ${String(t.prompt).slice(0, 80)}`
    })
    return lines.join('\n')
  }
}

export class CronDeleteTool extends Tool {
  constructor() {
    super({
      name: 'CronDelete',
      description: '删除一个定时任务。',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string', description: '任务ID（CronList里看）' } },
        required: ['id'],
      },
      isReadOnly: () => false,
      isDestructive: () => false,
      isConcurrencySafe: () => true,
    })
  }
  async execute(input) {
    if (!input.id) return '缺少 id：请提供任务ID（CronList里看）'
    const ok = deleteCronTask(String(input.id))
    return ok ? `已删除 ${input.id}` : `找不到任务 ${input.id}`
  }
}
