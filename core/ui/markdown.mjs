// Claude Code Mobile - Markdown 终端渲染
// 支持：代码块、加粗、斜体、行内代码、标题、列表、表格、引用
//
// 宽度计算一律走 core/width.mjs（唯一权威来源）。本文件曾有一份自造的
// strWidth，只剥 CSI 颜色序列、手列 Unicode 区段，实测 5 处算错：
//   · OSC 序列（如设置终端标题）整串当可见字符 → 一行多算 10 列，表格直接画歪
//   · emoji 面（U+1F300+）没算宽、零宽连接符按 1 列算、变体选择符没算 0
//   · 控制字符（\t 等）按 1 列算
// 表格列宽依赖它，算错就是错位，所以收口掉。
import { strWidth, stripAnsi } from './width.mjs'

/**
 * Markdown 样式主题。
 *
 * 【2026-09-19 加】用户要求：「看官方的 Markdown 样式，它和我们不一样，
 * 把官方的也做进来，但我们这版保留，可以用 slash 命令切换，比如 /markdown 经典/鲜艳」。
 *
 * 两套：
 *   · classic（经典）—— 我们原有的 ANSI 16 色方案。终端兼容性最好，
 *     老旧终端/主题色被用户改过时也不会花。
 *   · official（官方）—— 对齐官方 claude-code 的 dark 主题真彩色值
 *     （~/cc-src/claude-code-main/utils/theme.ts 的 darkTheme）。
 *     官方用 RGB 真彩色，层次更细腻；Termux 支持 truecolor，能正常显示。
 *
 * 切换用 /markdown classic|official（见 core/cmd-*.mjs）。
 * 主题存在 config.json 的 markdownTheme 字段，重启保留。
 *
 * ⚠ 结构约定：两套主题的**键必须完全一致**（下面 THEME_KEYS 是权威清单），
 * 缺键会让对应元素静默失去颜色。加新键时两套都要加。
 */

/** 主题键清单 —— 两套主题都必须提供这些键，测试会校验。 */
export const THEME_KEYS = [
  'reset', 'bold', 'dim', 'italic', 'underline',
  'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'gray',
  'bgBlue', 'bgGray',
  // 语义色（官方主题用真彩色，经典主题映射到最接近的 ANSI 色）
  'h1', 'h2', 'h3', 'h4', 'quote', 'bullet', 'link', 'linkUrl',
  'codeLang', 'codeComment', 'codeString', 'codeKeyword', 'codeNumber',
  'tableBorder', 'tableHeader',
]

/** 经典：ANSI 16 色。兼容性优先。 */
const THEME_CLASSIC = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bgBlue: '\x1b[44m',
  bgGray: '\x1b[48;5;238m',
  // 语义色 = 原来的映射关系（保持既有观感不变）
  h1: '\x1b[36m',          // cyan
  h2: '\x1b[34m',          // blue
  h3: '',                    // 仅加粗
  h4: '\x1b[2m',            // dim
  quote: '\x1b[90m',        // gray
  bullet: '\x1b[36m',       // cyan
  link: '\x1b[36m',         // cyan
  linkUrl: '\x1b[2m',       // dim
  codeLang: '\x1b[2m',
  codeComment: '\x1b[2m',
  codeString: '\x1b[32m',   // green
  codeKeyword: '\x1b[35m',  // magenta
  codeNumber: '\x1b[33m',   // yellow
  tableBorder: '\x1b[2m',
  tableHeader: '\x1b[1m',
}

/**
 * 官方：真彩色，取值来自官方 darkTheme（utils/theme.ts:440）。
 * 只取 Markdown 渲染用得到的那部分，不是整份主题。
 */
