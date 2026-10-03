// /compact 压缩命令（handleCommand 拆分第八批）
//
// 压缩算法本身在 core/compact-service.mjs，这里只是命令层：
// 解析子命令 → 调服务 → 写回历史 → 存档。原来 86 行混在 handleCommand 里，
// 四条策略分支（status / micro / force / 裸调用自动挑）看不清哪条走哪。
//
// 【外层 let 的两个坑，跟第四批 setSessionTitle 同类】
//   1. compactAbortController 原来是给外层 let 赋值（建实例 → 用完置 null）。
//      模块里改不动外层变量，所以拆成两个回调：
//      newCompactAbort() 建实例并存进 index.mjs 的 let，
//      clearCompactAbort() 置 null。
//   2. sessionId 也是 let（/new /resume 会改），必须 getter 读。
//
// 【机械替换踩到的第三个坑】对象简写 { sessionId, reason } 被正则改成
// { ctx.sessionId(), reason } —— 非法语法。凡是简写属性都要先展开成 key: value。

// 完整摘要落盘用（见 formatSummary）。这里直接 import node 内置模块，
// 不走 ctx 透传 —— 写一个固定路径的文本文件，Web 端没有该路径也不会被调用
// （formatSummary 只在 CLI 的 /compact 路径上跑）。
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

/**
 * @param {object} ctx
 *   agent                Agent 实例（getter）
 *   sessionId            () => 当前会话 ID
 *   compactService       core/compact-service.mjs
 *   backupBeforeCompact  压缩前存档到压缩回收站
 *   getMaxContext        () => 上下文上限
 *   getCachePolicy       () => 缓存策略
 *   saveSession          保存会话
 *   newCompactAbort      () => AbortController（同时存进 index.mjs 的 let）
 *   clearCompactAbort    () => void，把那个 let 置 null
 */
