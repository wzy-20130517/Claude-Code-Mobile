// Claude Code Mobile - 文件工具（带 Undo + 回收站支持）
import { Tool } from './tools.mjs'
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { backupBeforeOverwrite } from '../session/trash.mjs'

function toolPath(filePath, ctx = {}) {
  return resolve(ctx.cwd || process.cwd(), filePath)
}

// ── 并发写保护：记录「本进程读过的文件版本」────────────────────────────
// 要堵的漏：worker-A Read 文件 → worker-B 改并写 → worker-A 拿旧内容 Write
//   → B 的工作静默消失，退出码 0，无任何告警（回收站里有，但没人知道要去找）。
// 做法：Read 时记录 mtime+size，Write 覆盖前比对，不一致就拒写并要求重新 Read。
// 只对「本进程 Read 过的文件」生效——没读过就直接 Write 视为用户明确要覆盖，不拦。
//
// ⚠ 已知局限（只是缩小窗口，没有解决）：
//   1. mtime 精度取决于文件系统。部分 FS（某些 FAT / 网络挂载）只有秒级精度，
//      同一秒内的两次修改测不出 mtime 差异。size 作为辅助信号能捞回一部分
//      （改动使长度变化的情况），但「同一秒内 + 长度不变」的修改仍然漏检。
//   2. 校验与写入之间不是原子的（check-then-write），理论上仍有极窄竞态窗口。
//   3. 记录以「解析后的绝对路径」为 key，也只覆盖本进程内的 Read；
//      走符号链接/不同挂载点指向同一文件，或别的进程读过的记录，都识别不到。
//   以上任一情况的失败方向都是 fail-open（退回旧的无校验行为），不会误拦。
const MAX_TRACKED = 500        // 记录上限，超了淘汰最早的；淘汰只会退回「不校验」
const fileVersions = new Map() // absPath -> { mtimeMs, size }

