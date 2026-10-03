// 侧问命令 /btw /summary（handleCommand 拆分第十四批）
//
// 两个都走 runSideQuestion：借当前对话历史问一句，但**不把问答写进主历史**。
// /btw     顺嘴问一句（不占后续上下文）
// /summary 让模型给这段对话起个标题
//
// 【incognitoMode 用 getter】它是 index.mjs 的 let，/incognito 会切。
// /summary 在隐身下禁用 —— 它会把标题写进会话存档，隐身会话不该留痕。
// sessionTitle 是 let 且要写回，所以用 setSessionTitle 回调（同第四批 /rename）。

// renderMarkdown 是纯函数，直接 import 不走 ctx
import { renderMarkdown } from './markdown.mjs'

/**
 * @param {object} ctx
 *   C
 *   agent                     Agent 实例（getter）
 *   api                       API 实例（getter，/config 会换）
 *   getCurrentSystemPrompt    取当前系统提示词
 *   runSideQuestion           core/side-question.mjs
 *   incognitoMode             () => 是否隐身
 *   setSessionTitle           (t) => void 写回 index.mjs 的 let
 *   saveSession               保存会话
 */
export function makeSideCommands(ctx) {
  return {
    async btw(args) {
        const question = args.join(' ').trim()
        if (!question) {
          return `/btw <问题>   顺嘴问一句，不打断主对话、不进主上下文

例：
  /btw 刚才那个 429 是什么意思
  /btw jq 取嵌套字段怎么写

特点：能看到当前对话内容，但没有工具、只回一轮，
回答不会写进主历史（不占后续上下文）。`
        }
        try {
          const { text, usage } = await ctx.runSideQuestion({
            question,
            api: ctx.api,
            history: ctx.agent?.getHistory?.() || [],
            systemPrompt: ctx.getCurrentSystemPrompt(),
          })
          if (!text) return '侧问没有返回内容'
          const cost = usage?.prompt_tokens
            ? `\n${ctx.C.dim}（侧问 ${usage.prompt_tokens} in / ${usage.completion_tokens || 0} out，未计入主上下文）${ctx.C.reset}`
            : ''
          return `${renderMarkdown(text)}${cost}`
        } catch (e) {
          return `侧问失败: ${e.message}`
        }
    },

    async summary(args) {
        if (ctx.incognitoMode()) return 'Incognito 会话禁用 /summary'
        const hist = ctx.agent?.getHistory?.() || []
        if (hist.length < 2) return '对话内容太少，还不需要摘要'
        try {
          const { text } = await ctx.runSideQuestion({
            question: '用一句不超过 20 字的中文短语概括这段对话在做什么，只输出短语本身，不要引号、不要标点结尾、不要解释。',
            api: ctx.api,
            history: hist,
            systemPrompt: ctx.getCurrentSystemPrompt(),
          })
          const title = String(text || '').split('\n')[0].replace(/^["'「『]|["'」』。.]$/g, '').trim().slice(0, 40)
          if (!title) return '没能生成摘要'
          if (args.includes('--apply') || args.includes('-a')) {
            ctx.setSessionTitle(title)
            ctx.saveSession()
            return `会话已命名为: ${title}`
          }
          return `摘要: ${title}\n${ctx.C.dim}加 --apply 直接用它命名会话${ctx.C.reset}`
        } catch (e) {
          return `生成摘要失败: ${e.message}`
        }
    },
  }
}
