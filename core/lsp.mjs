// Claude Code Mobile - LSP 工具
// 提供诊断、hover、定义跳转、补全等 LSP 能力
// 支持 TypeScript 和 Python（pyright）

import { Tool } from './tools.mjs'
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { resolve, extname, dirname } from 'node:path'

// ─────────────────────────────────────────────────────────────
// LSP Server 配置：按文件扩展名路由
// ─────────────────────────────────────────────────────────────
const NPM_ROOT = '/data/data/com.termux/files/usr/lib/node_modules'
const TSLSP_BIN = `${NPM_ROOT}/typescript-language-server/lib/cli.mjs`
const TSSERVER_PATH = `${NPM_ROOT}/typescript/lib/tsserver.js`
const PYRIGHT_LS = `${NPM_ROOT}/pyright/langserver.index.js`

// 语言 → LSP 服务器配置
const SERVER_CONFIGS = {
  typescript: {
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    command: process.execPath,
    args: [TSLSP_BIN, '--stdio'],
    initOptions: {
      // typescript-language-server 支持的 initializationOptions
      tsserver: { path: TSSERVER_PATH },
      logVerbosity: 'off',
      plugins: [],
      // 启用诊断（推送到 client）
      diagnostics: true,
      // 关闭 file-level 语义检查的延迟（尽快发送）
      diagnosticDelay: 0,
    },
  },
  python: {
    extensions: ['.py', '.pyi'],
    command: process.execPath,
    args: [PYRIGHT_LS, '--stdio'],
    initOptions: {},
  },
}

// 扩展名 → 语言
const EXT_TO_LANG = {}
for (const [lang, cfg] of Object.entries(SERVER_CONFIGS)) {
  for (const ext of cfg.extensions) EXT_TO_LANG[ext] = lang
}

function getLanguage(filePath) {
  return EXT_TO_LANG[extname(filePath).toLowerCase()]
}

// ─────────────────────────────────────────────────────────────
// LSP Client：单例，管理一个语言的长连接子进程
// ─────────────────────────────────────────────────────────────
class LspClient {
  constructor(config, language) {
    this.config = config
    this.language = language
    this.proc = null
    this.requestId = 0
    this.pending = new Map()      // id → { resolve, reject, timer }
    this.openedFiles = new Map()  // filePath → { mtime, version }，用 mtime 检测文件改动
    this.initialized = false
    this.initPromise = null
    this.shuttingDown = false
    this.lastActivity = Date.now()
  }

  async _ensureStarted() {
    if (this.proc && this.proc.exitCode === null && !this.shuttingDown) return
    if (this.initPromise) return this.initPromise
    // 失败时清空 initPromise，允许下次重试（否则 rejected promise 会被缓存，LSP 永久不可用直到重启）
    this.initPromise = this._start().catch((e) => {
      this.initPromise = null
      throw e
    })
    return this.initPromise
  }

