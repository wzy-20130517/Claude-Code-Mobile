// Claude Code Mobile - 搜索工具
import { Tool } from './tools.mjs'
import { lstatSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { resolve, join, sep, dirname } from 'node:path'

// ══════════════════════════════════════════════════════════════════════
//  防卡死约束（2026-09-27，实测触发）
// ══════════════════════════════════════════════════════════════════════
//
// 卡死证据：Glob({ path: home, pattern: '*capture*' }) 在 Termux 上
// 25 秒未完成，主线程被同步递归堵死，Ctrl+C 无效，spinner 冻结在
// 「Searching」。隔离子进程复现同样超时。
//
// 根因（两层）：
//   1. statSync 跟随符号链接 → 家目录下有 storage/shared → /storage/emulated/0
//      虽然 Termux 读不了 /sdcard/Android/data，但 73 个顶层条目 + 深层
//      树（Android/obb、DCIM、Download 等）也够它转几分钟。
//   2. readdirSync + statSync 全是同步调用，没有任何让出事件循环的机会，
//      332k 文件、59k 目录的遍历把所有异步回调（按键、spinner、网络）全堵死。
//
// 修法（三条一起上，缺一不可）：
//   a. 用 lstatSync 替代 statSync —— 不把符号链接当目录递归进去
//   b. 每扫 200 个条目 await setImmediate() 一次 —— 让事件循环喘口气
//   c. 条目数上限 + 已知慢目录跳过 —— 防止走到 /sdcard 里出不来

/** 最多扫描多少个文件系统条目（防止失控遍历） */
const MAX_WALK_ENTRIES = 3000
/** 每扫多少个条目让出一次事件循环 */
const WALK_YIELD_EVERY = 200
/** 已知慢/大目录：绝对路径前缀匹配。不在这些目录下递归。 */
const SKIP_DIR_PREFIXES = [
  '/storage/emulated',       // Android 共享存储（FUSE，stat 慢）
  '/sdcard',                 // 同上
  '/proc',                   // 虚拟文件系统，无意义
  '/sys',
  '/dev',
]
/** 跳过不进入的目录名（ basename 精确匹配） */
const SKIP_DIR_NAMES = new Set([
  'node_modules', '__pycache__', '.git', '.svn', '.hg',
  'Android',  // /sdcard/Android 里面的 data/obb 动辄几万文件
])

/** 让出事件循环的辅助 */
const yieldLoop = () => new Promise(r => setImmediate(r))

/**
 * 受限异步遍历器：walk 目录树，但受控。
 * @param {string} root 起始目录（绝对路径）
 * @param {(fullPath: string, name: string, isDir: boolean) => boolean|void} visit
 *   返回 false 停止整个遍历。
 * @returns {Promise<{stopped: boolean, visited: number}>}
 */
async function walkBounded(root, visit) {
  let visited = 0
  const stack = [root]
  while (stack.length > 0) {
    if (visited >= MAX_WALK_ENTRIES) return { stopped: true, visited }
    const dir = stack.pop()
    // 跳过已知慢/大目录
    if (SKIP_DIR_PREFIXES.some(p => dir === p || dir.startsWith(p + '/'))) continue
    let entries
    try { entries = readdirSync(dir) } catch { continue }
    for (const e of entries) {
      if (visited >= MAX_WALK_ENTRIES) return { stopped: true, visited }
      if (e.startsWith('.')) continue
      const full = join(dir, e)
      // 用 lstatSync：不跟随符号链接，防止循环/大目录穿透
      let s; try { s = lstatSync(full) } catch { continue }
      const isDir = s.isDirectory()
      if (isDir && SKIP_DIR_NAMES.has(e)) continue
      visited++
      const cont = visit(full, e, isDir)
      if (cont === false) return { stopped: true, visited }
      if (isDir) stack.push(full)
      // 定期让出事件循环
      if (visited % WALK_YIELD_EVERY === 0) await yieldLoop()
    }
  }
  return { stopped: false, visited }
}

export class GlobTool extends Tool {
  constructor() {
    super({
      name: 'Glob', description: 'glob 模式查找文件', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      maxResultSizeChars: 20000,
      validateInput: (input) => {
        const errors = []
        if (!input.pattern) errors.push('pattern is required')
        return { valid: errors.length === 0, errors }
      },
    })
  }
  async execute(input, ctx = {}) {
    const root = resolve(ctx.cwd || process.cwd(), input.path || '.')
    const results = []
    const { stopped, visited } = await walkBounded(root, (full, name, isDir) => {
      const relPath = full.slice(root.length + 1)
      if (this._matchGlob(relPath, input.pattern)) results.push(full)
      if (results.length >= 500) return false  // 够了，停
    })
    if (stopped && visited >= MAX_WALK_ENTRIES) {
      return results.length
        ? results.slice(0, 500).join('\n') + `\n... [已达 ${MAX_WALK_ENTRIES} 条目上限，结果截断] ...`
        : `(扫描了 ${MAX_WALK_ENTRIES} 个条目仍未找到匹配，已截断。请缩小 path 范围。)`
    }
    return results.slice(0, 500).join('\n') || '(no matches)'
  }

  _matchGlob(path, pattern) {
    let regex = ''
    let i = 0
    while (i < pattern.length) {
      const c = pattern[i]
      if (c === '*' && pattern[i + 1] === '*') {
        regex += '.*'
        i += 2
        if (pattern[i] === '/') i++
      } else if (c === '*') {
        regex += '[^/]*'
        i++
      } else if (c === '?') {
        regex += '[^/]'
        i++
      } else if ('\\^$.+()[]{}|'.includes(c)) {
        regex += '\\' + c
        i++
      } else if (c === '/') {
        regex += sep === '\\' ? '[\\\\/]' : '/'
        i++
      } else {
        regex += c
        i++
      }
    }
    try {
      const r = new RegExp('^' + regex + '$')
      return r.test(path)
    } catch { return false }
  }
}

export class GrepTool extends Tool {
  constructor() {
    super({
      name: 'Grep', description: '正则搜索文件内容', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, include: { type: 'string' } }, required: ['pattern'] },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      maxResultSizeChars: 30000,
      validateInput: (input) => {
        const errors = []
        if (!input.pattern) errors.push('pattern is required')
        return { valid: errors.length === 0, errors }
      },
    })
  }
  async execute(input, ctx = {}) {
    const root = resolve(ctx.cwd || process.cwd(), input.path || '.')
    let r
    try { r = new RegExp(input.pattern) } catch (e) { return `Invalid regex: ${e.message}` }
    const matches = []
    let fileFilter = null
    if (input.include) {
      try { fileFilter = new RegExp(input.include) } catch {}
    }

    // 目录遍历时跳过大文件（>5MB），但要在结果里告知 —— 不能静默吞掉
    let skippedLarge = 0
    const searchFile = (full, { skipLarge = false } = {}) => {
      let content
      try {
        if (skipLarge) {
          const st = lstatSync(full)
          if (st.size > 5 * 1024 * 1024) { skippedLarge++; return }
        }
        content = readFileSync(full, 'utf-8')
      } catch { return }
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].search(r) !== -1) {
          matches.push(`${full}:${i + 1}:${lines[i]}`)
          if (matches.length >= 200) return
        }
      }
    }

    // ⚠️ path 可能指向**单个文件**而不是目录。
    // 单文件搜索不跳过大文件（用户明确指定了目标），只截断输出。
    let isFile = false
    try { isFile = lstatSync(root).isFile() } catch { /* 路径不存在，下面 walk 会处理 */ }

    if (isFile) {
      searchFile(root, { skipLarge: false })
    } else {
      await walkBounded(root, (full, name, isDir) => {
        if (isDir) return  // 目录由 walkBounded 自己决定是否深入
        if (fileFilter && !fileFilter.test(name)) return
        searchFile(full, { skipLarge: true })
        if (matches.length >= 200) return false
      })
    }

    let result = matches.join('\n') || '(no matches)'
    if (skippedLarge > 0) {
      result += `\n[跳过了 ${skippedLarge} 个 >5MB 的大文件（目录遍历时为保响应速度）。如需搜索它们，请直接指定文件路径。]`
    }
    return result
  }
}

