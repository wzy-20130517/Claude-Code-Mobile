// 杂项命令批（handleCommand 拆分第十三批）
//
// /keepalive      息屏保活（wake-lock + 静音音频 + 电池白名单检查）
// /compact-trash  压缩回收站（压缩前的完整会话快照）
// /skills         skill 浏览
// /font           字体查看与恢复默认
// /context        上下文占用与上限
//
// 【转换方法】用第 12 批总结出的可靠顺序：
//   1. 先把「纯简写属性行」展开成 key: value
//   2. 再替换标识符，且跳过 key 位置（`name:` 后面才是 value）
// 直接替换会生成 `{ ctx.config, ctx.api }` 这类非法语法 —— 前面踩了 6 次。

import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
// TRASH_DIR 是常量，直接 import 不走 ctx。
// （⚠ 预检抓到过：语法检查和单元测试都放过了纯值引用的漏改，
//   只有重启预检的「运行期未声明标识符」检查能发现。）
import { TRASH_DIR } from './compact-trash.mjs'
import { FONT_CHOICES, FONT_ALIASES, installFont } from './font-choice.mjs'

/**
 * @param {object} ctx
 *   C, config, saveConfig
 *   acquireMainWakeLock / checkBatteryWhitelist   保活
 *   listCompactTrash / readCompactTrash / restoreCompactTrash / deleteCompactTrash
 *   agent, saveSession
 *   skillLoader
 *   readTtfFullName
 *   cmdContext / getMaxContext / setMaxContext / updateFsStatus
 */
