// 工具审批 + 权限模式 + permissions.json 规则（真正接到 runtime）
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { atomicWrite } from './atomic.mjs'
import { join } from 'node:path'
import { DATA_DIR, resolveConfigPath } from './paths.mjs'

// 【2026-10-03】原为相对路径（相对 cwd）→ 读写源码目录里的配置。
// 用户要求配置属用户数据，统一放 ~/.claude-code-mobile/（见 core/paths.mjs）。
const PERM_FILE = resolveConfigPath('permissions.json')
const CONFIG_FILE = resolveConfigPath('config.json')

// 装饰性工具：default 模式下未点名就默认拒绝（治乱调）
export const DECORATIVE_TOOLS = new Set([
  'Toast', 'TTS', 'Notify', 'Vibrate', 'Battery', 'Location', 'ClipboardGet', 'Screencap',
])

// 写操作类工具：acceptEdits 自动放行
const WRITE_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'HashlineEdit', 'GitAdd', 'GitCommit',
  'ApplyPatch', 'SafeRename',
])

// plan 模式允许的只读工具
const PLAN_ALLOWED = new Set([
  'Read', 'Glob', 'Grep', 'HashlineRead', 'HashlineGrep', 'Bash',
  'WebFetch', 'WebSearch', 'LSP', 'GitStatus', 'GitDiff', 'GitLog',
  'TodoWrite', 'ExitPlanMode', 'EnterPlanMode', 'EnterWatch', 'ExitWatch', 'Agent', 'Skill',
  'UserInputHistory', 'ViewImage', 'CommandExec', 'AskUserQuestion',
  'Test', 'Diagnostics', 'RepoMap', 'Symbols',
])

const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

export class PermissionManager {
  // 【2026-10-03】默认值原来是相对路径（相对 cwd）→ 缓存写进源码目录。
  // 改到家目录绝对路径，与源码分离。
  constructor(cacheFile = join(DATA_DIR, 'perm_cache.json')) {
    this.cacheFile = cacheFile
    this.cache = this._loadCache()
    this.mode = this._loadMode() // default | acceptEdits | plan | bypassPermissions
  }

  _loadCache() {
    try {
      if (!existsSync(this.cacheFile)) return {}
      return JSON.parse(readFileSync(this.cacheFile, 'utf-8'))
    } catch { return {} }
  }

  _saveCache() {
    try {
      const dir = this.cacheFile.split('/').slice(0, -1).join('/')
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
      atomicWrite(this.cacheFile, JSON.stringify(this.cache, null, 2), 'utf-8')
    } catch {}
  }

  _loadMode() {
    try {
      if (!existsSync(CONFIG_FILE)) return 'default'
      const c = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
      const m = c.permissionMode || c.permission_mode || 'default'
      return MODES.includes(m) ? m : 'default'
    } catch { return 'default' }
  }

  setMode(mode) {
    if (!MODES.includes(mode)) throw new Error(`未知模式: ${mode}，可选: ${MODES.join('|')}`)
    this.mode = mode
    try {
      let config = {}
      if (existsSync(CONFIG_FILE)) config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
      config.permissionMode = mode
      atomicWrite(CONFIG_FILE, JSON.stringify(config, null, 2))
    } catch {}
    return `权限模式 → ${mode}`
  }

  getMode() { return this.mode }

  loadRules() {
    // 带 mtime 缓存：resolve 每次工具调用都会跑，不能每次读盘
    try {
      if (!existsSync(PERM_FILE)) {
        this._rulesCache = { allow: [], deny: [], ask: [] }
        this._rulesMtime = 0
        return this._rulesCache
      }
      const m = statSync(PERM_FILE).mtimeMs
      if (this._rulesCache && this._rulesMtime === m) return this._rulesCache
      const r = JSON.parse(readFileSync(PERM_FILE, 'utf-8'))
      this._rulesCache = {
        allow: Array.isArray(r.allow) ? r.allow : [],
        deny: Array.isArray(r.deny) ? r.deny : [],
        ask: Array.isArray(r.ask) ? r.ask : [],
      }
      this._rulesMtime = m
      return this._rulesCache
    } catch {
      return this._rulesCache || { allow: [], deny: [], ask: [] }
    }
  }

  checkCache(toolName, input) {
    const key = `${toolName}:${JSON.stringify(input)}`
    return this.cache[key]
  }

  recordDecision(toolName, input, allowed) {
    const key = `${toolName}:${JSON.stringify(input)}`
    this.cache[key] = allowed
    this._saveCache()
  }

  /**
   * 统一权限裁决
   * @returns {{ allowed: boolean, reason?: string, needAsk?: boolean }}
   */
  resolve(toolName, input = {}) {
    // 1) 显式规则最高优先
    const rules = this.loadRules()
    if (rules.deny.includes(toolName)) {
      return { allowed: false, reason: `permissions.json deny: ${toolName}` }
    }
    if (rules.allow.includes(toolName)) {
      return { allowed: true }
    }
    if (rules.ask.includes(toolName)) {
      return { allowed: false, needAsk: true, reason: `permissions.json ask: ${toolName}` }
    }

    // 2) 模式
    if (this.mode === 'bypassPermissions') {
      return { allowed: true }
    }

    if (this.mode === 'plan') {
      if (PLAN_ALLOWED.has(toolName)) {
        // plan 下 Bash 仅放行明显只读前缀
        if (toolName === 'Bash') {
          const cmd = String(input.command || '')
          const writey = /\b(rm|mv|cp|write|tee|sed\s+-i|npm\s+i|pip\s+install|git\s+(commit|push|add)|chmod|chown)\b/i.test(cmd)
          if (writey) return { allowed: false, reason: 'plan 模式禁止写操作 Bash' }
        }
        return { allowed: true }
      }
      return { allowed: false, reason: `plan 模式禁止工具: ${toolName}` }
    }

    if (this.mode === 'acceptEdits') {
      // 自动放行写文件 + 一切只读；装饰工具仍拦
      if (DECORATIVE_TOOLS.has(toolName)) {
        return { allowed: false, reason: `acceptEdits 下装饰工具需 /permissions allow 或用户点名（${toolName}）` }
      }
      return { allowed: true }
    }

    // 3) default：拦装饰工具（除非 rules.allow）
    if (DECORATIVE_TOOLS.has(toolName)) {
      return { allowed: false, reason: `default 模式拒绝装饰工具 ${toolName}（用户未明确要求时）。需要：/permissions allow ${toolName} 或切换 /permissions mode bypassPermissions` }
    }

    // 危险 Bash 不再在这里 needAsk 等人确认——交给 Bash 工具内部的
    // （2026-09-26：原 confirm_dangerous 二次确认机制已删 —— 见 pty.mjs 顶部说明。）
    // permissions.json 里显式 ask/deny 仍然生效（上面第 1 步已处理）。

    return { allowed: true }
  }

  // 兼容旧接口：不再调用 onAsk 等人。Bash 默认允许（工具内确认）；其他 needAsk 视为拒绝。
  async checkPermission(toolName, input, onAsk) {
    if (toolName === 'Bash') {
      const rules = this.loadRules()
      if (rules.deny.includes('Bash')) return false
      return true
    }
    const r = this.resolve(toolName, input)
    if (r.allowed) return true
    // needAsk 也不阻塞用户，直接 false（工具结果 Denied）
    return false
  }
}

export { MODES as PERMISSION_MODES }