  async _start() {
    const { command, args } = this.config
    this.proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, npm_config_prefix: NPM_ROOT },
    })
    // spawn 失败（命令不存在/无执行权限）会异步 emit 'error'，无监听者会抛未捕获异常崩整个进程
    this.proc.on('error', (err) => {
      for (const { reject } of this.pending.values()) {
        try { reject(new Error(`LSP server (${this.language}) spawn failed: ${err.message}`)) } catch {}
      }
      this.pending.clear()
      this.openedFiles.clear()
      this.initialized = false
      this.initPromise = null
      this.proc = null
    })
    this.proc.on('exit', (code, signal) => {
      // 非预期退出，清理状态，下次重新启动
      if (!this.shuttingDown) {
        for (const { reject } of this.pending.values()) {
          reject(new Error(`LSP server (${this.language}) exited unexpectedly (code=${code})`))
        }
        this.pending.clear()
        this.openedFiles.clear()
        this.initialized = false
        this.initPromise = null
        this.proc = null
      }
    })
    let buf = Buffer.alloc(0)
    this.proc.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (true) {
        if (buf.length < 16) return
        const headerEnd = buf.indexOf('\r\n\r\n', 0, 'utf8')
        if (headerEnd < 0) return
        const headerStr = buf.slice(0, headerEnd).toString('utf8')
        const headerMap = {}
        for (const line of headerStr.split('\r\n')) {
          const [k, v] = line.split(': ')
          if (k && v) headerMap[k.toLowerCase()] = v
        }
        const contentLen = parseInt(headerMap['content-length'] || '0', 10)
        if (isNaN(contentLen) || contentLen <= 0 || buf.length < headerEnd + 4 + contentLen) return
        const body = buf.slice(headerEnd + 4, headerEnd + 4 + contentLen).toString('utf8')
        buf = buf.slice(headerEnd + 4 + contentLen)
        let msg
        try { msg = JSON.parse(body) } catch { continue }
        this._handleMessage(msg)
      }
    })
    this.proc.stderr.on('data', () => { /* 丢弃 stderr，避免噪音 */ })
    // LSP initialize
    const result = await this._send('initialize', {
      processId: process.pid,
      capabilities: {
        textDocument: {
          synchronization: { didOpen: true, didChange: false, willSave: false },
          publishDiagnostics: { relatedInformation: true },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: false },
          completion: { completionItem: { snippetSupport: false } },
        },
      },
      rootUri: `file://${this.config.cwd || process.cwd()}`,
      initializationOptions: this.config.initOptions || {},
    })
    // 发 initialized notification
    this._notify('initialized', {})
    this.initialized = true
    return result
  }

  _handleMessage(msg) {
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id)
      clearTimeout(timer)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    } else if (msg.method === 'textDocument/publishDiagnostics') {
      // 按 uri 缓存诊断（push 模式）
      const uri = msg.params && msg.params.uri
      if (uri) this.diagnosticsByUri = this.diagnosticsByUri || new Map()
      if (uri && this.diagnosticsByUri) {
        const diags = msg.params.diagnostics || []
        this.diagnosticsByUri.set(uri, diags)
        // 跟踪每个 uri 最近的 publish 时间（用于静默等待）
        this._diagTimes = this._diagTimes || new Map()
        this._diagTimes.set(uri, Date.now())
        // 仅当获得非空诊断或多次更新后再通知等待者
        this._diagNotifyCount = this._diagNotifyCount || new Map()
        const cnt = (this._diagNotifyCount.get(uri) || 0) + 1
        this._diagNotifyCount.set(uri, cnt)
        // 第一次空（0 项）表示 server 预热阶段，继续等
        // 第二次或非空即可通知
        if (cnt >= 2 || diags.length > 0) {
          const waiters = this._diagWaiters && this._diagWaiters.get(uri)
          if (waiters) {
            this._diagWaiters.delete(uri)
            this._diagNotifyCount.delete(uri)
            for (const w of waiters) w()
          }
        }
        // 第一次 0 项时继续等待后续 publish 或总超时
      }
    }
    // 其他通知忽略
  }

  _waitForDiagnostics(uri, timeoutMs = 2500) {
    return new Promise((resolve) => {
      if (!this.diagnosticsByUri) this.diagnosticsByUri = new Map()
      this._diagWaiters = this._diagWaiters || new Map()
      const arr = this._diagWaiters.get(uri) || []
      arr.push(resolve)
      this._diagWaiters.set(uri, arr)
      // 总超时兜底
      setTimeout(() => {
        const waiters = this._diagWaiters && this._diagWaiters.get(uri)
        if (waiters) {
          this._diagWaiters.delete(uri)
          for (const w of waiters) w()
        }
      }, timeoutMs)
    })
  }

  _send(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.exitCode !== null) {
        reject(new Error('LSP server not running'))
        return
      }
      const id = ++this.requestId
      const msg = { jsonrpc: '2.0', id, method, params: params || {} }
      const body = JSON.stringify(msg)
      const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`LSP request '${method}' timed out (10s)`))
      }, 10000)
      this.pending.set(id, { resolve, reject, timer })
      this.proc.stdin.write(header + body)
    })
  }

  _notify(method, params) {
    if (!this.proc || this.proc.exitCode !== null) return
    const msg = { jsonrpc: '2.0', method, params: params || {} }
    const body = JSON.stringify(msg)
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
    this.proc.stdin.write(header + body)
  }

  async openFile(filePath) {
    await this._ensureStarted()
    let text
    try { text = readFileSync(filePath, 'utf8') } catch (e) {
      throw new Error(`无法读取文件: ${e.message}`)
    }
    // 用 mtime 判断文件自上次打开后是否被改动（Edit/Write 后）
    let mtime = 0
    try { mtime = statSync(filePath).mtimeMs } catch {}
    const prev = this.openedFiles.get(filePath)
    if (prev && prev.mtime === mtime) return false  // 未变化，命中缓存（未重新同步）
    const uri = `file://${filePath}`
    const lang = getLanguage(filePath)
    const LANGUAGE_ID = { typescript: 'typescript', python: 'python' }
    if (prev) {
      // 文件已打开但内容变了：先 didClose 再重新 didOpen，让 server 丢弃旧诊断
      this._notify('textDocument/didClose', { textDocument: { uri } })
      // 清掉该 uri 的旧推送诊断缓存，避免 getDiagnostics 命中过期结果
      if (this.diagnosticsByUri) this.diagnosticsByUri.delete(uri)
    }
    const version = prev ? (prev.version + 1) : 1
    this._notify('textDocument/didOpen', {
      textDocument: { uri, languageId: LANGUAGE_ID[lang] || lang, version, text },
    })
    this.openedFiles.set(filePath, { mtime, version })
    this.lastActivity = Date.now()
    // 给 server 500ms 预热 publishDiagnostics
    await new Promise(r => setTimeout(r, 500))
    return true  // 发生了 open / 重新 open（内容变化）
  }

  async getDiagnostics(filePath) {
    const uri = `file://${filePath}`
    // openFile 返回是否发生了同步（首次打开或文件改动后重开）；发生了就等诊断刷新
    const synced = await this.openFile(filePath)
    if (synced) await this._waitForDiagnostics(uri, 3000)
    // 尝试 pull diagnostics（LSP 3.17）
    try {
      const result = await this._send('textDocument/diagnostic', { textDocument: { uri } })
      if (result && result.items && result.items.length > 0) return result.items
    } catch { /* server 不支持 pull */ }
    // 回退到 push 缓存
    if (this.diagnosticsByUri && this.diagnosticsByUri.has(uri)) {
      const cached = this.diagnosticsByUri.get(uri)
      if (cached.length > 0) return cached
    }
    // 最终兜底：tsc 命令行 / pyright 命令行
    return this._fallbackDiagnostics(filePath)
  }

  async _fallbackDiagnostics(filePath) {
    const lang = getLanguage(filePath)
    if (lang === 'typescript') {
      try {
        const output = execFileSync(process.execPath, [
          `${NPM_ROOT}/typescript/bin/tsc`, '--noEmit', '--pretty', 'false', filePath
        ], { cwd: dirname(filePath), timeout: 15000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
        return []  // tsc 成功=无错误
      } catch (e) {
        const stderr = (e.stderr || '') + (e.stdout || '')
        return parseTscErrors(stderr)
      }
    }
    if (lang === 'python') {
      try {
        const output = execFileSync(process.execPath, [
          `${NPM_ROOT}/pyright/index.js`, filePath
        ], { cwd: dirname(filePath), timeout: 15000, encoding: 'utf-8' })
        return parsePyrightErrors(output)
      } catch (e) {
        const stdout = e.stdout || ''
        return parsePyrightErrors(stdout)
      }
    }
    return []
  }

  async hover(filePath, line, character) {
    await this.openFile(filePath)
    return this._send('textDocument/hover', {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character },
    })
  }

  async definition(filePath, line, character) {
    await this.openFile(filePath)
    const result = await this._send('textDocument/definition', {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character },
    })
    return result
  }

  async completion(filePath, line, character) {
    await this.openFile(filePath)
    const result = await this._send('textDocument/completion', {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character },
    })
    return result
  }

  async shutdown() {
    if (!this.proc || this.proc.exitCode !== null) return
    this.shuttingDown = true
    try {
      await this._send('shutdown', {})
      this._notify('exit', null)
    } catch {}
    this.proc.stdin.end()
    this.proc.kill()
    this.proc = null
    this.initialized = false
    this.initPromise = null
    this.openedFiles.clear()
    this.pending.clear()
  }
}

