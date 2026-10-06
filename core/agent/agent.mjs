// @ts-nocheck
// Claude Code Mobile - Agent v4（5次重试 + 修复terminated + aiport tool args）
import { TraceStore, preview as tracePreview } from '../api/trace.mjs'
import { resolveToolTimeout, describeTimeout } from '../infra/tool-timeout.mjs'
import { StreamArgsPreview, shouldPreviewArgs } from '../ui/stream-args.mjs'
// 队友消息自动送达用。teams.mjs 不反向依赖 agent.mjs，无循环
import { readInbox as teamReadInbox } from './teams.mjs'
// 【轮数上限单一真值源】静态导入安全：plan.mjs 只在函数体内动态 import agent.mjs，
// 模块图中没有 agent → plan → agent 的静态环。
import { NORMAL_MAX_TURNS, DEEP_MAX_TURNS } from './plan.mjs'

/**
 * 合并流式 tool_calls.arguments 分片。
 * aiport/Claude 网关常见：先发完整 "{}"，再发完整真实 JSON（不是 token 级增量）。
 * 朴素字符串 += 会变成 "{}{...}" 导致 JSON.parse 失败 → 表现为「丢参」。
 */
function mergeToolArguments(prev, frag) {
  if (frag == null || frag === '') return prev || ''
  const p = prev || ''
  if (!p) return frag
  // 已经是完整 JSON，新片也是完整 JSON → 覆盖（取更「有内容」的）
  if (looksLikeCompleteJson(p) && looksLikeCompleteJson(frag)) {
    // 优先非空对象
    if (p === '{}' && frag !== '{}') return frag
    if (frag === '{}' && p !== '{}') return p
    // 两者都完整：用更长的（通常是真实参数）
    return frag.length >= p.length ? frag : p
  }
  // 标准 OpenAI 增量：直接拼接
  return p + frag
}

/**
 * 判断流式收集到的 tool_call.arguments 是否可用。
 * 关键：零参数工具（Battery / QQInbox / ClipboardGet 等）网关常推空 arguments
 * 或根本不推该字段——这是合法的 {}，不是截断，必须放行。
 * 只有“有内容但 JSON 未闭合/无法解析”才算真正损坏。
 */
function isUsableToolArguments(args) {
  if (args == null) return true              // 未推 arguments → 视为 {}
  if (typeof args !== 'string') return false
  const t = args.trim()
  if (t === '') return true                  // 空字符串 → 视为 {}
  return looksLikeCompleteJson(t)            // 有内容则必须是完整可解析 JSON
}

/** 把空/缺失 arguments 归一化为 "{}"，避免下游 JSON.parse 失败 */
function normalizeToolArguments(args) {
  if (args == null) return '{}'
  if (typeof args !== 'string') return '{}'
  const t = args.trim()
  return t === '' ? '{}' : args
}

function looksLikeCompleteJson(s) {
  if (typeof s !== 'string') return false
  const t = s.trim()
  if (!t) return false
  if (!(t.startsWith('{') || t.startsWith('['))) return false
  try { JSON.parse(t); return true } catch { return false }
}

export class Agent {
  constructor({ api, visionApi = null, systemPrompt, tools, maxTurns = NORMAL_MAX_TURNS, onText, onReasoning, onToolUse, onToolArgsPreview, onToolProgress, onToolResult, onError, onPermissionRequest, onTodoUpdate, onUsage, onTurnEnd, onTurnLimitApproaching, beforeToolCall = null, logger, undoStore, useStream, pullSteering, traceEnabled = true, traceDir = null, traceParentRunId = null, streamWatchdogMs = 300000, cwd = null, sessionId = null }) {
    this.api = api
    // 【让 api 层的内部重试进 trace】
    // api.request() 自己会按 maxRetries 重试，但 trace 里只有 agent 记的那一条
    // api_request —— 于是「60s×3+退避≈181s」在 trace 里看起来像"一次请求耗时181秒"，
    // 排查时完全看不出实际发了 3 次。这里包装（而不是覆盖）已有的 onRetry：
    // 原回调负责给用户打提示，我们额外补一条 trace 事件。
    if (api && typeof api === 'object') {
      const userOnRetry = api.onRetry
      api.onRetry = (info) => {
        try { this._traceEmit('api_retry', { turn: this.turnCount, ...info }) } catch {}
        if (typeof userOnRetry === 'function') { try { userOnRetry(info) } catch {} }
      }
    }
    this.visionApi = visionApi  // 可选：识图专用 api（智谱4v），含图消息自动切换
    this.systemPrompt = systemPrompt
    this.tools = tools
    this.maxTurns = maxTurns
    this.tokenBudget = null    // 预留：总 token 预算上限（未启用）
    this.onText = onText || (() => {})
    this.onReasoning = onReasoning || (() => {})  // GLM-5.2 思考内容流式回调
    this.onToolUse = onToolUse || (() => {})
    // 流式参数预览回调：tool_call 参数传输中触发，可选（不传就不做预览）
    this.onToolArgsPreview = onToolArgsPreview || null
    // 工具执行中的实时输出回调（Bash 等长任务用），可选
    this.onToolProgress = onToolProgress || null
    this.onToolResult = onToolResult || (() => {})
    this.onError = onError || (() => {})
    this.onPermissionRequest = onPermissionRequest || (async () => true)
    this.onTodoUpdate = onTodoUpdate || (() => {})
    // 每次 API 返回 usage 后触发：Web 用它把真实上下文用量推给前端
    this.onUsage = onUsage || (() => {})
    // 轮数接近 maxTurns 上限（剩≤10）时触发一次：(turnCount, maxTurns)。
    // CLI 用它给用户显示提醒；模型侧另有「自查空转」的 hidden 消息（见 run 循环）
    // 既支持构造参数传入，也支持构造后赋值（plan.mjs 走后者）
    this.onTurnLimitApproaching = onTurnLimitApproaching || null
    // 每个 turn 结束时触发：(turnCount)。QQ 桥用它按 turn 分条发送回复。
    this.onTurnEnd = onTurnEnd || null
    // pullSteering: () => string[] — Web mid-turn steering。
    // 2026-09-28：没传时用**内部队列**兜底 —— 这样 pushSteering() 对任何
    // Agent 实例都可用（resumeSubagent 给运行中的子 Agent 追加指令靠它，
    // 不再对同一实例重开 run 造成「两个 task 一个实例」）。
    this._steeringQueue = []
    this.pullSteering = typeof pullSteering === 'function'
      ? pullSteering
      : () => this._steeringQueue.splice(0)
    // 是否正在 run —— resumeSubagent 用它判断「在跑就注入，别重开」
    this.isRunning = false
    this.hookManager = null  // 可选：由外部设置
    /**
     * 每次工具调用**之前**的回调（2026-10-06 加）。
     *
     * 用途：上下文自动压缩 —— 检查 token 占用，超阈值时先压缩再继续。
     * 为什么放在 agent 层而不是 hook：hook 是**外部脚本**，只能
     * 返回 DENY/INJECT，**没法真正执行压缩**（压缩要改 agent 的历史，
     * 是进程内操作）。这里给一个进程内回调，能拿到 agent 实例直接操作。
     *
     * 签名：async (agent) => void（抛异常不影响工具执行）
     * 由 index.mjs 注入（它持有 compactService）。
     */
    this.beforeToolCall = beforeToolCall
    this.undoStore = undoStore || null  // 可选：用于 group 撤销
    this.cwd = cwd || null
    this.sessionId = sessionId
    // useStream: true/false/function。function 时每轮调用，支持热切换
    this.useStream = useStream !== undefined ? useStream : true
    this.logger = logger || console
    this.messages = []
    this.turnCount = 0
    this.tokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    // ── 运行时指标（状态条展示用，2026-09-15）──
    //
    // 需求来自状态条要多显示「平均首字 / LLM 时间 / 工具时间」。
    // 这些之前在 trace 里算过（stream_end 的 first_event_ms / duration_ms），
    // 但 trace 是落盘给排查用的，UI 拿不到。这里单独累积一份轻量的。
    //
    // 单位一律用 ms，_llmCalls 用于算平均首字（首字时间求和 ÷ 轮数）。
    // 只统计**成功的**流：失败/中断的轮次会把平均拉得没意义。
    this.metrics = {
      firstTokenMsSum: 0,   // 首字时间累加（求平均用）—— 跨 run 保留，见 resetMetrics 注释
      firstTokenSamples: 0, // 有效样本数（= 成功产生首字的轮数）
      llmMs: 0,             // LLM 推理+输出总耗时（本次任务）
      toolMs: 0,            // 工具执行总耗时（本次任务）
      toolCalls: 0,         // 工具调用次数（本次任务）
      // tps（tok/s）：输出 token ÷ 生成耗时。
      // 为什么单独记「生成耗时」而不是用 llmMs：llmMs 含首字等待（网络+排队），
      // 拿它算 tps 会被网络延迟稀释（首字 20s、生成 10s 的话 tps 会低一半）。
      // 生成耗时 = 流总耗时 − 首字耗时，即"真正在吐字"的那段时间。
      outTokens: 0,         // 本轮累计输出 token（用于算 tps）
      genMs: 0,             // 生成阶段耗时（= 总耗时 − 首字耗时）
    }
    // 首字样本对应的端点（协议|URL|模型）；变化时作废样本，见 _syncMetricsEndpoint
    this._metricsEndpointKey = undefined
    this.lastPromptTokens = 0  // 最近一次 API 调用的 prompt_tokens（=当前上下文大小）
    this.lastUsage = null
    this._lastUsedStream = false
    this._aborted = false
    this.watchMode = false  // 持续模式：开启后一轮结束不返回，注入"继续"循环直到关闭/打断
    this.traceEnabled = traceEnabled !== false
    this.traceDir = traceDir || undefined
    this.streamWatchdogMs = Math.max(1, Number(streamWatchdogMs) || 300000)
    this.traceParentRunId = traceParentRunId || null
    this._activeTrace = null
  }

  _traceEmit(type, data = {}) {
    try { this._activeTrace?.emit(type, data) } catch {}
  }

  // 每次 run 独立一个 trace 文件；失败也不影响 Agent 主流程。
  async run(initialMessage, options = {}) {
    this.isRunning = true
    const trace = this.traceEnabled ? new TraceStore({ dir: this.traceDir, logger: this.logger }) : null
    this._activeTrace = trace
    this.lastTraceId = trace?.runId || null
    let traceStatus = 'completed'
    trace?.emit('run_start', {
      kind: 'agent',
      input: tracePreview(initialMessage, 800),
      max_turns: this.maxTurns,
      watch_mode: this.watchMode,
      message_count_before: this.messages.length,
      parent_run_id: this.traceParentRunId,
    })
    try {
      const result = await this._run(initialMessage, options)
      this.lastResult = result
      return result
    } catch (e) {
      traceStatus = e?.message === 'Interrupted' ? 'interrupted' : 'failed'
      this._traceEmit('run_error', { error: e?.message || String(e), turn: this.turnCount })
      throw e
    } finally {
      this.isRunning = false
      trace?.end({ status: traceStatus, turns: this.turnCount, message_count: this.messages.length })
      if (this._activeTrace === trace) this._activeTrace = null
    }
  }

  // 持续模式开关：开启后一轮 agent.run 不会因"无工具调用"结束，而是注入继续消息循环
  setWatchMode(on) { this.watchMode = !!on }

  // 是否启用流式（支持 function getter 热读 config）
  _wantStream() {
    if (typeof this.useStream === 'function') return this.useStream() !== false
    return this.useStream !== false
  }

  setVisionApi(api) {
    this.visionApi = api || null
  }

  abort() { this._aborted = true }

  /** 注入一条 hidden user 消息：模型上下文可见，但 UI/会话重放不显示（如 slash recent、系统提示） */
  addHiddenUser(content) {
    if (!content || typeof content !== 'string' || !content.trim()) return
    this.messages.push({ role: 'user', hidden: true, content })
  }

