// Claude Code Mobile - 轻量 repo map（Aider PageRank 的简化版）
// 扫描源码提取函数/类/变量定义，按引用频次排序，生成紧凑的代码库地图。
// 大仓库扫描采用异步分批让出事件循环，防止 RepoMap/Symbols 冻住终端 UI。

import { promises as fs } from 'node:fs'
import { resolve, join, sep } from 'node:path'

const DEFAULT_INCLUDE = /\.(mjs|js|ts|py|jsx|tsx)$/i
const DEFAULT_EXCLUDE_DIRS = /node_modules|\.git|\.claude-code-mobile|\.playwright-mcp|dist|build|coverage/i
// 预算刻意保守：RepoMap 只用于快速定向，不应把大仓库扫描变成 15 秒级任务。
const DEFAULT_MAX_FILES = 800
const DEFAULT_MAX_FILE_BYTES = 1 * 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 10 * 1024 * 1024
const YIELD_EVERY = 24

function interruptedError() {
  const error = new Error('Interrupted')
  error.code = 'ABORT_ERR'
  return error
}

function checkAbort(signal) {
  if (signal?.aborted) throw interruptedError()
}

async function yieldToEventLoop() {
  await new Promise(resolve => setImmediate(resolve))
}

// 提取单个文件的“定义标签”（函数/类/const 声明）
function extractTags(content, filePath) {
  const tags = []
  const lines = content.split('\n')
  const re = [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/,
    /^\s*(?:export\s+)?let\s+([A-Za-z_$][\w$]*)\s*=/,
    /^\s*(?:export\s+)?var\s+([A-Za-z_$][\w$]*)\s*=/,
    /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/,
  ]
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue
    for (const r of re) {
      const m = line.match(r)
      if (m) {
        tags.push({ name: m[1], line: i + 1, file: filePath })
        break
      }
    }
  }
  return tags
}

/**
 * 异步扫描目录，返回 { tags, files, contents, truncated, skipped }。
 * contents 只读一次，供 rankTags 复用；避免旧实现的 标签数 × 文件数 反复 I/O。
 */
export async function scanRepo(dir, opts = {}) {
  const include = opts.include || DEFAULT_INCLUDE
  const excludeDirs = opts.excludeDirs || DEFAULT_EXCLUDE_DIRS
  const maxFiles = Math.max(1, Math.min(Number(opts.maxFiles) || DEFAULT_MAX_FILES, 10000))
  const maxFileBytes = Math.max(1024, Number(opts.maxFileBytes) || DEFAULT_MAX_FILE_BYTES)
  const maxTotalBytes = Math.max(maxFileBytes, Number(opts.maxTotalBytes) || DEFAULT_MAX_TOTAL_BYTES)
  const signal = opts.signal
  const tags = []
  const files = []
  const contents = new Map()
  let totalBytes = 0
  let truncated = false
  let skipped = 0
  let visited = 0

  const walk = async (current) => {
    checkAbort(signal)
    if (truncated) return
    let entries
    try { entries = await fs.readdir(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      checkAbort(signal)
      if (truncated) return
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (!excludeDirs.test(entry.name)) await walk(full)
      } else if (entry.isFile() && include.test(entry.name)) {
        if (files.length >= maxFiles) { truncated = true; return }
        let stat
        try { stat = await fs.stat(full) } catch { continue }
        if (stat.size > maxFileBytes || totalBytes + stat.size > maxTotalBytes) {
          skipped++
          if (totalBytes + stat.size > maxTotalBytes) truncated = true
          continue
        }
        let content
        try { content = await fs.readFile(full, 'utf-8') } catch { continue }
        files.push(full)
        contents.set(full, content)
        totalBytes += stat.size
        tags.push(...extractTags(content, full))
      }
      if (++visited % YIELD_EVERY === 0) await yieldToEventLoop()
    }
  }

  await walk(resolve(dir))
  return { tags, files, contents, truncated, skipped, totalBytes }
}

// 统计每个标签的引用次数：每个文件内容只读一次，线性 token 扫描。
// 旧实现是「每个标签 × 每个文件」做 includes，在大仓库会爆成 O(tags × files)
// 并长时间堵塞事件循环；这里改为 O(源码 token 总数)。
export async function rankTags(tags, files, contents = null, opts = {}) {
  const signal = opts.signal
  const count = new Map()
  for (const tag of tags) count.set(tag.name, 0)
  let visited = 0
  for (const file of files) {
    checkAbort(signal)
    let content = contents?.get(file)
    if (content == null) {
      try { content = await fs.readFile(file, 'utf-8') } catch { continue }
    }
    const found = new Set()
    const identifiers = content.match(/[A-Za-z_$][\w$]*/g) || []
    for (const identifier of identifiers) {
      if (count.has(identifier)) found.add(identifier)
    }
    for (const name of found) count.set(name, (count.get(name) || 0) + 1)
    if (++visited % YIELD_EVERY === 0) await yieldToEventLoop()
  }
  return tags.map(t => ({ ...t, refs: count.get(t.name) || 0 }))
    .sort((a, b) => b.refs - a.refs || a.name.localeCompare(b.name))
}

// 生成紧凑 map 文本（按引用频次排序，token 预算截断）
export async function buildRepoMap(dir, opts = {}) {
  const { maxTags = 60, maxChars = 4000 } = opts
  const result = await scanRepo(dir, opts)
  const { tags, files, contents, truncated, skipped, totalBytes } = result
  if (tags.length === 0) {
    return truncated ? `(扫描已截断：${files.length} files，未找到源码标签)` : '(无源码标签)'
  }
  const ranked = await rankTags(tags, files, contents, opts)
  const out = []
  const suffix = truncated ? `，已截断${skipped ? `，跳过 ${skipped} 个大文件` : ''}` : ''
  out.push(`# Repo Map (${files.length} files, ${tags.length} tags, ${(totalBytes / 1024 / 1024).toFixed(1)}MB${suffix})`)
  let used = 0
  for (const t of ranked.slice(0, Math.max(1, Math.min(Number(maxTags) || 60, 500)))) {
    const rel = t.file.replace(resolve(dir) + sep, '')
    const line = `${t.name} (${t.line}) @ ${rel} · refs:${t.refs}`
    used += line.length
    if (used > Math.max(100, Number(maxChars) || 4000)) break
    out.push(line)
  }
  return out.join('\n')
}
