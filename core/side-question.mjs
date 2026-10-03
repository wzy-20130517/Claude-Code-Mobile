// 侧问（官方 /btw）：不打断主对话、不污染主上下文的快速提问。
//
// 官方实现在 src/utils/sideQuestion.ts + src/commands/btw/：
//   - fork 一个 agent，共享父上下文（复用 prompt cache）
//   - 禁用全部工具，硬性 1 轮
//   - 回答不写回主历史
//   - 不覆盖 thinking 配置（thinking 参与 cache key，改了就丢缓存）
//
// 我们这边简化：直接用当前 agent 的历史 + api.createMessage 单发一次，
// 不注册工具、不 push 进 agent.messages。

/**
 * 官方原文的 system-reminder：明确告诉模型这是侧问、没有工具、只有一轮，
 * 且不要说"让我看看/我去查一下"这类承诺动作的话。
 * 照搬语义（翻成中文），因为这段约束是效果的关键。
 */
export const SIDE_QUESTION_PREAMBLE = `<system-reminder>这是用户的一个侧问（side question）。你必须在一次回复里直接回答。

重要背景：
- 你是被临时拉起来回答这一个问题的独立轻量实例
- 主对话没有被打断，它在后台继续自己的工作
- 你共享对话上下文，但你是完全独立的实例
- 不要说"我刚才在做什么被打断了"这种话，那个理解是错的

硬性约束：
- 你没有任何工具：不能读文件、不能执行命令、不能搜索、不能做任何操作
- 这是一次性回答，不会有后续轮次
- 只能基于你已经从对话上下文里知道的信息回答
- 绝对不要说"让我看看…""我现在去…""我来检查一下…"或承诺任何动作
- 不知道就直说不知道，不要提出去查

直接用你已有的信息回答这个问题。</system-reminder>`

/** 侧问历史上限：太长会拖慢响应，也没必要带全部 */
const MAX_CONTEXT_MESSAGES = 40

/**
 * 跑一次侧问。
 * @param {object} opts
 * @param {string} opts.question 用户的问题
 * @param {object} opts.api ApiClient 实例
 * @param {Array} opts.history 主对话历史（只读，不修改）
 * @param {string} opts.systemPrompt 主对话的 system prompt
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{text: string, usage: object|null}>}
 */
export async function runSideQuestion({ question, api, history = [], systemPrompt = '', signal = null }) {
  const q = String(question || '').trim()
  if (!q) throw new Error('侧问内容为空')
  if (!api) throw new Error('没有可用的 API 客户端')

  // 只带最近 N 条，且必须以 user 消息收尾才合法
  const ctx = sanitizeHistory(history).slice(-MAX_CONTEXT_MESSAGES)
  const messages = [...ctx, { role: 'user', content: `${SIDE_QUESTION_PREAMBLE}\n\n${q}` }]

  // 关键：不传 tools（官方是 canUseTool 一律 deny，我们直接不给）
  const resp = await api.createMessage({
    system: systemPrompt,
    messages,
    tools: [],
    maxTokens: 2048,
    signal,
  })

  const text = extractText(resp)
  return { text, usage: resp?.usage || null }
}

/**
 * 清洗历史：
 *  - 丢掉 tool_use / tool_result（侧问没有工具，带上去会让模型以为能用）
 *  - 丢掉空消息
 *  - 合并连续同角色（有些网关不接受连续 user）
 */
export function sanitizeHistory(history) {
  const out = []
  for (const m of Array.isArray(history) ? history : []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue
    const content = stripToolBlocks(m.content)
    if (!content) continue
    const prev = out[out.length - 1]
    if (prev && prev.role === m.role) {
      prev.content = `${prev.content}\n\n${content}`
    } else {
      out.push({ role: m.role, content })
    }
  }
  // 首条必须是 user（Anthropic 协议要求），开头是 assistant 就丢掉
  while (out.length && out[0].role !== 'user') out.shift()
  return out
}

/** 把 content 归一成纯文本，剔除工具块 */
function stripToolBlocks(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const b of content) {
    if (!b) continue
    if (typeof b === 'string') { parts.push(b); continue }
    // tool_use / tool_result 一律丢掉
    if (b.type === 'tool_use' || b.type === 'tool_result') continue
    if (b.type === 'text' && b.text) parts.push(b.text)
    if (b.type === 'thinking' && b.thinking) continue   // 思考不带进侧问
  }
  return parts.join('\n').trim()
}

/** 从响应里取文本（兼容 OpenAI / Anthropic 两种形状） */
function extractText(resp) {
  if (!resp) return ''
  if (typeof resp.text === 'string' && resp.text) return resp.text.trim()
  if (Array.isArray(resp.content)) {
    return resp.content
      .filter(b => b?.type === 'text' && b.text)
      .map(b => b.text)
      .join('\n')
      .trim()
  }
  const msg = resp.choices?.[0]?.message
  if (msg?.content) {
    if (typeof msg.content === 'string') return msg.content.trim()
    if (Array.isArray(msg.content)) {
      return msg.content.filter(p => p?.text).map(p => p.text).join('\n').trim()
    }
  }
  return ''
}