  async _run(initialMessage, { signal, hidden = false } = {}) {
    this.messages.push({ role: 'user', content: initialMessage, ...(hidden ? { hidden: true } : {}) })
    this.turnCount = 0
    // 指标按「一次 run」为单位重置 —— 状态条显示的是本次任务的耗时构成，
    // 跨 run 累加会越看越糊涂（上一个任务的时间混进来）。
    // 首字样本例外（跨 run 保留），详见 resetMetrics 注释。
    this._syncMetricsEndpoint(this.api)
    this.resetMetrics()
    this._aborted = false
    this._emptyRetries = 0
    this._maxOutputRetries = 0
    this._turnLimitWarned = false
    const watchRun = this.watchMode

    // 持续模式不受单轮 maxTurns 限制；关闭后在下一轮安全收尾。
    while (this.watchMode || this.turnCount < this.maxTurns) {
      if (this._aborted || (signal && signal.aborted)) {
        this._aborted = false
        throw new Error('Interrupted')
      }
      this.turnCount++

      // 轮数接近上限（剩余 ≤10）且还没提醒过：注入系统提示，让模型**先自查是否空转**：
      //   没空转（有实质进展）→ 自己调 EnterDeepMode 续命，继续干，别草草收尾；
      //   空转（反复调同一个工具/同一处改了又改没推进）→ 如实收尾。
      // 只提醒一次；deep/watch 模式下不提醒（上限本来就大/无限制）。
      if (!this.watchMode && !this._turnLimitWarned) {
        const remaining = this.maxTurns - this.turnCount + 1
        if (remaining <= 10 && remaining > 0) {
          this._turnLimitWarned = true
          try { this.onTurnLimitApproaching?.(this.turnCount, this.maxTurns) } catch {}
          this.messages.push({
            role: 'user',
            hidden: true,
            content: `（系统提示：本轮任务已执行 ${this.turnCount} 轮，距 maxTurns 上限（${this.maxTurns}）只剩不到 10 轮。`
              + `先自查最近几轮是不是在**空转**：反复调用同一个工具却拿不到新信息、同一处改了又改、同一个错误反复出现而没有实质推进。`
              + `① 不是空转、任务确实还需要更多轮才能做完 —— 立即调用 EnterDeepMode 工具自己开启 deep 模式（maxTurns 提升至 ${DEEP_MAX_TURNS}），然后继续干；不要因为快到上限就草草收尾。`
              + `② 是空转 —— 停下来如实收尾：卡在哪、已完成什么、还剩什么，不要无声中断。`
              + `不要明知在原地打转还硬撑，也不要为了省轮数交未验证的半成品。）`,
          })
        }
      }

      // 【队友消息自动送达】对齐官方 SendMessageTool 的
      // "Messages from teammates are delivered automatically; you don't check an inbox."
      //
      // 原来只能拉取：Agent 得自己反复 CheckMessages + sleep 轮询，
      // 实测图灵测试那局 4 个 Agent 跑了 33 分钟，大量轮次耗在等消息上。
      // 现在每轮开头自动把未读消息注入，Agent 不用管收信这件事。
      // 身份来自它自己调过的 TeamJoin（见 _noteTeamIdentity），没 join 过就不做事。
      this._deliverTeamMessages()

      // mid-turn steering：在下一轮模型调用前注入用户补充指令（不打断当前工具批次）
      if (this.pullSteering) {
        try {
          const extras = this.pullSteering() || []
          for (const text of extras) {
            const body = String(text || '').trim()
            if (!body) continue
            this.messages.push({
              role: 'user',
              content: `（执行中补充指令 / mid-turn steering）\n${body}`,
            })
          }
        } catch {}
      }

      // 网络错误最多重试5次；上下文超限直接报错，不收缩历史（防止旧消息被悄悄丢弃）。
      let response = null
      let lastError = null
      let visionStripped = false
      for (let retry = 0; retry < 5; retry++) {
        const apiStartedAt = Date.now()
        this._traceEmit('api_request', {
          turn: this.turnCount,
          retry,
          stream: this._wantStream(),
          message_count: this.messages.length,
          tool_count: this.tools.length,
        })
        if (this._aborted || (signal && signal.aborted)) {
          this._aborted = false
          throw new Error('Interrupted')
        }
        try {
          if (this._wantStream() && this.api.createMessageStream) {
            response = await this.streamAndCollect({ signal })
            this._lastUsedStream = true
            if (!response || !response.choices || !response.choices[0]) throw new Error('Empty response')
          } else {
            this._lastUsedStream = false
            response = await this.api.createMessage({
              system: this.systemPrompt,
              // 与流式路径一致：裁剪历史旧图（只改副本，不动 this.messages）
              messages: this._pruneOldImages(this.messages),
              tools: this.tools.map(t => t.toSchema()),
              signal,
            })
          }
          lastError = null
          this._traceEmit('api_response', {
            turn: this.turnCount,
            retry,
            duration_ms: Date.now() - apiStartedAt,
            finish_reason: response?.choices?.[0]?.finish_reason || null,
            usage: response?.usage || null,
          })
          break  // 成功，跳出重试
        } catch (e) {
          lastError = e
          const classification = this._classifyError(e)
          this._traceEmit('api_error', {
            turn: this.turnCount,
            retry,
            duration_ms: Date.now() - apiStartedAt,
            error: e?.message || String(e),
            category: classification.name,
            retryable: classification.retry,
          })
          if (e.message === 'Interrupted') throw e
          // 模型能力不支持（最常见：非 vision 模型收到历史里的图片 → 400 MODEL_CAPABILITY_NOT_SUPPORTED）。
          // 自动剥离历史中的图片块后重试，对话不再因带图历史"死掉"，恢复不依赖压缩。
          if (e.isVisionCapabilityError && !visionStripped) {
            visionStripped = true
            if (typeof this.api?.stripImagesFromHistory === 'function') {
              this.messages = this.api.stripImagesFromHistory(this.messages)
              this.messages.push({ role: 'user', hidden: true, content: '（系统提示：当前模型不支持图片，已把历史中的图片替换为 [图片已省略]，请直接继续回复用户最近的请求）' })
              continue
            }
          }
          // 4xx 错误直接抛出（api.mjs 抛的是 Error('HTTP 400: ...')，无 statusCode 属性）。
          if (!this.shouldRetry(e)) {
            throw e
          }
          // 【401/403 重试前必须换 key】否则拿同一个坏 key 重试 5 次，
          // 白等 31 秒还是同样的错。这才是 key 池真正起作用的地方。
          if (classification.name === 'auth_key' && typeof this.api?.rotateKey === 'function') {
            const rotated = this.api.rotateKey()
            this._traceEmit('key_rotated', { turn: this.turnCount, retry, ok: !!rotated })
            if (!rotated) {
              // 池子转完一圈都不行，再重试没意义，直接抛出让用户看到
              throw e
            }
          }
          // 可重试错误（502/503/429/timeout 等）
          if (retry >= 4) break  // 已达最大重试次数
          // 认证类换完 key 立刻重试，不必退避（不是限流，等待没有意义）
          //
          // 【2026-10-06 调整退避时长】用户反馈「网络断一次它就报了」——
          // 实测 trace 里 fetch failed 确实重试了 4 次，但总等待只有
          // 1+2+4+8 = 15 秒。手机网络抖动往往要更久才恢复（切 WiFi/基站
          // 重连），15 秒不够。现在：
          //   · 网络类错误（network / stream_broken / abort）用**更长**的
          //     退避序列，总等待约 45 秒（3+6+12+24）
          //   · 其他错误（5xx/429）保持原序列（服务端问题等太久没意义）
          const isNetErr = ['network', 'stream_broken', 'abort', 'stream_timeout'].includes(classification.name)
          const backoff = classification.name === 'auth_key'
            ? 0
            : isNetErr
              ? Math.min(3000 * Math.pow(2, retry), 30000)
              : Math.min(1000 * Math.pow(2, retry), 30000)
          this._traceEmit('retry_scheduled', { turn: this.turnCount, retry: retry + 1, backoff_ms: backoff, category: this._classifyError(e).name })
          await new Promise(r => setTimeout(r, backoff))
        }
      }

      if (lastError && !response) {
        if (lastError.message === 'Interrupted') throw lastError
        this.onError(lastError)
        throw lastError
      }

      if (response.usage) {
        const usage = response.usage
        const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0
        const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? 0
        // 【取第一个「有效」值，不是第一个「存在」的值】
        //
        // ⚠ 这里踩过一次：原来用 `??` 链，而中转站会**同时返回多个字段**，
        //   其中 Anthropic 风格的 cache_read_input_tokens 恒为 0（它们不做那套），
        //   OpenAI 风格的 prompt_tokens_details.cached_tokens 才是真值。
        //   `??` 只跳过 null/undefined，0 被当成有效值直接采用 →
        //   真值永远轮不到 → 状态条一直显示 0% 命中（用户 2026-09-13 发现：
        //   中转站日志里命中率不低，我们却说 0）。
        //
        // 实测该 provider 的完整 usage（2026-09-13）：
        //   cache_read_input_tokens: 0            ← 恒 0，别信
        //   prompt_tokens_details.cached_tokens: 384   ← 真值
        //   prompt_cache_hit_tokens: 384          ← 另一个真值来源（DeepSeek 风格）
        const pickCache = (u) => {
          const candidates = [
            u.prompt_tokens_details?.cached_tokens,
            u.input_tokens_details?.cached_tokens,
            u.prompt_cache_hit_tokens,
            u.cache_read_input_tokens,
          ]
          for (const v of candidates) {
            if (typeof v === 'number' && v > 0) return v
          }
          return 0
        }
        const cacheRead = pickCache(usage)
        // 同理：写入量也用「第一个正值」
        const cacheWrite = [usage.cache_creation_input_tokens, usage.prompt_cache_write_tokens]
          .find((v) => typeof v === 'number' && v > 0) || 0
        this.lastPromptTokens = promptTokens || this.lastPromptTokens
        this._approxPromptTokens = false   // 真实值回来了，清掉估算标记
        this.lastUsage = { promptTokens:this.lastPromptTokens, completionTokens, cacheRead, cacheWrite }
        this.tokenUsage.output += completionTokens
        this.tokenUsage.input += promptTokens
        this.tokenUsage.cacheRead += cacheRead
        this.tokenUsage.cacheWrite += cacheWrite
        // 回调放在最后且吞掉异常：上层 UI 出错不能影响 agent 主流程
        try { this.onUsage({ promptTokens: this.lastPromptTokens, completionTokens, cacheRead, cacheWrite, total: { ...this.tokenUsage } }) } catch { }
      }

      const am = this.parseResponse(response)
      this._traceEmit('assistant_parsed', {
        turn: this.turnCount,
        content_blocks: am.content.length,
        text_chars: am.content.filter(b => b.type === 'text').reduce((n, b) => n + String(b.text || '').length, 0),
        tool_calls: am.content.filter(b => b.type === 'tool_use').length,
        finish_reason: am.finishReason || null,
      })

      // 打断/部分响应不算空响应：Ctrl+C 后 finishReason=interrupted，choices 为空是正常的
      if (am.content.length === 0 && (am.finishReason === 'interrupted' || response._partial || this._aborted)) {
        this._emptyRetries = 0
        return '[Interrupted]'
      }
      // 【占位文本也算空响应】
      // ensureAlternatingRoles 会往历史里插 `(continue)` / `(empty)` 这类角色交替占位，
      // 模型看到历史里有这种东西，常常照着学、原封不动吐一个 `(continue)` 回来。
      // 这时 am.content 非空，旧逻辑判定为「正常回复」→ 那一轮就白掉了：
      // 用户只看到我回一句 `(continue)` 然后结束，还得手动催一次。
      // 判定条件必须同时满足「没有工具调用」+「文本去掉占位后为空」，
      // 否则会把正文里恰好提到 (continue) 的正常回复误杀。
      const PLACEHOLDER_RE = /^[（(]\s*(?:continue|empty|空响应|继续)\s*[)）]$/i
      const hasToolUse = Array.isArray(am.content)
        && am.content.some(b => b && b.type !== 'text')
      const onlyPlaceholder = !hasToolUse
        && Array.isArray(am.content)
        && am.content.length > 0
        && am.content.every(b => b && b.type === 'text'
          && (!String(b.text || '').trim() || PLACEHOLDER_RE.test(String(b.text).trim())))
      // 检测空响应（API 返回了 choices 但既无文本也无工具调用）
      if (am.content.length === 0 || onlyPlaceholder) {
        // 区分：原始流里有 tool_call 但参数不完整被过滤 → 给模型明确提示修正重发，而非当"空响应"
        if (response._droppedToolCalls) {
          // 原来这条路径不碰 _emptyRetries：既无上限（可无限循环），
          // 也不计入空响应统计（表现成「（空响应）」直接收场，用户看不到重试）。
          // 现在纳入统一计数：仍给模型修正机会，但有上限。
          this._emptyRetries = (this._emptyRetries || 0) + 1
          if (this._emptyRetries <= 3) {
            this.messages.push({ role: 'assistant', hidden: true, content: '（空响应）' })
            this.messages.push({ role: 'user', hidden: true, content: `（系统提示：你发起了 ${response._droppedToolCalls} 个工具调用，但参数不完整（arguments 未闭合/为空）已被丢弃。请重新发起这些工具调用，务必把每个必填参数补全）` })
            continue
          }
          const droppedErr = new Error(`连续 3 次工具调用参数不完整（已丢弃 ${response._droppedToolCalls} 个），可能模型或网关异常`)
          this._emptyRetries = 0
          // 【抛而不是 return ''】这是失败收尾：统一收尾逻辑要打出「未完成 + 原因」，
          // goal 循环 / QQ 同步也要能把它当错误处理（静默 return 会被当成正常结束）。
          this.onError(droppedErr)
          throw droppedErr
        }
        this._emptyRetries = (this._emptyRetries || 0) + 1
        // 空响应不截断历史（防止旧消息被悄悄丢弃），只重试
        // 注意：绝大多数站的空响应是偶发（一次即可恢复），不要加退避拖慢正常流程。
        // 空响应也走 API 计费，重试 3 次即止，不多花。
        if (this._emptyRetries <= 3) {
          // 用非空占位维持 role 交替，避免空 content 被 API 拒绝
          this.messages.push({ role: 'assistant', hidden: true, content: '（空响应）' })
          // 分开提示：模型吐占位符和真的什么都没吐，原因不同，笼统说"响应为空"
          // 它不知道自己错在哪，很可能再吐一个 (continue)。
          this.messages.push({
            role: 'user', hidden: true,
            content: onlyPlaceholder
              ? '（系统提示：你上一次只输出了 (continue) 这类占位符。那是历史记录里用于维持角色交替的内部占位，不是可以照抄的回复内容。请直接给出真正的回复或发起工具调用）'
              : '（系统提示：上一次响应为空，请重新回复）',
          })
          continue
        }
        // 达到最大空响应重试次数，停止
        const emptyErr = new Error('连续 3 次空响应，可能 API 异常')
        this._emptyRetries = 0
        // 同站点 A：失败收尾必须走错误通道，不能静默 return ''（会被当成正常结束）
        this.onError(emptyErr)
        throw emptyErr
      }
      // 注意：这里【不能】重置 _emptyRetries。
      // am.content 非空只说明「有块」，但下面 cleanContent 会滤掉纯空白文本块，
      // 滤完可能一个不剩（模型只吐 "\n\n" 的情况很常见）。原来在此处清零，
      // 导致 362 行那条路径每次都从 1 数起，永远到不了 3 —— 于是要么静默返回、
      // 要么反复空转，用户看到的就是「● （空响应）」且没有任何重试提示。
      // 重置统一推迟到 375 行（确认真有实内容进历史之后）。
      // 中断的部分响应不能把未配对 tool_use 写进历史，否则下次请求会被 OpenAI 拒绝。
      // 仅保留已经展示的文本半截；工具调用必须等结果齐全后才能持久化。
      if (am.finishReason === 'interrupted' || response._partial) {
        // 只保留有实际内容的文本块：纯空白 block 一旦进历史，Anthropic 后续每一轮
        // 都会 400（text content blocks must contain non-whitespace text）。
        // 被 max_tokens 截断、或模型只吐了个空白字符时非常容易踩到。
        const partialText = am.content.filter(b => b.type === 'text' && typeof b.text === 'string' && b.text.trim())

        // ── 已产生用户可见副作用的工具：补一条合成 tool_result，让它能安全入历史 ──
        //
        // 【为什么需要】Present 工具的执行效果是「已在对话里渲染出 SVG/HTML」——
        // 这是**不可撤销的用户可见结果**。但中断分支原来把 tool_use 全丢了，
        // 于是：用户看到 SVG 渲染出来 → 打断 agent → tool_use 没了 → 刷新后
        // SVG 消失（用户原话：「如果打断它，svg又不能正常使用了」）。
        //
        // 【为什么不能直接塞 tool_use】没有配对 tool_result 的 tool_use 会让下一轮
        // 请求被上游 400（上面注释已说明）。所以必须**同时**补一个 tool_use 和它的
        // tool_result，成对入历史 —— 这样既留住展示，又不破坏协议。
        //
        // 只对声明了 `_persistOnInterrupt` 的工具这么做；文件写入、Bash 等副作用
        // 工具照旧丢弃（它们的真实结果未知，伪造 result 会误导模型）。
        // this.tools 是**数组**（见 679/785 行的 .find 用法），不是按名字索引的对象
        const persistableNames = new Set(
          (Array.isArray(this.tools) ? this.tools : [])
            .filter(t => t?._persistOnInterrupt)
            .map(t => t.name))
        const persistedPairs = am.content.filter(b =>
          b?.type === 'tool_use' && persistableNames.has(b.name))
        const content = [...partialText, ...persistedPairs]
        if (content.length > 0) this.messages.push({ role: 'assistant', content })
        if (persistedPairs.length > 0) {
          // 合成 tool_result：措辞必须诚实说明「调用发出后被中断，效果已生效」
          this.messages.push({
            role: 'user',
            content: persistedPairs.map(block => ({
              type: 'tool_result',
              tool_use_id: block.id,
              content: '（调用已执行并产生用户可见效果，但本轮被中断，没有拿到工具返回。展示结果已保留。）',
            })),
          })
        }
        this._aborted = false
        return partialText[0]?.text || '[Interrupted]'
      }
      // 同理：正常轮次也过滤掉空白文本块（非文本块如 tool_use 原样保留）
      const cleanContent = Array.isArray(am.content)
        ? am.content.filter(b => b && (b.type !== 'text' || (typeof b.text === 'string' && b.text.trim())))
        : am.content
      const assistantMessage = { role: 'assistant', content: cleanContent }
      // Anthropic 原生 thinking 块：带 tool_use 的轮次必须原样回传（含 signature）
      if (am._anthropicThinking) assistantMessage._anthropicThinking = am._anthropicThinking
      // Responses 推理项：stateless 多轮要原样回传（含 encrypted_content）
      if (am._reasoningItems) assistantMessage._reasoningItems = am._reasoningItems
      // reasoning 独立持久化（OpenCode 参考：思考块作为独立 part 存储）
      //
      // 【存全文还是存占位？】由 shouldStoreReasoningText 决定，不是 shouldPreserveReasoningHistory。
      // 两者语义不同（2026-09-14 拆开）：
      //   存全文 = 本地可读（UI/后续轮次回看），用于「有原生回传机制」的协议
      //   发回上游 = 另一件事，由各协议自己的 builder 处理
      //
      // 之前混用导致 responses 下只存 `[thinking 13K chars]` →
      // 模型下一轮看不到自己想过什么 → 只能编（实测「琥珀」被报成「回声」）。
      if (am.reasoningContent) {
        const storeFull = this.api.shouldStoreReasoningText?.() || this.api.shouldPreserveReasoningHistory?.()
        if (storeFull) {
          assistantMessage.reasoning_content = am.reasoningContent
        } else {
          const len = String(am.reasoningContent).length
          assistantMessage.reasoning_content = `[thinking ${Math.max(1, Math.round(len / 1000))}K chars]`
        }
      }
      // 清洗后可能一个块都不剩（模型只吐了空白字符，如 "\n\n"）
      // 与主导循环的 am.content.length===0 路径合并：同样走 3 次重试
      if (Array.isArray(assistantMessage.content) && assistantMessage.content.length === 0) {
        this._emptyRetries = (this._emptyRetries || 0) + 1
        if (this._emptyRetries <= 3) {
          this.messages.push({ role: 'assistant', hidden: true, content: '（空响应）' })
          this.messages.push({ role: 'user', hidden: true, content: '（系统提示：上一次响应为空，请重新回复）' })
          continue
        }
        const emptyErr = new Error('连续 3 次空响应，可能 API 异常')
        this._emptyRetries = 0
        // 同站点 A：失败收尾必须走错误通道，不能静默 return ''（会被当成正常结束）
        this.onError(emptyErr)
        throw emptyErr
      }
      this._emptyRetries = 0
      this.messages.push(assistantMessage)

      // max_output_tokens 恢复：注入"继续"消息重试，最多 3 次
      if (am.finishReason === 'length' && am.content.length > 0) {
        this._maxOutputRetries = (this._maxOutputRetries || 0) + 1
        if (this._maxOutputRetries <= 3) {
          // 加「系统提示」前缀：与空响应重试的措辞保持一致。
          // 不加前缀时模型会把这句当成用户真的在催，无法区分是人说的还是程序注入的。
          this.messages.push({
            role: 'user',
            content: '（系统提示：上一条回复因达到 max_output_tokens 上限被截断，非用户打断。请直接从断点处继续输出，不要道歉、不要重复已写内容。）',
          })
          continue  // 跳过工具执行，直接下一轮 API 调用
        }
      }
      this._maxOutputRetries = 0

      if (!this._lastUsedStream) {
        for (const b of am.content) {
          if (b.type === 'text') this.onText(b.text)
          else if (b.type === 'tool_use') this.onToolUse(b)
        }
      } else {
        // 流式路径：只读工具可能在 earlyStart 里已 onToolUse；不要重复通知 UI
        for (const b of am.content) {
          if (b.type === 'tool_use' && !response._earlyPromises?.has(b.id)) this.onToolUse(b)
        }
      }

      const tools = am.content.filter(b => b.type === 'tool_use')
      const todoTool = tools.find(b => b.name === 'TodoWrite')
      if (todoTool) this.onTodoUpdate(todoTool.input.todos || [])

      if (tools.length === 0) {
        const text = am.content.find(b => b.type === 'text')?.text || ''
        // 持续模式：不结束，注入"继续"让循环保持（用于盯队列/持续任务）
        if (this.watchMode) {
          // assistantMessage 已在上方写入历史，这里只追加下一轮 user 指令，
          // 避免每轮重复保存同一份 assistant 正文导致上下文/费用膨胀。
          this.messages.push({ role: 'user', hidden: true, content: '（持续模式：继续执行当前任务，如无新任务则保持监听，不要停止回复）' })
          continue
        }
        return text
      }

      // 工具并发分区：连续的只读工具并行，写操作串行
      const earlyPromises = response._earlyPromises || new Map()
      const batches = this._partitionToolCalls(tools)
      const allResults = []
      // undo group：标记本轮所有工具操作的起始点
      if (this.undoStore) this.undoStore.beginGroup()
      try {
        for (const { isConcurrencySafe, blocks } of batches) {
          const batchResults = isConcurrencySafe
            ? await this._runToolsConcurrently(blocks, earlyPromises, signal)
            : await this._runToolsSerially(blocks, earlyPromises, signal)
          allResults.push(...batchResults)
        }
      } finally {
        // undo group 结束（无论正常完成还是中断，都关闭 group）
        if (this.undoStore) this.undoStore.endGroup()
      }

      // 网关说过「图被丢了」→ 通知工具层，之后直接走 OCR
      if (this._visionDropped) {
        try {
          const { markVisionUnavailable } = await import('../tools/tools-phone.mjs')
          markVisionUnavailable()
          const { markVisionUnavailable: markVision2 } = await import('../tools/tools-vision.mjs')
          markVision2?.()
        } catch {}
        this._visionDropped = false
      }

      // 先推 tool_result，再对 vision 结果追加多模态 user（图片走 image_url）
      const visionFollowups = []
      const cleaned = allResults.map(r => {
        if (r && r._vision) {
          const { _vision, ...rest } = r
          const parts = []
          if (_vision.text) parts.push({ type: 'text', text: _vision.text })
          // Codex 式缩放透明化：图片被缩小过就告诉模型，避免它误判细节缺失
          const resizedNotes = []
          for (const img of _vision.images || []) {
            parts.push(img)
            if (img?._resized?.from) {
              const { from, to } = img._resized
              resizedNotes.push(to
                ? `图片已从 ${from.w}x${from.h} 缩放到 ${to.w}x${to.h}（节省 token；微小文字/细节可能受影响，必要时可用 detail:original 重看）`
                : `原图 ${from.w}x${from.h} 已等比缩小`)
            }
            delete img._resized // 不把内部字段发给 API
          }
          if (resizedNotes.length) {
            parts.push({ type: 'text', text: `<image_resize_notice>\n${resizedNotes.join('\n')}\n</image_resize_notice>` })
          }
          // ⚠️ 当前端点已知不支持图片时，**必须如实告诉模型**图没发出去。
          //
          // 否则工具文本还写着「手机屏幕截图（关注：xxx）」，模型以为图到了，
          // 就会凭文件名/上下文编造画面内容 —— 比直接报错更糟，因为它是**看不出来**的错。
          // （机制：api.mjs 遇到「image not supported」这类 400 后把该端点记进
          //   _visionDisabledKeys，后续同类请求自动把图片块换成 [图片已省略]。）
          if (this.api?._visionDisabled) {
            parts.push({
              type: 'text',
              text: `<vision_unsupported>\n当前模型不支持读图，本次图片已被丢弃，你看不到画面内容。\n`
                + `不要再猜测或编造图里的内容；需要看图请换一个支持视觉的模型（/config 切 Provider），`
                + `或让用户直接用文字描述关键信息。\n</vision_unsupported>`,
            })
          }
          if (parts.length) visionFollowups.push({ role: 'user', content: parts })
          return rest
        }
        return r
      })
      this.messages.push({ role: 'user', content: cleaned })
      for (const vf of visionFollowups) this.messages.push(vf)

      // 一个 turn 结束（响应 + 工具都跑完，即将进入下一轮）。
      // QQ 桥用它做「按 turn 发一条」：不这么切的话，一次 run 里十几个 turn
      // 的正文会攒成一条巨长消息发出去。
      try { this.onTurnEnd?.(this.turnCount) } catch {}
    }

    if (watchRun) return ''
    // 【消息要自解释】这条错误会经终端 / QQ / 图片等各条链路原样展示 ——
    // 旧的英文代号（'Max turns exceeded'）既看不懂，也不说怎么继续。
    throw new Error(`已达轮数上限（${this.maxTurns} 轮），停在中途；输入「继续」可接着做`
      + (this.maxTurns < DEEP_MAX_TURNS ? `，或 /deep 把上限提到 ${DEEP_MAX_TURNS} 轮` : ''))
  }

