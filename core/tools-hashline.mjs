// Claude Code Mobile - Hashline 工具集
// 基于 hashline 锚点系统的 Read/Edit/Grep 工具
// anchor 格式: "行号:local"（如 "22:abc"），编辑时验证行未被改动

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, basename } from 'node:path'
import { Tool } from './tools.mjs'
import {
  generateAnchor, generateAnchors, parseAnchor, validateAnchor,
  findShifted, formatHashlineContent, lineHash, encodeHash
} from './hashline.mjs'

// ─── HashlineRead ──────────────────────────────────────────────
export class HashlineReadTool extends Tool {
  constructor() {
    super({
      name: 'HashlineRead',
      description: '读取文件内容，每行带 hashline 锚点（格式：行号:hash→内容）。读取后可用 HashlineEdit 的 anchor 精确编辑。anchor 验证行内容未被改动，比纯字符串匹配更安全。',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件路径' },
          offset: { type: 'number', description: '起始行号（1-based，默认1）' },
          limit: { type: 'number', description: '读取行数（默认全部）' },
        },
        required: ['file_path'],
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    })
  }

  async execute(input, ctx = {}) {
    const { file_path, offset, limit } = input
    const absPath = resolve(ctx.cwd || process.cwd(), file_path)
    if (!existsSync(absPath)) return `错误: 文件不存在: ${file_path}`
    const content = readFileSync(absPath, 'utf-8')
    return formatHashlineContent(content, offset, limit)
  }
}

// ─── HashlineEdit ──────────────────────────────────────────────
export class HashlineEditTool extends Tool {
  constructor(undoStore) {
    super({
      name: 'HashlineEdit',
      description: '使用 hashline 锚点精确编辑文件。每个编辑操作需要 anchor（从 HashlineRead 获取）验证目标行未改动。支持 replace（替换行）、insert_after（在某行后插入）、write（整个文件重写）。多操作批量执行（bottom-up）。anchor 过期会报错并返回当前内容的新 anchor。',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件路径' },
          edits: {
            type: 'array',
            description: '编辑操作列表（bottom-up 执行）',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['replace', 'insert_after', 'write'], description: '操作类型' },
                anchor: { type: 'string', description: '锚点字符串（如 "22:abc"），insert_after 可用 "0:" 表示文件开头，"EOF" 表示文件末尾。write 不需要' },
                end_anchor: { type: 'string', description: 'replace 范围结束锚点（可选，用于批量替换多行）' },
                content: { type: 'string', description: '替换/插入的新内容。replace 空字符串=删除行' },
              },
            },
          },
        },
        required: ['file_path', 'edits'],
      },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
    })
    this.undoStore = undoStore
  }

  async execute(input, ctx = {}) {
    const { file_path, edits } = input
    const absPath = resolve(ctx.cwd || process.cwd(), file_path)
    if (!existsSync(absPath)) return `错误: 文件不存在: ${file_path}`
    const content = readFileSync(absPath, 'utf-8')
    // undo 快照：在修改前保存旧内容
    if (this.undoStore) this.undoStore.saveSnapshot(absPath, content)
    const lines = content.split('\n')
    // 去掉末尾空元素（文件以 \n 结尾时）
    let trailingNl = ''
    if (lines.length > 1 && lines[lines.length - 1] === '') {
      lines.pop()
      trailingNl = '\n'
    }

    // 解析并验证所有 anchor，收集有效操作
    const ops = []
    for (const edit of edits) {
      if (edit.op === 'write') {
        ops.push({ type: 'write', content: edit.content || '' })
        continue
      }

      // 特殊 anchor: "0:" = BOF, "EOF" = 文件末尾
      if (edit.anchor === '0:' || edit.anchor === 'EOF') {
        if (edit.op === 'insert_after') {
          ops.push({
            type: 'insert_after',
            line: edit.anchor === 'EOF' ? lines.length + 1 : 0,
            content: edit.content || '',
            special: edit.anchor,
          })
        }
        continue
      }

      const anchor = parseAnchor(edit.anchor)
      if (!anchor) {
        return `错误: 无效的 anchor: "${edit.anchor}"。格式应为 "行号:local"（如 "22:abc"）`
      }

      // 验证 anchor
      const status = validateAnchor(anchor, lines)
      if (status === 'out_of_range') {
        return `错误: anchor ${edit.anchor} 行号超出范围（文件共 ${lines.length} 行）`
      }
      if (status === 'stale') {
        // 尝试搜索偏移
        const shift = findShifted(anchor, lines, 15)
        const currentAnchor = generateAnchor(lines[anchor.line - 1] || '', anchor.line)
        if (shift.found) {
          return `错误: anchor ${edit.anchor} 已过期（行内容已改动）。可能在第 ${shift.found} 行（新 anchor: ${generateAnchor(lines[shift.found - 1], shift.found)}）。请重新读取文件获取最新 anchor。`
        }
        if (shift.ambiguous) {
          return `错误: anchor ${edit.anchor} 已过期。多个候选行: ${shift.ambiguous.join(', ')}。请重新读取文件。`
        }
        return `错误: anchor ${edit.anchor} 已过期。第 ${anchor.line} 行当前内容: "${(lines[anchor.line - 1] || '').slice(0, 100)}"（当前 anchor: ${currentAnchor}）。请重新读取文件获取最新 anchor。`
      }

      if (edit.op === 'replace') {
        let endLine = anchor.line
        if (edit.end_anchor) {
          const endAnchor = parseAnchor(edit.end_anchor)
          if (!endAnchor) return `错误: 无效的 end_anchor: "${edit.end_anchor}"`
          const endStatus = validateAnchor(endAnchor, lines)
          if (endStatus !== 'valid') return `错误: end_anchor ${edit.end_anchor} 已过期或无效`
          endLine = endAnchor.line
        }
        ops.push({ type: 'replace', start: anchor.line, end: endLine, content: edit.content || '' })
      } else if (edit.op === 'insert_after') {
        ops.push({ type: 'insert_after', line: anchor.line, content: edit.content || '' })
      }
    }

    // write 操作：直接重写整个文件
    if (ops.length === 1 && ops[0].type === 'write') {
      writeFileSync(absPath, ops[0].content)
      const newLines = ops[0].content.split('\n')
      const snippetStart = 1
      const snippetEnd = Math.min(newLines.length, 10)
      const snippet = []
      for (let i = snippetStart - 1; i < snippetEnd; i++) {
        snippet.push(`${generateAnchor(newLines[i], i + 1)}→${newLines[i]}`)
      }
      return `已写入 ${newLines.length} 行。\n\n新内容前 ${snippetEnd} 行:\n${snippet.join('\n')}`
    }

    // 按 start 行号降序排列（bottom-up 避免行号偏移）
    ops.sort((a, b) => {
      const aLine = a.type === 'insert_after' ? a.line : a.start
      const bLine = b.type === 'insert_after' ? b.line : b.start
      return bLine - aLine
    })

    // 应用操作
    let applied = 0
    for (const op of ops) {
      if (op.type === 'replace') {
        const startIdx = op.start - 1
        const endIdx = op.end - 1
        const newContent = op.content || ''
        const newLines = newContent ? newContent.split('\n') : []
        lines.splice(startIdx, endIdx - startIdx + 1, ...newLines)
        applied++
      } else if (op.type === 'insert_after') {
        if (op.special === 'EOF' || op.line === 0) {
          // 文件开头或末尾
          if (op.line === 0) {
            const newLines = op.content.split('\n')
            lines.unshift(...newLines)
          } else {
            const newLines = op.content.split('\n')
            lines.push(...newLines)
          }
        } else {
          const insertIdx = op.line // 0-based: 在 op.line 之后插入
          const newLines = op.content.split('\n')
          lines.splice(insertIdx, 0, ...newLines)
        }
        applied++
      }
    }

    const newContent = lines.join('\n') + trailingNl
    writeFileSync(absPath, newContent)

    // 生成编辑区域的新 anchor snippet
    const firstOp = ops[ops.length - 1] // 最后一个 = 行号最小的
    const focusLine = firstOp.type === 'insert_after' ? firstOp.line : firstOp.start
    const ctxStart = Math.max(0, focusLine - 4)
    const ctxEnd = Math.min(lines.length, focusLine + 5)
    const snippet = []
    for (let i = ctxStart; i < ctxEnd; i++) {
      snippet.push(`${generateAnchor(lines[i], i + 1)}→${lines[i]}`)
    }

    return `已应用 ${applied} 个编辑操作。\n\n编辑区域附近（行 ${ctxStart + 1}-${ctxEnd}）:\n${snippet.join('\n')}`
  }
}

