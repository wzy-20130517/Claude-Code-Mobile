// 结构化记忆目录（对齐官方 src/memdir/）。
//
// 官方结构：
//   ~/.claude/memory/MEMORY.md        入口
//   ~/.claude/memory/**/*.md          单条记忆，带 frontmatter
//   frontmatter: name / description / type
//   type ∈ user | feedback | project | reference
//
// 与 CLAUDE.md 的分工：
//   CLAUDE.md 是「每轮都注入」的全局约定，越写越长会一直吃 token
//   memdir 是「按需检索」的记忆库，只在相关时注入对应条目
//
// 官方用一次模型调用判断相关性（querySource: 'memdir_relevance'）。
// 这里改成本地关键词打分：手机上不值得为检索再花一次 API 往返。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs'
import { join, relative, basename, dirname } from 'node:path'
import { homedir } from 'node:os'

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference']
export const MEMORY_ENTRYPOINT = 'MEMORY.md'

/** 记忆库根目录。可用 CCM_MEMORY_DIR 覆盖（对应官方 CLAUDE_CODE_REMOTE_MEMORY_DIR） */
export function getMemoryDir() {
  return process.env.CCM_MEMORY_DIR || join(homedir(), '.claude-code-mobile', 'memory')
}

/** 解析 frontmatter。返回 {meta, body}；没有 frontmatter 时 meta 为空对象 */
export function parseFrontmatter(text) {
  const s = String(text ?? '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(s)
  if (!m) return { meta: {}, body: s.trim() }
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (!kv) continue
    let v = kv[2].trim()
    // 去掉包裹引号
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    meta[kv[1]] = v
  }
  return { meta, body: s.slice(m[0].length).trim() }
}

/** 生成带 frontmatter 的文件内容 */
export function buildMemoryFile({ name, description = '', type = 'reference', body = '' }) {
  const t = MEMORY_TYPES.includes(type) ? type : 'reference'
  const esc = (v) => String(v ?? '').replace(/\r?\n/g, ' ').trim()
  return `---\nname: ${esc(name)}\ndescription: ${esc(description)}\ntype: ${t}\n---\n\n${String(body ?? '').trim()}\n`
}

/** 递归列出所有记忆文件（不含入口 MEMORY.md） */
export function listMemories({ dir = getMemoryDir() } = {}) {
  if (!existsSync(dir)) return []
  const out = []
  const walk = (d) => {
    let items = []
    try { items = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      const p = join(d, it.name)
      if (it.isDirectory()) { walk(p); continue }
      if (!it.name.endsWith('.md')) continue
      if (it.name === MEMORY_ENTRYPOINT && d === dir) continue   // 入口单独处理
      let raw = ''
      try { raw = readFileSync(p, 'utf-8') } catch { continue }
      const { meta, body } = parseFrontmatter(raw)
      let mtime = 0
      try { mtime = statSync(p).mtimeMs } catch {}
      out.push({
        path: p,
        rel: relative(dir, p),
        name: meta.name || basename(it.name, '.md'),
        description: meta.description || '',
        type: MEMORY_TYPES.includes(meta.type) ? meta.type : 'reference',
        body,
        mtime,
      })
    }
  }
  walk(dir)
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** 读入口文件（长期总纲，始终可注入） */
export function readEntrypoint({ dir = getMemoryDir() } = {}) {
  const p = join(dir, MEMORY_ENTRYPOINT)
  if (!existsSync(p)) return null
  try { return readFileSync(p, 'utf-8').trim() } catch { return null }
}

/** 写一条记忆。rel 是相对路径（可带子目录），自动补 .md */
export function saveMemory({ rel, name, description = '', type = 'reference', body = '', dir = getMemoryDir() }) {
  const relPath = String(rel || name || '').trim().replace(/^\/+/, '')
  if (!relPath) throw new Error('记忆需要一个名字或路径')
  // 防目录穿越
  if (relPath.split(/[\\/]/).includes('..')) throw new Error('路径不合法')
  const file = relPath.endsWith('.md') ? relPath : `${relPath}.md`
  const abs = join(dir, file)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, buildMemoryFile({ name: name || basename(file, '.md'), description, type, body }), 'utf-8')
  return { path: abs, rel: file }
}

