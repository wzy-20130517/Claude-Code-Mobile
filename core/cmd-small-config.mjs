// 小型配置命令批（handleCommand 拆分第十批）
//
// /voice      正文语音朗读开关与音色
// /statusline 自定义底部状态行
// /mail       邮箱账号管理（多账号表）
//
// 这三个共同点：依赖少、纯配置读写、没有跟渲染状态耦合。
// 相比之下 /image 拆不动 —— 它会发起一次 agent.run，牵扯 20+ 个渲染状态变量
// （mdRenderer / streamingActive / thinkStatus / abortController …），
// 拆出去 ctx 会比原代码还长，那是负收益。

/**
 * @param {object} ctx
 *   C, ctx.config, saveConfig
 *   getVoice / isVoiceEnabled / setVoice / setVoiceEnabled / setVoiceRate / stopVoice
 *   voiceStatus                  () => { enabled, name, rate, available[] }
 *   runStatusLineCommand         跑状态行命令
 *   statusLinePayload            () => 喂给状态行命令的 JSON
 *   runWizard, isNonInteractive  交互层
 *   rl / fsSession               () => 交互层实例
 *   updateFsStatus               刷新底部状态行显示
 */
export function makeSmallConfigCommands(ctx) {
  return {
    voice(args) {
        const sub = (args[0] || '').toLowerCase()
        const st = ctx.voiceStatus()
        if (!sub || sub === 'status') {
          return `语音朗读: ${st.enabled ? '开启' : '关闭'}\n`
            + `音色: ${st.voice}（${st.full}）\n`
            + `语速: ${st.rate}\n`
            + (st.enabled ? `队列: ${st.queued} 句${st.playing ? '，正在播放' : ''}\n` : '')
            + `\n可用音色: ${st.available.join(' / ')}\n`
            + `用法: /voice on|off · /voice <音色> · /voice rate <+10%> · /voice stop`
        }
        if (sub === 'on' || sub === 'off') {
          const on = sub === 'on'
          ctx.setVoiceEnabled(on)
          ctx.config.voice = { ...(ctx.config.voice || {}), enabled: on, name: ctx.getVoice() }
          ctx.saveConfig(ctx.config)
          return on
            ? `语音朗读已开启（音色 ${ctx.getVoice()}）。我说的正文会念出来，工具调用不念。`
            : '语音朗读已关闭。'
        }
        if (sub === 'stop') {
          ctx.stopVoice()
          return '已停止当前朗读（开关未变）。'
        }
        if (sub === 'rate') {
          const r = ctx.setVoiceRate(args[1])
          if (!r.ok) return `${r.error}\n用法: /voice rate +10%（范围 -100% ~ +100%）`
          ctx.config.voice = { ...(ctx.config.voice || {}), enabled: ctx.isVoiceEnabled(), name: ctx.getVoice(), rate: r.rate }
          ctx.saveConfig(ctx.config)
          return `语速已设为 ${r.rate}`
        }
        // 其余当成音色名
        const r = ctx.setVoice(sub)
        if (!r.ok) return `${r.error}\n可用音色: ${(r.available || []).join(' / ')}`
        ctx.config.voice = { ...(ctx.config.voice || {}), enabled: ctx.isVoiceEnabled(), name: r.voice }
        ctx.saveConfig(ctx.config)
        return `音色已切换为 ${r.voice}（${r.full}）${ctx.isVoiceEnabled() ? '' : '\n提示: 朗读当前是关闭状态，用 /voice on 打开'}`
    },

    async statusline(args) {
        const sub = String(args[0] || '').toLowerCase()
        if (!sub || sub === 'show') {
          const cur = ctx.config.statusLine?.command
          return `自定义状态行: ${cur ? `已设置\n  ${cur}` : '未设置（用内置的上下文+模型）'}

/statusline set <命令>   设置（stdin 收到 JSON 上下文，stdout 第一段作为状态行）
/statusline test         用当前上下文试跑一次
/statusline off          关掉，回到内置状态行

例：
  /statusline set echo "$(date +%H:%M) · 手机端"
  /statusline set cat | sed -n 's/.*"display_name":"\\([^"]*\\)".*/\\1/p'

注意：超时 2 秒、失败或空输出自动回退内置状态行，不会卡住界面。`
        }
        if (sub === 'off' || sub === 'unset' || sub === 'clear') {
          ctx.config.statusLine = null
          ctx.saveConfig(ctx.config)
          ctx.updateFsStatus()
          return '已关闭自定义状态行'
        }
        if (sub === 'set') {
          const command = args.slice(1).join(' ').trim()
          if (!command) return '用法: /statusline set <命令>'
          ctx.config.statusLine = { type: 'command', command }
          ctx.saveConfig(ctx.config)
          const out = await ctx.runStatusLineCommand(command, ctx.statusLinePayload())
          ctx.updateFsStatus()
          return out
            ? `已设置自定义状态行\n试跑结果: ${out.split('\n')[0]}`
            : `已设置，但试跑没有输出（会回退到内置状态行）\n命令: ${command}`
        }
        if (sub === 'test') {
          const command = ctx.config.statusLine?.command
          if (!command) return '还没有设置自定义状态行'
          const out = await ctx.runStatusLineCommand(command, ctx.statusLinePayload())
          return out ? `输出:\n${out}` : '没有输出（会回退到内置状态行）'
        }
        return `不认识的子命令: ${sub}\n可用: show / set / test / off`
    },

    async mail(args) {
        const M = await import('./mail-mcp-config.mjs')
        const sub = String(args[0] || 'status').toLowerCase()

        if (!sub || sub === 'status' || sub === 'list') return M.mailStatus()

        if (sub === 'add') {
          // 一行式：/mail add <别名> <邮箱> <授权码> [imap主机] [端口]
          // 参数够多但顺序直观（别名在前），非交互环境（Agent/QQ）只能用这个
          if (args.length >= 4) {
            return M.mailAdd({
              alias: args[1], user: args[2], pass: args[3],
              host: args[4], port: args[5],
            })
          }
          if (ctx.isNonInteractive()) {
            return '非交互环境请用一行式：/mail add <别名> <邮箱> <授权码> [imap主机] [端口]\n'
              + '例: /mail add 小号 test@qq.com abcdefghijklmnop'
          }
          const a = await ctx.runWizard({ rl: ctx.rl(), fsSession: ctx.fsSession(), C: ctx.C,  title: '添加邮箱账号',
            steps: [
              { key: 'alias', label: '别名', hint: '如 小号 / work', desc: '留空则用邮箱 @ 前的部分' },
              { key: 'user', label: '邮箱地址', required: true, hint: 'you@qq.com' },
              { key: 'pass', label: '授权码', required: true, secret: true,
                desc: 'QQ邮箱在「设置→账户→生成授权码」，不是登录密码' },
              { key: 'host', label: 'IMAP 主机', default: 'imap.qq.com', hint: 'imap.qq.com' },
              { key: 'port', label: 'IMAP 端口', default: '993',
                validate: v => /^\d+$/.test(v) ? null : '端口必须是数字' },
              { key: 'note', label: '备注', hint: '可留空，如「接码专用」' },
            ],
          })
          if (!a) return '已取消'
          return M.mailAdd(a)
        }

        if (sub === 'rm' || sub === 'remove' || sub === 'del') return M.mailRemove(args[1])
        if (sub === 'default') return M.mailSetDefault(args[1])

        // 单字段修改：/mail pass [别名] <值>。只有一个账号时别名可省。
        const FIELD_ALIAS = { imap: 'host', smtp: 'smtpHost', 'smtp-port': 'smtpPort' }
        const field = FIELD_ALIAS[sub] || sub
        if (['pass', 'user', 'host', 'port', 'smtpHost', 'smtpPort', 'note'].includes(field)) {
          // 两种写法都支持：/mail pass <值>（单账号）和 /mail pass <别名> <值>
          const hasAlias = args.length >= 3
          return M.mailUpdate(field, hasAlias ? args[1] : '', hasAlias ? args[2] : args[1])
        }

        if (sub === 'test') {
          // 连通性测试：直接起一次 MCP 请求太重，这里只查配置完整性
          return M.mailStatus() + '\n\n（想测真实收发：让我调 mcp_mail-qq_list_messages 或 send_mail）'
        }

        return `用法:\n`
          + `  /mail                     看所有账号（授权码打码）\n`
          + `  /mail add                 向导添加账号\n`
          + `  /mail add <别名> <邮箱> <授权码> [imap主机] [端口]   一行式\n`
          + `  /mail rm <别名>           删除账号\n`
          + `  /mail default <别名>      设默认账号\n`
          + `  /mail pass [别名] <授权码>  改授权码（单账号时别名可省）\n`
          + `  /mail user|host|port|smtp|smtp-port|note [别名] <值>\n`
          + `账号表: ~/.claude-code-mobile/mail-accounts.json（600 权限）\n`
          + `改完按 Ctrl+X 重启，MCP 才会重新读取。`
    },
  }
}
