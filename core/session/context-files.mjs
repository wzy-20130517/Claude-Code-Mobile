// 上下文文件追踪（官方 /files）。
//
// 官方在 ToolUseContext 里维护 readFileState（Map<absPath, {content, timestamp}>），
// /files 就是把它的 key 列出来、转成相对路径。
//
// 我们没有那个结构，所以在这里独立维护一份：由 index.mjs 的 onToolResult 挂钩喂进来。
// 只记路径和元信息，不存内容 —— 存内容等于把上下文又复制一份，手机上没必要。

import { relative, isAbsolute, resolve } from 'node:path'

/** 会把文件内容带进上下文的工具 */
const READ_TOOLS = new Set([
  'Read', 'HashlineRead', 'ViewImage', 'ReadFile', 'FileRead',
])
/** 会改文件的工具（也算进上下文，因为改动内容同样在对话里） */
const WRITE_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'HashlineEdit', 'ApplyPatch', 'SafeRename',
])

export class ContextFileTracker {
  constructor({ cwd = process.cwd(), max = 500 } = {}) {
    this.cwd = cwd
    this.max = max
    // 单调递增序号：不能用 Date.now() 排序 —— 同一毫秒内连续记录（字段完全相同）
    // 会让 sort 结果不确定，“最近使用”顺序就乱了。
    this._seq = 0
    /** @type {Map<string, {path:string, kind:string, tool:string, at:number, count:number}>} */
    this.files = new Map()
  }

  /**
   * 记录一次工具调用。kind：
   *   read  只是读进上下文
   *   write 写过（会覆盖 read 标记，写更重要）
   */
  record(toolName, input = {}) {
    const name = String(toolName || '')
    const isRead = READ_TOOLS.has(name)
    const isWrite = WRITE_TOOLS.has(name)
    if (!isRead && !isWrite) return null

    const raw = input?.file_path || input?.path || input?.notebook_path
    if (typeof raw !== 'string' || !raw.trim()) return null
    const abs = isAbsolute(raw) ? raw : resolve(this.cwd, raw)

    const prev = this.files.get(abs)
    const kind = isWrite ? 'write' : (prev?.kind === 'write' ? 'write' : 'read')
    const entry = {
      path: abs,
      kind,
      tool: name,
      at: Date.now(),
      seq: ++this._seq,
      count: (prev?.count || 0) + 1,
    }
    // 重新插入以维持 LRU 顺序（Map 保留插入序）
    this.files.delete(abs)
    this.files.set(abs, entry)
    // 超上限丢最旧的
    while (this.files.size > this.max) {
      const oldest = this.files.keys().next().value
      this.files.delete(oldest)
    }
    return entry
  }

  /** 清空（/clear、新会话时调用） */
  reset() { this.files.clear(); this._seq = 0 }

  /** 当前记录数 */
  get size() { return this.files.size }

  /** 按最近使用倒序列出（用 seq 而不是时间戳，同毫秒也稳定） */
  list() {
    return [...this.files.values()].sort((a, b) => b.seq - a.seq)
  }

  /** 相对 cwd 的短路径（超出 cwd 的保留绝对路径） */
  shortPath(abs) {
    const rel = relative(this.cwd, abs)
    if (!rel || rel.startsWith('..')) return abs
    return rel
  }
}

/**
 * 渲染 /files 输出。官方是极简的「Files in context:\n<相对路径逐行>」，
 * 这里多标一个读/写和次数 —— 手机屏幕小，一眼看出哪个被改过更有用。
 */
export function formatContextFiles(tracker, { color = null, reset = '' } = {}) {
  if (!tracker || tracker.size === 0) return '当前上下文里没有文件'
  const rows = tracker.list()
  const writes = rows.filter(r => r.kind === 'write')
  const reads = rows.filter(r => r.kind === 'read')
  const out = [`上下文中的文件 ${rows.length} 个  改动 ${writes.length} · 只读 ${reads.length}`]
  const line = (r) => {
    const mark = r.kind === 'write' ? '~' : ' '
    const times = r.count > 1 ? `  ×${r.count}` : ''
    return `${mark} ${tracker.shortPath(r.path)}${times}`
  }
  if (writes.length) {
    out.push('')
    out.push('改动过:')
    for (const r of writes) out.push(line(r))
  }
  if (reads.length) {
    out.push('')
    out.push('只读:')
    for (const r of reads) out.push(line(r))
  }
  const body = out.join('\n')
  return color ? `${color}${body}${reset}` : body
}
