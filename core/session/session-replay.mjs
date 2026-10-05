// Claude Code Mobile - 会话历史显示（2026-10-03）
//
// 【用途】/resume 切换会话、Ctrl+X 重启续接时，把恢复的历史画到屏幕上。
// 对齐官方：官方 REPL 把恢复的消息直接作为消息列表渲染
// （screens/REPL.tsx:1182 `useState<MessageType[]>(initialMessages ?? [])` → <Messages>），
// 用户看到的和没退出过一样。
//
// ══════════════════════════════════════════════════════════════
//  【五轮返工的核心教训：不是「回放」，是「重新显示对话」】
// ══════════════════════════════════════════════════════════════
//
// 用户五次反馈，我前四次都猜错方向：
//   ① 「显示得很糟糕」→ 以为工具噪音 → 过滤纯工具消息（对，但不够）
//   ② 「回放还是丑的要死」→ 以为碎句堆 → 按轮次合并（还在自己拼字符串）
//   ③ 「又做什么概要？把它改得像实际正文一样显示」→ 改用 renderMarkdown（对，但不够）
//   ④ 「把它改得不像回放就行」→ 去掉头尾「回放」壳（对，但还不够）
//   ⑤ 「工具调用和思考也正常显示」← **关键**
//
// 真正的目标：**完整还原实时对话的样子**。实时对话里一轮包含三样东西：
//   ∴ Thinking…   ← 思考过程（C.reasoning 色，斜体暖灰，缩进两格）
//   ● Bash (命令) ← 工具调用行（● 前缀 + 加粗工具名 + 参数摘要）
//     ⎿ 结果首行  ← 工具结果（⎿ 前缀）
//   ● 正文…       ← 助手正文（markdown 渲染）
// 少了任何一样，看起来就"不像那次对话"，用户一眼就觉得假。
//
// 所以本模块做的事就是**按实时格式逐条复刻**，不做任何"回放专用"的简化。
// 唯一的取舍：工具结果只显示首行（完整输出太长，实时对话里也是折叠显示）。

import { renderMarkdown } from '../ui/markdown.mjs'

/** 默认显示最近多少**轮**对话（一轮 = 用户问 + 助手答） */
export const REPLAY_MAX_TURNS = 20
/** 单条消息最多显示多少行（防超长消息刷屏；0 = 不限制） */
export const REPLAY_MAX_LINES = 40
/** 思考内容最多显示多少行 */
export const REPLAY_MAX_THINKING_LINES = 8
/** 工具结果最多显示多少字符 */
export const REPLAY_TOOL_RESULT_CHARS = 150
/**
 * 历史显示的总行数上限。
 *
 * 【为什么需要】一轮复杂对话可能有几十次工具调用 + 上百行思考，
 * 实测 3 轮就 132 行、20 轮轻松破千 —— 全画出来等于把屏幕刷爆，
 * 用户往上翻要翻很久才到头（反而看不清"上次聊到哪"）。
 * 超限时从**最旧的轮次**开始丢（保留最近的，用户最关心）。
 */
export const REPLAY_TOTAL_LINE_BUDGET = 220

// 配色与 index.mjs 的 C 对象保持一致（那边是权威源）
const DEFAULT_COLORS = {
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[38;2;78;186;101m',
  red: '\x1b[38;2;255;107;128m',
  // 思考专用：暖灰 + 斜体（同 index.mjs 的 C.reasoning / C.reasoningPrefix）
  reasoning: '\x1b[2;3;38;2;150;140;125m',
  reasoningPrefix: '\x1b[2;38;2;150;140;125m',
}

/** 限行（默认 40 行；0 = 不限） */
function clampLines(text, n = REPLAY_MAX_LINES) {
  const lines = String(text ?? '').split('\n')
  if (!n || n <= 0 || lines.length <= n) return lines
  return [...lines.slice(0, n), `…（还有 ${lines.length - n} 行）`]
}

/** 单行截断 */
function clampLine(s, n = REPLAY_TOOL_RESULT_CHARS) {
  const t = String(s ?? '').replace(/\s+$/, '')
  return t.length > n ? t.slice(0, n) + '…' : t
}

/** 从 content（字符串或块数组）里取纯文本 */
function extractText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(b => b && (b.type === 'text' || b.type === 'input_text'))
    .map(b => b.text || '')
    .join('\n')
}

/**
 * 工具参数摘要（复刻 core/cli-task-state.mjs 的 inputSummary，
 * 那边没 export，这里保持同序同截断，改一处要改两处）。
 */
function inputSummary(input = {}) {
  if (!input || typeof input !== 'object') return ''
  const v = input.file_path || input.path || input.command || input.pattern ||
    input.query || input.description || input.question || input.task_id || ''
  const s = String(v || '')
  return s.length > 180 ? s.slice(0, 180) + '…' : s
}

/** tool_result 块的纯文本 */
function toolResultText(block) {
  const c = block?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c.map(x => (typeof x === 'string' ? x : x?.text || '')).join('\n')
  }
  return ''
}