// 语义/索引搜索：带倒排索引缓存 + 模糊匹配
// 用法：query 关键词，可选 path 限定目录；返回 文件:行号:内容
export class CodeSearchTool extends Tool {
  constructor() {
    super({
      name: 'CodeSearch',
      description: '语义/索引搜索代码：用关键词模糊匹配符号、函数、变量名（比 Grep 更适合"找那个函数叫什么"）',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词（支持空格分隔多个词，全部匹配才命中）' },
          path: { type: 'string', description: '限定目录（默认当前目录）' },
          include: { type: 'string', description: '文件名过滤正则（如 \\.mjs$）' },
          limit: { type: 'number', description: '返回条数上限（默认 50）' },
        },
        required: ['query'],
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      maxResultSizeChars: 30000,
      validateInput: (input) => {
        const errors = []
        if (!input.query) errors.push('query is required')
        return { valid: errors.length === 0, errors }
      },
    })
  }

  async execute(input, ctx = {}) {
    const root = resolve(ctx.cwd || process.cwd(), input.path || '.')
    const query = String(input.query).toLowerCase().split(/\s+/).filter(Boolean)
    const limit = Math.max(1, Math.min(200, Number(input.limit) || 50))
    let fileFilter = null
    if (input.include) { try { fileFilter = new RegExp(input.include) } catch {} }

    const results = []

    /** 搜一个文件 */
    const searchFile = (full, name) => {
      if (fileFilter && !fileFilter.test(name)) return
      if (!/\.(mjs|js|ts|jsx|tsx|py|json|md|css|html|sh)$/i.test(name)) return
      let content; try { content = readFileSync(full, 'utf-8') } catch { return }
      const srcLines = content.split('\n')
      for (let i = 0; i < srcLines.length; i++) {
        if (results.length >= limit) return
        const line = srcLines[i]
        const low = line.toLowerCase()
        const hit = query.every(q => low.includes(q))
        if (hit) {
          results.push(`${full}:${i + 1}:${line.trim().slice(0, 200)}`)
        }
      }
    }

    let isFile = false
    try { isFile = lstatSync(root).isFile() } catch { /* 不存在，交给 walk */ }

    if (isFile) {
      searchFile(root, root.split(sep).pop() || root)
    } else {
      await walkBounded(root, (full, name, isDir) => {
        if (isDir) return
        searchFile(full, name)
        if (results.length >= limit) return false
      })
    }

    return results.join('\n') || '(no matches)'
  }
}
