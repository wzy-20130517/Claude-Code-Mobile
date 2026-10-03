/**
 * core/width.mjs — 终端显示宽度 / 换行 / 光标定位的【单一权威来源】
 *
 * 背景：readline.mjs、fullscreen.mjs、fullscreen-adapter.mjs、status-report.mjs
 * 各有一套宽度与换行实现，导致光标类 bug 修一处、另一处复发。此处是唯一实现，
 * 消费方只许调用本模块，不许再自己数列。
 *
 * 铁律 1（ANSI 必须整串剥离）：
 *   绝不能逐字符调用 strWidth。单独传 '\x1b' / '[' / '2' / 'm' 时正则匹配不到，
 *   四个字符各算 1 列，带色 prompt 会让光标右移 6~8 格。
 *   → 所有布局函数先 stripAnsi 一次，再按【码点】遍历。
 *
 * 铁律 2（满行边界光标归属）：
 *   abs = promptWidth + 光标前文本宽度；row = floor(abs/cols)、col = abs%cols。
 *   当 abs > 0 且 col === 0（恰好压在满行边界）时：
 *     - 若 row 这一行在渲染区内（row < rows）→ 光标落 row 行第 0 列（下一行首）
 *     - 否则 → 退回 (row-1, cols-1) 末列，即终端的 deferred wrap 行为
 *   rows 是否为满行多留一行由 reserveWrapRow 决定：
 *     全屏输入区多留（光标去下一行首），裸 readline 不留（光标停末列）。
 *   两种历史期望由此统一，不是两套语义。
 */

