// 权限命令 /permissions（handleCommand 拆分第十六批）
//
// 三条路径：
//   /permissions mode [模式]     改权限模式（无参走 select，四个模式名又长又易拼错）
//   /permissions reload-commands 重载 .claude/commands 与 .claude/agents
//   /permissions [其他]          转给 cmdPermissions（allow/deny/ask 规则管理）
//
// 【为什么能拆】它写的是 `agent.systemPrompt = ...`（对象属性），不是外层 let。
// 改模式后必须重建系统提示词 —— 提示词里写着当前权限模式，不重建模型就不知道自己
// 现在能不能调装饰性工具。三条路径里有两条都要重建，漏一处就会出现
// 「模式已改但模型仍按旧模式行事」。

/**
 * @param {object} ctx
 *   agent                    Agent 实例（getter；要给 systemPrompt 赋值）
 *   permManager              权限管理器
 *   cmdPermissions           规则管理（allow/deny/ask）
 *   customCommands / customAgents   .claude/ 下的自定义命令与 agent
 *   getCurrentSystemPrompt   重建系统提示词
 *   runSelect                交互选择
 *   rl / fsSession           () => 交互层实例
 */
export function makePermissionsCommand(ctx) {
  return {
    async permissions(args) {
        // 扩展：/permissions mode <default|acceptEdits|plan|bypassPermissions>
        if (args[0] === 'mode') {
          if (!args[1]) {
            // 无参数 → select 选模式，四个模式名又长又容易拼错
            const cur = ctx.permManager.getMode()
            const picked = await ctx.runSelect({
              rl: ctx.rl(), fsSession: ctx.fsSession(), title: '权限模式',
              items: [
                { value: 'default', label: 'default', hint: `装饰性工具硬拒绝${cur === 'default' ? '  ← 当前' : ''}` },
                { value: 'acceptEdits', label: 'acceptEdits', hint: `写文件自动放行${cur === 'acceptEdits' ? '  ← 当前' : ''}` },
                { value: 'plan', label: 'plan', hint: `只放行只读工具${cur === 'plan' ? '  ← 当前' : ''}` },
                { value: 'bypassPermissions', label: 'bypassPermissions', hint: `全放行${cur === 'bypassPermissions' ? '  ← 当前' : ''}` },
              ],
              initial: ['default', 'acceptEdits', 'plan', 'bypassPermissions'].indexOf(cur),
            })
            if (picked == null) return '已取消'
            const m = ctx.permManager.setMode(picked)
            ctx.agent.systemPrompt = ctx.getCurrentSystemPrompt()
            return m
          }
          const msg = ctx.permManager.setMode(args[1])
          ctx.agent.systemPrompt = ctx.getCurrentSystemPrompt()
          return msg
        }
        if (args[0] === 'reload-commands') {
          ctx.customCommands.reload()
          ctx.customAgents.reload()
          ctx.agent.systemPrompt = ctx.getCurrentSystemPrompt()
          return `已重载: commands=${ctx.customCommands.list().length} agents=${ctx.customAgents.list().length}`
        }
        return ctx.cmdPermissions(args) + `\n\n当前模式: ${ctx.permManager.getMode()}\n  /permissions mode <default|acceptEdits|plan|bypassPermissions>`
    },
  }
}
