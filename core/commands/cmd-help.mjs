// 帮助命令 /help（handleCommand 拆分第十七批 · 最后一个大块）
//
// 分层帮助：无参给弹层（Pane + Tab 切页 + 滚动 + Esc），带主题给纯文本。
// 原来一次泼 180 行 / 110 条命令，常用命令埋在里面找不到。
//
// 【两个已踩过的坑，改这里前先看】
// 1. overlay 的每页要的是**行数组**，不是整段字符串 —— 传字符串会被当可迭代对象
//    逐字符渲染，屏幕上每个字占一行（2026-09-13 踩过）。所以有 toLines()。
// 2. 非交互环境（QQ 私聊 / Agent 调用）没键盘按不了弹层，必须回纯文本。
//    不能让 openOverlay 抛 NonInteractiveError —— /help 的本职是「给内容」，
//    回一句「请改用带参写法」等于没帮上忙。
//
// 【自动对账】HELP_TOPICS 是手写的，之前 /name 出现过「命令能用但帮助里没有」。
// 这里拿 slashCommands（真实注册表）跟帮助正文比对，把漏的列出来 ——
// 既提示用户还有这些命令，也提醒维护者补文档。

import { HELP_TOPICS, HELP_TOPIC_ALIASES } from './help-topics.mjs'

/**
 * @param {object} ctx
 *   C, CLI_VERSION
 *   HIDDEN_COMMANDS      不进帮助的命令集合（当前为空）
 *   skillCommandNames    () => skill 名数组（832 个 skill 不该出现在兜底清单里）
 *   slashCommands        真实注册表（用于对账）
 *   openOverlay          分页弹层
 *   isNonInteractive     () => 是否非交互（QQ / Agent）
 *   incognitoMode        () => 是否隐身
 *   rl / fsSession       () => 交互层实例
 */