// CSI 序列 / OSC 序列 / 单字符转义
const ANSI_RE =
  /[\u001b\u009b](?:\[[0-9;:?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g

/** 剥掉所有 ANSI 转义序列。必须整串调用。 */
export function stripAnsi(s) {
  return typeof s === 'string' ? s.replace(ANSI_RE, '') : ''
}

/** 单个【码点】的显示宽度：0（零宽/控制）、1（窄）、2（East Asian Wide / emoji）。 */
export function charWidth(cp) {
  if (cp == null || Number.isNaN(cp)) return 0
  // 控制字符与 DEL
  if (cp < 0x20 || cp === 0x7f) return 0
  // 零宽、组合记号、变体选择符
  if (
    cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff ||
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  ) return 0
  // East Asian Wide / Fullwidth + 常用 emoji 面
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2
  return 1
}

/** 字符串显示宽度（先整串剥 ANSI，再按码点累加）。 */
export function strWidth(s) {
  const plain = stripAnsi(s)
  let w = 0
  for (const ch of plain) w += charWidth(ch.codePointAt(0))
  return w
}

/**
 * 把字符串切成 [{ch, w}] 码点单元（已剥 ANSI）。布局函数的共同底座。
 * 注意：返回的是【可见字符】序列，索引与原始带色字符串不对应。
 */
export function cells(s) {
  const out = []
  for (const ch of stripAnsi(s)) out.push({ ch, w: charWidth(ch.codePointAt(0)) })
  return out
}

/** 规范化列宽：非法值兜底 80，最小 1。 */
export function normCols(cols) {
  const c = Number(cols)
  return Number.isFinite(c) && c >= 1 ? Math.floor(c) : 80
}

/**
 * 按显示宽度硬换行（不做单词边界处理，宽字符不劈半）。
 * @returns {string[]} 每段是一物理行的可见文本；空串返回 ['']
 */
export function wrapToWidth(s, cols) {
  const c = normCols(cols)
  const rows = []
  let cur = ''
  let w = 0
  for (const { ch, w: cw } of cells(s)) {
    if (ch === '\n') { rows.push(cur); cur = ''; w = 0; continue }
    if (w + cw > c) { rows.push(cur); cur = ''; w = 0 }
    cur += ch
    w += cw
  }
  rows.push(cur)
  return rows
}

/**
 * 布局 prompt + line，并算出光标位置。唯一的换行/光标真值来源。
 *
 * @param {string} prompt 可带 ANSI 颜色（整串剥离，不影响列数）
 * @param {string} line   输入内容
 * @param {object} [opt]
 * @param {number} [opt.cols]           终端列宽
 * @param {number} [opt.cursor]         光标在 line 中的【可见字符索引】，默认末尾
 * @param {boolean} [opt.reserveWrapRow=false]
 *        满行时是否多留一物理行。true（全屏输入区）→ 光标落下一行首；
 *        false（裸 readline）→ 光标停末列（deferred wrap）。
 * @returns {{rows:string[], rowCount:number, cursorRow:number, cursorCol:number, width:number}}
 *          cursorRow/cursorCol 都是 0-based；调用方自己 +1 转 CSI。
 */
export function layout(prompt, line, opt = {}) {
  const cols = normCols(opt.cols)
  const pw = strWidth(prompt)
  const lineCells = cells(line)
  const cur = opt.cursor == null
    ? lineCells.length
    : Math.max(0, Math.min(lineCells.length, Math.floor(opt.cursor)))

  // 光标绝对列 = prompt 宽 + 光标前文本宽
  let abs = pw
  for (let i = 0; i < cur; i++) abs += lineCells[i].w

  const rows = wrapToWidth(stripAnsi(prompt) + lineCells.map(x => x.ch).join(''), cols)
  let rowCount = rows.length

  const total = pw + lineCells.reduce((a, x) => a + x.w, 0)
  const atFullEdge = total > 0 && total % cols === 0
  if (opt.reserveWrapRow && atFullEdge) rowCount += 1

  // 【不能用 abs % cols 反推行列】宽字符（汉字/emoji 占 2 格）在行尾只剩 1 列时
  // **不会被劈开**：终端把它整体推到下一行，原来那一列留空（跳格）。
  // 取模完全感知不到这次跳格 → 每跳一格误差累积一格 → 光标压在宽字符右半格上。
  // 中英混排最容易触发（英文宽 1，容易正好停在边界剩 1 列）。
  // 实测：40 列 + prompt2 + 37个x + 汉，取模算出 col=1，实际应为 col=2。
  // 这正是本模块要终结的那类 bug，所以这里必须逐 cell 模拟终端行为。
  const walk = (untilIdx) => {
    let row = 0, col = 0
    // prompt 先入（已剥 ANSI，按可见宽推进）
    for (const cell of cells(stripAnsi(prompt))) {
      if (col + cell.w > cols) { row++; col = 0 }
      col += cell.w
    }
    for (let i = 0; i < untilIdx; i++) {
      const cell = lineCells[i]
      if (cell.ch === '\n') { row++; col = 0; continue }
      if (cell.w > 0 && col + cell.w > cols) { row++; col = 0 }
      col += cell.w
    }
    return { row, col }
  }

  const at = walk(cur)
  let cursorRow = at.row
  let cursorCol = at.col
  const end = cur === lineCells.length ? at : walk(lineCells.length)

  // 铁律 2：满行边界（col 顶到 cols）的归属由「是否保留 wrap 行」决定。
  // reserveWrapRow=true（全屏虚拟输入区）→ 落到下一行首，需要真实占一行承载光标；
  // false（裸 readline）→ 保持末列，即终端 deferred wrap 的真实状态。
  // 铁律 2（完整版）：光标恰好顶到行尾（col === cols）时归属哪一行，
  // 由**光标后面还有没有内容**决定，这比单看调用方更本质：
  //   · 后面还有内容 → 那一行确实会继续被写满并折行，光标属于**下一行行首**。
  //     此时把它留在末列就会压在已有字符上（宽字符尤其明显：压右半格）。
  //   · 光标在内容末尾 → 终端处于 deferred wrap（末列之后、尚未真正换行），
  //     **保持末列**才是终端的真实状态；强行跳行会先固化那次换行、导致错位。
  // reserveWrapRow 只在「末尾满行」这一种情况下起作用：全屏虚拟输入区需要
  // 真实占一行来承载光标（否则光标画到边框上），裸 readline 不需要。
  // 历史上这两个场景被当成「两套冲突的语义」各写一套实现，才有了反复复发的压字 bug。
  if (cursorCol >= cols) {
    const hasMoreAfterCursor = cur < lineCells.length
    if (hasMoreAfterCursor || opt.reserveWrapRow) {
      cursorRow += 1
      cursorCol = 0
    } else {
      cursorCol = cols - 1
    }
  }

  return {
    rows, rowCount, cursorRow, cursorCol, width: total,
    endRow: end.row,
    endCol: Math.min(end.col, cols),
  }
}

/** 只要行数（旧 rowsForWidth / _inputRows.length 的替代）。 */
export function rowsFor(prompt, line, opt = {}) {
  return Math.max(1, layout(prompt, line, opt).rowCount)
}

/** 按显示宽度右填充（表格/状态栏对齐用，替代 padEnd 对宽字符的误算）。 */
export function padTo(s, target, fill = ' ') {
  const need = Math.max(0, normCols(target) - strWidth(s))
  return s + fill.repeat(need)
}

/** 按显示宽度截断，保证不超过 max 列，宽字符不劈半。 */
export function truncTo(s, max, ellipsis = '') {
  const cap = Math.max(0, Math.floor(Number(max) || 0))
  const ew = strWidth(ellipsis)
  let out = ''
  let w = 0
  for (const { ch, w: cw } of cells(s)) {
    if (w + cw > cap - (ellipsis ? ew : 0)) return out + ellipsis
    out += ch
    w += cw
  }
  return out
}

/**
 * 按显示宽度截断，但【保留 ANSI 转义序列】。
 *
 * 为什么不能用 truncTo：truncTo 走 cells()，cells 会整串 stripAnsi，
 * 于是带色文本被截断后颜色全丢。终端面板（补全候选、活动看板）每一行都带
 * dim/橙色/反显，掉色等于换了一套视觉，不可接受。
 *
 * 与消费方各自手写的版本相比，这里堵掉两类误用（都真实存在过）：
 *   1) 逐字符算宽 —— 见铁律 1。按【码点】前进，emoji 代理对不会被劈成
 *      两个各算 1 列的半字符。
 *   2) 只认 SGR（\x1b[…m）—— 光标移动/OSC 等序列会被当成可见字符计入宽度。
 *      这里复用统一的 ANSI_RE（sticky 版），认全部序列。
 *
 * @param {string} s        原始串（可带 ANSI）
 * @param {number} max      最大显示列数
 * @param {string} ellipsis 截断时追加的省略标记（如 '…'，其宽度已计入 max）
 * @param {boolean} reset   截断时是否补 \x1b[0m 收尾（默认 true）。
 *                          必须补：截断可能把原串的 reset 切掉，颜色会泄漏到后续输出。
 *                          未发生截断时原串自带的 reset 还在，不额外补。
 */
export function truncAnsi(s, max, ellipsis = '', reset = true) {
  const str = typeof s === 'string' ? s : ''
  const cap = Math.max(0, Math.floor(Number(max) || 0))
  const ew = strWidth(ellipsis)
  const budget = ellipsis ? Math.max(0, cap - ew) : cap
  const re = new RegExp(ANSI_RE.source, 'y')
  let out = ''
  let w = 0
  let i = 0
  let sawAnsi = false
  while (i < str.length) {
    re.lastIndex = i
    const m = re.exec(str)
    if (m && m.index === i) {          // ANSI：原样保留，不占列
      out += m[0]
      i += m[0].length
      sawAnsi = true
      continue
    }
    const cp = str.codePointAt(i)
    const ch = String.fromCodePoint(cp) // 按码点前进，代理对整体处理
    const cw = charWidth(cp)
    if (w + cw > budget) {              // 放不下就停，宽字符不劈半
      return out + ellipsis + (sawAnsi && reset ? '\x1b[0m' : '')
    }
    out += ch
    w += cw
    i += ch.length
  }
  return out                            // 没截断：原串的 reset 仍在，不补
}

export default { stripAnsi, charWidth, strWidth, cells, normCols, wrapToWidth, layout, rowsFor, padTo, truncTo, truncAnsi }
