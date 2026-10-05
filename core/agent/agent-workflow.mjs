// Claude Code Mobile - Agent workflow
// 固定、可审计的 Explore → Plan → Implement → Review 子 Agent 流程。
// 每阶段独立上下文；阶段结果只以压缩后的文本传给下一阶段。
import { Tool } from '../tools/tools.mjs'
import { Agent } from './agent.mjs'
import { registerBackgroundTask } from './bg-tasks.mjs'
import { preview as tracePreview } from '../api/trace.mjs'

const STAGE_LIMIT = 12000
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

export const WORKFLOW_STAGES = {
  Explore: {
    description: '只读探索代码库，收集相关文件、符号、约束和现状',
    maxTurns: 200,
    tools: ['Read', 'Glob', 'Grep', 'CodeSearch', 'RepoMap', 'Symbols', 'LSP', 'GitStatus', 'GitLog', 'WebFetch', 'HashlineRead', 'HashlineGrep'],
    prompt: `你负责 Explore 阶段。只读调查，不修改文件、不提交 git、不调用 Agent 或 AgentWorkflow。
先确认任务涉及的代码路径、入口、关键符号、现有测试和约束。完成后返回事实密集的探索报告，保留 file_path:line_number。`,
  },
  Plan: {
    description: '根据探索结果制定可执行计划和验证步骤',
    maxTurns: 200,
    tools: ['Read', 'Glob', 'Grep', 'CodeSearch', 'RepoMap', 'Symbols', 'LSP', 'GitStatus', 'GitDiff', 'TodoWrite', 'HashlineRead', 'HashlineGrep', 'TaskCreate', 'TaskList', 'TaskGet', 'TaskUpdate', 'TeamCreate', 'TeamJoin', 'TeamStatus', 'SendMessage', 'CheckMessages'],
    prompt: `你负责 Plan 阶段。只读分析，不修改文件、不提交 git、不调用 Agent 或 AgentWorkflow。
根据原始任务和 Explore 报告，产出分步骤计划、涉及文件、风险、回滚点和验证命令。不要把计划写成已经完成。
多步骤任务用 TaskCreate 把每步落成持久任务，有先后顺序的用 blockedBy 标明依赖，让 Implement 阶段能逐个领取。`,
  },
  Implement: {
    description: '按计划实施修改并验证结果',
    maxTurns: 200,
    tools: null,
    prompt: `你负责 Implement 阶段。根据原始任务、Explore 报告和 Plan 报告实施修改。
优先编辑现有文件，遵守项目约定；改动后运行合适的语法检查或测试。不要调用 AgentWorkflow 递归拆分任务；遇到不确定处基于仓库证据推进，并在结果中说明。
若 Plan 阶段建了 Task（先 TaskList 看一下）：开工前 TaskClaim 领取，做完一件立即 TaskUpdate 标 completed，不要攒到最后一起改。`,
  },
  Review: {
    description: '只读审查实现、风险和测试证据',
    maxTurns: 200,
    tools: ['Read', 'Glob', 'Grep', 'CodeSearch', 'RepoMap', 'Symbols', 'LSP', 'GitStatus', 'GitDiff', 'GitLog', 'Test', 'Diagnostics', 'HashlineRead', 'HashlineGrep', 'TaskList', 'TaskGet', 'TeamStatus', 'CheckMessages', 'SendMessage'],
    prompt: `你负责 Review 阶段。只读审查，不修改文件、不提交 git、不调用 Agent 或 AgentWorkflow。
检查实现是否满足原始任务，寻找 bug、安全问题、遗漏测试和未验证声明。明确区分已验证和待验证项，并给出 file_path:line_number。`,
  },
}

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback
}

function stageTools(allTools, stageName) {
  const cfg = WORKFLOW_STAGES[stageName]
  const blocked = new Set(['Agent', 'AgentWorkflow', 'AskUserQuestion'])
  const candidates = allTools.filter(t => t && !blocked.has(t.name))
  if (cfg.tools === null) return candidates
  const allowed = new Set(cfg.tools)
  return candidates.filter(t => allowed.has(t.name))
}

function stagePrompt(base, original, reports, stageName) {
  const prior = reports.length
    ? `\n\n## 前置阶段报告\n${reports.map(r => `### ${r.stage}\n${r.result}`).join('\n\n')}`
    : ''
  return `${base}\n\n## 原始任务\n${original}${prior}\n\n## 当前阶段\n${stageName}\n只返回当前阶段的实质结果，供后续阶段继续使用。`
}

function withTimeout(signal, timeoutMs) {
  const controller = new AbortController()
  let timer = setTimeout(() => controller.abort(), timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  let listener = null
  if (signal) {
    listener = () => controller.abort()
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', listener, { once: true })
  }
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer)
      timer = null
      if (signal && listener) signal.removeEventListener('abort', listener)
    },
  }
}

