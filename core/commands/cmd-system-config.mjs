// 系统配置命令批 —— 从 index.mjs 的 handleCommand 拆出，两端共用
//
// 【为什么拆这批】
// 2026-10-05 用户指出「web 端其实有点落后了」。排查发现一批**纯配置读写**
// 命令只写在 index.mjs 的 handleCommand 里（没搬进 core/），
// 于是 Web 的注册表拿不到它们 —— 敲了报「未知命令」。
//
// 这批的共同点：依赖少（都是 core 里已有的纯函数）、无渲染状态耦合。
// 与拆不动的那批（/image 会发起 agent.run，牵扯 20+ 渲染状态变量）不同。
//
// 收录：
//   /cache              Prompt Cache 扩展字段开关
//   /compact-threshold  自动压缩阈值
//   /workspace          工作区查看/设置
//   /me                 用户资料
//   /check              重启预检
//   /context7           Context7 MCP 配置
//
// 【不收录（对 Web 无意义，已在 CLI_ONLY 或 web 有别的入口）】
//   /exit /quit /palette /editor —— 终端特性
//   /coordinate /cowork —— Web 有 CoworkPage
//   /web /bg-status /bg-list —— CLI 专属或 Web 有 API

import {
  getTokenLimit, setTokenLimit, getMessageLimit, setMessageLimit,
  isAutoCompactEnabled, getCachePolicy,
} from '../session/auto-compact.mjs'
import { loadUserProfile, setProfileField, PROFILE_FIELDS } from '../session/user-profile.mjs'
// Context7 与重启预检都是纯函数，直接 import —— 不必经 ctx 转一手。
import { context7Help, context7Status, setupContext7, setContext7Enabled } from '../integrations/context7.mjs'
import { runRestartPreflight, formatRestartPreflightFailure } from '../infra/restart-preflight.mjs'

/**
 * @param {object} ctx
 *   C                    颜色表
 *   config               配置对象（会被就地修改 + saveConfig）
 *   saveConfig           保存配置
 *   syncActiveProvider   (config, api, prov) => void  把 provider 变更同步到运行中的 api 实例
 *   syncSessionCacheKey  () => void  重新计算会话缓存键
 *   getWorkspacePath     () => string
 *   setWorkspacePath     (path) => { ok, path?, error? }
 *   onWorkspaceChanged   () => void  工作区变更后刷新系统提示词
 *   onProfileChanged     () => void  用户资料变更后刷新系统提示词
 *   isIncognito          () => boolean
 *   cwd                  () => string  预检的工作目录
 *   mcpPath              MCP 配置路径（Context7 用）
 */