function statVersion(p) {
  try {
    const st = statSync(p)
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch { return null }      // stat 不到就放弃校验（fail-open，绝不误拦）
}

// 记录/刷新版本。Read 之后、以及本模块每次成功写盘之后都必须调用，
// 否则「读一次、写两次」的第二次写会拿旧 mtime 比新文件 → 误拦自己。
function trackVersion(p) {
  const v = statVersion(p)
  if (!v) return
  if (fileVersions.has(p)) fileVersions.delete(p)  // 重新 set 到队尾，形成 LRU 顺序
  fileVersions.set(p, v)
  if (fileVersions.size > MAX_TRACKED) {
    fileVersions.delete(fileVersions.keys().next().value)
  }
}

// 覆盖写前的守卫。返回 null = 放行；返回字符串 = 拒绝原因。
function staleWriteReason(p) {
  if (!existsSync(p)) return null       // 新建文件，无冲突可言
  const known = fileVersions.get(p)
  if (!known) return null              // 本进程没读过 → 明确要覆盖，不拦
  const now = statVersion(p)
  if (!now) return null
  if (now.mtimeMs === known.mtimeMs && now.size === known.size) return null
  const fmt = (t) => { try { return new Date(t).toISOString() } catch { return String(t) } }
  return `文件已被其他 Agent 修改，拒绝覆盖（否则对方的改动会静默消失）：${p}\n`
    + `  记录 mtime ${fmt(known.mtimeMs)}（${known.mtimeMs}，${known.size} bytes）\n`
    + `  当前 mtime ${fmt(now.mtimeMs)}（${now.mtimeMs}，${now.size} bytes）\n`
    + `请重新 Read 这个文件，把对方的改动合并进来后再写。`
}

// 测试/诊断用：清空版本记录
export function _resetFileVersions() { fileVersions.clear() }

export class FileReadTool extends Tool {
  constructor() {
    super({
      name: 'Read', description: '读取文件内容（支持指定行范围）',
      input_schema: { type: 'object', properties: { file_path: { type: 'string' }, start_line: { type: 'number' }, end_line: { type: 'number' } }, required: ['file_path'] },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      maxResultSizeChars: 50000,
      validateInput: (input) => {
        const errors = []
        if (!input.file_path) errors.push('file_path is required')
        if (input.start_line && input.start_line < 1) errors.push('start_line must be >= 1')
        if (input.end_line && input.start_line && input.end_line < input.start_line) errors.push('end_line must be >= start_line')
        return { valid: errors.length === 0, errors }
      },
    })
  }
  async execute(input, ctx = {}) {
    const p = toolPath(input.file_path, ctx)
    if (!existsSync(p)) throw new Error(`File not found: ${p}`)
    // 先记录版本再读内容：万一读取期间文件被改，宁可记旧版本（后续写被拦、可重读），
    // 也不要记新版本（那会放行「旧内容覆盖新文件」，正是要堵的漏）
    trackVersion(p)
    const content = readFileSync(p, 'utf-8')
    const lines = content.split('\n')
    // start_line 从 1 开始计数（更直观），默认从第 1 行开始
    const start = Math.max(0, (input.start_line || 1) - 1)
    const end = input.end_line || lines.length
    return lines.slice(start, end).map((line, i) => `${String(start + i + 1).padStart(5)}| ${line}`).join('\n')
  }
}

export class FileWriteTool extends Tool {
  constructor(undoStore) {
    const config = {
      name: 'Write', description: '写入文件（覆盖）',
      input_schema: { type: 'object', properties: {
        file_path: { type: 'string' },
        content: { type: 'string' },
        backup_note: { type: 'string', description: '（可选）这次写入的目的/简短描述，会写进备份文件名方便回溯' },
      }, required: ['file_path', 'content'] },
      isDestructive: () => true,   // 覆盖写入
      maxResultSizeChars: 500,
      validateInput: (input) => {
        const errors = []
        if (!input.file_path) errors.push('file_path is required')
        if (input.content === undefined || input.content === null) errors.push('content is required')
        return { valid: errors.length === 0, errors }
      },
    }
    super(config, { undoStore })
    this.undoStore = undoStore
  }
  async execute(input, ctx = {}) {
    const p = toolPath(input.file_path, ctx)
    // 并发守卫放最前面：校验失败不产生任何副作用（不污染 undo / 回收站）
    const stale = staleWriteReason(p)
    if (stale) throw new Error(stale)
    // 如果文件已存在，先备份到回收站（大文件才备份）
    backupBeforeOverwrite(p, input.content, input.backup_note || '')
    // 再保存 undo 快照
    if (existsSync(p) && this.undoStore) {
      const oldContent = readFileSync(p, 'utf-8')
      this.undoStore.saveSnapshot(p, oldContent, input.backup_note || '')
    }
    writeFileSync(p, input.content, 'utf-8')
    trackVersion(p)   // 刷新记录，否则连续两次 Write 会被自己的第一次写误拦
    return `Wrote ${input.content.length} bytes`
  }
}

export class FileEditTool extends Tool {
  constructor(undoStore) {
    const config = {
      name: 'Edit', description: '精确替换文件中的字符串',
      input_schema: { type: 'object', properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        backup_note: { type: 'string', description: '（可选）这次修改的目的/简短描述，会写进备份文件名方便回溯' },
      }, required: ['file_path', 'old_string', 'new_string'] },
      isDestructive: () => true,
      maxResultSizeChars: 500,
      validateInput: (input) => {
        const errors = []
        if (!input.file_path) errors.push('file_path is required')
        if (!input.old_string) errors.push('old_string is required')
        if (input.new_string === undefined || input.new_string === null) errors.push('new_string is required')
        return { valid: errors.length === 0, errors }
      },
    }
    super(config, { undoStore })
    this.undoStore = undoStore
  }
  async execute(input, ctx = {}) {
    const p = toolPath(input.file_path, ctx)
    if (!existsSync(p)) throw new Error('File not found')
    const content = readFileSync(p, 'utf-8')
    // 先校验，校验失败不产生任何副作用（不污染 undo / 回收站）
    const occurrences = content.split(input.old_string).length - 1
    if (occurrences === 0) throw new Error('old_string not found')
    if (occurrences > 1) throw new Error('old_string not unique')
    // 用 split/join 做替换，避免替换串里的美元符号被当作 replace 的特殊替换模式而损坏内容
    const newContent = content.split(input.old_string).join(input.new_string)
    // 备份到回收站（大修改才备份）
    backupBeforeOverwrite(p, newContent, input.backup_note || '')
    // undo 快照
    if (this.undoStore) this.undoStore.saveSnapshot(p, content, input.backup_note || '')
    writeFileSync(p, newContent, 'utf-8')
    trackVersion(p)   // Edit 也改了 mtime，不刷新的话之后的 Write 会被误拦
    return `Edited ${p}`
  }
}