  /**
   * 给**正在跑**的这轮追加一条指令（mid-turn steering）。
   * 在下一轮模型调用前被 pullSteering 取走注入，不打断当前工具批次。
   * SendMessage 对 running 子 Agent 的投递走这里（第25批修复 wake 重复）。
   */
  pushSteering(text) {
    if (text && String(text).trim()) this._steeringQueue.push(String(text))
  }

  /**
   * 按名取工具 —— **大小写不敏感**。
   *
   * 【为什么需要】模型常把工具名写错大小写（`read` 而非 `Read`、
   * `gitstatus` 而非 `GitStatus`）。`block.name` 是模型生成的自由文本，
   * 各厂商模型（尤其非 Anthropic 的）习惯不一。以前精确匹配导致模型
   * 明明调对了工具却拿 `Tool "read" not found`，整轮白跑。
   *
   * 【为什么不用 Map】this.tools 是 registry.list() 返回的**数组**（见 index.mjs），
   * 不是 registry 对象。ToolRegistry.get() 已修大小写不敏感，但这里是数组，
   * 只能自己查。工具数 ~100，线性扫可接受（一次工具调用只扫一遍）。
   *
   * 精确匹配优先 —— 避免同时注册 `Read` 与 `read` 时的歧义。
   */
  _findTool(name) {
    if (!Array.isArray(this.tools)) return undefined
    const exact = this.tools.find(t => t.name === name)
    if (exact) return exact
    if (typeof name !== 'string') return undefined
    const lower = name.toLowerCase()
    return this.tools.find(t => typeof t.name === 'string' && t.name.toLowerCase() === lower)
  }

