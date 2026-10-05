// Claude Code Mobile - Hook 系统
// 支持事件：SessionStart, SessionEnd, PreToolUse, PostToolUse, UserPromptSubmit, PreCompact, PostCompact, Stop
import { exec } from 'node:child_process'
import { HOOKS_PATH } from './paths.mjs'
import { existsSync, readFileSync } from 'node:fs'

// shell 路径自适应（Termux / proot Ubuntu）
// 逻辑统一在 core/shell-path.mjs，这里包一层保持调用点不变
import { getShellPath } from './shell-path.mjs'
function detectShell() {
  return getShellPath()
}

const SHELL_PATH = detectShell()

export class HookManager {
  // 【2026-10-03】默认值从相对路径改为数据目录（配置属用户数据）
  constructor(configPath = HOOKS_PATH, logger) {
    this.configPath = configPath
    this.logger = logger || console
    this.hooks = this._loadConfig()
    this.shell = SHELL_PATH
    // skill 声明的 hooks。跟 hooks.json 分开存，因为生命周期不同：
    // hooks.json 是常驻配置，skill hooks 只在该 skill 激活期间有效，
    // skill 卸载/会话结束就要摘掉，混在一起会导致摘不干净。
    // 对齐官方 SkillHookMatcher —— 它也是 session 级、带 skillRoot 的独立层。
    this.skillHooks = new Map()  // skillName → { event: [entry...] }
  }

  /**
   * 注册某个 skill 的 hooks。
   * skillRoot 会作为 hook 命令的 cwd —— skill 的脚本应该在自己目录里跑，
   * 而不是在用户当前工作区（否则 skill 带的辅助脚本引不到相对路径）。
   */
  registerSkillHooks(skillName, hooksSpec, skillRoot = null) {
    if (!skillName || !hooksSpec || typeof hooksSpec !== 'object') return 0
    const byEvent = {}
    let count = 0
    for (const [event, entries] of Object.entries(hooksSpec)) {
      const list = Array.isArray(entries) ? entries : [entries]
      byEvent[event] = list.map(e => ({
        matcher: e.matcher || '',
        hooks: Array.isArray(e.hooks) ? e.hooks : (e.command ? [e] : []),
        // 标记来源，便于日志区分「是哪个 skill 拦了我的工具」
        _skill: skillName,
        _skillRoot: skillRoot,
      })).filter(e => e.hooks.length)
      count += byEvent[event].length
    }
    if (count) this.skillHooks.set(skillName, byEvent)
    return count
  }

  unregisterSkillHooks(skillName) {
    return this.skillHooks.delete(skillName)
  }

  clearSkillHooks() {
    const n = this.skillHooks.size
    this.skillHooks.clear()
    return n
  }

  /** 某事件下的全部 hook 条目 = hooks.json + 所有已激活 skill 的声明。 */
  _entriesFor(event) {
    const out = [...(this.hooks[event] || [])]
    for (const byEvent of this.skillHooks.values()) {
      if (byEvent[event]) out.push(...byEvent[event])
    }
    return out
  }

  _loadConfig() {
    try {
      if (!existsSync(this.configPath)) return {}
      return JSON.parse(readFileSync(this.configPath, 'utf-8'))
    } catch (e) {
      this.logger.warn && this.logger.warn(`[Hooks] ${e.message}`)
      return {}
    }
  }

  // 触发 hook 事件
  // 返回值：
  //   PreToolUse → { deny: true, message } 可阻止工具执行
  //   Stop → { block: true, message } 可阻止 agent 结束（续跑一轮）
  //   其他事件 → {} 无效果（观察类）
  async trigger(event, context = {}) {
    const entries = this._entriesFor(event)
    const result = {}
    for (const entry of entries) {
      // matcher 过滤（PreToolUse 按 tool name 匹配，其他事件按 context.matcher 字段匹配）
      const matchValue = context.tool || context.matcher || ''
      if (entry.matcher && matchValue) {
        let re
        try { re = new RegExp(entry.matcher) } catch (e) {
          this.logger.warn && this.logger.warn(`[Hooks] invalid matcher "${entry.matcher}": ${e.message}`)
          continue
        }
        if (!matchValue.match(re)) continue
      }

      // 展开 entry.hooks 数组，逐个执行
      const innerHooks = entry.hooks || []
      for (const hook of innerHooks) {
        // 带上来源 skill 信息：_runHook 用它决定 cwd 和环境变量
        const hookResult = await this._runHook(hook, {
          ...context, event,
          _skill: entry._skill, _skillRoot: entry._skillRoot,
        })

        // PreToolUse: DENY 短路
        if (event === 'PreToolUse' && hookResult?.deny) {
          return { deny: true, message: hookResult.message || 'Hook denied' }
        }

        // PreToolUse: hook 返回的 input 修改（官方 updatedInput 对应物）
        if (event === 'PreToolUse' && hookResult?.updatedInput && typeof hookResult.updatedInput === 'object') {
          result.updatedInput = { ...(result.updatedInput || {}), ...hookResult.updatedInput }
        }

        // PreToolUse: hook 返回的上下文注入（官方 additionalContext 对应物）
        if (event === 'PreToolUse' && hookResult?.additionalContext) {
          if (!result.additionalContexts) result.additionalContexts = []
          result.additionalContexts.push(hookResult.additionalContext)
        }

        // Stop: BLOCK 累积（所有 hook 都跑，block 累加）
        if (event === 'Stop' && hookResult?.block) {
          if (!result.blocks) result.blocks = []
          result.blocks.push(hookResult.message || 'Hook requested continue')
        }

        // UserPromptSubmit: 注入额外上下文
        if (event === 'UserPromptSubmit' && hookResult?.inject) {
          if (!result.injections) result.injections = []
          result.injections.push(hookResult.inject)
        }
      }
    }

    // Stop: 如果有任何 block，返回 block 结果
    if (event === 'Stop' && result.blocks?.length > 0) {
      return { block: true, messages: result.blocks }
    }

    // UserPromptSubmit: 返回注入内容
    if (event === 'UserPromptSubmit' && result.injections?.length > 0) {
      return { inject: result.injections.join('\n') }
    }

    // PreToolUse: 返回 hook 累积的 updatedInput / additionalContexts
    if (event === 'PreToolUse') {
      const out = {}
      if (result.updatedInput) out.updatedInput = result.updatedInput
      if (result.additionalContexts?.length) out.additionalContexts = result.additionalContexts
      return out
    }
    return {}
  }

