// Claude Code Mobile - 高级行编辑
// 支持：光标移动、历史记录、多行粘贴、Ctrl 快捷键、Tab 补全
//
// 【已移除的键位，别照着注释加回来】触屏上无意义的都删了，
// tests/readline-wrap.test.mjs 锁死「按了不产生任何效果」：
//   Ctrl+R/G 历史搜索（^P/^N 翻历史够用；G 现在改作删排队消息）
//   Ctrl+W/K/U 删词/删到行尾/清行（长按退格更直接，Ctrl+C 能清行）
//   Ctrl+B/F 左右一格、Ctrl+D EOF（触屏点一下更快）

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, basename, dirname, join } from 'node:path'
import stringWidth from 'string-width'
// 【宽度/排版的单一权威实现】历史上同一语义在 readline / fullscreen /
// fullscreen-adapter / status-report 各写了一套，算法不同 → 光标类 bug 修一处、
// 另一处复发（card 残字 / 橙色角重复 / 压字 / 右移全是同一缺陷的多次爆发）。
// 现已收口到 core/width.mjs，本文件不再自己算宽度。
import * as W from './width.mjs'

/**
 * 规整粘贴文本：统一换行符，并剥掉可能混进来的 bracketed paste 标记。
 * 剥标记是防御性的——某些终端在嵌套/转发场景下会把标记塞进内容里，
 * 留着的话用户消息里会出现 `[200~` 这种乱码。
 */