  // 分区：连续的 concurrencySafe 工具归一批，否则单独批次
  _partitionToolCalls(toolUseBlocks) {
    return toolUseBlocks.reduce((acc, block) => {
      const tool = this._findTool(block.name)
      let isSafe = false
      try { isSafe = tool?.isConcurrencySafe?.(block.input) || false } catch { isSafe = false }
      if (isSafe && acc[acc.length - 1]?.isConcurrencySafe) {
        acc[acc.length - 1].blocks.push(block)
      } else {
        acc.push({ isConcurrencySafe: isSafe, blocks: [block] })
      }
      return acc
    }, [])
  }

  /**
   * 带计时的工具执行（状态条的「工具时间」用）。
   *
   * 为什么要包一层而不是在 _executeTool 内部收尾计时：那个函数有十几处
   * 提前 return（工具不存在、hook 拒绝、中断、超时…），逐处插计时必然漏。
   * 包在调用点用 finally 才能覆盖所有路径。
   *
   * 计数在**开始**就 +1（不放在 finally）：中途抛异常也算"调用过一次"，
   * 否则工具全失败时状态条会显示 0 次，与实际操作不符。
   */
  async _timedExecuteTool(block, early, signal) {
    const t0 = Date.now()
    this.metrics.toolCalls += 1
    // 登记"正在跑的工具"起始时刻，供 getMetrics 实时累加（跑完就移除）。
    // 用数组而不是单值：并发工具（_runToolsConcurrently）会同时有多个在跑，
    // 单值会让后来者覆盖前者，少算时间。
    if (!this._runningToolStarts) this._runningToolStarts = []
    this._runningToolStarts.push(t0)
    try {
      return await this._executeTool(block, early, signal)
    } finally {
      this.metrics.toolMs += Date.now() - t0
      const i = this._runningToolStarts.indexOf(t0)
      if (i >= 0) this._runningToolStarts.splice(i, 1)
    }
  }

  async _runToolsConcurrently(blocks, earlyPromises = new Map(), signal) {
    return Promise.all(blocks.map(block => {
      const early = earlyPromises.get(block.id) || null
      return this._timedExecuteTool(block, early, signal)
    }))
  }

  async _runToolsSerially(blocks, earlyPromises = new Map(), signal) {
    const results = []
    for (const block of blocks) {
      const early = earlyPromises.get(block.id) || null
      results.push(await this._timedExecuteTool(block, early, signal))
    }
    return results
  }

  /**
   * 记住 Agent 通过 TeamJoin 声明的身份（team + agent 名）。
   * 一个 Agent 可能加入多个团队，所以用数组存。
   */
  _noteTeamIdentity(input = {}) {
    const team = String(input?.team || '').trim()
    const agent = String(input?.agent || '').trim()
    if (!team || !agent) return
    if (!this._teamIds) this._teamIds = []
    if (!this._teamIds.some(x => x.team === team && x.agent === agent)) {
      this._teamIds.push({ team, agent })
    }
  }

  /**
   * 把未读的队友消息作为 user 消息注入，等价于"自动送达"。
   *
   * 为什么做成推送：官方 SendMessageTool 明确写
   * "Messages from teammates are delivered automatically; you don't check an inbox."
   * 而拉取模式下 Agent 必须自己 sleep+CheckMessages 轮询，既浪费轮次又容易漏。
   *
   * 注意：这里会把消息标记为已读，所以 Agent 之后再调 CheckMessages 就看不到了 ——
   * 这是预期行为（消息已经在上下文里了）。fail-open：任何异常都不影响主循环。
   */
  _deliverTeamMessages() {
    if (!this._teamIds?.length) return
    try {
      for (const { team, agent } of this._teamIds) {
        // readInbox 默认只返回未读、并顺手标记已读，正是这里需要的语义
        const unread = teamReadInbox(team, agent) || []
        if (!unread.length) continue
        const lines = unread.map(m => {
          const who = m.from || '?'
          const sum = m.summary ? `（${m.summary}）` : ''
          return `【来自 ${who}${sum}】\n${String(m.text ?? '')}`
        })
        this.messages.push({
          role: 'user',
          content: `（队友消息 · 团队 ${team} · ${unread.length} 条自动送达，无需再 CheckMessages）\n\n${lines.join('\n\n')}`,
        })
      }
    } catch {}
  }

