// Claude Code Mobile - 任务级 diff
// 目的：一轮任务结束后能一眼看完"到底改了什么"，而不是只看到文件名列表。
// 只对本轮 taskState.files 里记录的文件取 diff，避免把仓库里无关的旧改动也刷出来。
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { renderWordDiff } from '../ui/word-diff.mjs'

const MAX_FILE_DIFF_LINES = 60      // 单文件最多显示多少行 diff
const MAX_TOTAL_LINES = 240         // 整体上限，防止刷屏

function gitDiffFor(file, { cwd = process.cwd(), staged = false } = {}) {
  const args = ['diff', '--no-color', '--no-ext-diff']
  if (staged) args.push('--staged')
  args.push('--', file)
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return ''
  }
}

function isTracked(file, cwd) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', file], {
      cwd, encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return true
  } catch {
    return false
  }
}

/** 统计 diff 里的 +/- 行数（跳过 +++/--- 文件头） */
export function countDiffLines(diffText) {
  let added = 0, removed = 0
  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

/**
 * 把 hunk 正文渲染成带词级高亮的行（对齐官方 StructuredDiff）。
 * @@ 头保持原样输出，只对内容行做配对和高亮。
 */
function colorizeHunks(lines, colors) {
  const out = []
  let buf = []
  const flush = () => {
    if (!buf.length) return
    out.push(...renderWordDiff(buf, colors))
    buf = []
  }
  for (const line of lines) {
    if (String(line).startsWith('@@')) {
      flush()
      out.push(`${colors.hunk || colors.dim}${line}${colors.reset}`)
    } else {
      buf.push(line)
    }
  }
  flush()
  return out
}

/** 去掉 diff 的噪音头部，只留 hunk 内容 */
function stripDiffHeader(diffText) {
  const lines = String(diffText || '').split('\n')
  const firstHunk = lines.findIndex(l => l.startsWith('@@'))
  return firstHunk === -1 ? lines : lines.slice(firstHunk)
}

/**
 * 为一组文件生成紧凑 diff。
 * @param {string[]} files 本轮改动的文件（相对/绝对路径）
 * @returns {{ entries: Array, totals: object, truncated: boolean }}
 */
export function buildTaskDiff(files = [], { cwd = process.cwd() } = {}) {
  const entries = []
  const totals = { files: 0, added: 0, removed: 0, untracked: 0, missing: 0 }
  let usedLines = 0
  let truncated = false

  for (const raw of [...new Set(files)]) {
    if (!raw) continue
    const file = String(raw)
    if (!existsSync(file)) {
      entries.push({ file, status: 'missing' })
      totals.missing++
      continue
    }
    if (!isTracked(file, cwd)) {
      // 新文件：git diff 看不到，只报告存在
      entries.push({ file, status: 'untracked' })
      totals.untracked++
      totals.files++
      continue
    }
    // 未暂存优先；没有则看已暂存（AI 可能已经 git add 过）
    let diff = gitDiffFor(file, { cwd, staged: false })
    let staged = false
    if (!diff.trim()) {
      diff = gitDiffFor(file, { cwd, staged: true })
      staged = !!diff.trim()
    }
    if (!diff.trim()) {
      entries.push({ file, status: 'unchanged' })
      continue
    }
    const { added, removed } = countDiffLines(diff)
    let body = stripDiffHeader(diff)
    if (body.length > MAX_FILE_DIFF_LINES) {
      body = body.slice(0, MAX_FILE_DIFF_LINES)
      body.push(`… 该文件 diff 已截断（共 ${added + removed} 处变更行）`)
      truncated = true
    }
    if (usedLines + body.length > MAX_TOTAL_LINES) {
      body = body.slice(0, Math.max(0, MAX_TOTAL_LINES - usedLines))
      truncated = true
    }
    usedLines += body.length
    entries.push({ file, status: staged ? 'staged' : 'modified', added, removed, body })
    totals.files++
    totals.added += added
    totals.removed += removed
    if (usedLines >= MAX_TOTAL_LINES) { truncated = true; break }
  }

  return { entries, totals, truncated }
}

/**
 * 渲染成终端文本；showBody=false 只给统计摘要。
 * color=true 开启词级高亮（官方 StructuredDiff 风格）。
 */
export function formatTaskDiff(result, { showBody = true, color = false, colors = {} } = {}) {
  const { entries = [], totals = {}, truncated } = result || {}
  if (!entries.length) return '本轮没有记录到文件改动'

  const out = []
  const changed = entries.filter(e => e.status === 'modified' || e.status === 'staged')
  const untracked = entries.filter(e => e.status === 'untracked')
  const unchanged = entries.filter(e => e.status === 'unchanged')
  const missing = entries.filter(e => e.status === 'missing')

  out.push(`本轮改动 ${totals.files || 0} 个文件  +${totals.added || 0} / -${totals.removed || 0}`)

  for (const e of changed) {
    out.push('')
    out.push(`${e.file}  +${e.added} / -${e.removed}${e.status === 'staged' ? '  (已暂存)' : ''}`)
    if (showBody && e.body?.length) {
      out.push(color ? colorizeHunks(e.body, {
        add: colors.add ?? '\x1b[38;2;120;190;120m',
        remove: colors.remove ?? '\x1b[38;2;220;110;110m',
        dim: colors.dim ?? '\x1b[2m',
        reset: colors.reset ?? '\x1b[0m',
        emphasis: colors.emphasis ?? '\x1b[7m',
        hunk: colors.hunk ?? '\x1b[38;2;108;174;196m',
      }).join('\n') : e.body.join('\n'))
    }
  }
  if (untracked.length) {
    out.push('')
    out.push(`新文件（git 未跟踪，无 diff）:`)
    for (const e of untracked) out.push(`  + ${e.file}`)
  }
  if (unchanged.length) {
    out.push('')
    out.push(`无实际变更: ${unchanged.map(e => e.file).join(', ')}`)
  }
  if (missing.length) {
    out.push('')
    out.push(`已不存在（可能被删除或移动）: ${missing.map(e => e.file).join(', ')}`)
  }
  if (truncated) {
    out.push('')
    out.push('（输出已截断，完整内容用 git diff 查看）')
  }
  return out.join('\n')
}