/** 是不是「用户真的打的字」（而不是工具结果回填） */
function isRealUserMessage(m) {
  if (!m || m.role !== 'user') return false
  if (typeof m.content === 'string') return true
  if (Array.isArray(m.content)) {
    return !m.content.some(b => b && b.type === 'tool_result')
  }
  return false
}

/**
 * 把历史消息聚合成「轮次」，每轮含用户消息 + 助手侧的有序片段。
 *
 * 助手侧片段按出现顺序保留：思考 / 工具调用 / 工具结果 / 正文。
 * 这样能完整复刻实时对话的时间线（先想、再动手、再说结论）。
 *
 * @returns {Array<{user: string, parts: Array<{kind:string, ...}>}>}
 */
export function groupIntoTurns(messages) {
  const turns = []
  let cur = null
  for (const m of (Array.isArray(messages) ? messages : [])) {
    if (!m || m.hidden) continue
    if (isRealUserMessage(m)) {
      if (cur) turns.push(cur)
      cur = { user: extractText(m.content), parts: [] }
      continue
    }
    if (!cur) cur = { user: '', parts: [] }
    if (m.role === 'assistant') {
      // 思考（reasoning_content 字段，实时对话里显示为 ∴ Thinking… 区块）
      const think = m.reasoning_content
      if (typeof think === 'string' && think.trim()) {
        cur.parts.push({ kind: 'thinking', text: think })
      }
      // 正文与工具调用（按块顺序）
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b?.type === 'text' && b.text?.trim()) {
            cur.parts.push({ kind: 'text', text: b.text })
          } else if (b?.type === 'tool_use') {
            cur.parts.push({ kind: 'tool', name: b.name, summary: inputSummary(b.input), id: b.id })
          }
        }
      } else if (typeof m.content === 'string' && m.content.trim()) {
        cur.parts.push({ kind: 'text', text: m.content })
      }
    } else if (m.role === 'user' && Array.isArray(m.content)) {
      // 工具结果回填（不是用户说的，是工具输出）
      for (const b of m.content) {
        if (b?.type !== 'tool_result') continue
        cur.parts.push({
          kind: 'tool_result',
          id: b.tool_use_id,
          text: toolResultText(b),
          isError: b.is_error === true,
        })
      }
    }
  }
  if (cur) turns.push(cur)
  return turns
}

/**
 * 生成要写进正文的行 —— **完整复刻实时对话的显示格式**。
 *
 * @param {Array} messages agent 的消息数组
 * @param {object} [opts]
 *   maxTurns   最多显示多少轮（默认 REPLAY_MAX_TURNS）
 *   C          颜色覆盖（默认用内置配色）
 * @returns {string[]} 行数组
 */
export function formatHistoryForReplay(messages, opts = {}) {
  const C = { ...DEFAULT_COLORS, ...(opts.C || {}) }
  const maxTurns = opts.maxTurns || opts.maxMessages || REPLAY_MAX_TURNS
  const out = []

  const turns = groupIntoTurns(messages).filter(t => t.user || t.parts.length)
  if (!turns.length) return out

  const omitted = Math.max(0, turns.length - maxTurns)
  const slice = omitted > 0 ? turns.slice(-maxTurns) : turns

  // 先把每一轮渲染成独立行块，再按总预算从**最旧**开始丢。
  // 这样超长会话不会刷爆屏幕，且保留的是用户最关心的最近内容。
  const blocks = slice.map(t => renderTurn(t, C))
  let budget = REPLAY_TOTAL_LINE_BUDGET
  let keepFrom = blocks.length
  for (let i = blocks.length - 1; i >= 0; i--) {
    const n = blocks[i].length
    if (budget - n < 0 && keepFrom < blocks.length) break   // 至少保留最后一轮
    budget -= n
    keepFrom = i
  }
  // 只提示一次折叠（轮数上限 + 长度预算取「丢得更多」的那个，别打两行）
  const totalDropped = omitted + keepFrom
  if (totalDropped > 0) {
    out.push(`${C.dim}…（更早的 ${totalDropped} 轮未显示，AI 仍能看到）${C.reset}`)
    out.push('')
  }
  for (let i = keepFrom; i < blocks.length; i++) {
    for (const l of blocks[i]) out.push(l)
  }

  // ── Session Recovery 分割线（2026-10-03 用户要求）──
  // 放在历史**末尾**：往上翻是恢复的历史，往下就是新对话。
  // 有这条线，用户一眼能分清「哪些是以前的、从哪里开始是我新说的」——
  // 之前没有分界，历史和新对话糊在一起。
  out.push(...recoveryDivider(C))

  return out
}

/**
 * 会话分隔线：横线 + 居中标题 + 横线。
 * 用 cols 算宽度，窄屏也不会折行；cols 拿不到时退回固定宽度。
 *
 * 两个用途（2026-10-03 用户要求）：
 *   · `Session Recovery` —— 恢复历史之后，标出「从这里开始是新对话」
 *   · `New Session Start` —— 全新对话启动时，标出会话起点
 *
 * @param {object} C 配色
 * @param {string} title 标题文字
 * @param {boolean} leadingBlank 前面是否加空行（恢复历史用 true，新对话用 false）
 */