// ─────────────────────────────────────────────────────────────
// 全局 LSP 管理器：按语言缓存 client，长时持有
// ─────────────────────────────────────────────────────────────
class LspManager {
  constructor() {
    this.clients = new Map()  // lang → LspClient
    this.idleCheckTimer = setInterval(() => this._gcIdle(), 60000)
    // 不阻止进程自然退出
    if (this.idleCheckTimer.unref) this.idleCheckTimer.unref()
  }

  getClient(lang, cwd = process.cwd()) {
    if (!SERVER_CONFIGS[lang]) return null
    const key = `${lang}:${resolve(cwd)}`
    if (!this.clients.has(key)) {
      const cfg = { ...SERVER_CONFIGS[lang], cwd: resolve(cwd) }
      this.clients.set(key, new LspClient(cfg, lang))
    }
    return this.clients.get(key)
  }

  async run(filePath, action, params, cwd = process.cwd()) {
    const lang = getLanguage(filePath)
    if (!lang) {
      return {
        error: `LSP 不支持此文件类型: ${extname(filePath)}`,
        supported: Object.values(SERVER_CONFIGS).flatMap(c => c.extensions),
      }
    }
    if (!existsSync(resolve(filePath))) {
      return { error: `文件不存在: ${filePath}` }
    }
    const client = this.getClient(lang)
    try {
      switch (action) {
        case 'diagnostic':
          return await client.getDiagnostics(filePath)
        case 'hover':
          return await client.hover(filePath, params.line - 1, params.character - 1)
        case 'definition':
          return await client.definition(filePath, params.line - 1, params.character - 1)
        case 'completion':
          return await client.completion(filePath, params.line - 1, params.character - 1)
        default:
          return { error: `未知操作: ${action}` }
      }
    } catch (e) {
      return { error: e.message }
    }
  }

