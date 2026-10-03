// 命令注册表 —— 单一真值源
//
// 【为什么要有这个文件】
// 2026-09-19 用户要求：「不在 web 搞另一套 slash 了，复用 cli。有向导的也复用，在 web 也建向导」。
//
// 背景：命令实现在项目里长期存在**两套**——
//   · CLI：index.mjs 的 handleCommand（1307 行 / 88 case）+ core/cmd-*.mjs 各模块
//   · Web：web/server.mjs 的 executeSlashCommand（531 行 / 30 个手写分支）
// 两套必然漂移，实际已经踩坑：web 漏了 `/config list`（CLI 面板里它排第一），
// 用户敲了得到「Provider 不存在: list」；web 47 个命令 vs CLI 87 个，
// 用户结论是「web 命令完全不能用」。
//
// 【设计】
// 这个文件**不做任何业务逻辑**，只做两件事：
//   1. 汇总所有已拆分的 core/cmd-*.mjs 模块（makeXxxCommands(ctx) → {name: handler}）
//   2. 给出「哪些命令在当前 ctx 下可用」的查询接口
//
// 调用方（CLI 的 handleCommand / web 的 executeSlashCommand）各自组装自己的 ctx，
// 然后查同一张表。业务代码只有一份，两端行为天然一致。
//
// 【边界】
// 只收「纯命令处理器」：签名是 (args) => string | Promise<string>。
// 需要 readline 交互的（向导）、需要写回外层 let 的，由 ctx 提供回调，
// 模块内部照常调用 —— 注册表不关心这些细节。

import { makeQueryCommands, makeSessionCommands } from './cmd-queries.mjs'
import { makeSmallConfigCommands } from './cmd-small-config.mjs'
import { makeIntegrationCommands } from './cmd-integrations.mjs'
import { makeTeamTaskCommands } from './cmd-team-task.mjs'
import { makeMiscCommands } from './cmd-misc.mjs'
import { makeSideCommands } from './cmd-side.mjs'
import { makeCompactCommand } from './cmd-compact.mjs'
import { makeMemCommand } from './cmd-mem.mjs'
import { cmdAgents } from './cmd-agents.mjs'
import { makeImageGenCommand } from './cmd-imagegen.mjs'
import { makePermissionsCommand } from './cmd-permissions.mjs'
import { makeQqCommand } from './cmd-qq.mjs'
// 【已删除 2026-10-03】cmd-backup.mjs —— /backup 功能下线（用户：CLI 成熟了，不需要防源码丢失动备份）
import { makeHelpCommand } from './cmd-help.mjs'
import { runQuickProviderCommand } from './cmd-quick-provider.mjs'
import { makeSessionExtraCommands } from './cmd-session-extra.mjs'
import { makeMarkdownCommand } from './cmd-markdown.mjs'
import { makeStyleCommand } from './cmd-style.mjs'
import { makeDeviceCommand } from './cmd-device.mjs'

/**
 * 命令的「端可用性」标注。
 *
 * 有些命令在 Web 上没有意义或会造成混乱，直接调会得到难以理解的报错
 * （例如 /exit 在 Web 里没有"退出"这个动作）。与其让用户撞上去，
 * 不如显式声明并给出人话提示。
 *
 * 值为 null = 两端都可用；值为字符串 = 该端不可用时的提示语。
 */
// 【2026-09-23 改动】/clear 和 /clear-restore 从名单里移除了。
//
// 原来它们标着「Web 请用侧栏」，理由是 Web 有侧栏 UI 做同样的事。但那带来两个问题：
//   1. 行为不一致 —— 侧栏「新对话」只清屏不存回收站，CLI 的 /clear 会先存一份，
//      用户在 Web 上手滑清空就找不回来了；
//   2. APK 只跑 web/server.mjs，而侧栏是 React 前端的事 —— 后端没有任何恢复入口，
//      真要救只能手动翻 .claude-code-mobile/cleared/ 目录。
//
// 现在 /clear 的实现搬进了 core/cmd-queries.mjs（两端同一份，都会存回收站），
// 所以 Web 也能用，不该再拦。
export const CLI_ONLY = {
  exit: 'Web 没有"退出程序"这个动作。关掉浏览器标签页即可；要停服务用 /web status 查看。',
  quit: 'Web 没有"退出程序"这个动作。关掉浏览器标签页即可。',
  palette: '命令面板是终端特性（Ctrl+I 补全、Ctrl+P 历史）。Web 直接输入 / 就会弹出命令列表。',
  font: '字体设置在终端的 /font；Web 用浏览器自己的缩放。',
  statusline: '状态行是终端底部的界面元素，Web 有自己的布局。',
  editor: 'Web 没有 $EDITOR 概念。',
  copy: 'Web 用系统复制（长按选中或复制按钮）。',
  export: 'Web 在会话右上角有 Export 按钮。',
  screencap: 'Web 端请用输入框左侧「+」菜单里的「截取屏幕」。',
  // /keys 在 CLI 是「快捷键速查表」（Ctrl+I / Ctrl+X 那些）。
  // Web 是浏览器界面，那些键位一个都不适用 —— 直接列出来只会误导。
  keys: '快捷键速查表是终端特性。Web 端：输入 / 弹出命令列表，上下键选择，Esc 关闭；发送/换行键在设置页配置。',
  // 【2026-09-24 加】
  // 【2026-09-24 更新】Web/CCM 现在**也有** QQ 桥了（web/qq-integration.mjs），
  // 所以 /qq 不再无条件拦截。
  //
  // 但要处理一种情况：桥还没启动（或启动失败）时，cmd-qq 里
  // `ctx.qqBridge.getEndpoints()` 会抛 "Cannot read properties of undefined"
  // —— 实测过的崩溃。做法见下面 platform==='web' 的 /qq 特殊包装：
  // 执行时现查桥在不在，不在就给提示语而不是崩。
}

