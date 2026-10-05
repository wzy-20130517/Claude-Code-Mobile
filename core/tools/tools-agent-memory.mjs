// AgentMemory 工具：让子 Agent 把经验写进长期记忆、跨会话复用。
import { Tool } from './tools.mjs'
import { writeMemory, readMemory, listMemories, clearMemory } from '../agent/agent-memory.mjs'

export class AgentMemoryTool extends Tool {
  constructor({ getAgentType = null, cwd = null } = {}) {
    super({
      name: 'AgentMemory',
      description: `读写你自己这一类 Agent 的长期记忆（跨会话保留）。
【什么时候写】你解决了一个绕了很久的问题、发现某个模块的隐藏契约、踩了一个下次还会踩的坑、或摸清了项目某处的约定 —— 写下来，下次同类 Agent 就不用重新踩。
【什么时候读】开工前先 read 一次，看看以前的自己留了什么。
【别写什么】一次性的琐碎操作、显而易见的常识、这次任务特有的细节。记忆是给"未来的同类"看的，不是工作日志。
作用域：project（默认，跟着仓库走）· user（跨项目的个人经验）· local（本机私有，不进版本控制）。`,
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'write', 'list', 'clear'], description: 'read=读取记忆；write=追加一条；list=列出所有有记忆的 Agent 类型；clear=清空（需指定 scope）' },
          text: { type: 'string', description: 'write 时必填：要记住的内容。写清「根因」和「为什么会踩」，别只写"修了X"' },
          type: { type: 'string', description: '可选：Agent 类型（默认用你自己的类型）。想读别类 Agent 的经验时才填' },
          scope: { type: 'string', enum: ['project', 'user', 'local'], description: '可选：作用域，默认 project' },
        },
        required: ['action'],
      },
      maxResultSizeChars: 12000,
    })
    this.getAgentType = getAgentType
    this.cwd = cwd
  }

  // 返回框杂约定的 { valid, errors }。
  // （旧实现返回字符串/null，与 tools.mjs run() 里的 v.valid 访问不兼容，
  //   导致本工具读写双向全挂。基类现已加归一化兼容，此处同步到标准风格。）
  validateInput(input = {}) {
    const a = input.action
    if (!['read', 'write', 'list', 'clear'].includes(a)) {
      return { valid: false, errors: ['action 必须是 read/write/list/clear'] }
    }
    if (a === 'write' && !String(input.text || '').trim()) {
      return { valid: false, errors: ['write 需要 text'] }
    }
    if (a === 'clear' && !input.scope) {
      return { valid: false, errors: ['clear 必须显式指定 scope，避免误删'] }
    }
    return { valid: true }
  }

  _type(input) {
    return input.type || (this.getAgentType?.() ?? 'general')
  }

  async execute(input = {}) {
    const cwd = this.cwd || process.cwd()
    const type = this._type(input)

    if (input.action === 'list') {
      const all = listMemories({ cwd })
      if (!all.length) return '暂无任何 Agent 记忆。用 AgentMemory({action:"write", text:"..."}) 开始积累。'
      return `有记忆的 Agent 类型（${all.length}）:\n` + all.map(m =>
        `  ${m.type} [${m.scope}] ${(m.size / 1024).toFixed(1)}KB`
      ).join('\n')
    }

    if (input.action === 'write') {
      const r = writeMemory({
        type, text: input.text,
        scope: input.scope || 'project',
        cwd, by: this.getAgentType?.() || null,
      })
      if (!r.ok) return `写入失败: ${r.reason}`
      return `已记入 [${type}] 的 ${r.scope} 记忆。下次同类 Agent 开工时能读到。`
    }

    if (input.action === 'clear') {
      const r = clearMemory({ type, scope: input.scope, cwd })
      return r.ok ? `已清空 [${type}] 的 ${input.scope} 记忆` : `清空失败: ${r.reason}`
    }

    const mem = readMemory({ type, cwd })
    if (!mem) return `[${type}] 还没有任何记忆。这是你这类 Agent 第一次跑，做完记得 write 一条。`
    return `【${type} 的长期记忆】\n\n${mem}`
  }
}