const THEME_OFFICIAL = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  // 基础色用真彩色（官方 permission / success / warning / error 等）
  red: '\x1b[38;2;255;107;128m',      // error
  green: '\x1b[38;2;78;186;101m',     // success
  yellow: '\x1b[38;2;255;193;7m',     // warning
  blue: '\x1b[38;2;71;130;200m',      // ide
  magenta: '\x1b[38;2;175;135;255m',  // autoAccept (electric violet)
  cyan: '\x1b[38;2;0;204;204m',       // background (bright cyan)
  gray: '\x1b[38;2;153;153;153m',     // inactive
  bgBlue: '\x1b[48;2;39;47;111m',     // rate_limit_empty
  bgGray: '\x1b[48;2;55;55;55m',      // userMessageBackground 同系
  // 语义色
  h1: '\x1b[38;2;215;119;87m',        // claude orange —— 官方品牌色，标题最醒目
  h2: '\x1b[38;2;177;185;249m',       // permission (light blue-purple)
  h3: '\x1b[38;2;147;165;255m',       // claudeBlue
  h4: '\x1b[38;2;153;153;153m',       // inactive
  quote: '\x1b[38;2;136;136;136m',    // promptBorder (medium gray)
  bullet: '\x1b[38;2;215;119;87m',    // claude orange
  link: '\x1b[38;2;177;185;249m',     // permission
  linkUrl: '\x1b[38;2;136;136;136m',  // promptBorder
  codeLang: '\x1b[38;2;153;153;153m', // inactive
  codeComment: '\x1b[38;2;128;128;128m',
  codeString: '\x1b[38;2;78;186;101m',   // success
  codeKeyword: '\x1b[38;2;175;135;255m', // autoAccept
  codeNumber: '\x1b[38;2;255;193;7m',    // warning
  tableBorder: '\x1b[38;2;136;136;136m',
  tableHeader: '\x1b[1m\x1b[38;2;215;119;87m',  // 加粗 + 品牌橙
}

export const THEMES = {
  classic: THEME_CLASSIC,
  official: THEME_OFFICIAL,
}

/** 当前生效的主题名。默认 classic（保持用户既有观感，不擅自改变）。 */
let currentThemeName = 'classic'

/**
 * 切换 Markdown 主题。
 * @returns {boolean} 主题名是否有效并已切换
 */
export function setMarkdownTheme(name) {
  const key = String(name || '').trim().toLowerCase()
  if (!THEMES[key]) return false
  currentThemeName = key
  return true
}

export function getMarkdownTheme() { return currentThemeName }

/** 可用主题名（供补全/帮助）。 */
export function markdownThemeNames() { return Object.keys(THEMES) }

/**
 * 当前主题对象。用 Proxy 而不是每次取 `THEMES[currentThemeName]`，
 * 是为了让下面 28 处 `C.xxx` 的写法**完全不用改** —— 主题切换后它们自动跟着变。
 */
const C = new Proxy({}, {
  get(_t, key) {
    const theme = THEMES[currentThemeName] || THEME_CLASSIC
    return theme[key] !== undefined ? theme[key] : ''
  },
})