export function makeSystemConfigCommands(ctx) {
  return {
    // ── /cache：Prompt Cache 扩展字段 ────────────────────────────────
    // 控制请求里是否带 prompt_cache_key 与 24h retention。
    // 未知兼容网关不要盲开（可能不认这两个字段）。
    cache(args) {
      const { C } = ctx
      const prov = ctx.config.providers?.[ctx.config.current]
      if (!prov) return '当前 Provider 不存在'
      const sub = String(args[0] || 'show').toLowerCase()
      if (sub === 'show' || sub === 'status') {
        return `Prompt Cache（Provider ${ctx.config.current}）:\n`
          + `  扩展字段: ${prov.promptCacheEnabled === true ? '开启' : '关闭'}\n`
          + `  保留时间: ${prov.promptCacheRetention === '24h' ? '24h' : '默认'}\n`
          + `用法:\n  /cache on|off\n  /cache retention 24h|off`
      }
      if (sub === 'on' || sub === 'enable') {
        prov.promptCacheEnabled = true
        ctx.saveConfig(ctx.config)
        ctx.syncActiveProvider?.(ctx.config, null, prov)
        ctx.syncSessionCacheKey?.()
        return `Provider ${ctx.config.current} Prompt Cache 扩展字段已开启`
      }
      if (sub === 'off' || sub === 'disable') {
        prov.promptCacheEnabled = false
        delete prov.promptCacheRetention
        ctx.saveConfig(ctx.config)
        ctx.syncActiveProvider?.(ctx.config, null, prov)
        ctx.syncSessionCacheKey?.()
        return `Provider ${ctx.config.current} Prompt Cache 扩展字段已关闭`
      }
      if (sub === 'retention') {
        const value = String(args[1] || '').toLowerCase()
        if (value === '24h') {
          prov.promptCacheEnabled = true
          prov.promptCacheRetention = '24h'
        } else if (value === 'off' || value === 'default' || value === '0') {
          delete prov.promptCacheRetention
        } else {
          return '用法: /cache retention 24h|off'
        }
        ctx.saveConfig(ctx.config)
        ctx.syncActiveProvider?.(ctx.config, null, prov)
        return `Provider ${ctx.config.current} Prompt Cache 保留时间: ${prov.promptCacheRetention || '默认'}`
      }
      return '用法: /cache show|on|off|retention 24h|off'
    },

    // ── /compact-threshold：自动压缩阈值 ─────────────────────────────
    // 默认关闭（用户明确要求：不要主动压缩上下文）。
    'compact-threshold'(args) {
      if (args[0] === undefined && args[1] === undefined) {
        const tokenStr = getTokenLimit() > 0 ? getTokenLimit() : '关闭(0)'
        const msgStr = getMessageLimit() > 0 ? getMessageLimit() : '关闭(0)'
        return `当前自动压缩:\n`
          + `  固定 Token 阈值: ${tokenStr}\n`
          + `  固定消息阈值: ${msgStr}\n`
          + `  自动压缩总开关: ${isAutoCompactEnabled() ? '开启' : '关闭'}\n\n`
          + `说明:\n`
          + `  · 默认关闭自动摘要，对话中不会主动压缩\n`
          + `  · /compact status           仅查看建议，不执行\n`
          + `  · /compact / /compact force 手动压缩\n`
          + `  · /compact-threshold 0 0    完全关闭自动压缩\n`
          + `  · /compact-threshold <t> <m> 设固定阈值并按阈值自动压缩\n`
          + `  · 上下文真正超长时由 agent 紧急截断保护（非摘要）`
      }
      const newTokens = parseInt(args[0])
      const newMessages = parseInt(args[1])
      let msg = ''
      if (!isNaN(newTokens) && setTokenLimit(newTokens)) msg += `Token 上限已设为: ${newTokens === 0 ? '关闭' : newTokens}\n`
      if (!isNaN(newMessages) && setMessageLimit(newMessages)) msg += `消息条数上限已设为: ${newMessages === 0 ? '关闭' : newMessages}\n`
      if (isAutoCompactEnabled()) msg += `自动压缩: 开启（按固定阈值）`
      else msg += `自动压缩: 已完全关闭（仅手动 /compact）`
      return msg || '参数无效。用法: /compact-threshold <tokens> <messages>'
    },

    // ── /workspace：工作区查看/设置 ──────────────────────────────────
    workspace(args) {
      if (!args[0] || args[0] === 'show') {
        const wp = ctx.getWorkspacePath()
        return `当前工作区: ${wp}\n用法: /workspace /sdcard/Download/my-project\n（改完立即生效，系统提示词会同步更新）`
      }
      const r = ctx.setWorkspacePath(args[0])
      if (!r.ok) return `设置失败: ${r.error}`
      ctx.onWorkspaceChanged?.()
      return `工作区已设为: ${r.path}`
    },

    // ── /me：用户资料（注入系统提示词）────────────────────────────────
    me(args) {
      const { C } = ctx
      const sub = String(args[0] || '').trim()
      if (!sub) {
        const p = loadUserProfile()
        const lines = []
        for (const f of PROFILE_FIELDS) {
          lines.push(`  ${f.padEnd(22)} ${p[f] ? p[f] : C.dim + '(未设置)' + C.reset}`)
        }
        return `用户资料（注入系统提示词；改了下一轮生效）\n${lines.join('\n')}\n\n`
          + `用法: /me set <字段> <值>\n`
          + `      /me clear <字段>\n`
          + `      /me clear-all`
      }
      if (sub === 'set') {
        const field = String(args[1] || '').trim()
        const value = args.slice(2).join(' ').trim()
        if (!field || !value) {
          return `用法: /me set <字段> <值>\n字段: ${PROFILE_FIELDS.join(' / ')}\n`
            + `例: /me set display_name 小杰`
        }
        const r = setProfileField(field, value)
        if (!r.ok) return r.error
        ctx.onProfileChanged?.()
        return `已设置 ${field}: ${value}\n（下一轮对话生效）`
      }
      if (sub === 'clear') {
        const field = String(args[1] || '').trim()
        if (!field) return `用法: /me clear <字段>\n字段: ${PROFILE_FIELDS.join(' / ')}`
        const r = setProfileField(field, '')
        if (!r.ok) return r.error
        ctx.onProfileChanged?.()
        return `已清除 ${field}`
      }
      if (sub === 'clear-all') {
        for (const f of PROFILE_FIELDS) setProfileField(f, '')
        ctx.onProfileChanged?.()
        return '已清空全部用户资料'
      }
      return `不认识的子命令: ${sub}\n用法: /me [set <字段> <值> | clear <字段> | clear-all]`
    },

    // ── /check：重启预检 ─────────────────────────────────────────────
    async check(args) {
      if (ctx.isIncognito?.()) return 'Incognito 会话禁用 /check'
      const result = await runRestartPreflight(ctx.cwd())
      return result.ok
        ? (result.cached
          ? `重启预检通过（未改动）：文件集与内容哈希自上次预检后无变化，直接放行（${result.skipped} 个 .mjs）`
          : `重启预检通过：${result.checked} 个 .mjs 文件${result.skipped ? `（跳过 ${result.skipped} 个未修改）` : ''}`)
        : formatRestartPreflightFailure(result).replace(/^重启已拦截：/, '')
    },

    // ── /context7：Context7 文档查询 MCP ─────────────────────────────
    context7(args) {
      if (ctx.isIncognito?.()) return 'Incognito 会话禁用 /context7'
      const p = ctx.mcpPath
      const sub = String(args[0] || 'status').toLowerCase()
      if (sub === 'help') return context7Help()
      if (sub === 'setup') return `Context7 配置完成：${JSON.stringify(setupContext7(p))}\n默认仍禁用；用 /context7 enable 后重启加载。`
      if (sub === 'enable' || sub === 'on') return `Context7 已启用：${JSON.stringify(setContext7Enabled(true, p))}\n请重启后加载 MCP。`
      if (sub === 'disable' || sub === 'off') return `Context7 已禁用：${JSON.stringify(setContext7Enabled(false, p))}\n请重启后卸载 MCP。`
      if (sub === 'status') return JSON.stringify(context7Status(p), null, 2)
      return context7Help()
    },
  }
}