export class MultiEditTool extends Tool {
  constructor(undoStore) {
    const config = {
      name: 'MultiEdit',
      description: '对单个文件做多处精确替换（原子操作：全部成功才写盘，任一失败则整体不改）。edits 按顺序依次应用，后面的 edit 看到的是前面 edit 之后的内容。比多次调用 Edit 更快更安全。',
      input_schema: { type: 'object', properties: {
        file_path: { type: 'string', description: '目标文件路径' },
        edits: {
          type: 'array',
          description: '替换操作列表，按顺序应用',
          items: { type: 'object', properties: {
            old_string: { type: 'string', description: '要替换的原文（必须在当前内容中唯一，除非 replace_all=true）' },
            new_string: { type: 'string', description: '替换成的新文本' },
            replace_all: { type: 'boolean', description: '替换所有出现（默认 false，要求唯一匹配）' },
          }, required: ['old_string', 'new_string'] },
        },
        backup_note: { type: 'string', description: '（可选）这次修改的目的/简短描述，会写进备份文件名方便回溯' },
      }, required: ['file_path', 'edits'] },
      isDestructive: () => true,
      maxResultSizeChars: 2000,
      validateInput: (input) => {
        const errors = []
        if (!input.file_path) errors.push('file_path is required')
        if (!Array.isArray(input.edits) || input.edits.length === 0) {
          errors.push('edits must be a non-empty array')
        } else {
          input.edits.forEach((e, i) => {
            if (!e || typeof e !== 'object') { errors.push(`edits[${i}] must be an object`); return }
            if (!e.old_string) errors.push(`edits[${i}].old_string is required`)
            if (e.new_string === undefined || e.new_string === null) errors.push(`edits[${i}].new_string is required`)
            if (e.old_string === e.new_string) errors.push(`edits[${i}]: old_string 与 new_string 相同`)
          })
        }
        return { valid: errors.length === 0, errors }
      },
    }
    super(config, { undoStore })
    this.undoStore = undoStore
  }
  async execute(input, ctx = {}) {
    const p = toolPath(input.file_path, ctx)
    if (!existsSync(p)) throw new Error(`File not found: ${p}`)
    const original = readFileSync(p, 'utf-8')

    // 全部在内存中应用，任一失败直接抛错 → 文件保持原样
    let content = original
    const applied = []
    for (let i = 0; i < input.edits.length; i++) {
      const { old_string, new_string, replace_all } = input.edits[i]
      const occurrences = content.split(old_string).length - 1
      if (occurrences === 0) {
        throw new Error(`edits[${i}] 失败：old_string 未找到（前 ${i} 个编辑已在内存中应用，文件未改动）\n  ${JSON.stringify(old_string.slice(0, 80))}`)
      }
      if (occurrences > 1 && !replace_all) {
        throw new Error(`edits[${i}] 失败：old_string 匹配 ${occurrences} 处，不唯一。加 replace_all:true 或提供更长的上下文（文件未改动）`)
      }
      content = content.split(old_string).join(new_string)
      applied.push(`  ${i + 1}. 替换 ${occurrences} 处`)
    }

    backupBeforeOverwrite(p, content, input.backup_note || '')
    if (this.undoStore) this.undoStore.saveSnapshot(p, original, input.backup_note || '')
    writeFileSync(p, content, 'utf-8')
    trackVersion(p)   // 同 Edit：刷新版本，避免后续 Write 被误拦
    return `MultiEdit 完成 ${p}（${input.edits.length} 个编辑）\n${applied.join('\n')}`
  }
}