export function sessionDivider(C, title, { leadingBlank = true } = {}) {
  let cols = 60
  try { cols = Math.max(24, Number(process.stdout.columns) || 60) } catch {}
  const pad = 2   // 标题两侧各留一个空格
  const side = Math.max(2, Math.floor((cols - title.length - pad * 2) / 2))
  const line = `${C.dim}${'─'.repeat(side)}${C.reset} ${C.dim}${title}${C.reset} ${C.dim}${'─'.repeat(side)}${C.reset}`
  return leadingBlank ? ['', line, ''] : [line, '']
}

/** 兼容旧调用名（历史末尾的 Session Recovery 线） */
function recoveryDivider(C) {
  return sessionDivider(C, 'Session Recovery', { leadingBlank: true })
}

/**
 * 渲染一轮对话为行数组（用户消息 + 助手侧时间线）。
 * 抽出来是为了支持「按总行数预算裁掉最旧轮次」。
 */
function renderTurn(t, C) {
  const out = []

  // ── 用户消息：❯ 前缀 ──
  const userText = String(t.user || '').trim()
  if (userText) {
    const isSummary = /^\s*\[历史摘要\]/.test(userText)
    if (isSummary) {
      out.push(`${C.dim}● 历史摘要（/compact 产生）${C.reset}`)
      for (const l of clampLines(userText.replace(/^\s*\[历史摘要\]\s*/, ''), 20)) {
        out.push(`  ${l}`)
      }
    } else {
      clampLines(userText, REPLAY_MAX_LINES).forEach((l, i) => {
        out.push(i === 0 ? `${C.dim}❯${C.reset} ${l}` : `  ${l}`)
      })
    }
    out.push('')
  }

  // ── 助手侧：按时间线逐条复刻 ──
  for (const p of t.parts) {
    if (p.kind === 'thinking') {
      // 同 index.mjs onText：`∴ Thinking…` 标题 + 缩进两格的正文（暖灰斜体）
      out.push(`${C.reasoningPrefix}∴ Thinking…${C.reset}`)
      // 【首尾取样，不是纯截断】实时对话里思考是流式展开的（很长，正常），
      // 但历史里一条思考动辄 400 行，全放会把屏幕刷爆、把后面的对话挤走。
      // 取**头部**（思路起点）+ **尾部**（通常落结论），中间折叠一行 ——
      // 比只取头部信息量大得多（结论往往在最后）。
      const rawLines = String(p.text || '').split('\n')
      const head = Math.ceil(REPLAY_MAX_THINKING_LINES / 2)
      const tail = REPLAY_MAX_THINKING_LINES - head
      let thinkLines
      if (rawLines.length <= REPLAY_MAX_THINKING_LINES) {
        thinkLines = rawLines
      } else {
        thinkLines = [
          ...rawLines.slice(0, head),
          `…（中间省略 ${rawLines.length - REPLAY_MAX_THINKING_LINES} 行）`,
          ...rawLines.slice(-tail),
        ]
      }
      for (const l of thinkLines) {
        out.push(`${C.reasoning}  ${l}${C.reset}`)
      }
      out.push('')
    } else if (p.kind === 'tool') {
      // 同 index.mjs onToolUse 的工具行格式：`● Name (摘要)`。
      //
      // ⚠ 颜色用 dim，**不能**用成功绿：实测 472 个 tool_result 里只有 5 个带
      // is_error 字段，历史里无法可靠判断成败 —— 全染绿是假装知道结果。
      // 实时对话里工具行刚出现时也是 dim，结果到了才变色；历史没有那个时刻，
      // 保持 dim 最诚实。
      const sum = p.summary ? ` (${clampLine(p.summary, 120)})` : ''
      out.push(`${C.dim}●${C.reset} ${C.bold}${p.name}${C.reset}${sum}`)
    } else if (p.kind === 'tool_result') {
      // 同 index.mjs onToolResult：`  ⎿ 首行`（失败用红）
      const rc = String(p.text || '')
      const first = clampLine(rc.split('\n').find(l => l.trim()) || '(空)')
      const color = p.isError ? C.red : C.dim
      out.push(`${C.dim}  ⎿${C.reset} ${color}${first}${C.reset}`)
      out.push('')
    } else if (p.kind === 'text') {
      // 正文：markdown 渲染（同实时对话）
      let rendered = ''
      try {
        rendered = renderMarkdown(clampLines(String(p.text).trim(), REPLAY_MAX_LINES).join('\n'))
      } catch {
        rendered = String(p.text).trim()
      }
      const body = String(rendered || '').replace(/\n+$/, '')
      if (!body) continue
      body.split('\n').forEach((l, i) => {
        out.push(i === 0 ? `${C.dim}●${C.reset} ${l}` : `  ${l}`)
      })
      out.push('')
    }
  }
  return out
}