export function makeMiscCommands(ctx) {
  return {
    async keepalive(args) {
        const audioScript = join(process.cwd(), 'core', 'audio-keepalive.sh')
        const sub = String(args[0] || '').toLowerCase()
        // /keepalive auto on|off — 持久化自动保活：每次 CLI 启动/重启自动拉起静音音频
        // on/off 仍只控制当前这一次，避免用户临时关音频时顺手把自动策略也改掉。
        if (sub === 'auto') {
          const value = String(args[1] || '').toLowerCase()
          if (value === 'on') {
            ctx.config.keepaliveAuto = true
            ctx.saveConfig(ctx.config)
            return '自动保活已开启 ✓\n今后每次程序启动（含 Ctrl+X 重启）都会自动播放静音音频。\n立即启动请用 /keepalive on；关闭自动启动：/keepalive auto off'
          }
          if (value === 'off') {
            ctx.config.keepaliveAuto = false
            ctx.saveConfig(ctx.config)
            return '自动保活已关闭 ✓\n当前已在播放的静音音频不会被停止；要立刻停用请执行 /keepalive off'
          }
          return `自动保活: ${ctx.config.keepaliveAuto !== false ? '开启 ✓（默认）' : '关闭'}\n  /keepalive auto on   每次启动时自动开启静音音频\n  /keepalive auto off  关闭启动自动保活`
        }
        // /keepalive on  — 开启静音音频保活（息屏不断流，费电）
        if (args[0] === 'on') {
          try {
            execFileSync('bash', [audioScript, 'start'], { timeout: 10000, stdio: 'ignore' })
            return '静音音频保活已开启 ✓ 息屏时网络不断、CPU 不冻\n用完请 /keepalive off 关闭（省电）'
          } catch { return '开启失败：检查 termux-api / ffmpeg 是否安装' }
        }
        // /keepalive off — 关闭静音音频保活
        if (args[0] === 'off') {
          try {
            execFileSync('bash', [audioScript, 'stop'], { timeout: 10000, stdio: 'ignore' })
            return '静音音频保活已关闭（省电）'
          } catch { return '关闭失败' }
        }
        const wake = ctx.acquireMainWakeLock() ? '已持有 ✓' : '失败 ✗'
        const audio = (() => {
          try {
            const out = execFileSync('bash', [audioScript, 'status'], { timeout: 5000, encoding: 'utf-8' })
            return out.includes('运行中') ? '播放中 ✓（费电）' : '未运行（省电）'
          } catch { return '未知' }
        })()
        const whitelist = ctx.checkBatteryWhitelist()
        const whitelistStr = whitelist === true ? '在白名单 ✓' : whitelist === false ? '不在白名单 ✗' : '无法检测（需 root/Shizuku）'
        return `保活状态:
  主进程 wake-lock: ${wake}
  静音音频保活: ${audio}
  启动自动保活: ${ctx.config.keepaliveAuto !== false ? '开启 ✓（默认，每次启动自动播放）' : '关闭'}
  电池优化白名单: ${whitelistStr}

静音音频保活（治息屏断流，但费电）:
  /keepalive on        仅本次开启（挂机/自主任务前用）
  /keepalive off       立即关闭（不改变自动设置）
  /keepalive auto on   每次程序启动时自动开启
  /keepalive auto off  关闭启动自动开启
  原理: 循环播放静音音频 → 系统当你是音乐应用 → 息屏网络不断、CPU 不冻

小米/红米手动设置（推荐配合）:
  设置 → 应用设置 → 应用管理 → Termux → 省电策略 → 无限制
  设置 → 电池 → 更多电池设置 → 锁屏后清理 → 不清理 Termux
  自启动: 设置 → 应用设置 → 授权管理 → 自启动 → 允许 Termux`
    },

    'compact-trash': function (args) {
        const sub = args[0]?.toLowerCase()
        if (sub === 'list' || sub === undefined) {
          const list = ctx.listCompactTrash()
          if (!list.length) return `压缩回收站为空（还没有压缩过）。目录: ${TRASH_DIR}`
          const lines = list.map((it, i) => {
            const size = (it.size / 1024).toFixed(0) + 'KB'
            const time = new Date(it.mtime).toLocaleString('zh-CN', { hour12: false })
            return `${i + 1}. [${time}] ${it.reason || 'manual'} · ${it.messageCount ?? '?'} 条 · ${size}`
          })
          return `压缩回收站（${list.length} 个备份，1=最新）:\n${lines.join('\n')}\n\n用法:\n  /compact-trash view <n>     查看备份摘要\n  /compact-trash restore <n>  恢复到该完整上下文\n  /compact-trash delete <n>   删除指定备份\n  /compact-trash clear        清空回收站`
        }
        if (sub === 'view') {
          const n = parseInt(args[1])
          const data = ctx.readCompactTrash(n)
          if (!data) return `没有第 ${n} 个备份。用 /compact-trash list 查看`
          const first = data.messages.slice(0, 5).map(m => `${m.role}: ${String(m.content).slice(0, 80)}`).join('\n')
          return `备份 #${n}: ${data.name}\n时间: ${data.createdAt}\n原因: ${data.reason}\n消息数: ${data.messageCount}\n开头几条:\n${first}`
        }
        if (sub === 'restore') {
          const n = parseInt(args[1])
          const messages = ctx.restoreCompactTrash(n)
          if (!messages) return `没有第 ${n} 个备份。用 /compact-trash list 查看`
          ctx.agent.setHistory(messages)
          ctx.saveSession()
          return `已恢复到备份 #${n} 的完整上下文：${messages.length} 条消息。\n(注意：这会替换当前对话历史，恢复的是压缩前的完整会话)`
        }
        if (sub === 'delete') {
          const n = parseInt(args[1])
          const deleted = ctx.deleteCompactTrash(n)
          return deleted ? `已删除备份 #${n}` : `没有第 ${n} 个备份`
        }
        if (sub === 'clear') {
          const n = ctx.deleteCompactTrash(0, true)
          return n ? `已清空压缩回收站（${n} 个备份）` : '压缩回收站已空'
        }
        return '用法: /compact-trash [list|view <n>|restore <n>|delete <n>|clear]'
    },

    skills(args) {
        const list = ctx.skillLoader.list()
        if (list.length === 0) return '(无)'

        const project = list.filter(s => s.scope !== 'global')
        const global = list.filter(s => s.scope === 'global')
        const pageSize = 30
        const first = String(args[0] || '').toLowerCase()
        const pageMode = first === 'page' || first === 'p'
        const page = pageMode
          ? Math.max(1, parseInt(args[1], 10) || 1)
          : 1
        const query = (pageMode ? args.slice(2) : args).join(' ').trim().toLowerCase()

        // 默认只显示摘要，避免全局 skill 库把终端刷屏。
        if (!pageMode && !query) {
          const projectLines = project.length
            ? project.map(s => `  ${s.name}${s.passive ? ' [被动]' : ''}`).join('\n')
            : '  （无）'
          return `Skills 共 ${list.length} 个（项目 ${project.length} · 全局 ${global.length}）\n项目 skills:\n${projectLines}\n\n全局 skills 默认不展开。\n用法:\n  /skills <关键词>       搜索 skill\n  /skills page <页码>    分页查看全局 skill（每页 ${pageSize} 个）`
        }

        const source = query
          ? list.filter(s => `${s.name} ${s.description}`.toLowerCase().includes(query))
          : global
        if (source.length === 0) return `没有匹配的 skill: ${query || '(全局 skills)'}\n用 /skills 查看用法。`

        const totalPages = Math.max(1, Math.ceil(source.length / pageSize))
        const currentPage = Math.min(page, totalPages)
        const start = (currentPage - 1) * pageSize
        const entries = source.slice(start, start + pageSize)
        const title = query ? `匹配 “${query}” 的 skills` : '全局 skills'
        const lines = entries.map(s => `  ${s.name}${s.passive ? ' [被动]' : ''}${s.description ? ` - ${s.description}` : ''}`)
        const more = currentPage < totalPages ? `\n下一页：/skills page ${currentPage + 1}${query ? ` ${query}` : ''}` : ''
        return `${title}（${source.length} 个，第 ${currentPage}/${totalPages} 页）:\n${lines.join('\n')}${more}`
    },

    font(args) {
        const fontPath = join(homedir(), '.termux', 'font.ttf')
        const installed = existsSync(fontPath)
        const sub = args[0]?.toLowerCase()
        // 三选项切换（2026-10-01）：/font system|jetbrains|maple（含别名，reset 兼容）
        const aliasId = sub ? FONT_ALIASES[sub] : undefined
        if (aliasId) {
          const r = installFont(aliasId)
          if (r.ok) {
            const cur = aliasId === 'system' ? '系统字体'
              : (ctx.readTtfFullName(fontPath) || FONT_CHOICES.find(f => f.id === aliasId)?.name)
            return `${r.msg}\n当前：${cur}`
          }
          return r.msg
        }
        if (sub && !aliasId) {
          return `未知字体选项：\`${sub}\`\n可用：${Object.keys(FONT_ALIASES).join(' | ')}`
        }
        // 无参：显示当前 + 三选项
        let current = '(未安装，使用系统默认)'
        if (installed) current = ctx.readTtfFullName(fontPath) || '已安装（未能解析字体名）'
        const list = FONT_CHOICES.map(f => `- \`${f.id}\` ${f.name}`).join('\n')
        return `**终端字体**\n\n当前：${current}\n路径：\`~/.termux/font.ttf\`\n\n${list}\n\n- \`/font\`               查看当前字体\n- \`/font jetbrains\`     装 JetBrains Mono（推荐）\n- \`/font maple\`         装 Maple Mono NF\n- \`/font system\`        恢复系统字体\n\n（首次使用向导里也会问一次；选哪个装哪个，装完立即生效）`
    },

    context(args) {
        // /context            查看当前占用
        // /context 200k       设置上下文窗口上限（影响状态行百分比与压缩判断）
        // /context reset      恢复默认
        const arg = (args[0] || '').toLowerCase()
        if (arg === 'reset') {
          ctx.setMaxContext(1000000)
          ctx.updateFsStatus()
          return '上下文上限已恢复默认：1000K'
        }
        if (arg) {
          // 接受 200000 / 200k / 200K 三种写法
          const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(arg)
          if (!m) return '用法：/context [200k | 200000 | reset]'
          let v = Number(m[1])
          if (m[2] === 'k') v *= 1000
          else if (m[2] === 'm') v *= 1000000
          v = Math.floor(v)
          if (!ctx.setMaxContext(v)) return `设置失败：上限必须大于 10000（收到 ${v}）`
          ctx.updateFsStatus()
          return `上下文上限已设为 ${(v / 1000).toFixed(0)}K\n（影响状态行百分比与自动压缩判断；用 /context reset 恢复默认）`
        }
        return ctx.cmdContext(ctx.agent, ctx.getMaxContext())
    },
  }
}
