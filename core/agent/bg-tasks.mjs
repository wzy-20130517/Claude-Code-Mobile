// 统一后台任务存储（subagent + bash 共用）
// 状态机：pending → running → completed/failed/killed
import { randomBytes } from 'node:crypto'
import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Termux 下 /tmp 不可写，用包内目录
const TASK_LOG_DIR = join(homedir(), '.claude-code-mobile', 'task-logs')
// 单任务日志落盘上限：对标官方 2.1.265（1GB cap on tool results saved to disk）
const BG_TASK_LOG_MAX_BYTES = 1024 * 1024 * 1024
// 内存副本尾部保留量（与 bg-bash.mjs 的 MAX_OUTPUT_CHARS 同量级）
const MAX_OUTPUT_CHARS = 200_000
function ensureLogDir() {
  try { if (!existsSync(TASK_LOG_DIR)) mkdirSync(TASK_LOG_DIR, { recursive: true }) } catch {}
  return TASK_LOG_DIR
}

const backgroundTasks = new Map()

// 任务集合变化通知（UI 面板刷新用）：register/start/complete/fail/kill 都触发
export let onTasksChanged = null
export function setOnTasksChanged(fn) { onTasksChanged = typeof fn === 'function' ? fn : null }
function notifyTasksChanged() {
  try { onTasksChanged?.() } catch {}
}

export class BgTask {
  constructor(id, type, description) {
    this.taskId = id
    this.type = type           // 'local_agent' | 'local_bash'
    this.description = description
    this.status = 'pending'
    this.startTime = null
    this.endTime = null
    this.output = ''
    this.outputOffset = 0
    this.outputFile = null
    // 最近一次真的产出内容的时刻。用来区分「在干活」和「空转」——
    // 只看 duration 和 turns 分不出来：卡在第 40 轮空转的 worker 和正常干活的
    // 长得一模一样，没有任何信号提示该 AgentStop（COO 诊断过这条）。
    this.lastOutputAt = null
    this.notified = false
    this.result = null
    this.abortController = null
    this.proc = null
    this.exitCode = null
  }

  start() { this.status = 'running'; this.startTime = Date.now(); notifyTasksChanged() }

  /**
   * 进终态时放掉 agent 实例引用。
   * 这个实例带着整段对话历史（messages），而 gcTerminalTasks 要 5 分钟后才删 task，
   * 期间白占内存。turnCount 先快照到 finalTurns，否则终态后 turns 会归 0。
   * 想复用上下文让它返工，走 plan.mjs 的 keptAgents（SendMessage wake:true），
   * 那边有 LRU 上限管着，不是靠这里挂引用。
   */
  _releaseAgent() {
    if (this.agent) {
      this.finalTurns = this.agent.turnCount ?? this.finalTurns
      this.finalMaxTurns = this.agent.maxTurns ?? this.finalMaxTurns
      this.agent = null
    }
  }

  complete(result) { this.status = 'completed'; this.endTime = Date.now(); this.result = result; this._releaseAgent(); notifyTasksChanged() }
  fail(error) { this.status = 'failed'; this.endTime = Date.now(); this.result = { ok: false, error }; this._releaseAgent(); notifyTasksChanged() }
  kill() { this.status = 'killed'; this.endTime = Date.now(); this.result = { ok: false, error: 'killed' }; this._releaseAgent(); notifyTasksChanged() }
  isTerminal() { return ['completed', 'failed', 'killed'].includes(this.status) }

  appendOutput(text) {
    if (!text) return
    this.lastOutputAt = Date.now()
    // 超过 50KB 转落盘：后续 chunk 直接 appendFile 追加，不再全量重写；
    // 内存副本只保留尾部（getOutputDelta 读文件增量，不依赖内存头部）。
    // 【1GB 上限】对标官方 2.1.265：防失控任务写满手机磁盘。超限后丢弃后续输出。
    if (!this.outputFile && this.output.length + text.length > 50000) {
      this.outputFile = join(ensureLogDir(), `task-${this.taskId}.log`)
      try { writeFileSync(this.outputFile, this.output) } catch { this.outputFile = null }
    }
    if (this.outputFile) {
      if (this._fileBytes >= BG_TASK_LOG_MAX_BYTES) {
        // 达到上限：丢弃后续，只记一次提示
        if (!this._capped) {
          this._capped = true
          try { appendFileSync(this.outputFile, `\n[输出达到上限，后续输出被丢弃]\n`) } catch {}
        }
        return
      }
      this.output += text
      // 内存副本只留尾部，防长任务内存泄漏
      if (this.output.length > MAX_OUTPUT_CHARS) {
        this.output = '…[earlier output truncated]…\n' + this.output.slice(-MAX_OUTPUT_CHARS)
        if (this.outputOffset > this.output.length) this.outputOffset = this.output.length
      }
      try { appendFileSync(this.outputFile, text); this._fileBytes += Buffer.byteLength(text) } catch { this.outputFile = null }
    } else {
      this.output += text
    }
  }