export class AgentWorkflowTool extends Tool {
  constructor({ api = null, systemPrompt = '', tools = [], onPermissionRequest, logger, traceEnabled = true, cwd = null, sessionId = null } = {}) {
    super({
      name: 'AgentWorkflow',
      description: '运行 Explore → Plan → Implement → Review 的多阶段子 Agent 工作流；每阶段独立上下文并返回阶段报告。适合复杂多文件任务。',
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '要完成的完整任务' },
          stages: { type: 'array', items: { type: 'string', enum: Object.keys(WORKFLOW_STAGES) }, description: '阶段列表，默认 Explore、Plan、Implement、Review' },
          run_in_background: { type: 'boolean', description: '是否后台执行，默认 false' },
          timeout_ms: { type: 'number', description: '每个阶段超时，默认 600000，最大 1800000' },
          max_turns: { type: 'number', description: '覆盖每阶段 maxTurns，范围 1-300' },
        },
        required: ['prompt'],
      },
      isReadOnly: () => false,
      maxResultSizeChars: 30000,
      validateInput: input => {
        const errors = []
        if (!input || typeof input.prompt !== 'string' || !input.prompt.trim()) errors.push('prompt 必须是非空字符串')
        if (input?.stages !== undefined && (!Array.isArray(input.stages) || input.stages.length === 0)) errors.push('stages 必须是非空数组')
        if (Array.isArray(input?.stages) && input.stages.some(s => !WORKFLOW_STAGES[s])) errors.push(`stages 只能包含: ${Object.keys(WORKFLOW_STAGES).join(', ')}`)
        return { valid: errors.length === 0, errors }
      },
    })
    this.api = api
    this.systemPrompt = systemPrompt
    this.tools = tools
    this.onPermissionRequest = onPermissionRequest || (async () => true)
    this.logger = logger || console
    this.traceEnabled = traceEnabled !== false
    this.cwd = cwd || null
    this.sessionId = sessionId || null
    this._activeTrace = null
  }

  setTrace(trace) { this._activeTrace = trace }

  _getSystemPrompt() {
    return typeof this.systemPrompt === 'function' ? this.systemPrompt() : this.systemPrompt
  }

  _getStages(input) {
    const requested = Array.isArray(input.stages) && input.stages.length ? input.stages : Object.keys(WORKFLOW_STAGES)
    return requested.filter((name, index) => WORKFLOW_STAGES[name] && requested.indexOf(name) === index)
  }

  async _run(input, signal = null) {
    if (!this.api) throw new Error('AgentWorkflow 尚未绑定 API')
    const stages = this._getStages(input)
    const timeoutMs = clampInt(input.timeout_ms, DEFAULT_TIMEOUT_MS, 10_000, 1_800_000)
    const maxTurnsOverride = input.max_turns == null ? null : clampInt(input.max_turns, 200, 1, 300)
    const reports = []
    const startedAt = Date.now()
    this._activeTrace?.emit('workflow_start', { stages, timeout_ms: timeoutMs, prompt: tracePreview(input.prompt, 800) })

    for (const stageName of stages) {
      const cfg = WORKFLOW_STAGES[stageName]
      const selectedTools = stageTools(this.tools, stageName)
      const stageMaxTurns = maxTurnsOverride || cfg.maxTurns
      this._activeTrace?.emit('workflow_stage_start', { stage: stageName, max_turns: stageMaxTurns, tools: selectedTools.map(t => t.name) })
      const timed = withTimeout(signal, timeoutMs)
      const sub = new Agent({
        api: this.api,
        systemPrompt: `${this._getSystemPrompt()}\n\n${cfg.prompt}`,
        tools: selectedTools,
        maxTurns: stageMaxTurns,
        useStream: false,
        onPermissionRequest: this.onPermissionRequest,
        logger: this.logger,
        traceEnabled: this.traceEnabled,
        traceParentRunId: this._activeTrace?.runId || null,
        streamWatchdogMs: timeoutMs,
        cwd: this.cwd,
        sessionId: this.sessionId,
      })
      sub.setTrace?.(this._activeTrace)
      try {
        const result = await sub.run(stagePrompt(cfg.prompt, input.prompt, reports, stageName), { signal: timed.signal })
        const clipped = String(result || '(阶段无文本输出)').slice(0, STAGE_LIMIT)
        reports.push({ stage: stageName, ok: true, result: clipped, turns: sub.turnCount, trace_id: sub.getLastTraceId?.() || null })
        this._activeTrace?.emit('workflow_stage_end', { stage: stageName, ok: true, turns: sub.turnCount, trace_id: sub.getLastTraceId?.() || null, result: tracePreview(clipped, 500) })
      } catch (e) {
        const error = e?.message || String(e)
        this._activeTrace?.emit('workflow_stage_error', { stage: stageName, error })
        reports.push({ stage: stageName, ok: false, error, turns: sub.turnCount, trace_id: sub.getLastTraceId?.() || null })
        this._activeTrace?.emit('workflow_stage_end', { stage: stageName, ok: false, error, turns: sub.turnCount, trace_id: sub.getLastTraceId?.() || null })
        throw new Error(`AgentWorkflow 在 ${stageName} 阶段失败: ${error}`)
      } finally {
        timed.cleanup()
      }
    }

    const output = { ok: true, workflow: stages, duration_ms: Date.now() - startedAt, stages: reports }
    this._activeTrace?.emit('workflow_end', { ok: true, duration_ms: output.duration_ms, stages: reports.map(r => ({ stage: r.stage, ok: r.ok })) })
    return output
  }

  async execute(input) {
    if (input.run_in_background) {
      const task = registerBackgroundTask('local_agent', `workflow: ${String(input.prompt).slice(0, 60)}`)
      task.start()
      task.abortController = new AbortController()
      this._run(input, task.abortController.signal).then(result => {
        if (!task.isTerminal()) {
          task.appendOutput(JSON.stringify(result, null, 2))
          task.complete(result)
        }
      }).catch(e => {
        if (!task.isTerminal()) {
          task.appendOutput(`ERROR: ${e?.stack || e?.message || String(e)}`)
          task.fail(e.message)
        }
      })
      return JSON.stringify({ task_id: task.taskId, status: 'running', workflow: this._getStages(input), message: `AgentWorkflow 已在后台启动，用 /bg-status ${task.taskId} 查看` })
    }
    return JSON.stringify(await this._run(input), null, 2)
  }
}