// 渲染 Markdown 文本为带 ANSI 颜色的终端输出
export function renderMarkdown(text) {
  if (!text) return ''
  const lines = text.split('\n')
  const output = []
  let inCodeBlock = false
  let codeLang = ''
  let codeLines = []
  let inTable = false
  let tableRows = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 代码块边界
    const fence = line.match(/^```(\w*)/)
    if (fence) {
      if (inCodeBlock) {
        // 结束代码块
        output.push(renderCodeBlock(codeLines, codeLang))
        codeLines = []
        inCodeBlock = false
        codeLang = ''
      } else {
        // 开始代码块
        inCodeBlock = true
        codeLang = fence[1] || ''
      }
      continue
    }
    if (inCodeBlock) {
      codeLines.push(line)
      continue
    }

    // 表格
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      // 分隔行跳过
      if (line.match(/^\|[\s:|-]+\|$/)) continue
      tableRows.push(line)
      inTable = true
      // 预读下一行
      if (i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) continue
      // 下一行不是表格了，输出
      if (inTable && tableRows.length > 0) {
        output.push(renderTable(tableRows))
        tableRows = []
        inTable = false
      }
      continue
    } else if (inTable) {
      if (tableRows.length > 0) output.push(renderTable(tableRows))
      tableRows = []
      inTable = false
    }

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)/)
    if (heading) {
      const level = heading[1].length
      const content = renderInline(heading[2])
      const prefix = '▐ '
      if (level === 1) output.push(`${C.bold}${C.h1}${prefix}${content}${C.reset}`)
      else if (level === 2) output.push(`${C.bold}${C.h2}${prefix}${content}${C.reset}`)
      else if (level === 3) output.push(`${C.bold}${C.h3}${content}${C.reset}`)
      else output.push(`${C.h4}${C.bold}${content}${C.reset}`)
      continue
    }

    // 引用块
    if (line.match(/^>\s?/)) {
      const content = renderInline(line.replace(/^>\s?/, ''))
      output.push(`${C.quote}│ ${content}${C.reset}`)
      continue
    }

    // 无序列表
    if (line.match(/^\s*[-*+]\s/)) {
      const indent = line.match(/^(\s*)/)[1].length
      const content = renderInline(line.replace(/^\s*[-*+]\s+/, ''))
      const bullet = indent > 0 ? '  • ' : `${C.bullet}•${C.reset} `
      output.push(' '.repeat(indent) + bullet + content)
      continue
    }

    // 有序列表
    if (line.match(/^\s*\d+\.\s/)) {
      const num = line.match(/^\s*(\d+)\.\s/)
      const content = renderInline(line.replace(/^\s*\d+\.\s+/, ''))
      output.push(`${C.bullet}${num[1]}.${C.reset} ${content}`)
      continue
    }

    // 分割线
    if (line.match(/^(-{3,}|={3,}|_{3,})$/)) {
      output.push(`${C.tableBorder}${'─'.repeat(Math.min(60, process.stdout.columns || 60))}${C.reset}`)
      continue
    }

    // 空行
    if (line.trim() === '') {
      output.push('')
      continue
    }

    // 普通文本
    output.push(renderInline(line))
  }

  // 收尾
  if (inCodeBlock && codeLines.length > 0) {
    output.push(renderCodeBlock(codeLines, codeLang))
  }
  if (inTable && tableRows.length > 0) {
    output.push(renderTable(tableRows))
  }

  return output.join('\n')
}

// 代码块渲染
function renderCodeBlock(lines, lang) {
  const langTag = lang ? `${C.bgGray}${C.codeLang} ${lang} ${C.reset}` : ''
  const code = lines.join('\n')
  // 简单语法高亮：注释、字符串、关键字
  // 【2026-09-20 修：official 主题下高亮被自己的颜色值污染】
  //
  // 原来四步 replace 顺序执行，每一步插入的 ANSI 序列会被**后续步骤**再次匹配。
  // classic 的序列是 `\x1b[35m`（无独立数字）所以看不出来；
  // official 用真彩色 `\x1b[38;2;175;135;255m`，里面的 38 / 2 / 175 / 135 / 255
  // 全被最后那步「数字高亮」`\b(\d+)\b` 命中 → 序列被打碎成乱码。
  //
  // 修法：把每步的匹配结果换成**哨兵**，全部步骤跑完再统一还原成颜色序列。
  // 这样任何一步都看不到前一步插入的 ESC。
  //
  // ⚠⚠ 踩了两次坑，都记在这里免得再犯：
  //   1. 第一版每步 `protect()` 新建 stash 数组 → 前面的序列被丢掉，
  //      屏幕上直接显示 \x00 0 \x01 控制字符，比原 bug 还糟。
  //   2. 第二版哨兵写成 `\x00<数字>\x01` → **哨兵里的数字被"数字高亮"步骤匹配**，
  //      于是 `\x00` 被当成普通字符留下、下标被染成黄色，颜色全错。
  //      （我一边写着"要防止后续步骤污染"，一边用数字做哨兵，等于没防。）
  //
  // 现在：哨兵用**纯字母**（\x00a\x01 / \x00b\x01 …），不可能被任何
  // markdown 正则（注释/字符串/关键字/数字）命中；stash 是行级共享的一个数组。
  const SENTINEL_OPEN = (i) => `\x00${String.fromCharCode(97 + (i % 26))}\x01`
  const SENTINEL_RESET = '\x00z\x01'
  const highlighted = code.split('\n').map(line => {
    const colors = []
    const mark = (color, text) => {
      colors.push(color)
      return SENTINEL_OPEN(colors.length - 1) + text + SENTINEL_RESET
    }

    let result = line
    // 注释
    result = result.replace(/(\/\/.*$|#.*$)/g, (m) => mark(C.codeComment, m))
    // 字符串 —— 线性扫描替代回溯正则
    //
    // 【2026-09-27 修：正则回溯导致终端永久卡死】
    // 原正则：/(['"`])((?:[^\\${'`"}]*|\\.)*?)\1/g
    // 问题：字符集排除不完整 + 非贪婪回溯 → 未闭合引号时指数级回溯
    //       （实测 28 字符 > 2 秒，终端永久卡死）。
    //
    // 线性扫描：O(n) 遍历，遇到引号时找最近的同类型闭合引号，
    // 找不到就原样保留（不高亮），绝不回溯。
    result = highlightStringsLinear(result, mark, C.codeString)
    // 关键字
    result = result.replace(/\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|new|this|throw|try|catch|finally|typeof|instanceof|null|undefined|true|false)\b/g, (m) => mark(C.codeKeyword, m))
    // 数字
    result = result.replace(/\b(\d+)\b/g, (m) => mark(C.codeNumber, m))

    // 还原：字母哨兵 → 颜色序列
    const rendered = result
      .replace(/\x00([a-y])\x01/g, (_, ch) => colors[ch.charCodeAt(0) - 97] ?? '')
      .replace(/\x00z\x01/g, C.reset)
    return `${C.codeComment}  ${rendered}`
  }).join('\n')
  return `${langTag}\n${highlighted}\n${C.reset}`
}

// 表格渲染
function renderTable(rows) {
  const parsed = rows.map(r => {
    return r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
  })
  if (parsed.length === 0) return ''
  const cols = Math.max(...parsed.map(r => r.length))
  // 计算每列宽度。
  //
  // ⚠ 必须用 **renderInline 之后**的宽度，不是原始 cell：
  //   行内代码 `` `x` `` 渲染后少了两个反引号、链接 `[t](u)` 渲染后多一个空格。
  //   用原始宽度算列宽，基准本身就是错的 —— 后面 pad 算得再对也对不齐
  //  （2026-09-16 用户截图：表格右边框参差不齐）。
  const cellW = (cell) => {
    try { return strWidth(renderInline(cell)) } catch { return strWidth(cell) }
  }
  const widths = new Array(cols).fill(0)
  for (const row of parsed) {
    for (let c = 0; c < cols; c++) {
      const w = cellW(row[c] || '')
      if (w > widths[c]) widths[c] = w
    }
  }
  // 总宽度 = 边框(1) + 每列(内容宽+2空格) + 列间分隔(cols-1) + 边框(1)
  const totalWidth = 1 + widths.reduce((s, w) => s + w + 2, 0) + (cols - 1) + 1
  const ttyCols = process.stdout.columns || 80
  // 超宽/超窄 → 用列表形式显示（key: value），避免窄屏错位
  if (totalWidth > ttyCols) {
    const headerCells = parsed[0] || []
    // ⚠ 从 r=1 开始：表头在这种降级渲染里只当**标签**用（`表头: 单元格`），
    //   它自己不是数据行。原来从 r=0 起，表头行也走了一遍配对逻辑 →
    //   header 和 cell 都是表头文字，输出 `元素: 元素 | 官方: 官方`
    //   （2026-09-13 用户截图发现）。
    //
    // 【2026-09-15 修：不再把整行塞成一行】
    // 原来每行输出 `${header}: ${cell} | ${header2}: ${cell2}`，**完全不管宽度**。
    // 表格之所以走到这里，正是因为 totalWidth > ttyCols —— 而拼出来的这一行
    // 只会比表格更宽（还有 ` | ` 和 `表头:` 的额外开销）。结果就是：
    // 终端硬折行 → 第二行从行首开始、看不出属于哪个字段，比不降级还乱
    //（用户截图为证：数据行掉在表格框外面）。
    //
    // 现在改成：每条记录紧凑排版 —— 序号与第一个字段同行，后续字段缩进换行，
    // 字段过长再按可用宽度软换行。无论多窄都不会溢出，且「哪段属于哪个字段」始终清楚。
    const lines = []
    let idx = 0
    for (let r = 1; r < parsed.length; r++) {
      const row = parsed[r]
      idx++
      const pairs = []
      for (let c = 0; c < cols; c++) {
        const header = headerCells[c] || `Col ${c + 1}`
        const cell = row[c]?.trim() || ''
        if (cell) pairs.push({ header, cell })
      }
      if (pairs.length === 0) continue
      // 单列表格：表头就是列名，重复很啰嗦 → 直接 `1. 内容`
      const oneCol = cols === 1 || pairs.length === 1
      pairs.forEach(({ header, cell }, i) => {
        // 首个字段跟在序号后面；其余字段另起一行（缩进对齐到同一起点）
        const lead = i === 0 ? `${C.bullet}${idx}.${C.reset} ` : '   '
        const label = oneCol && i === 0 ? '' : `${C.linkUrl}${header}:${C.reset} `
        lines.push(...wrapField(lead + label, cell, ttyCols))
      })
    }
    return lines.join('\n')

    /**
     * 把「前缀 + 内容」按可用宽度折成多行，续行缩进到内容起点。
     * prefix 可能含 ANSI（不计宽），所以宽度用它剥掉转义后的显示宽度。
     */
    function wrapField(prefix, content, width) {
      const prefixW = strWidth(stripAnsi(prefix))
      const avail = Math.max(8, width - prefixW)
      const out = []
      let rest = String(content)
      let first = true
      while (rest.length > 0) {
        const head = first ? prefix : ' '.repeat(prefixW)
        if (strWidth(rest) <= avail) { out.push(head + rest); break }
        // 按显示宽度切一刀（不能按 .length，中文占 2 列）
        let w = 0, cut = 0
        for (let i = 0; i < rest.length; i++) {
          const cw = strWidth(rest[i])
          if (w + cw > avail) break
          w += cw; cut = i + 1
        }
        if (cut === 0) cut = 1   // 单个宽字符也超宽时，至少吃掉一个字符，避免死循环
        // 【优先在词边界断】—— 硬切会把 `/compact` 劈成 `/compa` + `ct`，
        // 英文标识符/路径被切断后非常难读（用户实测反馈）。
        // 规则：切点落在单词中间时，回退到最近的分隔符（空格 > 标点），
        // 但回退幅度不超过一半，否则一行只剩两三个字，比劈开更糟。
        const head_ = rest.slice(0, cut)
        const lastSep = Math.max(
          head_.lastIndexOf(' '),
          head_.lastIndexOf('/'),
          head_.lastIndexOf('，'), head_.lastIndexOf('。'),
          head_.lastIndexOf('、'), head_.lastIndexOf('：'),
        )
        if (lastSep > cut * 0.5) cut = lastSep + 1
        out.push(head + rest.slice(0, cut).replace(/\s+$/, ''))
        rest = rest.slice(cut).replace(/^\s+/, '')
        first = false
      }
      return out.length ? out : [prefix]
    }
  }

  // 渲染
  let out = ''
  // 表头分隔线
  out += `${C.tableBorder}┌${widths.map(w => '─'.repeat(w + 2)).join('┬')}┐${C.reset}\n`
  for (let r = 0; r < parsed.length; r++) {
    const row = parsed[r]
    const cells = row.map((cell, c) => {
      // 【pad 必须按「渲染后」的宽度算，不是原始 cell】
      //
      // renderInline 会改变可见宽度：`` `code` `` 去掉两个反引号（-2），
      // `[文字](url)` 变成 `文字 (url)`（+1 或更多）。原来 pad 用 strWidth(cell)
      // 算的是**带 markdown 语法**的宽度，而屏幕上显示的是渲染后的文本 ——
      // 于是含行内代码的行会多补 2 个空格，把右边框挤出去（用户 2026-09-16 截图：
      // 表格右侧竖线参差不齐）。
      //
      // 同理列宽 widths[c] 也该用渲染后宽度来算（见上方计算列宽的循环），
      // 否则整条边框的宽度基准就是错的。
      const rendered = renderInline(cell)
      const w = strWidth(rendered)
      const pad = ' '.repeat(Math.max(0, widths[c] - w))
      return ` ${r === 0 ? C.tableHeader : ''}${rendered}${r === 0 ? C.reset : ''}${pad} `
    })
    out += `${C.tableBorder}│${C.reset}${cells.join(`${C.tableBorder}│${C.reset}`)}${C.tableBorder}│${C.reset}\n`
    if (r === 0) {
      out += `${C.tableBorder}├${widths.map(w => '─'.repeat(w + 2)).join('┼')}┤${C.reset}\n`
    }
  }
  out += `${C.tableBorder}└${widths.map(w => '─'.repeat(w + 2)).join('┴')}┘${C.reset}`
  return out
}

// 按显示宽度截断字符串
function truncateStr(str, targetWidth) {
  let w = 0
  for (let i = 0; i < str.length; i++) {
    w += strWidth(str[i])
    if (w >= targetWidth) return str.slice(0, i)
  }
  return str
}

// 行内格式渲染
// 嵌套规则：加粗里可以含斜体（**text *em* text**），所以加粗正则要放宽 *
// 处理顺序：链接 → 行内代码 → 加粗 → 斜体（后处理以免加粗正则被斜体干扰）
function renderInline(text) {
  let result = text
  // 行内代码（先于其他处理，避免内部的 * ` 被当成格式标记）
  // 用 \x00...\x01 包裹作占位，避开所有 * _ 等格式字符
  result = result.replace(/`([^`]+)`/g, `\x00$1\x01`)
  // 链接 [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${C.link}$1${C.reset} ${C.linkUrl}($2)${C.reset}`)
  // 加粗：允许内部含 *（嵌套斜体），但用非贪婪匹配至最近的 ** 结尾
  result = result.replace(/\*\*([\s\S]+?)\*\*/g, `${C.bold}$1${C.reset}`)
  result = result.replace(/__([^_]+)__/g, `${C.bold}$1${C.reset}`)
  // 斜体
  result = result.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, `$1${C.italic}$2${C.reset}`)
  result = result.replace(/_([^_]+)_/g, `${C.italic}$1${C.reset}`)
  // 还原行内代码（带 cyan 背景）
  result = result.replace(/\x00([^\x00\x01]+)\x01/g, `${C.bgGray}${C.link}$1${C.reset}`)
  return result
}


