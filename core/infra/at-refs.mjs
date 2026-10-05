// @ 文件引用（对标原版 Claude Code 的 @path 语法）
// 用户消息里写 @src/foo.js 或 @./README.md → 自动读文件内容附到消息里
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { resolve, join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'

const MAX_FILE_CHARS = 30000
const MAX_TOTAL_CHARS = 80000
const MAX_FILES = 10

/**
 * 提取 Markdown 的标题骨架（供超长文件截断后附在末尾）。
 *
 * 【为什么需要】截断只给一句「已截断，原文件 N 字节」，模型不知道**漏掉了什么**：
 * 它可能正需要第 4 节的内容，但看到截断提示后只能要么猜、要么整读一遍。
 * 附上标题骨架后，模型一眼能看出「原文有 12 节，我只看到前 3 节」，
 * 需要时用 Read/Grep 精确去取那一节，不必盲读全文。
 *
 * 只认 ATX 标题（`#` 开头）。Setext（下划线式）极少见且要预读下一行，
 * 收益不抵复杂度 —— 漏掉的标题不影响「有骨架可参考」这个主要收益。
 *
 * @param {string} text 原文（截断前）
 * @param {number} startOffset 骨架从第几个字符开始（= 已展示的长度），
 *        用于标注「这里之后的内容没展示」。传 0 表示全部未展示。
 * @param {number} maxLines 骨架最多列多少条标题，超出折叠计数
 */
function extractHeadingOutline(text, startOffset = 0, maxLines = 60) {
  const lines = String(text).split('\n')
  const found = []
  let offset = 0
  for (const line of lines) {
    const lineStart = offset
    offset += line.length + 1   // +1 是换行符
    const m = /^(#{1,6})\s+(\S.*?)\s*$/.exec(line)
    if (!m) continue
    found.push({
      level: m[1].length,
      title: m[2].replace(/\s*#+\s*$/, '').trim(),   // 去掉尾部闭合的 #
      shown: lineStart < startOffset,                // 该标题是否已在上面展示过
    })
  }
  if (found.length === 0) return ''
  // 缩进体现层级，让模型直接看出结构（第几节属于谁）
  const fmt = (h) => `${'  '.repeat(h.level - 1)}${'#'.repeat(h.level)} ${h.title}`
  const head = found.slice(0, maxLines)
  const rest = found.length - head.length
  const body = head.map((h, i) => {
    const line = fmt(h)
    // 在「已展示 / 未展示」的交界处插一条分界线 —— 这是模型最需要的一行：
    // 它标出了「我看到哪儿为止」，之后的标题就是需要自己去找的内容。
    const prevShown = i > 0 ? head[i - 1].shown : null
    if (prevShown === true && h.shown === false) return `  ── 以上已完整展示 / 以下未展示 ──\n${line}`
    return line
  }).join('\n')
  return body + (rest > 0 ? `\n…（另有 ${rest} 个标题未列出）` : '')
}

// 匹配 @后跟路径：允许 . / - _ 中文 数字 字母，不允许空格
// 需前面是行首或空白，避免匹配 email / npm scope
//
// 【2026-09-15 修：相对路径被截断】
// 旧正则的第二个分支是 `[\w\u4e00-\u9fa5-]+(?:\.[\w]+)?` —— 不含 `/`，也只允许**一个**点后缀。
// 于是这些常见写法全都只匹配到一半（实测）：
//   @src/foo.js   → "src"      （在 / 处停）
//   @foo/bar.md   → "foo"
//   @a.b.c.md     → "a.b"      （第二个点之后被丢掉）
// 而 @文件名 恰恰是最常用的写法（用户不会每次都写 ./）。
// 修法：允许「若干段 [路径字符] 由 / 连接」，每段内部允许点号，
// 真正判定合法性交给后面的 existsSync（不在这里做存在性猜测）。
const AT_PATTERN = /(^|\s)@((?:\/|~\/|\.\.?\/)[^\s]+|[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5.\-/]*(?:\/[\w\u4e00-\u9fa5.\-/]+)*)/g

function expandHome(p) {
  return p.startsWith('~') ? p.replace(/^~/, homedir()) : p
}

/**
 * 从文本中提取 @路径
 * @returns {{ refs: string[], cleaned: string }}
 */
export function extractAtRefs(text) {
  if (typeof text !== 'string' || !text.includes('@')) return { refs: [], cleaned: text }
  const refs = []
  let m
  AT_PATTERN.lastIndex = 0
  while ((m = AT_PATTERN.exec(text)) !== null) {
    const p = m[2]
    // 过滤明显不是路径的：纯域名、单个词且无 / 无 . 且不存在
    if (!p) continue
    refs.push(p)
    if (refs.length >= MAX_FILES) break
  }
  return { refs, cleaned: text }
}

/**
 * 读取 @引用的文件/目录，生成注入文本
 * @param {string[]} refs
 * @param {string} cwd
 * @returns {{ block: string, loaded: string[], missing: string[] }}
 */
export function buildAtContext(refs, cwd = process.cwd()) {
  const loaded = []
  const missing = []
  const parts = []
  let total = 0

  for (const ref of refs) {
    const raw = expandHome(ref)
    const full = isAbsolute(raw) ? raw : resolve(cwd, raw)
    if (!existsSync(full)) { missing.push(ref); continue }

    let st
    try { st = statSync(full) } catch { missing.push(ref); continue }

    if (st.isDirectory()) {
      try {
        const entries = readdirSync(full).slice(0, 50)
        const listing = entries.join('\n')
        parts.push(`### @${ref} （目录）\n\`\`\`\n${listing}\n\`\`\``)
        loaded.push(ref)
        total += listing.length
      } catch { missing.push(ref) }
      continue
    }

    // 跳过二进制/大文件
    if (st.size > 2 * 1024 * 1024) {
      parts.push(`### @${ref}\n(文件过大 ${(st.size / 1024 / 1024).toFixed(1)}MB，已跳过)`)
      missing.push(ref)
      continue
    }

    try {
      let content = readFileSync(full, 'utf-8')
      if (content.includes('\0')) { missing.push(ref); continue } // 二进制
      let note = ''
      let outlineNote = ''
      if (content.length > MAX_FILE_CHARS) {
        const full = content
        content = content.slice(0, MAX_FILE_CHARS)
        // 截断了就把 Markdown 标题骨架附上 —— 只给「已截断」三个字的话，
        // 模型不知道漏了什么，只能盲猜或整文件重读。见 extractHeadingOutline 注释。
        const outline = extractHeadingOutline(full, content.length)
        note = `\n…[已截断，原文件 ${st.size} 字节；只展示了前 ${MAX_FILE_CHARS} 字符]`
        // ⚠ 骨架放在代码块【外】：放进 ``` 里会被当成文件原文的一部分，
        //   模型可能误以为文件里真有 `[全文标题结构]` 这一段。
        if (outline) {
          outlineNote = `\n[@${ref} 全文标题结构（上面只展示了前 ${MAX_FILE_CHARS} 字符；`
            + `需要哪一节请用 Read 按行范围读，不要重读整个文件）]\n\`\`\`\n${outline}\n\`\`\``
        }
      }
      if (total + content.length > MAX_TOTAL_CHARS) {
        parts.push(`### @${ref}\n(总量超限，未加载)`)
        continue
      }
      total += content.length
      const ext = full.split('.').pop()
      parts.push(`### @${ref}\n\`\`\`${/^[a-z0-9]+$/i.test(ext) ? ext : ''}\n${content}${note}\n\`\`\`${outlineNote}`)
      loaded.push(ref)
    } catch {
      missing.push(ref)
    }
  }

  if (!parts.length) return { block: '', loaded, missing }
  return {
    block: '\n\n<!-- @ 引用的文件内容 -->\n' + parts.join('\n\n'),
    loaded,
    missing,
  }
}