  getOutputDelta() {
    const src = this.outputFile
      ? (() => { try { return readFileSync(this.outputFile, 'utf-8') } catch { return this.output } })()
      : this.output
    // offset 可能因内容被截断而越界，夹紧防负数 slice 反读
    if (this.outputOffset > src.length) this.outputOffset = src.length
    const delta = src.slice(this.outputOffset)
    this.outputOffset = src.length
    return delta
  }
}

export function registerBackgroundTask(type, description) {
  const id = `${type === 'local_bash' ? 'b' : 'a'}${randomBytes(4).toString('hex')}`
  const task = new BgTask(id, type, description)
  backgroundTasks.set(id, task)
  notifyTasksChanged()
  return task
}

export function getBackgroundTask(taskId) {
  return backgroundTasks.get(taskId) || null
}

export function getBackgroundTaskStatus(taskId) {
  const task = backgroundTasks.get(taskId)
  if (!task) return null
  return {
    status: task.status,
    result: task.result,
    description: task.description,
    type: task.type,
    exitCode: task.exitCode ?? task.result?.exitCode ?? null,
    duration_ms: task.startTime ? (task.endTime || Date.now()) - task.startTime : 0,
    duration_human: task.startTime ? `${(((task.endTime || Date.now()) - task.startTime) / 1000).toFixed(1)}s` : '0s',
    // turns 优先读**实时** turnCount：task.result 要等跑完才有，
    // 只读 result.turns 会让 running 期间恒显示 0，看着像卡死（实际在正常干活）。
    // running 时读实例实时值；终态后实例已释放，读快照 finalTurns
    turns: task.agent?.turnCount ?? task.finalTurns ?? task.result?.turns ?? 0,
    // 子 Agent 的对话轮数，能区分"刚起步"和"聊了很久"
    messages: task.agent?.messages?.length ?? null,
    agentType: task.agentType || null,
    agentName: task.agentName || null,
    // 距上次产出多久没动静（ms）；null = 还没有任何产出
    idle_ms: task.lastOutputAt ? Date.now() - task.lastOutputAt : null,
    output_preview: task.outputFile
      ? (() => { try { return readFileSync(task.outputFile, 'utf-8').slice(-500) } catch { return task.output.slice(-500) } })()
      : task.output.slice(-500),
    // 【取头部不取尾部】result 是 JSON 字符串，尾部全是 } 和闭合括号，
    // 真正有用的 result/ok/error 字段在开头。原来用 slice(-1000) 等于只给一堆括号。
    result_preview: task.result ? truncHead(JSON.stringify(task.result), 1200) : null,
    error: task.error ? String(task.error).slice(0, 300) : null,
  }
}

function truncHead(s, n) {
  return s.length > n ? s.slice(0, n) + `… (共 ${s.length} 字符)` : s
}

export function listBackgroundTasks() {
  const list = []
  for (const [id, task] of backgroundTasks) {
    list.push({
      id, status: task.status, type: task.type, description: task.description,
      // 列表也要带这几个：否则 AgentStatus 不传 task_id 时只能看到状态，
      // 判断不了谁在推进、谁真的僵住了
      turns: task.agent?.turnCount ?? task.finalTurns ?? task.result?.turns ?? 0,
      duration_ms: task.startTime ? (task.endTime || Date.now()) - task.startTime : 0,
      agentName: task.agentName || null,
      // agentType/lastOutputAt 给 /agents 的实时状态用：类型要能对上角色卡，
      // lastOutputAt 用来标「疑似空转」
      agentType: task.agentType || null,
      lastOutputAt: task.lastOutputAt || null,
      startTime: task.startTime || null,
      // 轮次分母：只有 41/50 才能判断"要不要干预"，光看 41 没有意义。
      // running 时读实例，终态后实例已释放（_releaseAgent）故读快照。
      maxTurns: task.agent?.maxTurns ?? task.finalMaxTurns ?? null,
    })
  }
  return list
}

export function killBackgroundTask(taskId) {
  const task = backgroundTasks.get(taskId)
  if (!task) return false
  if (task.isTerminal()) return true
  try {
    if (task.proc) task.proc.kill('SIGKILL')
    if (task.abortController) task.abortController.abort()
  } catch {}
  task.kill()
  return true
}

export function gcTerminalTasks() {
  const now = Date.now()
  for (const [id, task] of backgroundTasks) {
    if (task.isTerminal() && task.endTime && now - task.endTime > 5 * 60 * 1000) {
      backgroundTasks.delete(id)
    }
  }
}