/**
 * 「命令能跑，但改了**不影响 Web**」的字段说明。
 *
 * 【2026-09-20 加，用户要求】
 * 「web 有些命令是需要特殊处理的，因为有些只修改 cli，对 web 无效」。
 *
 * 与 CLI_ONLY 的区别：
 *   · CLI_ONLY   = 这个命令在 Web 上**不该存在**（如 /exit 没有退出动作），直接换提示语
 *   · NO_EFFECT  = 命令本身有意义（读配置、改配置都正常），但它改的是 **CLI 侧行为**，
 *                  Web 端不会因此变化。此时**照常执行**（配置是共用的，用户在 Web 改完，
 *                  回 CLI 就生效），但要在输出末尾**明确说明**，免得用户以为 Web 也该变。
 *
 * 键 = 命令名，值 = 说明文案。
 */
export const WEB_NO_EFFECT = {
  font: '字体只影响终端渲染，Web 用浏览器自己的字号缩放。',
  statusline: '状态行画在终端底部，Web 有自己的布局，不受此项影响。',
  voice: '语音朗读由终端播放，Web 端的朗读开关在设置页。配置已保存，回 CLI 生效。',
  keepalive: '保活针对 Termux 进程，Web 服务有独立保活（/web start 时启动）。配置已保存。',
  markdown: '此项影响**终端里**的 Markdown 配色；Web 的正文由浏览器渲染，配色跟随网页主题。配置已保存，回 CLI 生效。',
  palette: '命令面板是终端特性，Web 直接输入 / 就会弹出命令列表。',
}

/**
 * 给命令输出追加「对 Web 无效」的说明。
 * 调用方（web/server.mjs）在命令执行成功后调用。
 *
 * @returns {string} 原文（若该命令无此说明）或 原文 + 提示
 */
export function appendWebNoEffectNote(name, output) {
  const note = WEB_NO_EFFECT[name]
  if (!note) return output
  return `${output}\n\n${'─'.repeat(24)}\n注：${note}`
}

/**
 * 构建命令表。
 *
 * @param {object} ctx 依赖注入容器。各模块需要的字段见 core/cmd-*.mjs 顶部注释。
 *   缺少某个字段时，**对应的命令会被跳过**而不是整体报错 ——
 *   这样 Web 可以只注入它支持的部分，不必为了跑通而伪造一堆空实现。
 * @param {object} [options]
 * @param {string} [options.platform] 'cli' | 'web'，用于过滤 CLI_ONLY 里的命令
 * @returns {{ table: Map<string, Function>, skipped: Array<{name:string, reason:string}> }}
 */