  async _runHook(hook, context) {
    const env = {
      ...process.env,
      EVENT: context.event || '',
      TOOL_NAME: context.tool || '',
      TOOL_INPUT: JSON.stringify(context.input || {}),
      TOOL_OUTPUT: String(context.output || '').slice(0, 4000),
      // SessionStart/SessionEnd
      SESSION_ID: context.sessionId || '',
      // UserPromptSubmit
      PROMPT: context.prompt || '',
      // Stop
      STOP_REASON: context.reason || '',
      // PreCompact/PostCompact
      TOKEN_COUNT: String(context.tokenCount || ''),
      TOKEN_LIMIT: String(context.tokenLimit || ''),
      // skill hooks: 让脚本知道自己属于哪个 skill、资源在哪
      SKILL_NAME: context._skill || '',
      SKILL_ROOT: context._skillRoot || '',
    }
    const timeout = hook.timeout || (context.event === 'Stop' ? 60000 : 5000)
    try {
      const output = await new Promise((resolve, reject) => {
        const child = exec(hook.command, {
          env, encoding: 'utf-8', timeout,
          shell: this.shell,
          // skill 的 hook 在 skill 自己目录里跑，否则它带的辅助脚本引不到相对路径；
          // 全局 hooks.json 的 hook 仍在当前工作区跑（cwd 为 undefined = 继承）。
          cwd: context._skillRoot || undefined,
        }, (err, stdout, stderr) => {
          if (stderr) this.logger.warn && this.logger.warn(`[Hook stderr] ${stderr}`.trim())
          if (err && err.signal === 'SIGTERM') reject(new Error('Hook timeout'))
          else if (err) reject(err)
          else resolve(stdout)
        })
      })
      const trimmed = output.trim()

      // PreToolUse: DENY: 前缀
      if (context.event === 'PreToolUse' && trimmed.startsWith('DENY:')) {
        return { deny: true, message: trimmed.slice(5).trim() }
      }

      // Stop: BLOCK: 前缀阻止结束
      if (context.event === 'Stop' && trimmed.startsWith('BLOCK:')) {
        return { block: true, message: trimmed.slice(6).trim() }
      }

      // UserPromptSubmit: INJECT: 前缀注入上下文
      if (context.event === 'UserPromptSubmit' && trimmed.startsWith('INJECT:')) {
        return { inject: trimmed.slice(7).trim() }
      }

      return { deny: false }
    } catch (e) {
      this.logger.warn && this.logger.warn(`[Hook] ${hook.command} failed: ${e.message}`)
      // fail-closed 支持：hook 可声明 failClosed: true（安全类 hook 该这么配）。
      // 崩溃/超时 = 无法证明放行是安全的 → 拒绝执行，宁可误拦不可漏放。
      // 默认仍 fail-open：普通 hook（通知、统计）挂了不该挡住正常工作。
      if (hook.failClosed) {
        return { deny: true, message: `安全 hook 异常(${e.message})，已按 fail-closed 拦截` }
      }
      return { deny: false }
    }
  }

  // 获取所有已注册的事件名（供 /hooks 命令使用）
  getHookedEvents() {
    return Object.keys(this.hooks).filter(k => this.hooks[k].length > 0)
  }

  // 列出所有 hook 配置（供 /hooks 命令使用）
  getAllHooks() {
    const result = {}
    for (const [event, hooks] of Object.entries(this.hooks)) {
      if (hooks.length > 0) result[event] = hooks
    }
    return result
  }
}