// ─── HashlineGrep ──────────────────────────────────────────────
export class HashlineGrepTool extends Tool {
  constructor() {
    super({
      name: 'HashlineGrep',
      description: '搜索文件内容，结果带 hashline 锚点。可用搜索到的 anchor 直接在 HashlineEdit 中编辑，无需先读取文件。支持正则表达式。',
      input_schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式' },
          path: { type: 'string', description: '搜索路径（文件或目录）' },
          include: { type: 'string', description: '文件名过滤（glob 模式，如 "*.mjs"）' },
        },
        required: ['pattern'],
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    })
  }

  async execute(input, ctx = {}) {
    const { pattern, path: searchPath, include } = input
    const cwd = searchPath
      ? resolve(ctx.cwd || process.cwd(), searchPath)
      : (ctx.cwd || process.cwd())

    // JS 原生搜索（不依赖系统 grep，兼容 Termux）
    const root = resolve(cwd)
    let regex
    try { regex = new RegExp(pattern) } catch (e) { return `Invalid regex: ${e.message}` }
    let fileFilter = null
    if (include) {
      // glob 转 regex：*.mjs → .*\.mjs
      const globRegex = include.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.')
      try { fileFilter = new RegExp(globRegex) } catch {}
    }

    const fileCache = new Map() // path → lines[]
    const outputLines = []
    let matchCount = 0

    const walk = (dir) => {
      let entries
      try { entries = readdirSync(dir) } catch { return }
      for (const e of entries) {
        if (e.startsWith('.') || e === 'node_modules') continue
        const full = join(dir, e)
        let s
        try { s = statSync(full) } catch { continue }
        if (s.isDirectory()) { walk(full); continue }
        if (fileFilter && !fileFilter.test(e)) continue

        let content
        try { content = readFileSync(full, 'utf-8') } catch { continue }
        const lines = content.split('\n')
        if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
        fileCache.set(full, lines)

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].search(regex) !== -1) {
            const anchor = generateAnchor(lines[i], i + 1)
            outputLines.push(`${full}:${i + 1}:${anchor}:${lines[i]}`)
            matchCount++
            if (matchCount >= 200) return
          }
        }
      }
    }
    walk(root)

    if (outputLines.length === 0) return '没有找到匹配结果'
    return outputLines.join('\n')
  }
}