function normalizePasted(text) {
  return String(text ?? '')
    .replace(/\x1b\[20[01]~/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

export class ReadLine {
  constructor({ prompt = '>>> ', historyFile = null, completers = {} } = {}) {
    this.prompt = prompt
    this.line = ''
    this.cursor = 0
    this.history = []
    this.histIndex = -1
    this.savedLine = ''
    this.onEnter = null
    this.onArrow = null
    this.onQueueEditExit = null  // 排队编辑态下用户开始改字时回调（上层清 queuedEditIndex）
    this.onHistoryUp = null      // 处理中接管 Ctrl+P：翻上一条排队消息
    this.onHistoryDown = null    // 处理中接管 Ctrl+N：翻下一条排队消息
    this.onQueueDelete = null    // 处理中接管 Ctrl+G：删除当前翻到的排队消息
    this.onQueueSend = null      // 处理中接管 Ctrl+S：把当前翻到的排队消息立刻发出去
    this.multiline = false
    this.multilineBuffer = ''
    this.collapsedPaste = null
    this.pasteCollapseThreshold = 200
    this.lastWidth = 0
    this.lastLine = ''
    this.lastPrompt = prompt
    // 上次渲染时的终端宽度。必须单独记录：cols 是 getter，每次读 process.stdout.columns，
    // 而 Termux 软键盘弹出/收起、旋转屏都会改变它。清旧内容要按「当时画了几行」清，
    // 用当前宽度重算会算错行数 → 清少了残留（叠字）/ 清多了上移越界（吞行）。
    this.lastCols = 0
    // 上次 render 结束时光标停在第几物理行（0-based）。
    // 清旧内容前要先回到第一物理行，上移量 = lastCursorRow，不是 lastRows-1。
    // 光标在中间行时（比如内容 2 行、光标在第 1 行），render 结束时光标并不在最后一行；
    // 按 lastRows-1 上移会越界到输入区上方 → 清掉上面的行 → 内容整体上移（吞行 + 叠字）。
    this.lastCursorRow = 0
    // Tab 补全
    this.completers = completers  // { command: [...], files: true/false }
    this.tabCandidates = null     // 当前补全候选列表
    this.tabIndex = -1            // 当前选中的候选索引
    this.tabStartPos = -1         // 补全起始位置
    this.tabOriginalText = ''     // 触发补全前的原始文本
    this._tabOrigCursor = null    // 进入补全时的光标位置（循环切换候选时算尾部用）
    // 不完整转义序列缓冲：处理 Termux 箭头键分片到达的情况
    this.pendingEscape = null
    this.pendingTimer = null
    // bracketed paste 跨 chunk 状态：粘贴大段文本时内核会分多次 read，
    // 收到 \x1b[200~ 后一直攒到 \x1b[201~ 才作为一个 paste 事件交出去
    this.inBracketedPaste = false
    this.pasteBuffer = ''
    // 全屏模式下 Enter 不能直接向 stdout 写换行：输入框由固定 footer 绘制，
    // 原始换行会把终端光标推入 footer/正文，slash 或多行错误输出后就会波及输入框。
    // 普通流式模式保持原行为，由上层设为 false。
    this.writeEnterNewline = true
    // 全屏模式下由上层注入界面恢复回调；Ctrl+I 遇到 slash 输入时仍优先补全。
    this.onFullscreenRefresh = null
    // 首次 Ctrl+I 建议输入：输入框为空时按下 Ctrl+I 会把这段文本填进去
    // （而不是做补全）。上层按场景注入（如「有历史会话时填 /resume」），
    // readline 本身不认识具体命令 —— 它只是个通用输入框。
    // 只生效一次，填过即清空，之后 Ctrl+I 恢复常规补全行为。
    this.firstInputSuggestion = null
  }

  setPrompt(p) { this.prompt = p }

  // 获取终端宽度
  get cols() {
    return process.stdout.columns || 80
  }

  // 计算字符串占用的终端宽度（考虑中文等宽字符）
  // 用 string-width 包（标准 wcwidth 实现，和终端渲染一致）。
  // 之前手写范围判断：对 emoji(😀=2列算1)、歧义宽度字符(Ambiguous-width)等会算错，
  // 导致折行位置估算错误 → 叠字（Claude Code Issue #37396/#14812 同款问题）。
  //
  // ⚠ 2026-08-21 教训：曾误判 ❯ (U+276F) 在 Termux 占 2 列，加覆盖表强制成 2 →
  // 光标每行多偏一格（"字右边的右边夹一个空格"）。实测 `printf '❯X\nabX\n'`
  // 两行 X 不对齐 = ❯ 占 1 列，string-width 判定本来就是对的。别再改这里。
  // 委托给 core/width.mjs（单一权威）。保留方法名是因为调用点很多，
  // 换实现不改接口 = 改动面最小、回归风险最低。
  // 它已处理：全部 CSI/OSC 零宽（不只颜色，还有 \x1b[3C 移动、\x1b[10G 列定位、
  // \x1b[2K 清行这些零宽序列）、emoji/组合字符、歧义宽度。
  strWidth(s) {
    return W.strWidth(s)
  }

  // 计算给定宽度占用的物理行数
  // 注意：width 是经过 strWidth 计算的字符总宽度
  // 但如果 line 中含有 \n（续行），\n 会强制折行——这种场景下不能用 width 直接除以 cols。
  // rowsForWidth 是简化版本，假设 line 内部无 \n。续行场景由调用方自行处理（见 render）。
  rowsForWidth(width) {
    const c = this.cols
    if (width === 0) return 1
    return Math.ceil(width / c)
  }

  // 逐字符模拟终端排版——全类光标/行数计算的唯一权威模型。
  // 【为什么必须逐字符，不能用 总宽度 % cols】
  // 宽字符（汉字/emoji 占 2 列）在行尾只剩 1 列时**不会被劈开**：终端把它整个推到下一行，
  // 原来那一列留空。旧算法用 `cursorCol % cols` 反推光标列，完全不知道这次「跳格」，
  // 于是光标列偏左 1 格 → 压在宽字符的右半格上（视觉上就是光标压字）。
  // 中英混排最容易触发（英文宽 1，容易正好停在边界剩 1 列），而且每跳一格误差累积一格，
  // 所以「第一行末尾卡一下，第二行开始压字，行数越多越严重」。
  // 返回 rows 物理行数、cursorRow/cursorCol 光标 0-based 行列（cursorCol 可能等于 cols，
  // 表示 deferred wrap：末列已写满但尚未真正换行）、endRow/endCol 内容末尾位置。
  _simulateLayout(prompt, line, cols = null, cursorIndex = null) {
    // 【已收口到 core/width.mjs】裸 readline 场景传 reserveWrapRow:false ——
    // 恰好铺满一行时光标**保持末列**（终端 deferred wrap 的真实状态），
    // 不主动跳到下一行首；全屏输入区是虚拟屏幕、需要真实占一行承载光标，
    // 那边传 true。这个开关就是历史上「两处满行语义冲突」的统一解。
    // 【坐标系转换】本方法的 cursorIndex 是**原始字符串的 code unit 索引**
    //（调用方用 rl.cursor，那是 line.slice 用的索引）；
    // width.layout 的 cursor 是**cell 索引**（剥 ANSI 后按 code point 切分）。
    // 直接透传会让光标错位——代理对（emoji）占 2 个 code unit 但只有 1 个 cell，
    // ANSI 序列占多个 code unit 但 0 个 cell。这里显式换算。
    let cursorCell = null
    if (cursorIndex != null) {
      const s = String(line || '')
      const stop = Math.max(0, Math.min(cursorIndex, s.length))
      cursorCell = 0
      let i = 0
      while (i < stop) {
        const m = /^(?:\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB0-2]|\x1b[=>])/.exec(s.slice(i))
        if (m) { i += m[0].length; continue }        // ANSI：占 code unit，不占 cell
        const cp = s.codePointAt(i)
        i += String.fromCodePoint(cp).length
        cursorCell++
      }
    }
    const r = W.layout(prompt, line, {
      cols: cols || this.cols,
      cursor: cursorCell,
      reserveWrapRow: false,
    })
    // 字段名兼容旧调用点：rows（旧）= rowCount（新）
    return {
      rows: r.rowCount,
      cursorRow: r.cursorRow,
      cursorCol: r.cursorCol,
      endRow: r.endRow,
      endCol: r.endCol,
    }
  }


  // 计算指定 prompt+line 组合的实际物理行数（考虑 \n 硬换行 + 宽字符不劈开的折行）
  rowsForContent(prompt, line, cols = null) {
    const c = cols || this.cols
    if (c <= 0) return 1
    return Math.max(1, this._simulateLayout(prompt, line, c).rows)
  }

  // 内部统一接口：根据 line + prompt 算物理行数
  // cols 可显式传入——算「上次画了几行」时必须传 lastCols，不能用当前 cols
  _rowsFor(line, prompt, cols = null) {
    return this.rowsForContent(prompt || this.prompt, line || '', cols)
  }

  getDisplayLine() {
    return this.collapsedPaste?.label || this.line
  }

  expandCollapsedPaste({ render = true } = {}) {
    if (!this.collapsedPaste) return false
    this.collapsedPaste = null
    if (render) this.render()
    return true
  }

  // 渲染当前行（Termux 兼容方案，支持超宽折行 + \n 续行）
  render() {
    const displayLine = this.getDisplayLine()
    const visible = this.prompt + displayLine
    const width = this.strWidth(visible)
    const c = this.cols

    // 计算上次和本次的物理行数（考虑 \n 续行）
    // lastRows 必须用「上次渲染时的宽度」算：屏幕上那几行是当时按 lastCols 折的，
    // 用现在的 c 重算会得到错误行数（软键盘弹出/收起会改变 columns）。
    const lastRows = this._rowsFor(
      this.lastLine || '', this.lastPrompt || this.prompt, this.lastCols || c)
    const newRows = this._rowsFor(displayLine, this.prompt, c)

    // 清除旧内容：先从「上次光标实际停留的行」回到第一物理行。
    // 关键：上移量是 lastCursorRow，不是 lastRows-1。
    // 上次 render 结束时光标被定位到 cursorRow，可能不是最后一行（光标在中间行编辑时）。
    // 用 lastRows-1 会多上移，怼到输入区上方 → 清掉上面的行 → 内容整体上移。
    const upFromCursor = Math.min(this.lastCursorRow || 0, Math.max(0, lastRows - 1))
    if (upFromCursor > 0) {
      process.stdout.write(`\x1b[${upFromCursor}A`)
    }
    // 每行用 \x1b[2K（erase in line）清整行——标准清行，含最后一列，不动光标不触发 wrap。
    for (let r = 0; r < lastRows; r++) {
      process.stdout.write('\r\x1b[2K')
      if (r < lastRows - 1) {
        process.stdout.write('\n')  // 下移到下一物理行
      }
    }
    // 清完后光标在最后一物理行，回到第一物理行行首
    if (lastRows > 1) {
      process.stdout.write(`\x1b[${lastRows - 1}A\r`)
    } else {
      process.stdout.write('\r')
    }

    // 写入新内容
    process.stdout.write(visible)
    this.lastWidth = width
    this.lastLine = displayLine
    this.lastPrompt = this.prompt
    this.lastCols = c   // 记下本次画的时候是多宽，下次清行按这个算
    // 光标定位：统一走逐字符排版模拟器（_simulateLayout）。
    // 它精确复刻终端 wrap 行为（宽字符不劈开、deferred wrap），
    // 旧的「总宽 % cols」反推法在宽字符跳格后行列全错 → 光标压字、越编越歪。
    let cursorRow = 0
    let cursorInCol = 0
    const visualCursor = this.collapsedPaste ? displayLine.length : this.cursor
    const layout = this._simulateLayout(this.prompt, displayLine, c, visualCursor)
    cursorRow = layout.cursorRow
    cursorInCol = layout.cursorCol
    // 【满行语义已统一由 core/width.mjs 处理】
    // 传 reserveWrapRow:false（裸 readline）时，layout 已把「恰好铺满」的光标
    // 归到**末列**（cols-1），不会再返回 >= cols 的值。
    // 所以这里不需要（也不能）再做一次满行判断——历史上正是「两处各判一次、
    // 语义还不一致」造成光标压字反复复发。单一权威 = 只有一处能定这件事。
    if (cursorInCol >= 0) {
      // 先 \r 清掉写完 visible 后可能存在的 wrap-pending 并回行首，
      // 再做行/列移动，杜绝「移动指令固化换行」的历史坑。
      process.stdout.write('\r')
      if (cursorRow > layout.endRow) {
        process.stdout.write(`\x1b[${cursorRow - layout.endRow}B`)
      } else if (cursorRow < layout.endRow) {
        process.stdout.write(`\x1b[${layout.endRow - cursorRow}A`)
      }
      // \x1b[<col>G 绝对列（1-based，cursorInCol 是 0-based 所以 +1；不跨行，安全）
      if (cursorInCol > 0) process.stdout.write(`\x1b[${cursorInCol + 1}G`)
    }
    // 记下光标最终停在第几行，下次 render/printAbove 清旧内容时从这里往上回。
    // cursorInCol===-1（末尾 pending）时物理光标在 endRow 行末列。
    this.lastCursorRow = cursorInCol >= 0 ? cursorRow : layout.endRow
  }

  // 插入文本（支持批量粘贴；长文本先显示为 chip，Ctrl+I 展开）
  insert(text) {
    const value = String(text ?? '')
    const before = this.line
    const at = this.cursor
    this.line = before.slice(0, at) + value + before.slice(at)
    this.cursor += value.length
    // 折叠判据（2026-09-11 用户反馈：两行短句也被折叠，太激进）：
    //   - 无换行：>= pasteCollapseThreshold(200) 字符
    //   - 有换行：>= 60 字符 或 >= 4 行（两三行短句直接显示，不折叠）
    //   - 输入框已有内容时粘贴长文本也折叠（原来只在空行折叠 → 撑爆输入区）
    const lines = value.includes('\n') ? value.split('\n').length : 1
    const longEnough = value.length >= this.pasteCollapseThreshold ||
      (lines >= 4) || (value.includes('\n') && value.length >= 60)
    if (!this.collapsedPaste && longEnough) {
      this.collapsedPaste = {
        label: `[长文本 ${value.length} 字符${lines > 1 ? `，${lines} 行` : ''}；Ctrl+I 展开]`,
        length: value.length,
        lines,
      }
    }
  }

  // 在提示符上方打印一段文字（不干扰当前输入行）
  // 用于异步问候等场景：先清当前行，回车打印文字，再重新渲染提示符+已有输入
  printAbove(text) {
    const c = this.cols
    // 上移到本行行首（考虑 \n 续行多行情况）
    // 同 render：屏幕上那几行是按 lastCols 折的，必须用 lastCols 算
    const lastRows = this._rowsFor(
      this.lastLine || '', this.lastPrompt || this.prompt, this.lastCols || c)
    // 同 render：从光标实际所在行往上回，不能假设光标在最后一行
    const upFromCursor = Math.min(this.lastCursorRow || 0, Math.max(0, lastRows - 1))
    if (upFromCursor > 0) process.stdout.write(`\x1b[${upFromCursor}A`)
    process.stdout.write('\r\x1b[2K')   // 清当前行
    if (lastRows > 1) {
      // 清掉所有占用的物理行
      for (let r = 0; r < lastRows - 1; r++) {
        process.stdout.write('\n\x1b[2K')
      }
      process.stdout.write(`\x1b[${lastRows - 1}A\r`)
    }
    // 打印文字
    process.stdout.write(text + '\n')
    // 重新渲染当前输入行
    this.lastWidth = 0
    this.lastLine = ''
    this.lastCols = 0
    this.lastCursorRow = 0   // 屏幕已清，下次 render 不需要清旧行
    this.render()
  }

  // 流式 raw 输出（不分行拆解）：保留 prompt 不动
  // 做法和 printAbove 类似，但 text 可能不带 \n，所以先换行+输出+强制换行
  printAboveRaw(text) {
    if (!text) return
    // 上移到 prompt 行的行首 + 清掉 prompt（考虑 \n 续行多行情况）
    const lastRows = this._rowsFor(
      this.lastLine || '', this.lastPrompt || this.prompt, this.lastCols || this.cols)
    // 同 render：从光标实际所在行往上回，不能假设光标在最后一行
    const upFromCursor = Math.min(this.lastCursorRow || 0, Math.max(0, lastRows - 1))
    if (upFromCursor > 0) process.stdout.write(`\x1b[${upFromCursor}A`)
    process.stdout.write('\r\x1b[2K')
    if (lastRows > 1) {
      for (let r = 0; r < lastRows - 1; r++) {
        process.stdout.write('\n\x1b[2K')
      }
      process.stdout.write(`\x1b[${lastRows - 1}A\r`)
    }
    // 直接输出文字，确保以换行结尾，render 从新行开始
    process.stdout.write(text)
    if (!text.endsWith('\n')) process.stdout.write('\n')
    // 重新渲染 prompt + 已有输入
    this.lastWidth = 0
    this.lastLine = ''
    this.lastCols = 0
    this.lastCursorRow = 0
    this.render()
  }

  // 处理单次 data 事件
  handleData(data) {
    // 如果有挂起的转义序列，拼接到前面
    if (this.pendingEscape !== null) {
      data = this.pendingEscape + data
      this.pendingEscape = null
      if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null }
    }
    // 先尝试解析转义序列
    const events = this.parseData(data)
    // 如果解析后仍留下未完成的转义序列，开 50ms 超时丢弃
    if (this.pendingEscape !== null && !this.pendingTimer) {
      this.pendingTimer = setTimeout(() => {
        this.pendingEscape = null
        this.pendingTimer = null
      }, 50)
    }
    for (const ev of events) {
      this.handleEvent(ev)
      if (ev.type === 'enter' && this.onEnter) {
        // render 由 onEnter 后处理
      }
    }
  }

  parseData(data) {
    const events = []
    const raw = String(data ?? '')
    // 记录本批数据的到达时间与特征，供下面 \r 的"分片粘贴"判定使用。
    // 判定要在更新之前读旧值，所以先取出来。
    const _prevChunkAt = this._lastChunkAt || 0
    const _prevWasPasteish = this._lastEventWasPasteish || false
    this._lastChunkAt = Date.now()
    // 本批含换行且长度 >1 → 像粘贴的一部分（人类不会一次输入里带换行还接着别的字）
    this._lastEventWasPasteish = raw.length > 1 && /[\r\n]/.test(raw)
    this._prevChunkAt = _prevChunkAt
    this._prevWasPasteish = _prevWasPasteish

    // ─────────── bracketed paste（\x1b[200~ ... \x1b[201~）───────────
    // 这是唯一可靠的粘贴边界判定：终端明确告诉我们"这段是粘贴的"，
    // 于是里面的换行一律当普通字符，绝不误认成回车提交。
    // 必须支持跨 chunk：内核送大段文本会分多次 read，
    // 结束标记 \x1b[201~ 往往在好几个 chunk 之后才到。
    if (this.inBracketedPaste) {
      const endIdx = raw.indexOf('\x1b[201~')
      if (endIdx === -1) {
        this.pasteBuffer += raw          // 还没收完，继续攒
        return []
      }
      const text = this.pasteBuffer + raw.slice(0, endIdx)
      this.pasteBuffer = ''
      this.inBracketedPaste = false
      const rest = raw.slice(endIdx + 6)  // '\x1b[201~'.length === 6
      const evs = [{ type: 'paste', text: normalizePasted(text) }]
      // 结束标记后面可能紧跟真实按键（比如用户粘完立刻按回车）
      if (rest) evs.push(...this.parseData(rest))
      return evs
    }
    const startIdx = raw.indexOf('\x1b[200~')
    if (startIdx !== -1) {
      // 起始标记之前的部分是正常按键，先按普通流程解析
      const before = raw.slice(0, startIdx)
      const evs = before ? this.parseData(before) : []
      this.inBracketedPaste = true
      this.pasteBuffer = ''
      const after = raw.slice(startIdx + 6)
      // 同一 chunk 里就出现了结束标记 → 递归走上面那个分支收尾
      return [...evs, ...this.parseData(after)]
    }

    // ─────────── 以下是没有 bracketed paste 时的启发式兜底 ───────────
    // 终端不支持 ?2004 时（或通过管道喂输入）靠这套猜。
    //
    // 【必须同时认 \r】Termux/Android 的粘贴常把换行发成 CR(\x0d) 而不是 LF。
    // 原来这里只 includes('\n')，而且排除字符类 [\x00-\x08\x0b\x0c\x0e-\x1f]
    // 恰好**包含 \x0d**，于是含 \r 的粘贴两个条件都不满足 → 掉进逐字符路径，
    // 每个 \r 都被当成回车提交 → 三行提示词变成三条消息发出去（实测踩到）。
    const hasNewline = /[\r\n]/.test(raw)
    // 除换行外的控制字符/转义序列才说明"这是按键而非粘贴"
    const hasOtherCtrl = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x1b]/.test(raw)
    if (raw.length >= 2 && hasNewline && !hasOtherCtrl) {
      return [{ type: 'paste', text: normalizePasted(raw) }]
    }
    if (raw.length >= this.pasteCollapseThreshold && !/[\x00-\x1f\x7f\x1b]/.test(raw)) {
      return [{ type: 'paste', text: raw }]
    }
    let i = 0
    const chars = [...raw]  // 正确处理多字节 UTF-8

    while (i < chars.length) {
      const ch = chars[i]

      // Ctrl+C
      if (ch === '\x03') { events.push({ type: 'ctrl-c' }); i++; continue }

      // 回车 / 换行（必须在 Ctrl 检测之前，因为 \r=0x0D 属于 \x01-\x1a 范围）
      if (ch === '\r') {
        // 【分片粘贴兜底】终端不支持 bracketed paste 时，大段粘贴会被内核分成
        // 多次 read 送来，落在分片边界上的 \r 会被当成"用户按了回车"→ 一段提示词
        // 被拆成好几条消息发出去。人类连续敲两次回车最快也要 ~80ms，
        // 而分片是同一次粘贴的延续，间隔通常 <20ms。所以极短间隔内又来 \r，
        // 判为粘贴换行（newline，只插入不提交）。
        const gap = this._lastChunkAt - (this._prevChunkAt || 0)
        const isPasteContinuation = this._prevWasPasteish && gap < 30
        events.push({ type: isPasteContinuation ? 'newline' : 'enter' })
        i++
        if (i < chars.length && chars[i] === '\n') i++
        continue
      }
      if (ch === '\n') { events.push({ type: 'newline' }); i++; continue }

      // Ctrl+按键（排除 \r 已处理）
      if (ch >= '\x01' && ch <= '\x1a') {
        const key = String.fromCharCode(ch.charCodeAt(0) + 96) // a-z
        events.push({ type: 'ctrl', key })
        i++
        continue
      }

      // 转义序列
      if (ch === '\x1b') {
        // ESC 单独到达 — Termux 会分片发送箭头键（先 \x1b 再 [C）
        // 缓冲等下一段 data，不急着当作 standalone ESC
        if (i + 1 >= chars.length) {
          this.pendingEscape = '\x1b'
          i++
          continue
        }
        const next = chars[i + 1]
        if (next === '[') {
          const rest = chars.slice(i).join('')
          const modifiedEnter = rest.match(/^\x1b\[(?:13;2u|27;2;13~|13;3u|27;3;13~)/)
          if (modifiedEnter) {
            events.push({ type: 'newline' })
            i += modifiedEnter[0].length
            continue
          }
          // CSI 序列
          let j = i + 2
          let num = ''
          while (j < chars.length && chars[j] >= '0' && chars[j] <= '9') {
            num += chars[j]
            j++
          }
          if (j < chars.length) {
            const final = chars[j]
            const n = num || '1'
            if (final === 'A') events.push({ type: 'arrow', dir: 'up' })
            else if (final === 'B') events.push({ type: 'arrow', dir: 'down' })
            else if (final === 'C') events.push({ type: 'arrow', dir: 'right' })
            else if (final === 'D') events.push({ type: 'arrow', dir: 'left' })
            else if (final === 'H') events.push({ type: 'home' })
            else if (final === 'F') events.push({ type: 'end' })
            else if (final === '~') {
              if (n === '1' || n === '7') events.push({ type: 'home' })
              else if (n === '4' || n === '8') events.push({ type: 'end' })
              else if (n === '3') events.push({ type: 'delete' })
              else if (n === '2') events.push({ type: 'insert' })
            }
            i = j + 1
            continue
          }
          // CSI 序列被截断（[ 后或数字后没终结符）— 缓冲等下一段
          this.pendingEscape = chars.slice(i).join('')
          i = chars.length
          continue
        }
        // Alt+键 — ESC 后面没有更多字符，缓冲
        if (i + 1 >= chars.length) {
          this.pendingEscape = '\x1b'
          i++
          continue
        }
        // Alt+Enter：部分 Termux 输入法编码为 ESC + CR/LF
        if (next === '\r' || next === '\n') {
          events.push({ type: 'newline' })
          i += 2
          continue
        }
        // Alt+键
        events.push({ type: 'alt', key: next })
        i += 2
        continue
      }

      // 退格
      if (ch === '\x7f' || ch === '\x08') { events.push({ type: 'backspace' }); i++; continue }

      // Tab
      if (ch === '\t') { events.push({ type: 'tab' }); i++; continue }

      // 普通可打印字符（包括多字节）
      if (ch >= ' ') {
        // 收集连续的可打印字符（批量插入，提升粘贴性能）
        let batch = ''
        while (i < chars.length && chars[i] >= ' ' && chars[i] !== '\x7f') {
          batch += chars[i]
          i++
        }
        events.push({ type: 'text', text: batch })
        continue
      }

      // 其他控制字符跳过
      i++
    }
    return events
  }

  handleEvent(ev) {
    // Tab 补全
    if (ev.type === 'text' && ev.text === '\t') return // Tab 不作为文本
    // 命令面板激活：text 输入转发给面板查询框，不进主输入行
    if (this._paletteInput && ev.type === 'text') {
      this._paletteInput(ev.text)
      return
    }
    switch (ev.type) {
      case 'text':
        this.tabCandidates = null  // 输入后重置补全
        this._tabOrigCursor = null
        if (this.collapsedPaste) this.expandCollapsedPaste({ render: false })
        // 排队编辑态：用户开始改字 → 通知上层退出"选中某条排队消息"模式
        if (this.onQueueEditExit) this.onQueueEditExit()
        this.insert(ev.text)
        this.render()
        break

      case 'paste':
        this.tabCandidates = null
        this._tabOrigCursor = null
        if (this.collapsedPaste) this.expandCollapsedPaste({ render: false })
        if (this.onQueueEditExit) this.onQueueEditExit()
        this.insert(ev.text)
        this.render()
        break

      case 'backspace':
        // 面板激活：退格删查询字符
        if (this._paletteInput) { this._paletteInput('\b'); break }
        this.tabCandidates = null
        this._tabOrigCursor = null
        if (this.collapsedPaste) this.expandCollapsedPaste({ render: false })
        if (this.cursor > 0) {
          this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor)
          this.cursor--
          this.render()
        }
        break

      case 'tab':
        // 弹层激活时 Tab 交给 overlay 切页（_overlayTab 由 core/overlay.mjs 设置）
        if (this._overlayTab) { this._overlayTab('\t'); break }
        if (this.collapsedPaste) {
          this.expandCollapsedPaste()
          break
        }
        this.handleTab()
        break

      case 'delete':
        if (this.collapsedPaste) this.expandCollapsedPaste({ render: false })
        if (this.cursor < this.line.length) {
          this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1)
          this.render()
        }
        break

      case 'arrow':
        try {
          if (this.onArrow?.(ev.dir) === true) break
        } catch {}
        this.handleArrow(ev.dir)
        break

      case 'newline':
        if (this.collapsedPaste) this.expandCollapsedPaste({ render: false })
        this.insert('\n')
        this.render()
        break

      case 'home':
        this.cursor = 0
        this.render()
        break

      case 'end':
        this.cursor = this.line.length
        this.render()
        break

      case 'ctrl':
        if (ev.key === 'j') {
          if (this.collapsedPaste) this.expandCollapsedPaste({ render: false })
          this.insert('\n')
          this.render()
          break
        }
        this.handleCtrl(ev.key)
        break

      case 'ctrl-c':
      case 'esc':
        // 由上层处理
        break

      case 'enter': {
        // 先把本次输入提交到上一行，再清空内部状态，最后回调上层。
        // 旧顺序是先回调、后清空；processInput/旧 run 的异步收尾可能在
        // readline 清空前后交错，导致输入消失、续行多出空行或回车要按两次。
        const line = this.line
        if (this.writeEnterNewline) process.stdout.write('\n')
        this.line = ''
        this.cursor = 0
        this.collapsedPaste = null
        this.lastWidth = 0
        this.lastLine = ''
        this.lastCols = 0
        this.lastCursorRow = 0
        if (this.onEnter) this.onEnter(line)
        break
      }
    }
  }

  handleArrow(dir) {
    switch (dir) {
      case 'left':
        if (this.cursor > 0) {
          this.cursor--
          this.render()
        }
        break
      case 'right':
        if (this.cursor < this.line.length) {
          this.cursor++
          this.render()
        }
        break
      case 'up':
      case 'down':
        // 非全屏模式也不再用 ↑↓ 翻历史：手机有 Ctrl+P/N，
        // ↑↓ 留给系统/全屏正文滚动，避免一不小心改掉输入框。
        break
    }
  }

  handleCtrl(key) {
    switch (key) {
      // Ctrl+G：删除当前用 Ctrl+P/N 翻到的那条排队消息。
      // 原来排队消息只能改、不能删——发错了只能等它执行，或者改成一句废话。
      //
      // 【无队列时必须保持无操作】这个键位历史上是「历史搜索」，因为触屏没意义
      // 已被移除，tests/readline-wrap 里锁了「按了不产生任何效果」。
      // 不要顺手把它做成「清空当前行」—— Ctrl+C 已经能清行，重复功能还会破坏该约定。
      case 'g':
        if (this.onQueueDelete) this.onQueueDelete()
        break
      // Ctrl+S：把当前翻到的排队消息【立刻发出去】（2026-10-03 用户要求）。
      //
      // 【解决什么】排队消息原来是「等当前轮跑完才轮到它」。
      // 但有时候用户排的那条更急（比如「停一下，改个方向」），
      // 干等前一轮跑完可能要好几分钟。
      //
      // 【和 Ctrl+C 的区别】Ctrl+C 是打断当前轮再放行队列，
      // Ctrl+S 是**不打断当前轮**、把指定那条插到队首优先执行。
      // 两者互补：不想中断当前工作、但想让某条先跑时用 Ctrl+S。
      //
      // 【为什么选 s】a/e/i/p/n/f/d/k/u/w/r/l/j/g/c/t/y/o 都已占用
      // （见下方看板注释里的键位表）。s = Send，语义贴切。
      case 's':
        if (this.onQueueSend) this.onQueueSend()
        break
      case 'a': // 行首
        this.cursor = 0
        this.render()
        break
      case 'i': { // Ctrl+I：有折叠粘贴先展开（手机无 Tab 键）；否则 slash/路径补全；再否则全屏界面恢复
        if (this.collapsedPaste) { this.expandCollapsedPaste(); break }
        // 首次建议输入：输入框为空时优先填建议文本（只生效一次）。
        // 判据「输入框为空」保证不会覆盖用户已经打的字。
        if (this.firstInputSuggestion && !String(this.line ?? '').trim()) {
          const s = this.firstInputSuggestion
          this.firstInputSuggestion = null
          this.insert(s)
          this.render()
          break
        }
        const line = String(this.line ?? '')
        const hasSlashInput = line.trimStart().startsWith('/')
        if (!hasSlashInput && typeof this.onFullscreenRefresh === 'function') {
          this.onFullscreenRefresh()
        } else {
          this.handleTab()
        }
        break
      }
      case 'e': // 行尾
        this.cursor = this.line.length
        this.render()
        break
      case 'p': // 上一条历史；处理中且有排队消息时改为翻排队队列
        if (this.onHistoryUp && this.onHistoryUp() === true) break
        this.historyUp()
        break
      case 'n': // 下一条历史；同上
        if (this.onHistoryDown && this.onHistoryDown() === true) break
        this.historyDown()
        break
      case 'l': // 清屏：全屏模式交给上层清空正文缓冲（否则 render() 会把旧正文重新画回来）
        this.lastWidth = 0
        this.lastLine = ''
        this.lastCols = 0
        this.lastCursorRow = 0
        if (typeof this.onClearScreen === 'function') {
          this.onClearScreen()
          break
        }
        process.stdout.write('\x1b[2J\x1b[H')
        this.render()
        break
      // 看板折叠：交给上层（全屏适配器）处理，readline 本身不管显示策略。
      // 选这三个键是因为 a/e/i/p/n/f/d/k/u/w/r/l/j/g/c 都已占用
      //（b 原先也被占，已释放给「拉到底部」）。
      case 't': // Todo 待办看板
      case 'y': // activitY 活动看板（命令/自主任务/子 Agent）
      case 'o': // 全部（One shot 收起/展开）
        if (this.onToggleBoard) this.onToggleBoard(key)
        break
      // Ctrl+B：快速拉到底部（Bottom）并恢复跟随。
      //
      // 【为什么需要】配合 Sticky Scroll：用户上翻看历史后处于「脱离跟随」状态，
      // 想回到最新内容只能一路按 ↓。Ctrl+B 一步到位。
      // 注：v 1.0 时代的 Ctrl+B 曾是「光标左移」，那是触屏无意义的键位，早已移除，
      // 现在这个位置是空的。
      case 'b':
        if (typeof this.onScrollBottom === 'function') this.onScrollBottom()
        break
      // Ctrl+H：收起/展开顶部欢迎页（Header）。
      // 欢迎页那几行 logo 是固定 header，小屏上一直占着地方，
      // 折叠后只留第一行（Welcome to Claude Code vX），正文可视区多出几行。
      //
      // ⚠ 有些终端把 Backspace 发成 \x08（= Ctrl+H）。本项目的 backspace
      // 在 424~517 行那段的 `ch === '\x7f' || ch === '\x08'` 里【先于】
      // Ctrl 分派被拦掉，所以走到这里的 'h' 一定是真的 Ctrl+H，不会误吃退格。
      // 改那段拦截顺序时要留意这个依赖。
      case 'h':
        // 【2026-09-22】原来这里还兼「折叠/展开欢迎页」。**已移除**：
        // 欢迎页现在属于滚动内容（随正文滚出视野），不再悬浮固定在顶部，
        // 折叠功能失去意义。老的悬浮版才需要它（小屏时折起来多留几行正文）。
        // 现在 'h' 只服务于弹层翻页。
        if (this._overlayTab) { this._overlayTab('h'); break }
        break
    }
  }


  // ─── Tab 补全 ─────────────────────────────────────────
  handleTab() {
    // 首次 Tab：生成候选列表
    if (this.tabCandidates === null) {
      // 记下进入补全时的光标位置：后续循环切换候选要靠它算尾部
      this._tabOrigCursor = this.cursor
      this.generateCandidates()
      if (this.tabCandidates.length === 0) { this._tabOrigCursor = null; return }
      if (this.tabCandidates.length === 1) {
        // 唯一匹配：直接补全
        this.tabOriginalText = this.line
        this.applyCompletion(this.tabCandidates[0])
        this.tabCandidates = null
        this._tabOrigCursor = null
        this._tabOrigCursor = null
        return
      }
      this.tabIndex = 0
      this.tabOriginalText = this.line
      // 应用第一个候选
      this.applyCompletion(this.tabCandidates[0])
      return
    }
    // 多次 Tab：循环切换候选
    this.tabIndex = (this.tabIndex + 1) % this.tabCandidates.length
    // 恢复原始文本再应用新候选
    this.line = this.tabOriginalText.slice(0, this.tabStartPos)
    this.cursor = this.tabStartPos
    this.applyCompletion(this.tabCandidates[this.tabIndex])
  }

  generateCandidates() {
    const lineBeforeCursor = this.line.slice(0, this.cursor)
    this.tabCandidates = []
    this.tabStartPos = 0

    // 命令补全：以 / 开头
    if (lineBeforeCursor.startsWith('/')) {
      const cmdPart = lineBeforeCursor.slice(1)
      const spaceIdx = cmdPart.indexOf(' ')
      if (spaceIdx === -1 && this.completers.commands) {
        // 补全命令名。忽略大小写：全屏模式的实时补全面板用的是 toLowerCase 比较，
        // 这里如果大小写敏感，打 /C 时面板列出候选而 Tab 却补不出来，两边不一致。
        this.tabStartPos = 1  // /之后
        const lower = cmdPart.toLowerCase()
        this.tabCandidates = this.completers.commands
          .filter(c => c.toLowerCase().startsWith(lower))
      } else if (spaceIdx !== -1 && this.completers.subcommands) {
        // 已输入命令名 + 空格：补全子命令（如 /config <tab> → 1 2 3 model thinking ...）
        const cmdName = cmdPart.slice(0, spaceIdx)
        const subPart = cmdPart.slice(spaceIdx + 1)
        const subMap = this.completers.subcommands[cmdName]
        if (subMap) {
          // candidates 支持**函数**（惰性求值）：静态数组在启动时就定死了，
          // 而角色卡（/agents reload 后）、Provider 列表这类候选是运行时会变的。
          // 写成函数就能每次补全现读，不必重启。
          const rawCandidates = Array.isArray(subMap) ? subMap : subMap.candidates
          let subs = []
          try {
            subs = typeof rawCandidates === 'function' ? (rawCandidates() || []) : (rawCandidates || [])
          } catch { subs = [] }
          const subLower = subPart.toLowerCase()
          const filtered = subs.filter(s => s.toLowerCase().startsWith(subLower))
          if (filtered.length > 0) {
            this.tabStartPos = lineBeforeCursor.length - subPart.length
            this.tabCandidates = filtered
          }
        }
      }
    }
    // 文件补全：最后一个参数如果是路径
    else if (this.completers.files) {
      const parts = lineBeforeCursor.split(/\s+/)
      const lastPart = parts[parts.length - 1]
      if (lastPart && (lastPart.startsWith('/') || lastPart.startsWith('./') || lastPart.startsWith('../') || lastPart.includes('/') || parts.length > 1)) {
        this.tabStartPos = lineBeforeCursor.lastIndexOf(lastPart)
        this.tabCandidates = this.completeFilePath(lastPart)
      }
    }
  }

  completeFilePath(partial) {
    let dir, prefix
    if (partial.includes('/')) {
      dir = dirname(partial)
      prefix = basename(partial)
      if (!partial.startsWith('/') && !partial.startsWith('./') && !partial.startsWith('../')) {
        dir = './' + dir
      }
    } else {
      dir = '.'
      prefix = partial
    }
    try {
      const fullDir = resolve(dir)
      if (!existsSync(fullDir)) return []
      const entries = readdirSync(fullDir)
      const matches = entries.filter(e => e.startsWith(prefix))
      return matches.map(m => {
        const fullPath = dir === '.' ? m : join(dir, m)
        try {
          return statSync(join(fullDir, m)).isDirectory() ? fullPath + '/' : fullPath
        } catch {
          return fullPath
        }
      })
    } catch {
      return []
    }
  }

  applyCompletion(completion) {
    // 截断到 tabStartPos，然后拼上 completion
    // tabOriginalText 可能在唯一匹配时未设，兜底用当前 line
    const orig = this.tabOriginalText ?? this.line
    // 尾部必须按【原始光标位置】取，不能用 this.cursor —— handleTab 的循环分支
    // 会先把 cursor 改成 tabStartPos，此时 orig.slice(this.cursor) 会把原来的
    // 命令名当成尾部又接回来：/c 按第二次 Tab 补出 "/compact-thresholdc"（多个 c）。
    if (this._tabOrigCursor === undefined || this._tabOrigCursor === null) {
      this._tabOrigCursor = this.cursor
    }
    const tailFrom = Math.max(this.tabStartPos, Math.min(this._tabOrigCursor, orig.length))
    this.line = orig.slice(0, this.tabStartPos) + completion + orig.slice(tailFrom)
    this.cursor = this.tabStartPos + completion.length
    this.render()
  }

  historyUp() {
    if (this.history.length === 0) return
    if (this.histIndex === -1) {
      this.savedLine = this.line
      this.histIndex = this.history.length - 1
    } else if (this.histIndex > 0) {
      this.histIndex--
    }
    this.line = this.history[this.histIndex] || ''
    this.collapsedPaste = null
    this.cursor = this.line.length
    this.render()
  }

  historyDown() {
    if (this.histIndex === -1) return
    if (this.histIndex < this.history.length - 1) {
      this.histIndex++
      this.line = this.history[this.histIndex] || ''
      this.collapsedPaste = null
    } else {
      this.histIndex = -1
      this.line = this.savedLine
      this.collapsedPaste = null
    }
    this.cursor = this.line.length
    this.render()
  }

  addHistory(line) {
    if (line && line.trim() && (this.history.length === 0 || this.history[this.history.length - 1] !== line)) {
      this.history.push(line)
      if (this.history.length > 200) this.history.shift()
    }
    this.histIndex = -1
    this.savedLine = ''
  }

  reset() {
    this.line = ''
    this.cursor = 0
    this.histIndex = -1
    this.savedLine = ''
    this.collapsedPaste = null
    this.lastWidth = 0
    this.lastLine = ''
    this.lastCols = 0
    this.lastCursorRow = 0
  }
}
