// Claude Code Mobile - 流式 Markdown 渲染器（换行门控版）
//
// 【设计】参考 Codex 的 markdown_stream：以「源文本的换行边界」为唯一记账单位。
// 每收到一个完整行就判断它能否独立渲染：
//   - 能（标题/引用/列表/分割线/普通文本）→ 立刻渲染吐出，不等空行
//   - 不能（代码块 fence 内、表格连续行）→ 攒进缓冲，等结构收尾再整块渲染
//
// 【为什么改】旧实现把普通文本也攒到「空行」才 flush 整段。模型输出末尾常常
// 没有空行收尾，于是最后一段要靠 end() 兜底才出来；流断在非边界处就直接丢正文。
// 而 renderMarkdown 里真正需要跨行状态的只有代码块和表格两种，普通行逐行渲染
// 结果完全一致（见 markdown.mjs：heading/quote/list/hr/text 都是 continue 即输出）。
//
// 【不变量】
//   1. lastEmittedEnd 只在「消费掉一个完整行」时前进，永不跨越未闭合的多字符结构
//   2. onEmit 收到的每个片段都已是终态（调用方可直接写屏或塞 pendingText）
//   3. end() 负责把所有未闭合结构落地，不允许静默丢内容

import { renderMarkdown } from './markdown.mjs'