  async _executeTool(block, earlyPromise, signal, opts = {}) {
    // 工具调用前的检查点（上下文自动压缩等）。
    // 放在最前：压缩要改历史，越早做越安全（工具还没跑，没有半途状态）。
    // 失败不拦工具（压缩是优化，不是前置条件）。
    //
    // ⚠️ **early 工具跳过**（opts.skipBeforeCall）—— 流式期间提前启动的
    // 只读工具在**流还没结束**时就执行了；此时压缩会改 agent 历史，
    // 而流解析/工具循环都在用那份历史 → 状态错乱。
    // 这类工具的检查点由主循环（流结束后的正式执行）负责，或下一次
    // 工具调用时补上（差一次工具调用的时间，安全）。
    if (this.beforeToolCall && !opts.skipBeforeCall) {
      try { await this.beforeToolCall(this) } catch (e) {
        try { this._traceEmit('before_tool_call_error', { turn: this.turnCount, error: String(e?.message || e) }) } catch {}
      }
    }
    if (earlyPromise) return earlyPromise  // 复用流中提前执行的结果
    if (this._aborted || signal?.aborted) {
      const interrupted = { type: 'tool_result', tool_use_id: block.id, content: 'Interrupted', is_error: true }
      try { this.onToolResult(null, block, interrupted.content, { error: true, interrupted: true }) } catch {}
      return interrupted
    }
    const tool = this._findTool(block.name)
    try { tool?.setTrace?.(this._activeTrace) } catch {}
    // 记下 TeamJoin 声明的身份，供 _deliverTeamMessages 自动收信用
    if (block.name === 'TeamJoin') this._noteTeamIdentity(block.input)
    this._traceEmit('tool_start', { turn: this.turnCount, tool: block.name, tool_use_id: block.id, input: block.input })
    if (!tool) {
      const message = `Tool "${block.name}" not found`
      this._traceEmit('tool_error', { turn: this.turnCount, tool: block.name, tool_use_id: block.id, error: 'tool not found' })
      try { this.onToolResult(null, block, message, { error: true }) } catch {}
      return { type: 'tool_result', tool_use_id: block.id, content: message, is_error: true }
    }
    // PreToolUse hook
    if (this.hookManager) {
      const hookResult = await this.hookManager.trigger('PreToolUse', {
        event: 'PreToolUse', tool: block.name, input: block.input
      })
      if (hookResult?.deny) {
        const message = `Blocked by hook: ${hookResult.message}`
        this._traceEmit('tool_error', { turn: this.turnCount, tool: block.name, tool_use_id: block.id, error: `hook denied: ${hookResult.message}` })
        try { this.onToolResult(tool, block, message, { error: true }) } catch {}
        return { type: 'tool_result', tool_use_id: block.id, content: message, is_error: true }
      }
      // Hook 修改后的 input / 注入的 additionalContext
      if (hookResult?.updatedInput && typeof hookResult.updatedInput === 'object') {
        block.input = { ...block.input, ...hookResult.updatedInput }
      }
      if (hookResult?.additionalContexts?.length) {
        // 注入为下一轮 user 消息的额外上下文（不打扰本轮）
        block.additionalContext = hookResult.additionalContexts.join('\n')
      }
    }
    const allowed = await this.onPermissionRequest(tool, block.input)
    this._traceEmit('tool_permission', { turn: this.turnCount, tool: block.name, allowed })
    if (!allowed) {
      const message = 'Denied'
      this._traceEmit('tool_error', { turn: this.turnCount, tool: block.name, tool_use_id: block.id, error: 'permission denied' })
      try { this.onToolResult(tool, block, message, { error: true, denied: true }) } catch {}
      return { type: 'tool_result', tool_use_id: block.id, content: message, is_error: true }
    }
    // 工具超时：按工具类型分级，尊重输入里的显式 timeout（见 tool-timeout.mjs）。
    // 关键改动：把一个 toolSignal 传给工具，超时/中断时 abort 它，
    // 让 Bash 这类工具能真正 kill 子进程，而不是留下孤儿进程在后台跑。
    const timeoutMs = resolveToolTimeout(block.name, block.input || {})
    const toolAbort = new AbortController()
    let timeoutTimer
    const timeout = new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => {
        try { toolAbort.abort() } catch {}
        try { tool.cancel?.() } catch {}
        reject(new Error(`Tool timeout (${describeTimeout(timeoutMs)})`))
      }, timeoutMs)
    })
    // 如果有 signal，加一个 abort 监听
    let abortListener = null
    const abortP = signal ? new Promise((_, reject) => {
      abortListener = () => {
        try { toolAbort.abort() } catch {}
        try { tool.cancel?.() } catch {}
        reject(new Error('Interrupted'))
      }
      signal.addEventListener('abort', abortListener, { once: true })
    }) : null
    try {
      // 给参与 race 的 promise 挂兜底 catch：race 决胜后输家若再 reject，不会变成 unhandledRejection
      // ctx.onProgress：工具执行中回报实时输出（对齐 Kimi Code 的 tool.progress）。
      // 工具是否调用它是可选的——Bash 这类长时间跑的才有意义，
      // Read/Grep 瞬间返回，调了反而闪。
      const runP = tool.run(block.input, {
        signal: toolAbort.signal, cwd: this.cwd, workspacePath: this.cwd, sessionId: this.sessionId,
        // opts.replace = true 表示「这次内容替换上次」而不是追加，
        // 用于倒计时/进度百分比这类原地刷新的场景（见 SleepTool）。
        // 不传则沿用默认的追加语义（Bash 输出必须累积）。
        onProgress: (chunk, opts) => {
          if (!this.onToolProgress) return
          try {
            this.onToolProgress({
              name: tool.name, id: block.id, chunk: String(chunk ?? ''),
              replace: !!(opts && opts.replace),
            })
          } catch {}
        },
      })
      runP.catch(() => {})
      if (abortP) abortP.catch(() => {})
      const promises = [runP, timeout]
      if (abortP) promises.push(abortP)
      const result = await Promise.race(promises)
      // 【打断后等输家 settle】race 是"谁先回来用谁的"，输家（通常是还在跑的工具）
      // 不会自动停——它收到 toolAbort 信号后需要时间清理（kill 子进程、关流）。
      // 直接返回的话工具在后台继续跑（Bash 子进程没杀掉、Sleep 不停），
      // 用户看到"已打断"但工具还在干活。如果是 abort 赢的，等 runP 最多 3 秒。
      if (result && typeof result === 'object' && result.interrupted) {
        try {
          await Promise.race([runP, new Promise(r => setTimeout(() => r(null), 3000))])
        } catch {}
      }
      // 工具可通过 __ok 显式声明成败（Bash 用真实 exitCode）。没声明就传 undefined，
      // 由下游沿用旧的启发式；显式 false 才算失败，避免"输出里带 error 字样"被误判。
      const declaredOk = (result && typeof result === 'object' && '__ok' in result) ? !!result.__ok : undefined
      this.onToolResult(tool, block, result, declaredOk === undefined ? {} : { error: !declaredOk, ok: declaredOk, exitCode: result.__exitCode })
      this._traceEmit('tool_result', { turn: this.turnCount, tool: block.name, tool_use_id: block.id, ok: declaredOk !== false, result: tracePreview(result, 500) })
      // PostToolUse hook
      if (this.hookManager) {
        try {
          await this.hookManager.trigger('PostToolUse', {
            event: 'PostToolUse', tool: block.name, input: block.input, output: result
          })
        } catch (hookError) {
          this.logger.warn?.(`[Hook] PostToolUse failed: ${hookError.message}`)
        }
      }
      // 识图工具：返回 {__type:'vision', text, images[]} → tool_result 文本 + 旁路多模态 user 消息
      if (result && typeof result === 'object' && result.__type === 'vision' && Array.isArray(result.images)) {
        const summary = `${result.text || '图片已加载'}\npath: ${result.path || ''}`
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: summary,
          _vision: { text: result.text || summary, images: result.images },
        }
      }
      // String 包装对象（带 __ok 的那种）必须走 toString，否则 JSON.stringify
      // 会把它序列化成 {"0":"h","1":"i",...} 这种逐字符对象喂给模型
      const resultStr = (typeof result === 'string' || result instanceof String)
        ? String(result)
        : JSON.stringify(result, null, 2)
      return { type: 'tool_result', tool_use_id: block.id, content: resultStr }
    } catch (e) {
      const message = `Error: ${e.message}`
      this._traceEmit('tool_error', { turn: this.turnCount, tool: block.name, tool_use_id: block.id, error: e?.message || String(e) })
      try { this.onToolResult(tool, block, message, { error: true, exception: e }) } catch {}
      return { type: 'tool_result', tool_use_id: block.id, content: message, is_error: true }
    } finally {
      clearTimeout(timeoutTimer)
      if (signal && abortListener) signal.removeEventListener('abort', abortListener)
      try { tool?.setTrace?.(null) } catch {}
    }
  }

  /**
   * 裁剪历史消息中的旧图片（只作用于发给 API 的副本，不改 this.messages）。
   *
   * 【为什么需要】主对话历史里每张图都是 base64 data URL（300KB 图 ≈ 400k 字符）。
   * 聊得越久带图越多，单次请求体积和 token 都线性膨胀 —— 实测带 3 轮图的请求
   * 能到 1.5MB+，每轮都重发一遍纯属浪费。
   *
   * 【策略】只保留**最近一条**带图消息（当前轮用户刚发的图必须原样发），
   * 更早的 image_url 块替换成文本：
   *   （图片已省略）本地路径：/sdcard/xxx.png —— 需要重看时用 ViewImage 读
   * 路径信息优先从同消息的 web_attachment 块里取（Web 端上传的图带真实路径），
   * 找不到就退化为纯占位文本（不编造路径）。
   *
   * 【为什么不动 this.messages】会话存档 / 撤回 / 重看都依赖原图块；
   * 抹掉就真丢了。这里返回新数组 + 新消息对象（浅拷贝），原数据零改动。
   */
  _pruneOldImages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return messages
    // 找最后一条带图消息的下标
    let lastImageIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m && Array.isArray(m.content) && m.content.some(b => b && b.type === 'image_url')) {
        lastImageIdx = i
        break
      }
    }
    // 没有图，或图就在最后一条（没什么可裁的）→ 原样返回
    if (lastImageIdx < 0) return messages
    let changed = false
    const out = messages.map((m, i) => {
      if (i >= lastImageIdx) return m          // 最近一条带图消息及其之后：不动
      if (!m || !Array.isArray(m.content)) return m
      if (!m.content.some(b => b && b.type === 'image_url')) return m
      // 收集本消息里能拿到的图片路径（Web 端 web_attachment 带真实路径）
      const paths = m.content
        .filter(b => b && b.type === 'web_attachment' && b.file_type === 'image' && b.path)
        .map(b => String(b.path))
      let n = 0
      const newContent = m.content.map(block => {
        if (block && block.type === 'image_url') {
          const p = paths[n] || null
          n++
          return {
            type: 'text',
            text: p
              ? `（图片已省略）本地路径：${p}，需要重看时用 ViewImage 读该路径`
              : '（图片已省略）',
          }
        }
        return block
      })
      changed = true
      return { ...m, content: newContent }
    })
    return changed ? out : messages
  }

  /**
   * 给 visionApi 的精简历史：GLM-4V 等识图模型窗口小，不能把整段历史（含多轮
   * 累积的图片 data URL）都发过去。策略：
   * - 保留最后一条带图消息（本轮图片）
   * - 再保留其后/前的最近若干条纯文本消息做上下文
   * - 其余历史消息里的图片块替换为 [图片已省略] 文本
   */
  _prepareVisionMessages(messages) {
    const omit = (b) => b && b.type === 'image_url'
      ? { type: 'text', text: '[图片已省略]' }
      : b
    // 找到最后一条带图消息的索引
    let lastImageIdx = -1
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      if (Array.isArray(m?.content) && m.content.some(b => b && b.type === 'image_url')) lastImageIdx = i
    }
    // 保留窗口：lastImageIdx 之前最近 4 条 + 之后全部
    const KEEP_BEFORE = 4
    const start = Math.max(0, lastImageIdx - KEEP_BEFORE)
    return messages.slice(0, start).map(m => {
      if (m && Array.isArray(m.content)) {
        const newContent = m.content.map(omit)
        return { ...m, content: newContent }
      }
      return m
    }).concat(messages.slice(start))
  }

  async streamAndCollect({ signal } = {}) {
    // 本轮消息含图片（vision）且配置了 visionApi → 用 visionApi 发（主 api 可能不支持视觉）。
    // 只看【最后一条 user 消息】（本轮用户输入），不能扫整段历史 ——
    // 历史里任何一张旧图都会让后续纯文本对话整体改道 visionApi，
    // 而 visionApi 是「备用识图 Provider」独立实例（不跟随 /config 切换），
    // 于是切了配置对话仍打在旧识图站上（曾出现「切了配置还报配置2的 429」）。
    const lastUserIdx = (() => {
      for (let i = this.messages.length - 1; i >= 0; i--) {
        if (this.messages[i]?.role === 'user') return i
      }
      return -1
    })()
    const lastUser = lastUserIdx >= 0 ? this.messages[lastUserIdx] : null
    const hasImage = !!(lastUser && Array.isArray(lastUser.content)
      && lastUser.content.some(b => b && b.type === 'image_url'))
    const apiForThis = (hasImage && this.visionApi) ? this.visionApi : this.api
    // visionApi（如 GLM-4V）窗口小（16K），整段历史含多轮图片 data URL 必然 400 溢出。
    // 只保留本轮带图消息 + 最近若干条文本消息，旧图替换为占位文本。
    let messagesForApi = (hasImage && this.visionApi)
      ? this._prepareVisionMessages(this.messages)
      : this.messages
    // 【历史旧图裁剪 · 2026-10-04】
    // 主对话历史里每张图都是 base64 data URL（一张 300KB 图 ≈ 400k 字符），
    // 越聊越重：多轮带图后单次请求能到几 MB，token 也哗哗烧。
    // 策略：**只保留最近一条带图消息**（当前轮的图必须让模型看到），
    // 更早的图替换为「（图片已省略）+ 本地路径」文本 ——
    // 路径一直在磁盘上，模型需要重看时用 ViewImage 读即可。
    // 注意：只改发给 API 的副本（messagesForApi），不动 this.messages 本体，
    // 否则会话存档里的原图也会被抹掉（下次 resume 就真丢了）。
    if (!(hasImage && this.visionApi)) {
      messagesForApi = this._pruneOldImages(messagesForApi)
    }
    const streamController = new AbortController()
    const streamSignal = streamController.signal
    // 【提前执行工具的独立 signal · 2026-09-04 修 bug】
    // 原来流中提前启动的只读工具直接用 streamSignal，但下面 finally 里
    // 「流正常结束就 streamController.abort()」（那是修连接泄漏加的清理），
    // 于是还在跑的工具被自家收尾代码掐死 → tool_error: Interrupted。
    // 本地工具（Read/Grep）几十毫秒就返回、赶在流结束前完成，所以看不出来；
    // WebSearch 这类要走网络等几秒的必然中枪 —— 表现就是「联网搜索永远 Interrupted」。
    // 现在拆成两个 signal：earlyToolSignal 只跟随「用户真的打断」（外部 signal）
    // 和流的异常终止，不跟随正常收尾。
    const earlyToolController = new AbortController()
    const earlyToolSignal = earlyToolController.signal
    let externalStreamAbort = null
    if (signal) {
      externalStreamAbort = () => { streamController.abort(); earlyToolController.abort() }
      if (signal.aborted) { streamController.abort(); earlyToolController.abort() }
      else signal.addEventListener('abort', externalStreamAbort, { once: true })
    }
    const stream = apiForThis.createMessageStream({
      system: this.systemPrompt,
      messages: messagesForApi,
      tools: this.tools.map(t => t.toSchema()),
      signal: streamSignal,
    })
    let content = ''
    let reasoning = ''  // GLM-5.2 思考内容（独立累加，不入 messages 历史）
    let tcs = []
    let streamUsage = null
    let lastFinishReason = null
    const streamStartedAt = Date.now()
    // 【进行中计时】状态条要实时显示「LLM 167.4s」这种秒级数字，
    // 但 metrics.llmMs 是在流**结束时**才累加的 —— 一轮跑 3 分钟的话，
    // 状态条会整整 3 分钟停在上一轮的值上，看着像卡死。
    // 这里记下"当前这轮从何时开始"，getMetrics() 把它算进 llmMs（未结束也计）。
    this._inflightLlmStart = streamStartedAt
    // 【进行中的 tps 追踪】分子分母必须同步增长，否则 tps 会乱跳。
    // 字符数是流式过程中唯一能实时拿到的东西（token 数要等流结束的 usage），
    // 所以用「字符 ÷ 3.5」估算 token（中英混排的经验值，见 estimateTokens 同源逻辑）。
    // 第一版实现直接把 inflight 时间加进分母、分子不动 → tps 每秒往下掉
    //（用户 2026-09-16 报）。这里改成分子也随字符增长。
    this._inflightChars = 0
    let streamEventCount = 0
    let streamFirstEventAt = null
    let streamLastEventAt = null
    this._traceEmit('stream_start', { turn: this.turnCount, watchdog_ms: this.streamWatchdogMs })
    // Streaming 工具执行：收到完整 tool_call 就提前启动只读工具
    const earlyPromises = new Map()
    // 【early 工具在飞计数 · 2026-10-01 修「Sleep 期间 Ctrl+C 无效」】
    // finally 摘 externalStreamAbort 监听前要看它：early 工具（isReadOnly，
    // 流中提前执行）的 abort 源就是这个监听 → earlyToolController。流先结束、
    // 工具还在跑时（Sleep 150s 实测）摘掉监听 = 工具失去 abort 源，用户 Ctrl+C
    // 只能让主循环下一轮才检测到（表现为「打断无效，工具睡满才断/被拉回来」）。
    let earlyInflight = 0
    const tryEarlyStart = (tc) => {
      if (!tc || !tc.id || !tc.name || earlyPromises.has(tc.id)) return
      // 必须完整可 parse；避开 aiport 首包 "{}" 误触发空参 early run
      if (!tc.arguments || !looksLikeCompleteJson(tc.arguments)) return
      try {
        const input = JSON.parse(tc.arguments)
        if (input && typeof input === 'object' && Object.keys(input).length === 0) return
        const tool = this.tools.find(t => t.name === tc.name)
        if (tool?.isReadOnly?.(input)) {
          const block = { id: tc.id, name: tc.name, input }
          this.onToolUse(block)
          // 用 earlyToolSignal 而不是 streamSignal：流正常结束时的连接清理
          // 不该杀掉仍在跑的工具（见上方 earlyToolController 注释）
          // skipBeforeCall：early 工具在流未结束时执行，压缩会改历史 → 危险
          const p = this._executeTool(block, undefined, earlyToolSignal, { skipBeforeCall: true })
          earlyInflight++
          // settle 后补摘：全部 early 工具跑完 → 若监听还保留着（在飞时保的），
          // 此刻才轮到摘。remove 幂等，与 finally 主摘路径不冲突。
          p.finally(() => {
            earlyInflight--
            if (earlyInflight === 0 && signal && externalStreamAbort) {
              signal.removeEventListener('abort', externalStreamAbort)
            }
          }).catch(() => {})
          earlyPromises.set(tc.id, p)
        }
      } catch {}
    }
    // 流级 watchdog：如果 300s 内没收到任何新数据，视为连接卡死
    let watchdog
    let watchdogReject
    let watchdogError = null
    const watchdogPromise = new Promise((_, reject) => { watchdogReject = reject })
    const resetWatchdog = () => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        watchdogError = new Error(`Stream timeout (${Math.max(1, Math.ceil(this.streamWatchdogMs / 1000))}s no data)`)
        // 把 api 层的「最后到达的阶段」一起写进 trace：
        // 卡住时最需要知道的是「请求发出去了没有、响应头来了没有」，
        // 只有 event_count=0 无法区分这两种，之前排查就是卡在这里靠猜。
        let phase = null
        try { phase = apiForThis?._lastPhase || null } catch {}
        this._traceEmit('stream_watchdog', {
          turn: this.turnCount,
          no_data_ms: this.streamWatchdogMs,
          event_count: streamEventCount,
          first_event_ms: streamFirstEventAt == null ? null : streamFirstEventAt - streamStartedAt,
          last_event_ms: streamLastEventAt == null ? null : streamLastEventAt - streamStartedAt,
          // phase: fetch_sent = 请求已发出但响应头没回来（网关/连接问题）
          //        headers_received = 响应头到了但 body 不出数据（网关缓冲/上游卡）
          last_phase: phase?.phase || 'unknown',
          phase_age_ms: phase?.at ? Date.now() - phase.at : null,
          serialize_ms: phase?.serMs ?? null,
          body_bytes: phase?.bytes ?? null,
          fetch_ms: phase?.fetchMs ?? null,
          http_status: phase?.status ?? null,
        })
        // 【告知 api 层连接池可能已脏】流超时时底层连接常处于半开状态，
        // abort 不保证它被立即销毁。流式本身带 Connection: close 不受影响，
        // 但**非流式请求（/config test 等）会复用连接池**，正好捡到那条坏连接
        // → 用户看到「超时之后连 config test 也一直卡，重启才好」。
        // 这里置位后，api 层在接下来一段时间内对所有请求都弃用连接复用。
        try { apiForThis?.markConnectionSuspect?.(`stream_timeout@${phase?.phase || 'unknown'}`) } catch {}
        try { streamController.abort() } catch {}
        watchdogReject(watchdogError)
      }, this.streamWatchdogMs)
    }
    resetWatchdog()
    let wasInterrupted = false
    let abortListener = null
    const abortPromise = new Promise(resolve => {
      abortListener = () => resolve({ __aborted: true })
      if (streamSignal.aborted) abortListener()
      else streamSignal.addEventListener('abort', abortListener, { once: true })
    })
    let firstTextAfterReasoning = false  // text 块前是否刚流过 reasoning
    // Anthropic 原生 thinking 块攒取（按 block index 分槽）。
    // content_block_start(type=thinking) 开槽，thinking_delta 攒正文、
    // signature_delta 攒凭据，block_stop 封口。最后拼成块数组挂到结果上回传历史。
    // OpenAI 协议永远收不到这些事件，槽是空的、不影响。
    const thinkingSlots = new Map()
    // streamIter 提到 try 外，finally 里能拿到并 .return() 关闭底层 reader/连接（防泄漏）
    let streamIter = null
    try {
      streamIter = stream[Symbol.asyncIterator]()
      while (true) {
        const nextPromise = streamIter.next()
        nextPromise.catch(() => {})
        const next = await Promise.race([nextPromise, watchdogPromise, abortPromise])
        if (next?.__aborted) {
          if (watchdogError) throw watchdogError
          wasInterrupted = true
          break
        }
        if (next.done) break
        const e = next.value
        streamEventCount++
        streamLastEventAt = Date.now()
        if (streamFirstEventAt == null) {
          streamFirstEventAt = streamLastEventAt
          this._traceEmit('stream_first_event', { turn: this.turnCount, duration_ms: streamFirstEventAt - streamStartedAt, event_type: e?.type || 'unknown' })
        }
        resetWatchdog()
        if (streamSignal.aborted) { wasInterrupted = true; break }
        if (e.type === 'parse_error') {
          const parseError = new Error(`SSE 解析失败 (${e.protocol}): ${e.error}; data=${e.data}`)
          parseError.code = 'SSE_PARSE_ERROR'
          throw parseError
        }
        if (e.type === 'reasoning') {
          this.onReasoning(e.text); reasoning += e.text; firstTextAfterReasoning = true
          // 思考也算生成（模型在吐 token），计入 tps
          if (typeof e.text === 'string') this._inflightChars += e.text.length
        }
        else if (e.type === 'tool_call_start') {
          let idx = e.index
          if (idx === undefined || idx === null || idx < 0) idx = tcs.length
          if (!tcs[idx]) tcs[idx] = { id: e.id, name: e.name, arguments: '' }
          if (e.id) tcs[idx].id = e.id
          if (e.name) tcs[idx].name = e.name
          // 【工具名一到就通知 UI】text:null 表示"只是报名字，还没有参数"。
          // 下面的参数预览只对 shouldPreviewArgs() 白名单（10 类工具）生效，
          // Read/Grep/Glob/WebSearch 等永远进不去，动词只能等 onToolUse 那一瞬闪一下
          // ——就是用户说的「只在工具执行时显示一下」。这里对所有工具都发。
          if (tcs[idx].name && !tcs[idx]._named) {
            tcs[idx]._named = true
            try { this.onToolArgsPreview?.({ name: tcs[idx].name, text: null, id: tcs[idx].id }) } catch {}
          }
        }
        else if (e.type === 'text') {
          // 从思考切到正文：先发一个分隔换行，让正文另起一行
          if (firstTextAfterReasoning && reasoning) { this.onText('\n'); firstTextAfterReasoning = false }
          this.onText(e.text); content += e.text
          if (typeof e.text === 'string') this._inflightChars += e.text.length
          // 【识别「图片被网关丢弃」】不支持的模型不报错，而是在正文里塞一句
          //   [Image input omitted: selected model does not support vision.]
          // 返回 200 —— 从 HTTP 层完全看不出问题。这里嗅到就记下来，
          // 之后 screenshot/ViewImage 直接走 OCR，不再白跑一轮。
          if (typeof e.text === 'string' && /image input omitted|does not support vision/i.test(e.text)) {
            this._visionDropped = true
          }
        }
        else if (e.type === 'tool_call_delta') {
          // aiport/部分 Claude 网关：index 从 1 起、或偶发 undefined；首包 arguments 给 "{}" 再覆盖
          let idx = e.index
          if (idx === undefined || idx === null || idx < 0) {
            // 无 index：挂到最后一个已有槽，否则开新槽
            idx = tcs.length > 0 ? tcs.length - 1 : 0
          }
          if (!tcs[idx]) tcs[idx] = { id: e.id, name: e.name, arguments: '' }
          if (e.id) tcs[idx].id = e.id
          if (e.name) tcs[idx].name = e.name
          if (e.arguments) {
            // 修复：网关先推 "{}" 再推完整 JSON，朴素 += 变成 "{}{...}" 无法 parse
            // _authoritative（Responses 的 output_item.done）：这是服务端给的完整
            // arguments，直接覆盖 —— 之前的 delta 可能有丢片，拼接反而错。
            if (e._authoritative) tcs[idx].arguments = e.arguments
            else tcs[idx].arguments = mergeToolArguments(tcs[idx].arguments, e.arguments)
          }
          tryEarlyStart(tcs[idx])

          // 流式参数预览：参数还没收完就把已知字段吐给 UI，让用户看到
          // 「正在写哪个文件、写到哪了」，而不是等落盘后只看到一个字符数。
          // 节流在 StreamArgsPreview 内部做（render() 返回 null 就是让跳过）。
          if (this.onToolArgsPreview && tcs[idx].name) {
            const slot = tcs[idx]
            if (slot._preview === undefined) {
              slot._preview = shouldPreviewArgs(slot.name) ? new StreamArgsPreview(slot.name) : null
            }
            if (slot._preview) {
              slot._preview.feed(slot.arguments)
              const text = slot._preview.render()
              if (text) {
                try { this.onToolArgsPreview({ name: slot.name, id: slot.id, text }) } catch {}
              }
            }
          }
        }
        else if (e.type === 'thinking_block_start') {
          thinkingSlots.set(e.index, { type: 'thinking', thinking: '', signature: '' })
        }
        else if (e.type === 'thinking_block_delta') {
          const slot = thinkingSlots.get(e.index)
          if (slot) slot.thinking += e.text || ''
        }
        else if (e.type === 'thinking_block_signature') {
          const slot = thinkingSlots.get(e.index)
          if (slot) slot.signature = e.signature || ''
        }
        else if (e.type === 'block_stop') {
          // 只封 thinking 槽（tool_use 的封口事件本来就无人消费）
          if (thinkingSlots.has(e.index)) thinkingSlots.get(e.index)._closed = true
        }
        else if (e.type === 'usage') { streamUsage = { ...(streamUsage || {}), ...(e.usage || {}) } }
        else if (e.type === 'done') { streamUsage = { ...(streamUsage || {}), ...(e.usage || {}) }; lastFinishReason = e.reason }
      }
    } catch (e) {
      // watchdog 先 abort 底层 reader 后，底层可能以 AbortError 抢先拒绝；
      // 保留更有诊断价值的 stream timeout，避免 Agent 把它当普通 abort 重试。
      if (watchdogError) throw watchdogError
      throw e
    } finally {
      if (watchdog) clearTimeout(watchdog)
      if (abortListener) streamSignal.removeEventListener('abort', abortListener)
      // ★ 在飞的 early 工具还活着时不摘（根因见 earlyInflight 注释）；
      //   它跑完后由 p.finally 补摘。没有 early 工具时行为与原来完全一致。
      if (signal && externalStreamAbort && earlyInflight === 0) signal.removeEventListener('abort', externalStreamAbort)
      this._traceEmit('stream_end', {
        turn: this.turnCount,
        status: watchdogError ? 'timeout' : wasInterrupted ? 'interrupted' : 'closed',
        duration_ms: Date.now() - streamStartedAt,
        event_count: streamEventCount,
        first_event_ms: streamFirstEventAt == null ? null : streamFirstEventAt - streamStartedAt,
        last_event_ms: streamLastEventAt == null ? null : streamLastEventAt - streamStartedAt,
      })
      // 【指标累积】只统计正常结束的流 —— 超时/中断的耗时不代表模型真实速度，
      // 混进去会把「平均首字」算得毫无参考价值。
      // 首字样本要求真的收到过事件（streamFirstEventAt 非空）：
      // 空响应也走这里，但它没"首字"，计入会稀释平均。
      try {
        const clean = !watchdogError && !wasInterrupted
        if (clean) {
          const total = Date.now() - streamStartedAt
          this.metrics.llmMs += total
          if (streamFirstEventAt != null) {
            const firstMs = streamFirstEventAt - streamStartedAt
            this.metrics.firstTokenMsSum += firstMs
            this.metrics.firstTokenSamples += 1
            // 单轮速率：这一轮的输出 token ÷ 这一轮的生成耗时（首字之后的时段）。
            // **不跨轮累加** —— 见 getMetrics 里 tps 的注释（累计平均会递减）。
            const genMs = Math.max(0, total - firstMs)
            const outTok = Number(streamUsage?.completion_tokens ?? streamUsage?.output_tokens ?? 0)
            if (genMs > 500 && outTok > 0) {
              this._lastTps = Math.round(outTok / (genMs / 1000))
            }
            this.metrics.genMs += genMs
            this.metrics.outTokens += outTok
          }
        }
        // 这一轮已结算，清掉"进行中"标记（getMetrics 不再重复计入）
        this._inflightLlmStart = null
        this._inflightFirstCharAt = null
        this._inflightChars = 0
      } catch {}
      // 【关闭迭代器 + 强制断开底层连接】
      //
      // 这里曾经只调 `streamIter.return()` 并等 100ms 就放弃 —— 那是个连接泄漏源：
      // watchdog 超时时连接本来就卡着，`return()` 同样会卡，100ms 到点后我们撒手不管，
      // 底层 reader 和 TCP 连接就【永久泄漏】。泄漏累积到 Node 内置 fetch 对同一
      // origin 的连接上限后，**所有**新请求（包括 body 只有几十字节的 /config test）
      // 都只能排队等一个永不释放的连接 —— 这就是「一次超时之后什么都卡、
      // 只有重启进程才恢复」的根因（重启销毁整个连接池，所以"重启就好了"）。
      //
      // 修法：先 abort 掉 streamController（这会让 undici 真正销毁该连接，
      // 而不是留在池里等复用），再去 return 迭代器。顺序不能反：
      // 先 return 的话它可能一直挂着，永远走不到 abort。
      if (watchdogError || wasInterrupted) {
        try { streamController.abort() } catch {}
        // 流是异常终止（超时/被打断）：这时提前执行的工具确实该一起取消，
        // 否则会留下无人接收结果的孤儿请求。正常收尾则不碰它（见下方 1014 行注释）。
        try { earlyToolController.abort() } catch {}
      }
      if (streamIter && typeof streamIter.return === 'function') {
        try {
          await Promise.race([
            Promise.resolve(streamIter.return()),
            new Promise(resolve => setTimeout(resolve, 100)),
          ])
        } catch {}
      }
      // 兜底：即使上面两步都没能让连接关掉，也要确保 signal 已 abort，
      // 让 undici 侧的 socket 进入销毁流程，不留半开连接。
      //
      // ⚠ 注意这里【只 abort streamController，绝不能碰 earlyToolController】：
      // 这一行是「流正常结束也要执行」的连接清理，而提前执行的只读工具
      // （WebSearch 等）此刻很可能还在等网络。用同一个 controller 就会把它掐死，
      // 这正是 2026-09-04 修掉的 bug —— 改动时别图省事又合成一个。
      try { if (!streamSignal.aborted) streamController.abort() } catch {}
    }
    if (wasInterrupted) {
      // 返回已收集的 partial 内容，让上层保留半截结果
      const result = {
        choices: [{
          message: {
            content: content || null,
            reasoning_content: reasoning || undefined,
            tool_calls: tcs.filter(Boolean).filter(tc => tc.id && tc.name && isUsableToolArguments(tc.arguments)).map(tc => ({
              id: tc.id, type: 'function',
              function: { name: tc.name, arguments: normalizeToolArguments(tc.arguments) },
            })),
          },
          finish_reason: 'interrupted',
        }],
      }
      result._earlyPromises = earlyPromises
      result._partial = true   // 标记为部分结果
      // 中断路径不带 thinking：半截思考块（还没收到 signature）回传反被 Anthropic 拒
      return result
    }
    // 【按协议决定「什么算完整的思考块」】
    //
    // anthropic：**必须**带 signature。缺了会被服务端判为篡改：
    //   "thinking block must include a signature"（400）。
    //
    // responses：signature 是可选的（它是 encrypted_content，贵且不一定给）。
    //   很多网关只返回明文 summary 不带加密体 —— 只要拿到文本就值得回传，
    //   否则模型下一轮看不到自己的推理（实测「琥珀」被报成「回声」就这个原因）。
    //   强制要求 signature 会让这类网关下的思考**永远进不了历史**。
    const isResponses = apiForThis?.protocol === 'responses'
    const finishedThinking = [...thinkingSlots.values()]
      .filter(s => s.thinking && s._closed && (isResponses || s.signature))
      .map(s => ({ type: 'thinking', thinking: s.thinking, signature: s.signature || '' }))
    const result = {
      choices: [{
        message: {
          content: content || null,
          reasoning_content: reasoning || undefined,
          // 与中断路径一致：只丢弃真正被截断的参数（有内容但未闭合）。
          // 零参数工具（Battery / QQInbox / ClipboardGet 等）网关常推空 arguments，
          // 旧逻辑把它当成“参数不完整”丢弃 → 模型重发 → 再丢，造成空转死循环。
          tool_calls: tcs.filter(Boolean).filter(tc => tc.id && tc.name && isUsableToolArguments(tc.arguments)).map(tc => ({
            id: tc.id, type: 'function',
            function: { name: tc.name, arguments: normalizeToolArguments(tc.arguments) },
          })),
        },
        finish_reason: lastFinishReason || null,
      }],
    }
    if (finishedThinking.length > 0) {
      // 【按协议决定回传格式】
      // Anthropic：thinking 块 + signature
      // Responses：reasoning 项 + encrypted_content（stateless 模式下客户端负责回传）
      // 两者的原始形态完全不同，不能混用。
      if (apiForThis?.protocol === 'responses') {
        result.choices[0].message._reasoningItems = finishedThinking.map(s => {
          const item = {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: s.thinking }],
          }
          // encrypted_content 只在真拿到时才带 —— 带空串会被服务端当无效凭据
          if (s.signature) item.encrypted_content = s.signature
          return item
        })
      } else {
        result.choices[0].message._anthropicThinking = finishedThinking
      }
    }
    // 标记：原始流里有 tool_call 但被过滤掉的（参数不完整），供空响应处理区分"真·空响应"与"工具参数损坏"
    const rawToolCalls = tcs.filter(Boolean).filter(tc => tc.id && tc.name)
    if (rawToolCalls.length > 0 && result.choices[0].message.tool_calls.length === 0) {
      result._droppedToolCalls = rawToolCalls.length
    }
    // 存提前执行的结果，主循环可复用
    result._earlyPromises = earlyPromises
    if (streamUsage) result.usage = streamUsage
    return result
  }

  parseResponse(r) {
    const m = r.choices[0].message
    const finishReason = r.choices[0].finish_reason
    const c = []
    if (!this._lastUsedStream && (m.reasoning_content || m.reasoning)) this.onReasoning(m.reasoning_content || m.reasoning)
    if (m.content) c.push({ type: 'text', text: m.content })
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        let input = {}
        try {
          input = JSON.parse(tc.function.arguments || '{}')
        } catch {
          // 兜底：脏串 "{}{...}" 时取末尾完整 JSON 对象
          try {
            const raw = tc.function.arguments || ''
            const m = raw.match(/\{[\s\S]*\}\s*$/)
            if (m) input = JSON.parse(m[0])
          } catch {}
        }
        c.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
        })
      }
    }
    // _anthropicThinking：Anthropic 原生 thinking 块的原始副本（含 signature）。
    // 带 tool_use 的轮次必须原样回传，否则后续请求 400 —— 见 api.mjs
    // normalizeAnthropicResponse 的说明。OpenAI 协议下恒为 undefined。
    // _reasoningItems：Responses 协议的推理项（含 encrypted_content），
    // stateless 模式下要原样回传，否则模型丢掉自己的推理链。
    return {
      content: c,
      finishReason,
      reasoningContent: m.reasoning_content || m.reasoning || null,
      _anthropicThinking: m._anthropicThinking || null,
      _reasoningItems: m._reasoningItems || null,
    }
  }

  // 声明式异常重试表（Aider ExInfo 风格）：name / retry / description
  // 命中规则按顺序匹配，返回 { retry, description }
  _classifyError(e) {
    const msg = e.message || e.toString() || ''
    if (e?.isContextOverflow || /input\s+exceeds?\s+(?:the\s+)?context\s+window|context\s*(?:window|length|limit)|maximum\s+context|too\s+many\s+tokens|prompt\s+(?:is\s+)?too\s+long|上下文.{0,12}(?:超|过大|限制)/i.test(msg)) {
      return { retry: false, description: '输入超过模型上下文窗口，重试相同请求没有意义', name: 'context_overflow' }
    }
    // 先按 HTTP 状态码判定：这比在整条消息里搜三位数可靠得多。
    // 原来只有 /\b5\d\d\b/ 一条规则，会把 4xx 里出现的数字误当成 5xx 状态码：
    //   "HTTP 400: max_tokens must be <= 512"      → 512 命中 → 误判可重试
    //   "HTTP 400: temperature 0.500 invalid"      → 500 命中 → 误判可重试
    // 结果是必然失败的参数错误被重试 5 次，白等 31 秒（1+2+4+8+16s）。
    // deepseek-v4-flash 限 max_tokens 为 [1,1024]，这个场景真实会触发。
    const httpMatch = /HTTP\s+(\d{3})\b/i.exec(msg)
    if (httpMatch) {
      const code = Number(httpMatch[1])
      // 【本层不再重试「api 层已重试穷尽」的错误 —— 2026-09-26】
      //
      // api.mjs 对 429 已经做了「key 池轮换 + maxRetries(3) 次退避重试」，
      // 它抛出来时代表那一层真的试完了。这里若再判 retry:true，
      // agent 层又会跑 4 轮 → 底层实际发十几次请求，用户看到「同一个 429 报两次」。
      //
      // 与 connect_timeout 是同一类问题（CLAUDE.md 的「重试三层嵌套放大失败」），
      // 区别是那条靠错误文本匹配，这条靠 api 层显式打的标记，更可靠。
      if (e?.retriesExhausted) {
        return { retry: false, description: '下层已重试穷尽，不再叠加', name: 'retries_exhausted' }
      }
      if (code === 429) return { retry: true, description: '限流，可重试', name: 'rate_limit' }
      if (code >= 500 && code <= 599) return { retry: true, description: '服务端错误，可重试', name: 'server_5xx' }
      // 【401/403 必须可重试】它们是「这个 key 不行」，不是「这个请求不行」。
      // 换一个 key 就可能成功 —— 这正是 key 池存在的意义。
      //
      // 原来这里把 4xx 全判死（除 429），后果：
      //   API 层的 isKeyExhaustedError 明明认得 GROUP_DELETED / invalid_api_key，
      //   想换 key 重试，但请求在到达那一步之前就被这里否决了。
      //   实测 trace：retry:0 · retryable:false —— 池里另外 3 个 key 一次都没被用过，
      //   所以症状是「只报同一个 403，从不变化」（用户观察到的关键特征）。
      if (code === 401 || code === 403) {
        return { retry: true, description: `HTTP ${code} 认证/授权失败，换 key 后可能成功`, name: 'auth_key' }
      }
      // 其余 4xx 是请求本身的问题，重试同样的请求没意义
      if (code >= 400 && code <= 499) {
        return { retry: false, description: `HTTP ${code} 请求错误，重试无意义`, name: 'client_4xx' }
      }
    }
    const table = [
      // 【2026-10-06 改 retry: true】原来判 false（"重试同一 stream 没意义"）——
      // 那句话本身没错，但**结论错了**：我们不是重试"同一个 stream"，
      // 而是**重发一次全新请求**（新连接、新流）。
      //
      // 为什么现在敢开：
      //   · watchdog 是 **agent 层**的机制（api.mjs 不知道它的存在），
      //     所以这条错误**没有被 api 层重试过** —— 不存在叠加。
      //   · 用户实测体感：「五分钟不输出它就报错了」——
      //     中转站/网络抖动导致的长时间无数据，重发一次往往就通了。
      //   · 代价可控：重试前有退避，且 agent 层总重试次数仍受 maxRetries 约束。
      { name: 'stream_timeout', re: /Stream timeout/, retry: true, desc: '流长时间无数据（watchdog），重发新请求' },
      // 【2026-10-06 加】流**中途**网络中断 —— 用户体感「网络断一次它就报了」。
      //
      // 根因：createMessageStream 里，建连阶段走 request()（有重试），
      // 但**流解析阶段**（parseOpenAIStream 的 reader.read()）抛错时
      // 直接冒到 agent，中间没有任何重试。
      //
      // 这类错误的特征：reader.read() 在连接被掐断时抛 TypeError
      // （"network error" / "terminated" / "other side closed" 等）。
      // 上层看到的是**部分内容已收到**——重发会丢掉已收部分，
      // 但比整轮失败好（用户可接受"重新生成"，不可接受"直接报错"）。
      //
      // ⚠️ 必须排在下面的 network 规则**之前**，否则会被它先命中
      //（那条的 re 更宽），拿不到这条更精确的语义描述。
      { name: 'stream_broken', re: /other side closed|stream.*(?:error|closed|terminated)|terminated.*(?:stream|response)|premature close|incomplete (?:chunked|message)/i, retry: true, desc: '流中途断开，重发新请求' },
      // fetch 层超时（api.mjs 的 `Request timeout after Nms`）：**不可重试**。
      //
      // 【为什么不重试 —— 2026-09-01 实测教训】
      // api.mjs 的 `request()` 内部已经按 maxRetries(3) 自己重试过了，
      // 所以外面看到的一条错误其实是「N×3 + 退避」的总和。
      // 如果这里再标 retry:true，agent 层会又重试 4 轮 = 12 次请求，
      // 用户视角就是「十几分钟一声不响，连超时都不报」——
      // watchdog 也不会响，因为每次 fetch 都先抛错，够不到它的门槛。
      // 这正是 CLAUDE.md 记过的「重试三层嵌套放大失败」，只允许一层退避。
      { name: 'connect_timeout', re: /Request timeout after \d+ms/i, retry: false, desc: 'fetch 层超时（api 内部已重试），不再叠加重试' },
      // 流式不设 api 层超时后，传输层自己 abort（连接被中间设备掐断等）会走这条。
      // 这是连接问题、换条连接可能就好，且 api 内层已重试过 → 交给上层换 key/报错。
      { name: 'transport_abort', re: /Request aborted by transport/i, retry: false, desc: '传输层中断（api 内部已重试）' },
      { name: 'network', re: /ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|network error|fetch failed|ENOTFOUND|EAI_AGAIN|network/i, retry: true, desc: '网络错误，可重试' },
      { name: 'rate_limit', re: /\b429\b|rate limit|quota/i, retry: true, desc: '限流，可重试' },
      // 没有 HTTP 前缀时才用这些文本特征兜底（去掉了裸的 \b5\d\d\b）
      { name: 'server_5xx', re: /SERVICE_BUSY|LITELLM_UNAVAILABLE|upstream_unavailable|bad\s+gateway|service\s+unavailable|internal\s+server\s+error/i, retry: true, desc: '服务端错误，可重试' },
      // 中转站（new_api 等）的瞬时抖动不带 HTTP 前缀，纯文案特征：
      //   "该模型所有渠道都因错误而被禁用，请稍后重试" —— 上游 5xx 被网关包装后的说法，
      //   "请稍后重试" 就是网关自己让你重试。2026-08-25 实测：同一时段主会话撞 3 次全靠
      //   HTTP 503 前缀命中 server_5xx 重试恢复；子 agent 收到的是无前缀版，落 unknown
      //   直接终态。归 server_5xx 同档。
      { name: 'server_5xx', re: /渠道.*被禁用|无可用渠道|所有渠道|distributor|请稍后重试/i, retry: true, desc: '上游渠道瞬时不可用，可重试' },
      // 用户主动中断（Ctrl+C 触发 AbortController）不该重试 —— 那是用户的明确意图。
      // 上游只拦了 e.message === 'Interrupted'，而 AbortController 抛的是
      // "The operation was aborted"，会漏到这里。只有上游 terminated 才值得重试。
      { name: 'user_abort', re: /operation\s+was\s+aborted|AbortError|user\s+abort/i, retry: false, desc: '用户主动中断，不重试' },
      { name: 'abort', re: /terminated/i, retry: true, desc: '连接被终止，可重试' },
    ]
    for (const row of table) {
      if (row.re.test(msg)) return { retry: row.retry, description: row.desc, name: row.name }
    }
    return { retry: false, description: '未知错误，不重试', name: 'unknown' }
  }

  shouldRetry(e) {
    return this._classifyError(e).retry
  }

  addUserMessage(t) { this.messages.push({ role: 'user', content: t }) }
  clear() {
    this.messages = []
    this.turnCount = 0
    // 【2026-10-06 同批修】清空历史后必须重置占用计数 —— 否则水位判定
    // 还读着清空前的大数字 → 新对话第一条消息就被拦（与 /compact 那个
    // 死循环同源）。清空后占用就是系统提示词那点量，置 0 让判定走
    // 「无数据 → ok」分支，等首次请求后自然填真实值。
    this.lastPromptTokens = 0
    this._approxPromptTokens = false
  }

  /**
   * 清零「本次任务」的耗时指标（每次 run 开始调用）。
   *
   * 【为什么不连首字一起清】—— 这两类指标的时间尺度不同：
   *   - llmMs / toolMs / toolCalls：描述**本次任务**的耗时构成。任务换了就该重新算，
   *     否则上一轮的 30 秒混进来，「这次花了多久」完全失真。
   *   - avgFirstTokenMs：描述**这个端点+模型**的响应特征，跨任务才叫「平均」。
   *     跟着每次 run 清掉的话永远只有 1 个样本，「平均」名存实亡 —— 而首字时间
   *     本来抖动就大，单样本看不出任何规律。
   *
   * 端点/模型换了则首字样本作废（不同端点速度不可比），由 _syncMetricsEndpoint 处理。
   */
  resetMetrics() {
    this.metrics.llmMs = 0
    this.metrics.toolMs = 0
    this.metrics.toolCalls = 0
    this.metrics.outTokens = 0
    this.metrics.genMs = 0
    this._inflightLlmStart = null
    this._inflightFirstCharAt = null
    this._inflightChars = 0
    // 上个任务的速率对新任务没有参考价值（可能换了模型/网络），清掉
    this._lastTps = null
    // 上一轮若异常退出可能留下未清理的起始时刻，不清会让工具时间虚高
    this._runningToolStarts = []
    // firstTokenMsSum / firstTokenSamples 刻意保留，见上
  }

  /**
   * 端点或模型变了 → 首字样本作废。
   *
   * 判据复用 api 的 _endpointKey()（协议|URL|模型）：换 provider、换模型、
   * 换协议都会得到新 key。不这么做的话，从慢站切到快站后，
   * 「平均首字」会被旧站的样本拖着，显示一个跟当前端点无关的数。
   */
  _syncMetricsEndpoint(api) {
    let key = null
    try { key = api?._endpointKey?.() || null } catch {}
    if (!key) return
    if (this._metricsEndpointKey === undefined) { this._metricsEndpointKey = key; return }
    if (this._metricsEndpointKey !== key) {
      this._metricsEndpointKey = key
      this.metrics.firstTokenMsSum = 0
      this.metrics.firstTokenSamples = 0
    }
  }

  /**
   * 运行时指标快照（状态条用）。
   * avgFirstTokenMs 只在有样本时才有意义 —— 无样本返回 null，
   * 让调用方显示「—」而不是 0ms（0ms 会被误读成"首字瞬间到达"）。
   */
  getMetrics() {
    const m = this.metrics || {}
    // 【进行中的一轮也要算进来】否则状态条上的 LLM 时间要等整轮跑完才跳，
    // 一轮三分钟就三分钟不动 —— 用户以为卡了（2026-09-16 反馈）。
    // _inflightLlmStart 在流开始时置、finally 里清；这段不重复计入：
    // 结算时累加的是「完整耗时」，同时把标记清掉。
    let inflight = 0
    if (this._inflightLlmStart) inflight = Math.max(0, Date.now() - this._inflightLlmStart)
    // 【工具计时也要含进行中】原来只有 LLM 那段算了 inflight，
    // 结果是「LLM 时间在跳、工具时间纹丝不动」—— 工具跑 60 秒的话
    // 状态条上那 60 秒完全不显示，用户看不出时间花在哪（2026-09-16 反馈）。
    let toolInflight = 0
    const runningTools = this._runningToolStarts ? this._runningToolStarts.length : 0
    if (runningTools > 0) {
      const now = Date.now()
      for (const t0 of this._runningToolStarts) toolInflight += Math.max(0, now - t0)
    }
    // 【tps 绝对不能把"进行中"算进分母】
    //
    // 曾经的写法是 `genMs = 已结算 + inflight`，本意是"避免 tps 虚高"，
    // 实际是错的：进行中那轮**分子没变**（输出 token 数只有服务端知道，
    // 流没结束时拿不到），分母却每秒在涨 —— 算出来的是「历史平均速度被当前
    // 等待时间稀释」，表现为 **tps 每秒往下掉**（用户 2026-09-16 报：
    // "模型不输出的时候它每秒都在掉"）。
    //
    // 正确做法：分子分母必须**配套**——只用已结算的那部分算。
    // 代价是流式过程中 tps 保持上一次的值不动（而不是乱掉），这显然更好：
    // 一个稳定但略旧的数字，比一个每秒都在骗人的数字可信。
    // 进行中的那轮结算完（finally 里累加 outTokens/genMs）自然就更新了。
    // 【tps：报告"当前速度"，不是"全程平均"】
    //
    // 两次踩坑，别改回去：
    //   1.0：把进行中的**时间**加进分母、分子不动 →
    //        模型不输出时 tps 每秒往下掉（用户 2026-09-16 报）
    //   2.0：分子分母同步加（字符估算 token）→ 稳定输出时**仍然**递减
    //        （88→80→73→68），因为累计平均里混着起跑阶段的数据
    //
    // 正确模型：tps 是速率，该用"最近一段"算。最简实现 ——
    // **只看当前这一轮**：结算完立刻覆盖上一轮的值（不跨轮累加），
    // 进行中的那轮按"已收字符 ÷ 已过生成时间"实时算。
    let tps = this._lastTps || null
    if (this._inflightLlmStart && this._inflightChars > 0) {
      const firstAt = this._inflightFirstCharAt || this._inflightLlmStart
      const genMs = Math.max(0, Date.now() - firstAt)
      if (genMs > 500) {
        // 字符 → token：中英混排约 3.5 字符/token（与项目其他地方同口径）
        const inst = (this._inflightChars / 3.5) / (genMs / 1000)
        // 有历史值时做 7:3 加权，压掉刚开始样本少时的抖动
        tps = this._lastTps != null ? Math.round(inst * 0.7 + this._lastTps * 0.3) : Math.round(inst)
      }
    }
    return {
      avgFirstTokenMs: m.firstTokenSamples > 0 ? Math.round(m.firstTokenMsSum / m.firstTokenSamples) : null,
      llmMs: (m.llmMs || 0) + inflight,
      toolMs: (m.toolMs || 0) + toolInflight,
      toolCalls: (m.toolCalls || 0) + runningTools,
      tps,
      turns: this.turnCount || 0,
      inflight: inflight > 0,
      toolInflight: runningTools > 0,
    }
  }
  getHistory() { return this.messages }
  /**
   * 替换历史（/compact /clear /resume /rewind /branch 都会调）。
   *
   * 【2026-10-06 修死循环】这里**自动重估** lastPromptTokens ——
   * 原来的问题是：这些命令改了历史，但占用计数还是上一次 API 的旧值
   * （压缩前的大数字）→ 下次水位判定 → blocking → 请求发不出去 →
   * 值永远不更新。用户现象：「明明刚 compact 过，还是被拦」。
   *
   * 放在这里而不是每个命令里各调一次：**一处覆盖全部调用点**，
   * 以后新增改历史的命令也不会漏。估算用 4 字符 ≈ 1 token（与
   * CompactService 同口径），下次真实请求成功后会被准确值替换。
   */
  setHistory(m) {
    this.messages = Array.isArray(m) ? m : []
    try {
      const est = this._estimateHistoryTokens()
      if (est > 0) {
        this.lastPromptTokens = est
        this._approxPromptTokens = true
      }
    } catch { /* 估算失败不影响设历史本身 */ }
  }

  /**
   * 按当前历史粗估 token 数（4 字符 ≈ 1 token）。
   * 含 system prompt（它也是请求的一部分，不算会低估）。
   */
  _estimateHistoryTokens() {
    let chars = 0
    for (const msg of this.messages) {
      if (typeof msg?.content === 'string') chars += msg.content.length
      else if (Array.isArray(msg?.content)) {
        for (const part of msg.content) {
          if (typeof part?.text === 'string') chars += part.text.length
        }
      }
    }
    // system prompt 是请求的一部分 —— 只算历史会系统性低估
    const sp = typeof this.systemPrompt === 'string' ? this.systemPrompt.length : 0
    return Math.ceil((chars + sp) / 4)
  }
  getTokenUsage() { return this.tokenUsage }
  getLastPromptTokens() { return this.lastPromptTokens }

  /**
   * 历史被外部改动（/compact、/clear、/rewind）后，**重估**上下文占用。
   *
   * ══════════════════════════════════════════════════════════════
   *  要堵的死循环（2026-10-06 用户实测踩到）
   * ══════════════════════════════════════════════════════════════
   *
   * ```
   * 1. lastPromptTokens 是上一次 API 返回的 prompt_tokens（压缩前的大数字）
   * 2. /compact 压缩了历史，但这个值**没更新**
   * 3. 下次发消息 → 水位判定读旧值 → remain < 13K → blocking → 拒发
   * 4. 请求发不出去 → 值永远不更新 → 死循环
   * ```
   *
   * 用户现象：「context-blocking: 上下文已满，请先 /compact 再发消息」
   * —— 明明刚 compact 过，还是被拦。
   *
   * 修法：压缩后按**当前历史**做本地粗估（4 字符 ≈ 1 token，与
   * Compactor 的估算口径一致），覆盖 lastPromptTokens。
   * 这是**近似值**，下一次真实请求成功后会被准确值替换。
   *
   * @param {number} approxTokens 估算的当前上下文 token 数
   */
  setApproxPromptTokens(approxTokens) {
    const n = Math.max(0, Math.floor(Number(approxTokens) || 0))
    if (n > 0) {
      this.lastPromptTokens = n
      this._approxPromptTokens = true   // 标记：这是估算值，非真实 usage
    }
  }

  /** 当前占用是否为估算值（供 /context 显示 ~ 前缀） */
  isApproxPromptTokens() { return !!this._approxPromptTokens }
  getLastUsage() { return this.lastUsage }
  getLastTraceId() { return this.lastTraceId || null }
}