export function makeCompactCommand(ctx) {
  return {
    async compact(args) {
        const sub = args[0]?.toLowerCase()
        const usageOptions = { lastPromptTokens:ctx.agent.getLastPromptTokens(), lastUsage:ctx.agent.getLastUsage?.(), maxContextTokens:ctx.getMaxContext(), policy:ctx.getCachePolicy() }
        if (sub === 'status') {
          const s = ctx.compactService.status(ctx.agent.getHistory(), usageOptions)
          const micro = ctx.compactService.microCompact(ctx.agent.getHistory(), { dryRun: true })
          return `简单压缩状态:\n  建议: ${s.recommendation} (${s.reason})\n  可压缩: ${s.chunkMessages} 条 (~${s.chunkTokens} tokens)\n  当前上下文: ${s.lastPromptTokens}/${s.maxContextTokens} (${(s.pressure*100).toFixed(1)}%)\n  保留尾部: ${s.keepLast} 条\n  micro 可回收: ${micro.changed} 条工具输出 (~${micro.reclaimedTokens} tokens，零API)\n\n说明: 已移除缓存感知/不可变摘要段机制；压缩生成一段普通 [历史摘要]，可整体重写`
        }
        // micro：只回收可再生工具输出，零 API 调用。/compact micro [dry]
        if (sub === 'micro') {
          const dry = (args[1] || '').toLowerCase() === 'dry'
          const r = ctx.compactService.microCompact(ctx.agent.getHistory(), { dryRun: dry })
          if (!r.changed) return '没有可回收的可再生工具输出（或都在尾部保护区内）'
          if (dry) {
            const top = r.details.slice(0, 5).map(d => `  ${d.tool}: ${d.before} → ${d.after} 字符`).join('\n')
            return `[预览] 将回收 ${r.changed} 条工具输出，释放 ~${r.reclaimedTokens} tokens:\n${top}${r.details.length > 5 ? `\n  ...共 ${r.details.length} 条` : ''}\n去掉 dry 参数执行`
          }
          ctx.agent.setHistory(r.messages)
          ctx.saveSession()
          const top = r.details.slice(0, 5).map(d => `  ${d.tool}: ${d.before} → ${d.after}`).join('\n')
          return `micro 压缩完成: 回收 ${r.changed} 条工具输出，释放 ~${r.reclaimedTokens} tokens（零 API 调用）\n${top}${r.details.length > 5 ? `\n  ...共 ${r.details.length} 条` : ''}`
        }
        const force = sub === 'force' || /^\d+$/.test(sub || '')
        const keepLast = Math.max(1, parseInt(force && sub === 'force' ? args[1] : args[0]) || 10)

        // 裸 /compact（无参数）→ 自动挑策略，用户不用懂 micro/摘要的区别：
        //   1. 先跑 micro（零 API、无信息损失，只回收可重跑的工具输出）
        //   2. micro 之后压力已降到安全线 → 就此收手，省一次摘要调用
        //   3. 仍然吃紧 → 继续走摘要压缩
        // 带参数（force / 数字 / micro / status）时保持原有显式语义，不插手。
        if (!sub) {
          const before = ctx.compactService.status(ctx.agent.getHistory(), usageOptions)
          const m = ctx.compactService.microCompact(ctx.agent.getHistory())
          let microNote = ''
          if (m.changed) {
            ctx.agent.setHistory(m.messages)
            ctx.saveSession()
            microNote = `已回收 ${m.changed} 条工具输出（~${m.reclaimedTokens} tokens，无损）`
          }
          const after = ctx.compactService.status(ctx.agent.getHistory(), usageOptions)
          // micro 之后不再吃紧就收手：门槛取 70%，与 status 的建议口径一致
          if (m.changed && after.pressure < 0.7) {
            return `压缩完成：${microNote}\n当前上下文压力 ${(after.pressure * 100).toFixed(1)}%，无需摘要`
          }
          if (!m.changed && before.recommendation !== 'compact') {
            return `无需压缩：${before.reason}\n（如需强制摘要用 /compact force）`
          }
          // 继续摘要
          const histNow = ctx.agent.getHistory()
          const _abort = ctx.newCompactAbort()
          let r2
          try {
            r2 = await ctx.compactService.compact(histNow, { ...usageOptions, keepLast, force: true, abortSignal: _abort.signal })
          } catch (e) {
            ctx.clearCompactAbort()
            if (e.message === 'CompactAborted') return `压缩已取消（Ctrl+C）${microNote ? `\n${microNote}（已生效）` : ''}`
            throw e
          }
          ctx.clearCompactAbort()
          if (r2.compacted) {
            const bak = ctx.backupBeforeCompact(histNow, { sessionId: ctx.sessionId(), reason: 'auto-pick', meta: { keepLast, strategy: r2.strategy } })
            ctx.agent.setHistory(r2.messages)
            const lines = [`压缩完成：${r2.messages.filter(x => x.role !== 'system').length} 条消息，保留最后 ${keepLast} 条`]
            if (microNote) lines.push(microNote)
            lines.push(`已生成历史摘要 (${r2.strategy})`, `完整会话备份: ${bak}`)
            lines.push(formatSummary(r2.summary))
            return lines.join('\n')
          }
          return microNote ? `压缩完成：${microNote}` : `未执行压缩：${r2.analysis?.reason || '无需压缩'}`
        }

        const historyBefore = ctx.agent.getHistory()
        const _abort2 = ctx.newCompactAbort()
        let result
        try {
          result = await ctx.compactService.compact(historyBefore, { ...usageOptions, keepLast, force, abortSignal: _abort2.signal })
        } catch (e) {
          ctx.clearCompactAbort()
          if (e.message === 'CompactAborted') return '压缩已取消（Ctrl+C）'
          throw e
        }
        ctx.clearCompactAbort()
        if (result.compacted) {
          const backupName = ctx.backupBeforeCompact(historyBefore, { sessionId: ctx.sessionId(), reason: 'manual', meta: { keepLast, strategy: result.strategy } })
          ctx.agent.setHistory(result.messages)
          return `压缩完成：${result.messages.filter(m => m.role !== 'system').length} 条消息，保留最后 ${keepLast} 条 (${result.strategy})\n`
            + `(完整会话已备份到压缩回收站: ${backupName})`
            + formatSummary(result.summary)
        }
        return `未执行压缩：${result.analysis?.reason || '无需压缩'}。用 /compact force ${keepLast} 可强制执行。`
    },
  }

/**
 * 把摘要正文格式化后附在压缩结果后面（用户要看到"压了些什么"）。
 *
 * 【为什么显示】压缩是**信息有损**操作 —— 摘要写偏了，后续对话就跟着偏。
 * 只在压缩回收站里留备份不够：用户不会主动去翻，等他发现不对时早就基于
 * 错误摘要跑了好几轮。当场显示，让他一眼能判断"压得对不对"。
 *
 * 【为什么截断 + 完整版单独落盘】摘要可达 16000 字符（SUMMARY_CHAR_LIMIT），
 * 全量打印会把整个屏幕刷掉，反而看不清。所以屏幕上前 1200 字符，
 * **完整摘要写进独立文件**（~/.claude-code-mobile/last-summary.md），提示指向它。
 *
 * ⚠ 不要往「压缩回收站」里塞摘要：那是会话备份，restore 的语义是
 *   「还原压缩前的完整上下文」，混进摘要会让备份不再是干净的消息快照
 *   （2026-10-03 用户当场否掉了这个改法）。
 * ⚠ 也不要指 /compact-trash view：它显示的是原始消息的前 5 条，没有摘要，
 *   用户照着提示去翻只会扑空（这是本次要修的原始 bug）。
 */
function formatSummary(summary, { limit = 1200 } = {}) {
  const s = String(summary || '').trim()
  if (!s) return ''
  const head = `\n\n─── 摘要内容（${s.length} 字符）───\n`
  if (s.length <= limit) return head + s
  // 完整摘要落盘：覆盖式（只保留最近一次），文件名固定好记
  let path = null
  try {
    const dir = join(homedir(), '.claude-code-mobile')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    path = join(dir, 'last-summary.md')
    writeFileSync(path, s, 'utf-8')
  } catch { path = null }
  return head + s.slice(0, limit)
    + `\n\n…（还有 ${s.length - limit} 字符未显示；完整摘要已存到：\n`
    + (path ? `  ${path}\n` : '  （写入失败）\n')
    + `  用 /files 或编辑器打开即可查看全文）`
}

}
