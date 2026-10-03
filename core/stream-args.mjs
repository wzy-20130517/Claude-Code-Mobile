// 流式工具参数预览：在 tool_call 参数还没收完时，就把已知字段显示出来。
//
// 数据来源是 input_json_delta —— 模型分块推送 tool_call 的 arguments JSON。
// core/api.mjs 已经把它转成 tool_call_delta 事件，这里负责从半截 JSON 里
// 抽出能显示的部分。
//
// ── 设计来自 Kimi Code（@moonshot-ai/kimi-code 0.39.0）─────────────
// 它的三层结构（dist/main.mjs:431761 起）：
//   1) appendStreamingArgsPreview  增量累积，64KB 硬顶，超了丢弃后续
//   2) parseStreamingArgs          完整就 JSON.parse，不完整用正则抽白名单字段
//   3) capArgStrings               显示前单串再截到 16KB
//
// 【我们的差异：把 content 也纳入】
// Kimi 的白名单是 path/file_path/command/pattern/query/url/description/title/name，
// 刻意【不含 content】—— 所以它只显示「正在写哪个文件」，不显示文件内容。
// 用户明确要激进版：内容也要能看到写到哪了。
//
// 代价是必须自己做节流。Kimi 靠 React/Ink 批量渲染吸收高频更新（它的 bump()
// 只是 record.version += 1），我们直写终端，不控频会把终端刷爆、拖慢渲染。
// 所以这里加了 Kimi 没有的两道闸：时间节流 + 只显示尾部若干行。

import { langFromPath, highlightLines } from './mini-highlight.mjs'

// 累积上限。超过就停止累积——预览本来就只是给人看个大概，
// 没必要为了显示把几 MB 的文件内容全存一份。
const MAX_ACCUMULATE = 64 * 1024
// 单个字段显示上限
const MAX_FIELD_CHARS = 4 * 1024
// 内容类字段只显示最后这么多行（写文件时用户关心的是"写到哪了"）
const TAIL_LINES = 10   // 对齐 Kimi Code 的 maxLines
// 节流：手机终端渲染开销大，不能每个分块都重画。
//
// 【为什么不能只用时间节流】
// 最初只有 THROTTLE_MS=180，实测 110 个分块在网络上是连续到达的
// （每块 2~12 字符，总耗时常常不到 180ms），于是第一帧之后全被拦掉，
// 只输出 1 帧 —— 表现就是「一瞬间就显示完了」，完全没有流式感。
//
// 改成时间和行数双触发：任一满足就出帧。
// 行数变化是用户真正能感知的单位（窗口滚一行），比毫秒更贴合。
const THROTTLE_MS = 60
// 内容每增加这么多行就强制出一帧，不等时间闸
const LINE_STEP = 1

// Edit 类：只报进度不显示内容
const EDIT_LIKE = /^(Edit|MultiEdit|ApplyPatch|HashlineEdit)/
const MEMORY_LABEL = 'CLAUDE.md'

// 短字段：路径、命令这类，完整显示
const SHORT_FIELDS = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'notebook_path', 'name', 'subject', 'team', 'agent']
// 长字段：内容类，只显示尾部
const LONG_FIELDS = ['content', 'new_string', 'text', 'prompt', 'description', 'old_string']

/**
 * 从可能不完整的 JSON 里抽字段值。
 *
 * 为什么不用 partial-json 库：Kimi 虽然打包了它（main.mjs:5762），但 UI 侧
 * 的参数预览走的是正则，没用那个库。原因能理解——半截 JSON 补全括号后
 * 结构可能是错的，而正则只捞"已经闭合的字符串字段"，拿到的一定是真值。
 *
 * 我们对长字段放宽一档：允许匹配【未闭合】的字符串，这样才能边写边看。
 * 未闭合的值末尾可能是个不完整的转义（如 "abc\\），转义处理要容错。
 */
function extractField(json, key, { allowUnclosed = false } = {}) {
  // 已闭合：优先，拿到的是确定的完整值
  const closed = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`)
  const m = closed.exec(json)
  if (m) return unescapeJsonString(m[1])
  if (!allowUnclosed) return null
  // 未闭合：值还在传输中，取到目前为止的部分
  const open = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)$`)
  const m2 = open.exec(json)
  return m2 ? unescapeJsonString(m2[1]) : null
}