  _gcIdle() {
    // 5 分钟未使用则关闭
    const now = Date.now()
    for (const [lang, client] of this.clients) {
      if (now - client.lastActivity > 5 * 60 * 1000) {
        client.shutdown().catch(() => {})
        this.clients.delete(lang)
      }
    }
  }

  async shutdownAll() {
    await Promise.allSettled([...this.clients.values()].map(c => c.shutdown()))
    this.clients.clear()
    clearInterval(this.idleCheckTimer)
  }
}

// 全局单例
const lspManager = new LspManager()

// ─────────────────────────────────────────────────────────────
// LSP Tool 暴露给助手
// ─────────────────────────────────────────────────────────────
export class LspTool extends Tool {
  constructor() {
    super({
      name: 'LSP',
      description: '调用 Language Server Protocol 获取代码诊断、类型信息、定义跳转、补全建议。支持 TypeScript/JavaScript 和 Python。',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '目标文件路径' },
          action: {
            type: 'string',
            enum: ['diagnostic', 'hover', 'definition', 'completion'],
            description: '要执行的 LSP 操作',
          },
          line: { type: 'number', description: '行号（从1开始，用于 hover/definition/completion）' },
          character: { type: 'number', description: '列号（从1开始，用于 hover/definition/completion）' },
        },
        required: ['file_path', 'action'],
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => false,    // LSP 内部有缓存状态，避免并发
      maxResultSizeChars: 20000,
      validateInput: (input) => {
        const errors = []
        if (!input.file_path) errors.push('file_path is required')
        if (!input.action) errors.push('action is required')
        if (['hover', 'definition', 'completion'].includes(input.action) && (input.line == null || input.character == null)) {
          errors.push(`${input.action} 需要 line 和 character 参数`)
        }
        return { valid: errors.length === 0, errors }
      },
    })
  }

  async execute(input, ctx = {}) {
    const result = await lspManager.run(input.file_path, input.action, {
      line: input.line || 1,
      character: input.character || 1,
    }, ctx.cwd || process.cwd())
    return formatLspResult(result, input.action)
  }
}