export function buildCommandTable(ctx, options = {}) {
  const platform = options.platform || 'cli'
  // 【2026-09-20】把 platform 注入 ctx —— 命令模块（如 cmd-queries 的 keys()）
  // 需要据此给不同端的文案：终端键位表（Ctrl+P/N、滑屏翻正文）在浏览器里不成立，
  // 反过来「点发送按钮」「可搜索列表」在终端里也不存在。
  // 用户反馈：「web 中部分帮助文本是 CLI 的，比如 ↑↓ 这样的快捷键」。
  // 只在 ctx 没显式设过时注入，不覆盖调用方给的值。
  if (ctx && typeof ctx === 'object' && ctx.platform === undefined) {
    try { ctx.platform = platform } catch {}
  }
  const table = new Map()
  const skipped = []

  /**
   * 把一个 makeXxxCommands 的结果合并进表。
   *
   * 关键设计：**单个模块构造失败不影响其它模块**。
   * 这些模块在构造期不会碰 ctx（只把引用存进闭包），真正取字段是在 handler 被调用时。
   * 所以这里的 try/catch 主要防的是「模块自身有语法/初始化 bug」，
   * 那种情况应该让其它命令照常可用，而不是整个 CLI 起不来。
   */
  const merge = (label, build) => {
    try {
      const commands = build()
      if (!commands || typeof commands !== 'object') {
        skipped.push({ name: label, reason: '模块返回空' })
        return
      }
      for (const [name, handler] of Object.entries(commands)) {
        if (typeof handler !== 'function') continue
        if (table.has(name)) {
          // 重名说明两个模块都想管同一个命令 —— 静默后者会很难查，记下来
          skipped.push({ name, reason: `与 ${label} 之前的定义重名，已跳过` })
          continue
        }
        table.set(name, handler)
      }
    } catch (error) {
      skipped.push({ name: label, reason: error?.message || String(error) })
    }
  }

  // ── 各模块 ──
  // 顺序有意义：先注册的优先，重名的后来者被跳过并记进 skipped。
  merge('cmd-queries', () => makeQueryCommands(ctx))
  merge('cmd-session', () => makeSessionCommands(ctx))
  merge('cmd-small-config', () => makeSmallConfigCommands(ctx))
  merge('cmd-integrations', () => makeIntegrationCommands(ctx))
  merge('cmd-team-task', () => makeTeamTaskCommands(ctx))
  merge('cmd-misc', () => makeMiscCommands(ctx))
  merge('cmd-side', () => makeSideCommands(ctx))
  merge('cmd-compact', () => makeCompactCommand(ctx))
  merge('cmd-mem', () => makeMemCommand(ctx))
  // cmd-agents 不是工厂形式，是 cmdAgents(argStr, ctx) —— 包一层适配成统一签名
  merge('cmd-agents', () => ({ agents: (args) => cmdAgents(Array.isArray(args) ? args.join(' ') : String(args || ''), ctx) }))
  merge('cmd-imagegen', () => makeImageGenCommand(ctx))
  merge('cmd-permissions', () => makePermissionsCommand(ctx))
  merge('cmd-qq', () => makeQqCommand(ctx))
  merge('cmd-help', () => makeHelpCommand(ctx))

  // /markdown —— 渲染样式切换（经典 / 官方）
  merge('cmd-markdown', () => makeMarkdownCommand(ctx))

  // /style —— 输出风格（影响回复方式）
  merge('cmd-style', () => makeStyleCommand(ctx))
  merge('cmd-session-extra', () => makeSessionExtraCommands(ctx))

  // /device —— 设备 shell 通道（Shizuku / adb）
  merge('cmd-device', () => makeDeviceCommand(ctx))

  // ── 统一快捷命令（/model /url /name /key）──
  // 这四个共享一段 135 行的逻辑（解析 providerId → 区分 set/pool/clear/直接赋值），
  // 抽成 runQuickProviderCommand 后两端共用，语法天然一致。
  for (const kind of ['model', 'url', 'name', 'key']) {
    if (table.has(kind)) continue
    table.set(kind, (args) => runQuickProviderCommand(kind, args, ctx))
  }

  // ── 平台过滤 ──
  // 不删条目（调用方可能想知道"这个命令存在但不可用"），
  // 而是包一层返回提示语。这样 Web 端敲 /exit 得到的是解释而不是 404 式的沉默。
  if (platform === 'web') {
    for (const [name, message] of Object.entries(CLI_ONLY)) {
      if (!table.has(name)) continue
      table.set(name, async () => message)
    }

    // /qq 特殊处理：Web 侧的桥是异步启动的（server.listen 之后），
    // 建表时可能还没有 —— 所以不能在建表时决定拦不拦。
    // 包一层：**执行时**现查 ctx.qqBridge。
    //   · 有桥 → 走 CLI 的真实实现（正常工作）
    //   · 没桥 → 给提示语，而不是崩
    if (table.has('qq')) {
      const realQq = table.get('qq')
      // ⚠️ 不能「没桥就一律返回提示」—— 那会把 /qq on 也挡掉，
      // 变成死循环：「请用 /qq on 开启」→ 敲 /qq on → 「请用 /qq on 开启」。
      // 实测踩过（2026-09-24）。
      //
      // 正确做法：按子命令区分。
      //   · on/setup → 允许在无桥时执行（它们本来就是来创建/配置桥的）
      //   · 其他      → 需要桥存在，否则给提示
      // 需要「桥实例」才能执行的子命令。其余（无参 / status / help）
      // 只读配置，桥没起也该能看状态 —— 否则用户想查「为什么没消息」
      // 得到的是「请先 /qq on」，而他想知道的是当前配置长什么样。
      const NEEDS_BRIDGE = new Set(['queue', 'send', 'recall', 'clear', 'interrupt', 'open'])
      table.set('qq', async (args) => {
        const sub = String(args?.[0] || '').toLowerCase()
        if (!NEEDS_BRIDGE.has(sub)) return realQq(args)
        let bridge = null
        try { bridge = typeof ctx.qqBridge === 'function' ? ctx.qqBridge() : ctx.qqBridge } catch {}
        if (!bridge) return 'QQ 桥未启动。用 `/qq on` 开启（需要 NapCat 在运行）。'
        return realQq(args)
      })
    }
  }

  return { table, skipped }
}

/**
 * 命令表里所有命令名（排序后）。给补全面板 / 帮助文案用。
 */
export function commandNames(table) {
  return [...table.keys()].sort()
}

/**
 * 端可用性查询：某个命令在指定平台能不能用。
 * 返回 null 表示可用，否则返回给用户的提示语。
 */
export function platformUnavailableReason(name, platform) {
  if (platform !== 'web') return null
  return CLI_ONLY[name] || null
}