/** 手工反转义。不能用 JSON.parse——值可能是半截的，包不成合法 JSON。 */
function unescapeJsonString(s) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') { out += s[i]; continue }
    const c = s[++i]
    if (c === undefined) break          // 末尾孤立反斜杠：转义还没传完，丢掉
    if (c === 'n') out += '\n'
    else if (c === 't') out += '\t'
    else if (c === 'r') out += '\r'
    else if (c === 'u') {
      const hex = s.slice(i + 1, i + 5)
      if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16)); i += 4
      }
      // hex 不完整说明 \uXXXX 还在传，丢掉
    }
    else out += c                        // \" \\ \/ 等原样
  }
  return out
}

function tailLines(text, n) {
  const lines = text.split('\n')
  return lines.length <= n ? text : lines.slice(-n).join('\n')
}

function cap(s, max) {
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * 流式参数预览器。一个 tool_call 一个实例。
 *
 * 用法：
 *   const p = new StreamArgsPreview('Write')
 *   p.feed(argumentsSoFar)   // 每收到增量调一次
 *   const text = p.render()  // 返回要显示的文本，null 表示无需更新
 */
export class StreamArgsPreview {
  constructor(toolName) {
    this.toolName = toolName || ''
    this.buf = ''
    this.truncated = false
    this.lastEmit = 0
    this.lastRendered = ''
    this.lastLineCount = 0
    this.startedAt = 0
  }

  /** 喂入截至目前的完整 arguments 字符串（不是增量）。 */
  feed(argsSoFar) {
    if (this.truncated) return
    if (!this.startedAt) this.startedAt = Date.now()
    const s = String(argsSoFar || '')
    if (s.length > MAX_ACCUMULATE) {
      this.buf = s.slice(0, MAX_ACCUMULATE)
      this.truncated = true
    } else {
      this.buf = s
    }
  }

  /**
   * 生成预览文本。返回 null 表示「这次不用更新」——
   * 调用方据此跳过渲染，这是节流的关键。
   */
  render({ force = false } = {}) {
    const now = Date.now()
    // 双闸：时间到了、或内容又多了若干行，任一满足就出帧。
    // 只看时间会在快速流里被全拦（详见 THROTTLE_MS 上方说明）。
    if (!force) {
      const curLines = (this.buf.match(/\\n/g) || []).length
      const grew = curLines - this.lastLineCount >= LINE_STEP
      if (!grew && now - this.lastEmit < THROTTLE_MS) return null
      this.lastLineCount = curLines
    }

    const parts = []
    // Edit 类工具不显示内容（对齐 Kimi Code main.mjs:504350 的 Preparing changes）：
    // old_string/new_string 是片段而非完整文件，逐行显示看不出上下文，
    // 用户真正需要知道的是「在准备改动、传了多少」。
    if (EDIT_LIKE.test(this.toolName)) {
      const path = extractField(this.buf, 'file_path') || extractField(this.buf, 'path') || ''
      const kb = this.buf.length >= 1024 ? `${(this.buf.length / 1024).toFixed(1)}KB` : `${this.buf.length}B`
      // 带耗时（对齐 Kimi 的 "... 1.2KB · 3s elapsed"）：Edit 不显示内容，
      // 只有字节数的话看不出「是在正常传还是卡住了」，耗时才是关键信号。
      const secs = this.startedAt ? Math.max(0, Math.floor((now - this.startedAt) / 1000)) : 0
      const text = `准备修改 ${path || '…'} · 已传 ${kb} · ${secs}s`
      if (text === this.lastRendered) return null
      this.lastEmit = now
      this.lastRendered = text
      return text
    }

    // Bash：流式显示命令本身（对齐 Kimi 的 command 分支）。
    // 多行脚本（heredoc、for 循环）逐行出现时有用；单行命令一瞬即完，
    // 靠调用方的延迟门槛决定要不要显示。
    if (/^Bash/.test(this.toolName)) {
      const cmd = extractField(this.buf, 'command', { allowUnclosed: true })
      if (cmd && cmd.trim()) {
        const all = cmd.split('\n')
        const startIdx = all.length > TAIL_LINES ? all.length - TAIL_LINES : 0
        const painted = highlightLines(all.slice(startIdx).map(l => cap(l, 200)), 'sh')
        const numbered = painted.map((line, i) => String(startIdx + i + 1).padStart(4) + '  ' + line)
        const text = `command（已 ${all.length} 行 / ${cmd.length} 字符）:\n${numbered.join('\n')}`
        if (text === this.lastRendered) return null
        this.lastEmit = now
        this.lastRendered = text
        return text
      }
    }

    // ── Memory：往 CLAUDE.md 追加，按 markdown 高亮滚动显示 ──────
    // 它没有 file_path，走通用分支拿不到语言（无高亮），标题也只会显示裸的
    // 「text」。这里单独处理，行为对齐 Write：尾部滚动窗口 + 原始行号 + 高亮。
    if (this.toolName === 'Memory') {
      const action = extractField(this.buf, 'action')
      // show / init 没有正文可滚，只报动作
      if (action && action !== 'append') {
        const text = `Memory ${action}`
        if (text === this.lastRendered) return null
        this.lastEmit = now
        this.lastRendered = text
        return text
      }
      const body = extractField(this.buf, 'text', { allowUnclosed: true })
      if (body != null) {
        const all = body.split('\n')
        const startIdx = all.length > TAIL_LINES ? all.length - TAIL_LINES : 0
        const painted = highlightLines(all.slice(startIdx).map(l => cap(l, 200)), 'md')
        const numbered = painted.map((line, i) => String(startIdx + i + 1).padStart(4) + '  ' + line)
        const text = `${MEMORY_LABEL}（已 ${all.length} 行 / ${body.length} 字符）:\n${numbered.join('\n')}`
        if (text === this.lastRendered) return null
        this.lastEmit = now
        this.lastRendered = text
        return text
      }
    }

    for (const key of SHORT_FIELDS) {
      const v = extractField(this.buf, key)
      if (v) { parts.push(`${key}: ${cap(v, 200)}`); break }  // 只取第一个命中的路径类字段
    }
    for (const key of LONG_FIELDS) {
      const v = extractField(this.buf, key, { allowUnclosed: true })
      if (v && v.trim()) {
        // 带原始行号输出（对齐 Kimi Code main.mjs:504393）：
        //   窗口滚动时行号必须继续递增，不能重置成 1，
        //   否则用户看不出「写到文件第几行了」。
        //   真实行号 = 总行数 - 窗口高度 + 窗口内下标
        const all = v.split('\n')
        const startIdx = all.length > TAIL_LINES ? all.length - TAIL_LINES : 0
        // 语法高亮：按扩展名判断语言。行号保持无色，避免跟代码抢视觉。
        const lang = langFromPath(extractField(this.buf, 'file_path') || extractField(this.buf, 'path') || '')
        const raw = all.slice(startIdx).map(l => cap(l, 200))
        const painted = highlightLines(raw, lang)
        const numbered = painted.map((line, i) =>
          String(startIdx + i + 1).padStart(4) + '  ' + line
        )
        parts.push(`${key}（已 ${all.length} 行 / ${v.length} 字符）:\n${numbered.join('\n')}`)
        break
      }
    }
    if (!parts.length) return null

    const text = parts.join('\n')
    // 内容没变就不重画，避免光标抖动
    if (text === this.lastRendered) return null
    this.lastEmit = now
    this.lastRendered = text
    return text
  }
}

/**
 * 哪些工具值得做流式预览。
 * 只读工具（Read/Grep）参数短、瞬间就完整了，做预览纯属闪烁；
 * 写入类和长文本类才有价值。
 */
export function shouldPreviewArgs(toolName) {
  // Memory 也算「写长文」：它往 CLAUDE.md 追加 markdown，值得跟 Write 一样滚动预览
  return ['Write', 'Edit', 'MultiEdit', 'ApplyPatch', 'HashlineEdit', 'Bash', 'Agent', 'Task', 'Memory'].some(
    n => String(toolName || '').startsWith(n)
  )
}