// ══════════════════════════════════════════════════════════════════════
//  线性字符串高亮（替代回溯正则）
// ══════════════════════════════════════════════════════════════════════

/**
 * 线性扫描代码行中的字符串字面量，用 mark() 标记。
 *
 * 替代旧正则的原因：
 *   - 旧正则在未闭合引号时产生指数级回溯（28 字符 > 2 秒）
 *   - 流式输入天生不完整，未闭合引号是常态
 *   - 本函数 O(n) 遍历，最坏情况就是没找到闭合引号 → 原样保留
 */
function highlightStringsLinear(line, mark, color) {
  const QUOTES = new Set(['"', "'", '`'])
  let out = ''
  let i = 0
  const n = line.length

  while (i < n) {
    const ch = line[i]
    if (!QUOTES.has(ch)) { out += ch; i++; continue }

    const quote = ch
    let j = i + 1
    let closed = false
    while (j < n) {
      const c = line[j]
      if (c === '\\') { j += 2; continue }
      if (c === quote) { closed = true; break }
      if (quote === '`' && c === '$' && line[j+1] === '{') {
        j += 2
        let depth = 1
        while (j < n && depth > 0) {
          if (line[j] === '{') depth++
          else if (line[j] === '}') depth--
          j++
        }
        continue
      }
      j++
    }

    if (closed) {
      out += mark(color, line.slice(i, j + 1))
      i = j + 1
    } else {
      out += line.slice(i)
      break
    }
  }
  return out
}