// 格式化输出
function formatLspResult(result, action) {
  if (!result) return '(空结果)'
  if (result.error) {
    return `LSP 失败: ${result.error}${result.supported ? '\n支持的扩展名: ' + result.supported.join(', ') : ''}`
  }

  if (action === 'diagnostic') {
    if (!Array.isArray(result) || result.length === 0) return '(无诊断错误)'
    return result.map(d => {
      const sev = { 1: 'ERROR', 2: 'WARN', 3: 'INFO', 4: 'HINT' }[d.severity] || 'MSG'
      const start = d.range ? d.range.start : { line: 0, character: 0 }
      return `[${sev}] ${d.range ? start.line + 1 + ':' + (start.character + 1) : ''} ${d.message}${d.source ? ' (' + d.source + ')' : ''}`
    }).join('\n')
  }

  if (action === 'hover') {
    if (!result || (!result.contents && result.result === null)) return '(无 hover 信息)'
    let content
    if (typeof result.contents === 'string') content = result.contents
    else if (result.contents && result.contents.value) content = result.contents.value
    else content = JSON.stringify(result.contents)
    return content
  }

  if (action === 'definition') {
    if (!result) return '(未找到定义)'
    const locs = Array.isArray(result) ? result : [result]
    if (locs.length === 0) return '(未找到定义)'
    return locs.map(l => {
      const uri = l.uri || (l.targetUri)
      const range = l.range || l.targetRange
      const start = range ? range.start : { line: 0, character: 0 }
      return (uri ? uri.replace('file://', '') : '?') + ':' + (start.line + 1) + ':' + (start.character + 1)
    }).join('\n')
  }

  if (action === 'completion') {
    if (!result) return '(无补全)'
    const items = Array.isArray(result) ? result : (result.items || [])
    if (items.length === 0) return '(无补全)'
    return items.slice(0, 50).map(it => {
      const label = it.label || it.textEdit?.newText || '?'
      const kind = CompletionItemKindLabels[it.kind] || ''
      const detail = it.detail ? ' — ' + it.detail : ''
      return (kind ? `[${kind}] ` : '') + label + detail
    }).join('\n') + (items.length > 50 ? `\n... 其余 ${items.length - 50} 项已省略` : '')
  }

  return JSON.stringify(result, null, 2)
}

const CompletionItemKindLabels = {
  1: 'Text', 2: 'Method', 3: 'Function', 4: 'Constructor', 5: 'Field',
  6: 'Variable', 7: 'Class', 8: 'Interface', 9: 'Module', 10: 'Property',
  11: 'Unit', 12: 'Value', 13: 'Enum', 14: 'Keyword', 15: 'Snippet',
  16: 'Color', 17: 'File', 18: 'Reference', 19: 'Folder', 20: 'EnumMember',
  21: 'Constant', 22: 'Struct', 23: 'Event', 24: 'Operator', 25: 'TypeParameter',
}

// 解析 tsc --noEmit 输出
function parseTscErrors(output) {
  const diagnostics = []
  const re = /^([^(]+)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s+(.+)$/gm
  let m
  while ((m = re.exec(output)) !== null) {
    diagnostics.push({
      severity: m[4] === 'error' ? 1 : 2,
      message: `TS${m[5]}: ${m[6]}`,
      source: 'tsc',
      range: {
        start: { line: parseInt(m[2]) - 1, character: parseInt(m[3]) - 1 },
        end: { line: parseInt(m[2]) - 1, character: parseInt(m[3]) },
      },
    })
  }
  return diagnostics
}

// 解析 pyright 输出（pyright 命令行模式默认输出：file:line:col - error: msg）
function parsePyrightErrors(output) {
  const diagnostics = []
  const re = /^(.+?):(\d+):(\d+)\s*-\s*(error|warning|info):\s+(.+)$/gm
  let m
  while ((m = re.exec(output)) !== null) {
    diagnostics.push({
      severity: m[4] === 'error' ? 1 : m[4] === 'warning' ? 2 : 3,
      message: m[5],
      source: 'pyright',
      range: {
        start: { line: parseInt(m[2]) - 1, character: parseInt(m[3]) - 1 },
        end: { line: parseInt(m[2]) - 1, character: parseInt(m[3]) },
      },
    })
  }
  return diagnostics
}

export { lspManager, SERVER_CONFIGS, getLanguage }
