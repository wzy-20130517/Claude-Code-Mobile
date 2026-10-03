// 词级 diff 高亮（对齐官方 src/components/StructuredDiff/Fallback.tsx）。
//
// 官方做法：
//   1. patch 行转成 {code, type: add|remove|nochange}（transformLinesToObjects）
//   2. 相邻的 remove 块和 add 块按下标一对一配对（processAdjacentLines）
//   3. 配对的两行做 diffWordsWithSpace，逐词标 added/removed
//   4. changeRatio = 变化字符数 / (两行长度之和)，超过 CHANGE_THRESHOLD(0.4)
//      就退回整行高亮 —— 改太多时逐词标记反而更难读
//
// 分词直接用官方同一个库（jsdiff 的 diffWordsWithSpace）。
// 用 WithSpace 版本是关键：它保留空白，否则缩进变化会看不出来。

import { diffWordsWithSpace } from 'diff'

/** 官方阈值 */
export const CHANGE_THRESHOLD = 0.4

/** 超长行不做词级 diff（jsdiff 在长文本上也会明显变慢） */
const MAX_WORD_DIFF_CHARS = 2000

/** 词级 diff，返回 [{value, added?, removed?}]（官方 DiffPart 同形） */
export function diffWords(oldText, newText) {
  const a = String(oldText ?? ''), b = String(newText ?? '')
  if (!a && !b) return []
  return diffWordsWithSpace(a, b)
}

/**
 * 官方口径的改动比例：
 *   changedLength / (removedLineText.length + addedLineText.length)
 * 注意分母是【两行长度之和】，不是 parts 总长 —— 用后者会算出偏大的比例，
 * 导致本该词级高亮的行被判成整行改动。
 */
export function changeRatio(parts, oldText = '', newText = '') {
  const total = String(oldText ?? '').length + String(newText ?? '').length
  if (total === 0) return 0
  let changed = 0
  for (const p of parts) {
    if (p.added || p.removed) changed += p.value.length
  }
  return changed / total
}

export function shouldWordDiff(oldText, newText) {
  const a = String(oldText ?? ''), b = String(newText ?? '')
  if (!a || !b) return false
  if (a.length > MAX_WORD_DIFF_CHARS || b.length > MAX_WORD_DIFF_CHARS) return false
  return true
}

/** 解析 unified diff 正文行（官方 transformLinesToObjects） */
export function parseDiffLines(lines) {
  const src = Array.isArray(lines) ? lines : String(lines).split('\n')
  const out = []
  for (const raw of src) {
    const line = String(raw ?? '')
    if (line.startsWith('\\')) continue                      // "\ No newline at end of file"
    if (line.startsWith('+')) out.push({ type: 'add', code: line.slice(1), raw: line })
    else if (line.startsWith('-')) out.push({ type: 'remove', code: line.slice(1), raw: line })
    else out.push({ type: 'nochange', code: line.replace(/^ /, ''), raw: line })
  }
  return out
}

/**
 * 配对相邻 remove/add 块（官方 processAdjacentLines）。
 * 只有「连续 remove 紧跟连续 add」才配对，按下标一对一；
 * 多出来的行保持整行显示。
 */
export function pairAdjacentLines(lineObjects) {
  const rows = Array.isArray(lineObjects) ? lineObjects.map(o => ({ ...o })) : []
  let i = 0
  while (i < rows.length) {
    if (rows[i].type !== 'remove') { i++; continue }
    let j = i
    const removes = []
    while (j < rows.length && rows[j].type === 'remove') { removes.push(rows[j]); j++ }
    const adds = []
    while (j < rows.length && rows[j].type === 'add') { adds.push(rows[j]); j++ }
    if (removes.length && adds.length) {
      const pairs = Math.min(removes.length, adds.length)
      for (let k = 0; k < pairs; k++) {
        const rm = removes[k], ad = adds[k]
        if (!shouldWordDiff(rm.code, ad.code)) continue
        const parts = diffWords(rm.code, ad.code)
        // 官方阈值判断：分母是两行长度之和
        if (changeRatio(parts, rm.code, ad.code) > CHANGE_THRESHOLD) continue
        rm.wordDiff = true; ad.wordDiff = true
        rm.parts = parts; ad.parts = parts
      }
    }
    i = j
  }
  return rows
}

/**
 * 渲染成带 ANSI 的行。
 * 新增绿、删除红；词级改动部分反显加强 —— 终端没有官方那种「更深的背景色」，
 * 反显是最稳的强调手段（各终端都支持，不依赖 truecolor）。
 */
export function renderWordDiff(lines, {
  add = '\x1b[38;2;120;190;120m',
  remove = '\x1b[38;2;220;110;110m',
  dim = '\x1b[2m',
  reset = '\x1b[0m',
  emphasis = '\x1b[7m',
  showLineNumbers = false,
  startOld = 0,
  startNew = 0,
} = {}) {
  const rows = pairAdjacentLines(parseDiffLines(lines))
  const out = []
  let oldNo = startOld, newNo = startNew
  for (const row of rows) {
    const color = row.type === 'add' ? add : row.type === 'remove' ? remove : dim
    const sign = row.type === 'add' ? '+' : row.type === 'remove' ? '-' : ' '
    if (row.type === 'add') newNo++
    else if (row.type === 'remove') oldNo++
    else { oldNo++; newNo++ }
    const no = showLineNumbers
      ? `${dim}${String(row.type === 'add' ? newNo : oldNo).padStart(4)}${reset} `
      : ''

    if (row.wordDiff && row.parts) {
      // 本行只显示属于自己方向的内容：remove 行不显示 added 词，反之同理
      const want = row.type === 'add' ? 'added' : 'removed'
      let body = ''
      for (const p of row.parts) {
        const isChanged = want === 'added' ? p.added : p.removed
        const isOther = want === 'added' ? p.removed : p.added
        if (isOther) continue
        body += isChanged ? `${emphasis}${p.value}${reset}${color}` : p.value
      }
      out.push(`${no}${color}${sign}${body}${reset}`)
    } else {
      out.push(`${no}${color}${sign}${row.code}${reset}`)
    }
  }
  return out
}