// 闭合 fence：开头是 ```（可带语言标识），必须顶格
function isClosingFence(line) {
  return /^```/.test(line)
}

// 表格行：| 开头且 | 结尾
function isTableLine(line) {
  const t = line.trim()
  return t.startsWith('|') && t.endsWith('|')
}

export class StreamMarkdownRenderer {
  constructor(onEmit = () => {}) {
    this.onEmit = onEmit      // 渲染片段回调：onEmit(renderedString)
    this.buffer = ''
    this.lastEmittedEnd = 0   // buffer 里已消费到的位置（只按整行前进）
    this.inCodeBlock = false
    this.codeLinesPending = []
    this.codeLang = ''
    this.tableRowsPending = []  // 表格必须整块渲染（要对齐列宽）
  }

  feed(text) {
    this.buffer += text

    while (this.lastEmittedEnd < this.buffer.length) {
      // 代码块内：逐行判断闭合。
      // 不用 indexOf('\n```')——流式 chunk 边界任意，'\n' 已到而反引号未齐时
      // 会把 lastEmittedEnd 推过那个 '\n'，之后再也匹配不到，代码块永远等不到闭合。
      if (this.inCodeBlock) {
        const nlIdx = this.buffer.indexOf('\n', this.lastEmittedEnd)
        if (nlIdx === -1) break  // 半截行，等更多（可能是不带换行的收尾 fence）
        const line = this.buffer.slice(this.lastEmittedEnd, nlIdx)
        this.lastEmittedEnd = nlIdx + 1
        if (isClosingFence(line)) this._flushCodeBlock()
        else this.codeLinesPending.push(line)
        continue
      }

      const nlIdx = this.buffer.indexOf('\n', this.lastEmittedEnd)
      if (nlIdx === -1) break  // 还没完整一行
      const line = this.buffer.slice(this.lastEmittedEnd, nlIdx)
      this.lastEmittedEnd = nlIdx + 1

      // 代码块开始
      const fence = line.match(/^```(\w*)/)
      if (fence) {
        this._flushTable()
        this.inCodeBlock = true
        this.codeLang = fence[1] || ''
        this.codeLinesPending = []
        continue
      }

      // 表格行：攒着（列宽要看齐所有行才能算）
      if (isTableLine(line)) {
        this.tableRowsPending.push(line)
        continue
      }
      // 表格刚结束
      if (this.tableRowsPending.length > 0) this._flushTable()

      // 空行：直接输出换行（段落间距）
      if (line.trim() === '') {
        this.onEmit('\n')
        continue
      }

      // 其余全部逐行独立渲染：标题、引用、列表、分割线、普通文本。
      // 这是换行门控的核心——不再等空行，行到即出。
      this.onEmit(renderMarkdown(line) + '\n')
    }

    // ══════════════════════════════════════════════════════════════
    //  【2026-09-27 修「Responding… 卡死」的真凶】
    // ══════════════════════════════════════════════════════════════
    //
    // 原来这里**只累加不截断**：`this.buffer += text` 之后虽然用
    // `lastEmittedEnd` 标记了「消费到哪」，但 buffer 本身从不收缩。
    // 于是一轮回复内 buffer 单调增长到几万字，而每次 feed() 的 `+=`
    // 都要**复制整个 buffer** → O(n²)，越到后面每帧越慢。
    //
    // 【实测证据】ontext-slow.log：
    //   [04:22:52] onText 慢 297ms | mdFeed=296.5 | len=2
    //   ↑ 本次只喂了 2 个字符，却花了 296ms —— 说明开销与本次输入无关，
    //     而与累积 buffer 大小有关。其它样本 len=1 也要 32~93ms，同源。
    //   freeze.log 同时段：卡死 3883ms，RSS 327~503MB。
    //   （freeze.log 已于 2026-10-03 随卡死检测功能删除，此处为历史记录）
    //
    // 修法：消费完就把已消费的前缀丢掉，只保留「还没处理完的尾巴」
    // （半截行 / 未闭合代码块 / 未对齐的表格）。这一步是 O(未消费长度)，
    // 通常是几十字节。
    if (this.lastEmittedEnd > 0 && this.lastEmittedEnd <= this.buffer.length) {
      this.buffer = this.buffer.slice(this.lastEmittedEnd)
      this.lastEmittedEnd = 0
    }
  }

  _flushTable() {
    if (this.tableRowsPending.length === 0) return
    const md = this.tableRowsPending.join('\n')
    this.tableRowsPending = []
    this.onEmit(renderMarkdown(md) + '\n')
  }

  _flushCodeBlock() {
    const block = '```' + this.codeLang + '\n' + this.codeLinesPending.join('\n') + '\n```'
    this.onEmit(renderMarkdown(block) + '\n')
    this.codeLinesPending = []
    this.inCodeBlock = false
    this.codeLang = ''
  }

  end() {
    if (this.inCodeBlock) {
      const tail = this.buffer.slice(this.lastEmittedEnd)
      if (isClosingFence(tail.trim())) {
        this._flushCodeBlock()
      } else if (this.codeLinesPending.length > 0 || tail) {
        // 真未闭合：原样 dump，不能吞
        this.onEmit('```' + this.codeLang + '\n')
        for (const l of this.codeLinesPending) this.onEmit(l + '\n')
        if (tail) this.onEmit(tail)
      }
      this.reset()
      return
    }

    // 未闭合的表格先落地
    this._flushTable()

    // buffer 里最后一行没带 \n 的尾巴
    if (this.lastEmittedEnd < this.buffer.length) {
      const tail = this.buffer.slice(this.lastEmittedEnd)
      if (isTableLine(tail)) this.onEmit(renderMarkdown(tail) + '\n')
      else if (tail.trim() !== '') this.onEmit(renderMarkdown(tail) + '\n')
      else this.onEmit(tail)
    }
    this.reset()
  }

  /**
   * 软 flush：把**已经完整成行**的内容吐出去，但不 reset、不动未完成状态。
   *
   * 用途：带实时窗口的工具（Edit/Write）在开窗前要先把正文吐干净，
   * 否则窗口先出现、正文晚一步才补上，屏幕上就是 ● 独占一行 + 顺序颠倒。
   *
   * 为什么不能直接用 end()：end() 会 reset，而且在代码块中途会把未闭合的
   * ``` 原样 dump 出来 —— 工具正好在代码块中间调用时会直接破坏输出。
   * 这里遇到代码块/表格未闭合就**什么都不做**，等它自然闭合。
   */
  flushSoft() {
    // 代码块或表格没闭合时不动：中途吐出会破坏结构
    if (this.inCodeBlock || this.tableRowsPending.length > 0) return
    // 【2026-08-30】允许吐出「无换行尾巴」：正文「我来修复这个bug。」后面通常没有
    // \n，旧逻辑把它留在 buffer 里 → 工具窗口先出、正文整段晚一步才补上。
    // 这是开窗时序 bug 的根因。有 \n 吐到 \n 后，没有则吐到 buffer 末尾。
    const nl = this.buffer.lastIndexOf('\n', this.buffer.length - 1)
    const stop = (nl >= this.lastEmittedEnd) ? nl + 1 : this.buffer.length
    if (stop <= this.lastEmittedEnd) return
    const seg = this.buffer.slice(this.lastEmittedEnd, stop)
    if (!seg) return
    const lines = seg.split('\n')
    const tailNoNl = !seg.endsWith('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const isLast = i === lines.length - 1
      if (line === '' && isLast) continue // 结尾 \n 切出的空尾巴，跳过
      if (tailNoNl && isLast) {
        // 无换行的活尾巴：不加 \n，避免凭空多一个空行
        this.onEmit(renderMarkdown(line))
      } else {
        this.onEmit(renderMarkdown(line) + '\n')
      }
    }
    this.lastEmittedEnd = stop
  }

  reset() {
    this.buffer = ''
    this.lastEmittedEnd = 0
    this.inCodeBlock = false
    this.codeLinesPending = []
    this.codeLang = ''
    this.tableRowsPending = []
  }
}