export function deleteMemory({ rel, dir = getMemoryDir() }) {
  const file = String(rel || '').trim()
  if (!file || file.split(/[\\/]/).includes('..')) throw new Error('路径不合法')
  const abs = join(dir, file.endsWith('.md') ? file : `${file}.md`)
  if (!existsSync(abs)) return false
  unlinkSync(abs)
  return true
}

/**
 * 中英文分词（用于相关性打分）。
 *
 * 中文【只用两字组合（bigram）】，不收单字：
 * 单字误命中率高得离谱 —— "完全无关的量子纠缠" 里的「全」会命中"全屏"，
 * 白拿 2 分就够过阈值，导致无关查询也返回结果（实测踩到过）。
 * bigram 保留了中文最小语义单元，"全屏" 只会被"全屏"命中。
 * 单字查询（比如只打一个"图"）因此不会有结果，这是可接受的取舍。
 */
function terms(text) {
  const s = String(text ?? '').toLowerCase()
  const latin = s.match(/[a-z0-9_]{2,}/g) || []
  const bi = []
  for (const run of s.match(/[\u4e00-\u9fa5]+/g) || []) {
    // 单字词（如"图"）自成一个 token，否则永远搜不到
    if (run.length === 1) { bi.push(run); continue }
    for (let i = 0; i + 1 < run.length; i++) bi.push(run.slice(i, i + 2))
  }
  return new Set([...latin, ...bi])
}

/**
 * 按查询挑相关记忆（官方是模型判断，这里本地打分）。
 * 打分权重：name > description > body，命中次数不重复计。
 */
export function findRelevantMemories(query, { dir = getMemoryDir(), limit = 5, minScore = 2 } = {}) {
  const q = terms(query)
  if (q.size === 0) return []
  const scored = []
  for (const mem of listMemories({ dir })) {
    const nameT = terms(mem.name)
    const descT = terms(mem.description)
    const bodyT = terms(mem.body)
    let score = 0
    for (const t of q) {
      if (nameT.has(t)) score += 3
      else if (descT.has(t)) score += 2
      else if (bodyT.has(t)) score += 1
    }
    // feedback 类是「用户对做事方式的要求」，同分时优先
    if (mem.type === 'feedback') score += 0.5
    if (score >= minScore) scored.push({ ...mem, score })
  }
  return scored.sort((a, b) => b.score - a.score || b.mtime - a.mtime).slice(0, limit)
}

/** 渲染成可注入 prompt 的文本 */
export function formatMemoriesForPrompt(memories) {
  if (!memories?.length) return ''
  const out = ['<memories>']
  for (const m of memories) {
    out.push(`<memory name="${m.name}" type="${m.type}">`)
    if (m.description) out.push(m.description)
    if (m.body) out.push(m.body)
    out.push('</memory>')
  }
  out.push('</memories>')
  return out.join('\n')
}

/** 给用户看的清单 */
export function formatMemoryList(memories, { dir = getMemoryDir() } = {}) {
  if (!memories?.length) return `记忆库是空的（${dir}）`
  const byType = {}
  for (const m of memories) (byType[m.type] ||= []).push(m)
  const out = [`记忆 ${memories.length} 条  ${dir}`]
  for (const type of MEMORY_TYPES) {
    const items = byType[type]
    if (!items?.length) continue
    out.push('')
    out.push(`${type}:`)
    for (const m of items) {
      const score = m.score !== undefined ? `  [${m.score}]` : ''
      out.push(`  ${m.rel}${score}`)
      if (m.description) out.push(`    ${m.description}`)
    }
  }
  return out.join('\n')
}
