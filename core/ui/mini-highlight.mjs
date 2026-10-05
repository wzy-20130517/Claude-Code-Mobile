// 轻量语法高亮：只服务流式预览的 10 行窗口。
//
// 【为什么不用 highlight.js / cli-highlight】
// Kimi Code 用的是 cli-highlight（main.mjs:502004 的 highlight()），
// 那是 highlight.js 的终端封装 —— 几 MB 依赖、190+ 语言。
// 我们这里只需要给 10 行代码上色，为此在手机上装几 MB 包不划算，
// 而且 highlight.js 的 tokenizer 对「半截代码」容错一般（流式内容天生不完整）。
//
// 所以走正则版：只认注释、字符串、关键字、数字这四类，容错强、零依赖。
// 配色也参考 Kimi 的取舍 —— 它把 string/regexp 设成 plain 压低噪音，
// 我们保留字符串着色但用低饱和色，避免 10 行里满屏彩字。

const C = {
  reset: '\x1b[0m',
  comment: '\x1b[38;5;242m',   // 灰
  string: '\x1b[38;5;108m',    // 低饱和绿
  keyword: '\x1b[38;5;175m',   // 粉紫
  number: '\x1b[38;5;180m',    // 米黄
  func: '\x1b[38;5;110m',      // 淡蓝
}

// 扩展名 → 语言族。同族共用一套关键字，不必逐语言维护。
const EXT_LANG = {
  js: 'c', mjs: 'c', cjs: 'c', jsx: 'c', ts: 'c', tsx: 'c',
  java: 'c', c: 'c', h: 'c', cpp: 'c', hpp: 'c', cs: 'c', go: 'c', rs: 'c', swift: 'c', kt: 'c',
  py: 'py', rb: 'py',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  json: 'json', yaml: 'yaml', yml: 'yaml',
  md: 'md', markdown: 'md',
}

const KEYWORDS = {
  c: /\b(const|let|var|function|return|if|else|for|while|class|extends|new|await|async|import|export|from|default|try|catch|finally|throw|typeof|instanceof|null|undefined|true|false|this|super|static|get|set|switch|case|break|continue|delete|in|of|yield|interface|type|enum|public|private|protected|readonly|struct|impl|fn|pub|mut|use|package|func|defer|go|chan|nil|void|int|string|bool|float|double|char)\b/g,
  py: /\b(def|class|return|if|elif|else|for|while|import|from|as|try|except|finally|raise|with|lambda|None|True|False|self|async|await|yield|pass|break|continue|global|nonlocal|assert|del|in|is|not|and|or|end|do|require|module)\b/g,
  sh: /\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|local|export|readonly|echo|cd|exit|set|unset|source|trap)\b/g,
  json: /\b(true|false|null)\b/g,
  yaml: /\b(true|false|null|yes|no|on|off)\b/g,
  md: 'MD_SPECIAL',   // 占位：md 走上面的专用分支，不用关键字表
}

export function langFromPath(filePath) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filePath || ''))
  if (!m) return null
  return EXT_LANG[m[1].toLowerCase()] || null
}

/**
 * 给单行代码上色。
 *
 * 【为什么逐行而不是整段】
 * 流式内容是半截的，跨行结构（多行字符串、块注释）根本判断不了状态。
 * 逐行处理会把多行字符串的中间行当普通代码，这是已知的不精确 —— 
 * 但对「看写到哪了」这个用途足够，且永远不会因为解析失败而崩。
 *
 * 用占位符保护已着色片段，避免后续规则往 ANSI 序列里再插颜色（会显示成乱码）。
 */
export function highlightLine(line, lang) {
  if (!lang || !line) return line
  const kw = KEYWORDS[lang]
  const slots = []
  // 占位符不能含数字：否则下面第 4 步的数字规则会匹配到占位符内部的索引，
  // 把占位符切碎，还原时就错位了（实测症状是满屏错色数字）。
  // 这里把索引编码成纯字母。
  const enc = (n) => String(n).split('').map(d => String.fromCharCode(97 + Number(d))).join('')
  const hold = (text) => {
    slots.push(text)
    return `\x00${enc(slots.length - 1)}\x00`
  }
  // dec 要在 md 分支之前定义（md 分支自己还原占位符）
  const dec = (letters) => Number(letters.split('').map(c => c.charCodeAt(0) - 97).join(''))

  let s = line

  // ── Markdown 单独处理 ────────────────────────────────────
  // md 不能走下面的代码规则：它没有 // 注释、没有代码式字符串，
  // 硬套的话路径里的 // 会被当注释、撇号会被当字符串起点，
  // 整段染成错色。改按 markdown 自己的语法着色。
  if (lang === 'md') {
    // 标题行整行着色，不再往下细分
    if (/^\s{0,3}#{1,6}\s/.test(line)) return C.keyword + line + C.reset
    // 引用块
    if (/^\s{0,3}>/.test(line)) return C.comment + line + C.reset
    // 代码围栏
    if (/^\s*```/.test(line)) return C.comment + line + C.reset
    let m = line
    // 行内代码优先占位，避免里面的 * _ 被当强调符
    m = m.replace(/`[^`]*`/g, (x) => hold(C.string + x + C.reset))
    // 粗体 / 斜体
    m = m.replace(/\*\*[^*]+\*\*/g, (x) => hold(C.keyword + x + C.reset))
    // 列表符号（只染符号本身，正文保持原色）
    m = m.replace(/^(\s*)([-*+]|\d+\.)(\s)/, (_, sp, mark, tail) => sp + hold(C.func + mark + C.reset) + tail)
    // 链接文字
    m = m.replace(/\[[^\]]*\]\([^)]*\)/g, (x) => hold(C.func + x + C.reset))
    return m.replace(/\x00([a-j]+)\x00/g, (_, k) => slots[dec(k)] ?? '')
  }

  // 1) 整行注释优先——注释里的关键字不该再着色
  const lineComment = lang === 'py' || lang === 'sh' || lang === 'yaml' ? /#.*$/ : /\/\/.*$/
  s = s.replace(lineComment, (m) => hold(C.comment + m + C.reset))
  if (lang === 'c') s = s.replace(/\/\*[\s\S]*?(\*\/|$)/g, (m) => hold(C.comment + m + C.reset))

  // 2) 字符串（含未闭合——流式内容常见）
  s = s.replace(/(['"`])(?:\\.|(?!\1)[^\\])*(\1|$)/g, (m) => hold(C.string + m + C.reset))

  // 3) 关键字
  if (kw) s = s.replace(kw, (m) => hold(C.keyword + m + C.reset))

  // 4) 数字
  s = s.replace(/\b\d+(?:\.\d+)?\b/g, (m) => hold(C.number + m + C.reset))

  // 5) 函数调用名
  s = s.replace(/\b([A-Za-z_$][\w$]*)(?=\s*\()/g, (m) => hold(C.func + m + C.reset))

  // 还原占位符
  return s.replace(/\x00([a-j]+)\x00/g, (_, k) => slots[dec(k)] ?? '')
}

export function highlightLines(lines, lang) {
  if (!lang) return lines
  return lines.map(l => {
    try { return highlightLine(l, lang) } catch { return l }
  })
}
