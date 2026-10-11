// 工具审批 + 权限模式 + permissions.json 规则（真正接到 runtime）
import { readFileSync, existsSync, statSync } from 'node:fs'
import { atomicWrite } from './atomic.mjs'
import { resolveConfigPath } from './paths.mjs'
import { classifyBashCommand } from '../permission/bash-readonly.mjs'

// 【2026-10-03】原为相对路径（相对 cwd）→ 读写源码目录里的配置。
// 用户要求配置属用户数据，统一放 ~/.claude-code-mobile/（见 core/paths.mjs）。
const PERM_FILE = resolveConfigPath('permissions.json')
const CONFIG_FILE = resolveConfigPath('config.json')

// 装饰性工具：default 模式下未点名就默认拒绝（治乱调）
export const DECORATIVE_TOOLS = new Set([
  'Toast', 'TTS', 'Notify', 'Vibrate', 'Battery', 'Location', 'ClipboardGet', 'Screencap',
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
  constructor() {
    this.mode = this._loadMode() // default | acceptEdits | plan | bypassPermissions
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

  /**
   * 统一权限裁决
   * @returns {{ allowed: boolean, reason?: string, needAsk?: boolean }}
   */
  resolve(toolName, input = {}) {
    // 0) plan 模式的 Bash 只读约束 **先于显式规则** —— 这是硬约束，不是偏好。
    //
    // 【2026-10-11 为什么提到规则前面】原来 plan 的 Bash 检查在规则之后，
    // 而第 1 步的 `rules.allow.includes(toolName)` 会直接 return true。
    // 本机 permissions.json 恰好配了 allow:["Bash"]（很常见 —— 用户不想每次
    // 执行命令都被拦），于是 plan 模式的写保护**完全失效**：
    // 切到 plan 后 rm -rf /tmp 照样跑。这是安全缺口，不是配置问题。
    //
    // plan 的语义是「只看不改」，任何配置都不应该让它放行写操作 ——
    // 想跑写命令就该切出 plan（/permissions mode acceptEdits）。
    if (this.mode === 'plan' && toolName === 'Bash') {
      const cmd = String(input.command || '')
      const r = classifyBashCommand(cmd)
      if (!r.readonly) {
        return { allowed: false, reason: `plan 模式仅允许只读命令（${r.reason || '无法确认'}）` }
      }
    }

    // 1) 显式规则次高优先
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
        // plan 下 Bash 的只读约束已在第 0 步处理（先于规则，防 allow 绕过）
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
}

export { MODES as PERMISSION_MODES }