export function makeHelpCommand(ctx) {
  return {
    async help(args) {
        // 分层帮助：默认只给「每天真的会用」的十几条，细节按主题展开。
        // 原来一次泼 180 行 / 110 条命令，/ctx.config 分散出现 4 次、/image 重复两遍，
        // 常用命令埋在里面根本找不到 —— 用户反馈「太乱了，没几个人看了会用」。
        const topic = String(args[0] || '').toLowerCase()
        // skill 名单：832 个 skill 也是 slash 命令，但不该出现在
        // 「未分类命令」兜底清单里（那会把帮助刷成一屏 skill 名）。
        // 想看 skill 用 /skills，那是专门的浏览入口。
        const skillNameSet2 = new Set(ctx.skillCommandNames())

        // 【无参 = 分页弹层】对齐官方 HelpV2：Pane 框 + Tab 切页 + 滚动 + Esc 关。
        // 带主题参数时仍回纯文本（AI 可引用、管道可用）。
        if (!topic && ctx.fsSession() && !ctx.incognitoMode()) {
          // ⚠ overlay 的每一页要的是【行数组】，不是整段字符串。
          //   直接传字符串的话它会被当成可迭代对象逐字符渲染 ——
          //   屏幕上就是每个字占一行、「还有 1728 行」（2026-09-13 踩过）。
          const toLines = (s) => String(s || '').split('\n')
          const tabDefs = {
            常用: null,
            模型: toLines(HELP_TOPICS.model),
            上下文: toLines(HELP_TOPICS.context),
            会话: toLines(HELP_TOPICS.session),
            工具: toLines(HELP_TOPICS.tools),
            界面: toLines(HELP_TOPICS.ui),
            扩展: toLines(HELP_TOPICS.ext),
            全部: null,
          }
          const quickLines = [
            '直接输入消息即可对话。行末加 \\ 换行，Ctrl+I 补全，Ctrl+X 重启。',
            '',
            '日常最常用',
            '  /model <名称>     换模型        /ctx.config        切 Provider',
            '  /context          看上下文占用   /compact       压缩上下文',
            '  /clear            清空记录（可 /clear-restore 恢复）   /new  开新对话',
            '  /resume [id]      恢复会话      /undo          撤销文件改动',
            '  /diff             看 git 改动    /status        一屏状态汇总',
            '  /image [路径|序号] 识图（无参=最新截图，/image list 挑图）',
            '  /imagegen          生图配置（画图用，直接说「画一张…」即可）',
            '  /keys             快捷键速查    /doctor        诊断问题',
            '  /btw <问题>        顺嘴问一句（看得到对话，不占后续上下文）',
            '',
            // 键位提示要跟 overlay 的 nav 行一致：Termux 没有 Tab/Esc 键，
            // 弹层实际用 ←→ 切页（见 core/overlay.mjs 的历史教训注释）
            '按主题看：←→ 切页；/help <主题> 出纯文本版',
          ]
          const allLines = () => {
            const body = Object.values(HELP_TOPICS).join('\n').split('\n')
            let missing = []
            try {
              const documented = Object.values(HELP_TOPICS).join('\n') + '\n' + Object.keys(HELP_TOPICS).join(' ')
              missing = ctx.slashCommands
                .filter(c => typeof c === 'string')
                // 隐藏命令不进「未分类」清单 —— 否则从主题里删掉反而
                // 让它出现在这份兜底列表里，等于没隐藏
                .filter(c => !ctx.HIDDEN_COMMANDS.has(c))
                .filter(c => !skillNameSet2.has(c))
                .filter(c => !new RegExp(`/${c}\\b`).test(documented))
                .sort()
            } catch {}
            return missing.length
              ? body.concat(['', '未分类命令（已注册，主题里没细说）', '  ' + missing.map(c => '/' + c).join('  ')])
              : body
          }
          tabDefs['常用'] = quickLines
          tabDefs['全部'] = allLines
          // 非交互环境（QQ 私聊 / Agent 调用）：没有键盘按不了弹层，直接给纯文本。
          // 不能让 ctx.openOverlay 抛 NonInteractiveError —— /help 的本职是「给内容」，
          // 回一句「请改用带参写法」等于没帮上忙。
          if (ctx.isNonInteractive()) {
            // ⚠ quickLines 是**数组**（上面 59 行定义），不是函数。
            //   原代码写成 quickLines() → 非交互环境（QQ 私聊 / Agent 调用）
            //   执行 /help 必然 TypeError。拆分时实测才发现（2026-09-13）。
            const plain = quickLines
              .map((l) => String(l).replace(/\x1b\[[0-9;]*m/g, ''))
              .join('\n')
            return `Claude Code Mobile v${ctx.CLI_VERSION} 帮助\n${plain}\n\n分主题细看：/help model | context | session | tools | ui | ext\n全部命令：/help all`
          }
          await ctx.openOverlay({
            rl: ctx.rl(), fsSession: ctx.fsSession(), C: ctx.C, title: `Claude Code Mobile v${ctx.CLI_VERSION} 帮助`,
            tabs: tabDefs, visibleRows: 16,
          })
          return ''
        }
        if (topic && HELP_TOPICS[topic]) return HELP_TOPICS[topic]
        // 【为什么要命令名 → 主题的别名】
        // 用户不知道主题名叫什么，卡住时敲的是「/help goal」「/help key」——
        // 手里正在用的那个命令名。原来一律回「没有这个主题」，等于把「不知道怎么用」
        // 变成「连帮助都找不到」。主题名是我们的内部分类，不该要求用户先猜对。
        if (topic && HELP_TOPIC_ALIASES[topic]) {
          const t = HELP_TOPIC_ALIASES[topic]
          // 明说落到了哪个主题，否则用户以为 /help goal 有专门一页
          return `${ctx.C.dim}/${topic} 收在「${t}」主题里${ctx.C.reset}\n\n${HELP_TOPICS[t]}`
        }
        if (topic && topic !== 'all') {
          return `没有「${topic}」这个主题。可用：model / context / session / tools / ui / ext\n或 /help all 看全部命令`
        }
        if (topic === 'all') {
          const body = Object.values(HELP_TOPICS).join('\n\n')
          // 【为什么要自动对账】
          // 官方 HelpV2 用 builtInCommandNames() 从注册表枚举命令，帮助永远不会漏。
          // 我们的 HELP_TOPICS 是手写的，之前 /name 就出现过「命令能用但帮助里没有」。
          // 这里拿 ctx.slashCommands（真实注册表）和帮助正文比对，把漏掉的列出来，
          // 既提示用户还有这些命令，也提醒维护者补文档。
          let missing = []
          try {
            const documented = body + '\n' + Object.keys(HELP_TOPICS).join(' ')
            missing = ctx.slashCommands
              .filter(c => typeof c === 'string')
              .filter(c => !ctx.HIDDEN_COMMANDS.has(c))
              .filter(c => !skillNameSet2.has(c))
              .filter(c => !new RegExp(`/${c}\\b`).test(documented))
              .sort()
          } catch {}
          const tail = missing.length
            ? `\n\n未分类命令（已注册，主题里没细说）\n  ${missing.map(c => '/' + c).join('  ')}`
            : ''
          return body + tail +
            '\n\n提示：单独看某类用 /help <主题>，主题名见上面各段标题'
        }

        return `Claude Code Mobile v${ctx.CLI_VERSION} — 常用速查
━━━━━━━━━━━━━━━━━━━━━━━━
直接输入消息即可对话。行末加 \\ 换行，Ctrl+I 补全，Ctrl+X 重启。

日常最常用
  /model <名称>     换模型        /ctx.config        切 Provider
  /context          看上下文占用   /compact       压缩上下文
  /clear            清空记录（可 /clear-restore 恢复）   /new  开新对话
  /resume [id]      恢复会话      /undo          撤销文件改动
  /diff             看 git 改动    /status        一屏状态汇总
  /image [路径|序号] 识图（无参=最新截图，/image list 挑图）
  /imagegen          生图配置（画图用，直接说「画一张…」即可）
  /keys             快捷键速查    /doctor        诊断问题
  /update           检查并更新版本（镜像下载，不覆盖数据）
  /btw <问题>        顺嘴问一句（看得到对话，不占后续上下文）

按主题展开
  /help model     模型 · Provider · 思考强度 · 温度
  /help context   上下文 · 压缩 · 记忆
  /help session   会话 · 撤销 · 回收站 · 导出
  /help tools     诊断 · 权限 · 工具 · skills（含 goal/watch/deep）
  /help ui        输入技巧 · 快捷键 · 界面 · 字体
  /help ext       QQ 桥 · Web · MCP · 自定义命令
  /help all       全部命令

/exit  /quit  或空行 Ctrl+C 退出`
    },
  }
}
