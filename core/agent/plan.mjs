// Claude Code Mobile - 计划模式 + 子 Agent
import { Tool } from '../tools/tools.mjs'
import {
  registerBackgroundTask,
  getBackgroundTaskStatus,
  listBackgroundTasks,
  setOnTasksChanged as _setOnTasksChanged,
  killBackgroundTask,
  gcTerminalTasks,
} from './bg-tasks.mjs'

// re-export 方便 index 从 plan.mjs 统一引入
export { getBackgroundTaskStatus, listBackgroundTasks, killBackgroundTask, gcTerminalTasks }

export class PlanMode {
  constructor() { this.enabled = false }
  enable() { this.enabled = true; return '进入计划模式' }
  disable() { this.enabled = false; return '退出计划模式' }
  toggle() { return this.enabled ? this.disable() : this.enable() }
  getSystemPromptAddition() { return this.enabled ? '\n\n# 计划模式已启用\n你需要先给出一个执行计划（步骤列表），不要执行任何工具。\n等用户批准后再开始执行。\n' : '' }
}

// 【轮数上限的单一真值源】改这里即可，其余引用点都从这里读。
// 2026-09-19 用户要求：normal 100→300、deep 1000→3000
// （理由：很多人的任务超过 24h，1000 轮不够用）。
export const NORMAL_MAX_TURNS = 300
export const DEEP_MAX_TURNS = 3000

// Deep 模式：让 Claude 在复杂任务时使用更长 maxTurns
// 用户可以 /deep 主动开启，或 Claude 用 EnterDeepMode 工具自己切
export class DeepMode {
  constructor() { this.enabled = false; this.normalMaxTurns = NORMAL_MAX_TURNS; this.deepMaxTurns = DEEP_MAX_TURNS }
  enable() { this.enabled = true; return `进入 deep 模式：maxTurns 提升至 ${DEEP_MAX_TURNS}` }
  disable() { this.enabled = false; return `退出 deep 模式：maxTurns 恢复为 ${NORMAL_MAX_TURNS}` }
  toggle() { return this.enabled ? this.disable() : this.enable() }
  getMaxTurns() { return this.enabled ? this.deepMaxTurns : this.normalMaxTurns }
  getSystemPromptAddition() { return this.enabled ? `\n\n# Deep 模式已启用\n你拥有最多 ${DEEP_MAX_TURNS} 个工具轮次来完成复杂任务。可以展开详细的步骤、多次尝试、跨多个文件迭代。不要急于收尾。\n` : '' }
}

/**
 * 协调者模式（对齐官方 Coordinator Mode）。
 *
 * 【为什么有这个东西】
 * 用户问「web 中协作模式可能无效，其实就是多 Agent 编排。参考官方源码中有没有
 * 协作模式这个概念：如果有就做，没有的话就不在 web 显示这个功能」。
 *
 * 核实结论：**官方有**（~/cc-src/claude-code-main/coordinator/coordinatorMode.ts），
 * 就是多 Agent 编排：
 *   · 主对话变成「协调者」——只拆解、派活、读结果、汇总，**自己不写代码**
 *   · 用 Agent spawn worker、SendMessage 续跑（复用它的上下文）、AgentStop 中止
 *   · worker 结果以 <task-notification> 形式回到协调者
 *   · 由环境变量 CLAUDE_CODE_COORDINATOR_MODE 开关
 *
 * 我们的工具层其实**早就齐了**（Agent / SendMessage / TeamCreate / TaskCreate），
 * core/plan.mjs 的 BUILTIN_SUBAGENT_TYPES.Coordinator 里也有完整编排纪律 ——
 * 缺的只是「把主对话本身切成协调者」这一个开关。这个类就是那个开关。
 *
 * 【与 Coordinator 子 agent 类型的区别，别混】
 *   · BUILTIN_SUBAGENT_TYPES.Coordinator → 主对话 spawn 出的**某个子 agent** 是协调者
 *   · 这个 CoordinatorMode              → **主对话本人**变成协调者（官方语义）
 * 两者可以同时存在：协调者模式下的主对话再去 spawn Coordinator 子 agent 也合法。
 */
export class CoordinatorMode {
  constructor() { this.enabled = false }
  enable() { this.enabled = true; return '进入协调者模式：你只做编排，不亲自改代码' }
  disable() { this.enabled = false; return '退出协调者模式：恢复正常工作方式' }
  toggle() { return this.enabled ? this.disable() : this.enable() }
  getSystemPromptAddition() {
    if (!this.enabled) return ''
    // 提示词按官方 coordinatorMode.ts 的骨架写，但**不复述既有纪律** ——
    // Agent 工具描述、Coordinator 子 agent 类型里已经写了并发预算、
    // 返工找原 worker、按文件集合分串并行等细节。这里只讲「角色转变」这件
    // 主对话原本不知道的事，避免同一套规则散落三处各自过期。
    return `

# 协调者模式已启用（Coordinator Mode）

**你的角色变了：你是协调者，不是执行者。**

- **自己不写代码、不改文件、不跑长命令。** 想动手时，改成 spawn 一个 worker 去做。
- 你只做四件事：**拆解 → 派活 → 读结果 → 汇总**。
- 允许的例外：为了拆任务而做的少量只读侦察（看目录、确认文件存在），
  但不要发展成"我自己顺手把活干完"——那就失去了编排的意义。

**工具**：用 Agent spawn worker（给每个起好 agent_name）；用
SendMessage(to:<名字>, wake:true) 让跑完的 worker 带着原上下文继续干
（要返工找原 worker，不要重新 spawn，它记得自己做过什么）；派错方向用
AgentStop 中止，别干等它烧 token。

**每句话都是说给用户听的。** worker 的结果是内部信号，不是对话对象 ——
不要对它们说"谢谢""收到"。有新进展就替用户总结出来。

**并行按冲突分组，不是按个数**：只读任务放开并行；写文件的任务按**文件集合**
分组（同一批文件同时只能有一个 worker 在改，否则静默覆盖）；验证可与实现并行，
但要验证的文件若正在被改就必须等它交回。

**worker 的结论要抽查**，不要照抄。凡"有没有 / 是不是"的断言，自己 Read 关键位置核一眼。

用户没让你进这个模式时不要自己进（\`/coordinate\` 是用户命令）；
但如果你发现自己正在做「一堆可以并行的独立子任务」，可以建议用户开它。
`
  }
}

export class EnterPlanModeTool extends Tool {
  constructor(onEnter) { super({ name: 'EnterPlanMode', description: '进入计划模式', input_schema: { type: 'object', properties: {} } }); this.onEnter = onEnter }
  async execute() { this.onEnter(); return '已进入计划模式' }
}
export class ExitPlanModeTool extends Tool {
  constructor(onExit) { super({ name: 'ExitPlanMode', description: '退出计划模式', input_schema: { type: 'object', properties: { execute_immediately: { type: 'boolean' } } } }); this.onExit = onExit }
  async execute() { this.onExit(); return '已退出计划模式' }
}

export class EnterDeepModeTool extends Tool {
  constructor(onEnter) { super({ name: 'EnterDeepMode', description: `进入 deep 模式（maxTurns 提升至 ${DEEP_MAX_TURNS}，用于复杂多步骤任务）。适用于：任务确实复杂（多文件改动、反复迭代调试），或接近轮数上限但确认没有空转、还需要更多轮才能做完时（自救，不用等用户）。`, input_schema: { type: 'object', properties: {} } }); this.onEnter = onEnter }
  async execute() { this.onEnter(); return `已进入 deep 模式，maxTurns 提升至 ${DEEP_MAX_TURNS}` }
}

export class ExitDeepModeTool extends Tool {
  constructor(onExit) { super({ name: 'ExitDeepMode', description: '退出 deep 模式，恢复默认 maxTurns', input_schema: { type: 'object', properties: {} } }); this.onExit = onExit }
  async execute() { this.onExit(); return '已退出 deep 模式' }
}

/**
 * 子 Agent 自主续轮。
 *
 * 【为什么不能让子 Agent 用 EnterDeepMode】DeepMode 是主进程的**全局单例**，
 * 控制主 Agent 的 maxTurns；子 Agent 的 maxTurns 来自角色卡、在 new Agent() 时写死。
 * 子 Agent 调 EnterDeepMode 只会改主 Agent 的开关，对自己毫无作用 —— 更糟的是
 * 它会以为自己续上了，继续大手大脚干活，然后照样在原上限处被砍断
 *（2026-08-30 实测：CPO 被告知"你有 1000 轮"，实际 60 轮就用尽交还）。
 *
 * 所以给子 Agent 一个只改**自己实例**的工具。设计上刻意保留闸门：
 *   · 单次增量有上限（避免一次要到天上去）
 *   · 累计续轮次数有上限（避免无限续导致失控烧 token）
 *   · 要求写明理由（迫使它判断"是真没做完"还是"在原地打转"）
 * 用尽仍未完成时，正确行为是**诚实交还**（写清做到哪、待办是什么），不是硬续。
 */
/**
 * 持续模式（watch）——进入/退出工具（2026-09-30 用户要求「参考 plan 做成原生工具」）。
 *
 * 原来 /watch 只有用户命令入口，AI 自己想开启持续监听（盯队列/持续任务）时
 * 只能建议用户敲命令。现在与 EnterPlanMode/EnterDeepMode 对齐，AI 可自主进出。
 *
 * 状态存在 Agent 实例的 watchMode 字段（core/agent.mjs）——
 * run 内 while 循环读它决定「本轮结束后是否注入继续」，所以工具一调立即生效。
 */
export class EnterWatchTool extends Tool {
  constructor(onEnter) {
    super({
      name: 'EnterWatch',
      description: '进入持续模式（watch）：本轮结束后不主动停止回复，持续执行/监听，直到 ExitWatch 或用户打断（Ctrl+C）。仅在任务确实是「持续性」的（盯队列、轮询状态、持续下歌等）才用；一次性任务不要开。主对话专用。',
      input_schema: { type: 'object', properties: {} },
    })
    this.onEnter = onEnter
  }
  async execute() {
    this.onEnter()
    return '已进入持续模式：本轮结束后将继续执行/监听，不会主动停。用 ExitWatch 或让用户 Ctrl+C 退出。'
  }
}

export class ExitWatchTool extends Tool {
  constructor(onExit) {
    super({
      name: 'ExitWatch',
      description: '退出持续模式（watch），恢复正常「一轮结束即停」。持续任务已完成或不再有时调用。',
      input_schema: { type: 'object', properties: {} },
    })
    this.onExit = onExit
  }
  async execute() {
    this.onExit()
    return '已退出持续模式：本轮结束后将正常停止回复。'
  }
}

export class ExtendTurnsTool extends Tool {
  constructor({ getAgent, maxExtensions = 4, perExtension = 60, hardCap = 400 } = {}) {
    super({
      name: 'ExtendTurns',
      description: `给自己追加工具轮次（仅当任务确实没做完、且还在有效推进时用）。单次最多 +${perExtension} 轮，最多续 ${maxExtensions} 次，总上限 ${hardCap} 轮。收到「距上限只剩不到 10 轮」提醒且工作未完成时，先判断：是真的还需要更多轮，还是自己在原地打转？前者续，后者立刻收尾交还。`,
      input_schema: {
        type: 'object',
        properties: {
          turns: { type: 'number', description: `要追加多少轮（1-${perExtension}），省略则用 ${perExtension}` },
          reason: { type: 'string', description: '为什么还需要更多轮：已完成什么、还剩什么、预计几轮能收尾' },
        },
        required: ['reason'],
      },
      validateInput: (input) => {
        if (!String(input?.reason || '').trim()) {
          return { valid: false, errors: ['必须写 reason：说明已完成什么、还剩什么、预计几轮收尾'] }
        }
        return { valid: true }
      },
    })
    this.getAgent = getAgent
    this.maxExtensions = maxExtensions
    this.perExtension = perExtension
    this.hardCap = hardCap
    this.used = 0
  }

  async execute(input = {}) {
    const agent = this.getAgent?.()
    if (!agent) return '续轮失败：拿不到自身 Agent 实例（这是内部错误，请如实报告并收尾）'
    if (this.used >= this.maxExtensions) {
      return `已用完 ${this.maxExtensions} 次续轮机会（当前上限 ${agent.maxTurns} 轮）。`
        + `不能再续了 —— 请立刻收尾：把已完成的部分和未完成的部分如实写进报告，`
        + `并在 comment 里留下续做者需要的信息。`
    }
    const want = Number(input.turns) > 0 ? Math.min(Math.floor(Number(input.turns)), this.perExtension) : this.perExtension
    const before = agent.maxTurns
    if (before >= this.hardCap) {
      return `已达硬上限 ${this.hardCap} 轮，不能再续。请立刻收尾并如实交还未完成部分。`
    }
    agent.maxTurns = Math.min(before + want, this.hardCap)
    this.used++
    return `已续 ${agent.maxTurns - before} 轮：${before} → ${agent.maxTurns}`
      + `（第 ${this.used}/${this.maxExtensions} 次，硬上限 ${this.hardCap}）\n`
      + `理由已记录：${String(input.reason).slice(0, 200)}\n`
      + `继续干，但注意：续轮不是免费的，如果发现自己在原地打转就主动收尾。`
  }
}

// ─── 内置子 Agent 类型定义 ───────────────────────────────────────────

export const BUILTIN_SUBAGENT_TYPES = {
  'general-purpose': {
    description: '通用子 agent，拥有全部工具，可独立完成复杂任务',
    toolNames: null,
    maxTurns: 200,
    promptAddition: `\n# 你的角色：通用子 Agent
你是一个被主 Agent 委派的子 Agent，拥有全部工具权限。
你的任务会由主 Agent 在 task 中描述，请自行规划步骤、调用工具、完成任务。
完成后返回简洁的结果摘要给主 Agent，不要返回无意义的空话。
**重要**：你运行在后台，**永远不要调用 AskUserQuestion**——你无法与用户交互，调用会永远阻塞。
如果任务有模糊或信息不足的地方，基于合理假设推进，并在结果中说明你做的假设即可。`
  },
  'Explore': {
    description: '探索子 agent，只读工具，用于调研代码库、解答"代码在哪/怎么实现"等问题',
    toolNames: ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'HashlineRead', 'HashlineGrep', 'LSP'],
    maxTurns: 200,
    promptAddition: `\n# 你的角色：探索子 Agent (Explore)
你是一个只读的探索子 Agent，用于调研代码库结构、查找文件、理解实现。
**禁止**修改任何文件、执行任何写入操作、提交 git 等。
**重要**：你运行在后台，**永远不要调用 AskUserQuestion**——你无法与用户交互，调用会永远阻塞。
信息不足时基于合理推断推进。
完成后返回你的发现摘要：相关文件路径（用 file_path:line_number 格式）、关键实现位置、以及简短的代码结构说明。`
  },
  'Plan': {
    description: '计划子 agent，只读+TodoWrite，用于制定执行计划',
    toolNames: ['Read', 'Glob', 'Grep', 'Bash', 'TodoWrite', 'HashlineRead', 'HashlineGrep'],
    maxTurns: 200,
    promptAddition: `\n# 你的角色：计划子 Agent (Plan)
你是一个用于制定计划的子 Agent。先探索代码库现状，然后产出一份清晰的执行计划。
**禁止**执行任何修改操作。**重要**：你运行在后台，**永远不要调用 AskUserQuestion**。
返回格式：
1. 任务概述
2. 步骤列表（带 progress 标记）
3. 涉及的文件路径列表
4. 潜在风险与注意事项`
  },
  'Coordinator': {
    description: '协调者子 agent，编排多个 worker 并行完成复杂任务',
    toolNames: null,
    maxTurns: 200,
    promptAddition: `\n# 你的角色：协调者子 Agent (Coordinator)
你是一个多 Agent 编排者。你不直接执行任务，只做编排。
**重要**：你运行在后台，**永远不要调用 AskUserQuestion**——你无法与用户交互。
你的责任：
1. 分析任务，拆分为可并行的子任务
2. 用 Agent 工具 spawn 多个 worker（general-purpose 或 Explore 类型）
3. 只读子任务（research/exploration）可以并行 spawn
4. 写操作子任务如果涉及同一文件领域，串行执行
5. 汇总所有 worker 的结果，自己做综合分析
6. 不要把理解任务委托给 worker，你负责最终的 synthesize
spawn 时用 run_in_background: true，然后用 AgentStatus 查看结果。

## 纪律（对齐官方 coordinator，违反就失去了编排的意义）
- **你自己不写代码、不改文件、不跑长命令。** 想动手时，改成 spawn 一个 worker 去做。
  你只做：拆解 → 派活 → 读结果 → 交叉验证 → 汇总。允许的例外：为了拆解任务而做的
  少量只读侦察（看目录结构、确认文件是否存在），不要发展成自己把活干完。
- **并发预算 24 个**（全局共享，你派生的下级也算；改这个数字时同步 MAX_CONCURRENT_SUBAGENTS）。
  超限时 Agent 工具返回 rejected:"concurrency_limit"，那不是错误：等一批完成再派下一批，
  或缩减本层扇出。别因此放弃任务。
- **worker 交回的结论要抽查，不要照抄。** 它可能漏看一行就报"没有校验"。
  凡是涉及"有没有 / 是不是"的断言，自己 Read 关键位置核一眼再写进汇总。
- **要返工找原 worker，不要重新 spawn。** 用 SendMessage(to:"<agent_name>", wake:true, text:"...")
  唤醒它继续干——它保留原有上下文，记得自己做过什么，不用重讲背景。
  所以 spawn 时就给每个 worker 起好 agent_name。
- **派错方向就 AgentStop 掉**，别干等它跑完白烧 token、白占名额。
  中止后若当初给了 agent_name，仍可 wake 唤醒它带着上下文重来。

## 并行的正确姿势（真正的约束是资源冲突，不是数量）
并行是你最大的优势，能同时跑的别串行化，主动找扇出机会。但要按**冲突**分组，不是按个数：
- **只读任务（调研/勘察/搜索/读代码）** → 放开并行，几个都行，它们互不干扰
- **写文件的任务** → 按**文件集合**分组：同一批文件同时只能有一个 worker 在改，
  否则两边各自 Read 到旧内容、各自写回，后写的直接覆盖前面的改动（这类冲突不会报错，
  只会静默丢失工作，最难查）。不同目录/不同文件集可以并行
- **验证/测试** → 可以和实现并行，前提是碰的文件区域不重叠；
  要验证的正是别人在改的文件，就必须等它交回再验
- 派活前先想清楚每个 worker 会碰哪些文件，把这个写进它的 prompt（明确告诉它"只准改 X，别碰 Y"）`
  }
}

/**
 * 同时在跑的子 Agent 上限。
 *
 * 【为什么还留着闸门】官方 coordinator 没有数字上限，它只做语义约束
 * （只读自由并行、写操作按文件集合串行）。因为它跑桌面端、直连自家 API。
 * 我们跑在手机上：即使中转站不限并发，本机仍有内存、发热、Node 单进程
 * 事件循环这几道天花板，而且子 Agent 能递归 spawn（一层扇出 3 个、三层就 27 个），
 * 失控后很难收回。所以保留闸门，但数值按"中转站不限并发"放宽。
 *
 * 24 的依据：单个子 Agent 常驻开销主要是 messages 数组 + 一路流式缓冲，
 * 手机上 20 来个并发仍可控；真正的资源冲突交给语义约束（见 Coordinator 提示词）。
 * 超限时不抛错，而是返回说明给模型，让它自己选择等待/串行/缩减扇出 ——
 * 报错会让子 Agent 误判成"这条路走不通"直接放弃整个任务。
 */
export const MAX_CONCURRENT_SUBAGENTS = 24
let runningSubagents = 0

export function getRunningSubagents() { return runningSubagents }

/**
 * 已跑完的子 Agent 实例表，key = agent 名（input.agent_name 或 description）。
 *
 * 【为什么要留着】原来 sub 是 runAndCollect 里的局部变量，execute 返回就被丢掉，
 * 子 Agent 是纯一次性的：想让它"接着上次继续"只能重新 spawn 并把背景信息
 * 手工塞进 prompt —— 上下文没了、它也不记得自己之前说过什么。
 * 官方 coordinator 的 SendMessage 是能唤醒一个已结束 worker 并复用其上下文的，
 * 这里存下实例就是为了对齐这点（见 resumeSubagent）。
 *
 * 只存最近 MAX_KEPT 个，防止长会话里无限堆积 messages 吃内存。
 */
const keptAgents = new Map()   // name -> { agent, type, lastRunAt, turns }
const MAX_KEPT_AGENTS = 12

function keepAgent(name, agent, type) {
  if (!name) return
  keptAgents.delete(name)      // 重新插入以刷新 LRU 顺序
  keptAgents.set(name, { agent, type, lastRunAt: Date.now() })
  while (keptAgents.size > MAX_KEPT_AGENTS) {
    const oldest = keptAgents.keys().next().value
    keptAgents.delete(oldest)
  }
}

export function listKeptAgents() {
  return [...keptAgents.entries()].map(([name, v]) => ({
    name, type: v.type, lastRunAt: v.lastRunAt,
    messages: v.agent?.messages?.length || 0,
  }))
}

export function getKeptAgent(name) { return keptAgents.get(name) || null }

/**
 * 唤醒一个已跑完的子 Agent，把 text 作为新的 user 消息喂进它原有上下文继续跑。
 * 返回 null 表示没有这个 agent（调用方应提示可用名单）。
 */
export async function resumeSubagent(name, text, { signal = null, maxTurns = null, background = false } = {}) {
  const entry = keptAgents.get(name)
  if (!entry) return null
  if (runningSubagents >= MAX_CONCURRENT_SUBAGENTS) {
    return {
      ok: false, rejected: 'concurrency_limit',
      running: runningSubagents, limit: MAX_CONCURRENT_SUBAGENTS,
      message: `并发已满（${runningSubagents}/${MAX_CONCURRENT_SUBAGENTS}），本次未唤醒 ${name}。`,
      hint: '等已有子 Agent 完成后重试，或改成串行。这不是错误。',
    }
  }
  const { agent } = entry

  // ★ 目标**正在跑** → 不重开 run（2026-09-28 修「wake 出现两个一样的」）。
  //   keptAgents 是 spawn 时就写入的，运行中的实例也在里面；
  //   原来 wake 它会对同一实例再 start 一个 run —— AgentStatus 里出现
  //   两个 task、turnCount 互相覆盖，而实际只有一个实例在跑（用户原话：
  //   「多一个一样的出来，但实际还是一个」）。
  //   正确做法：把指令当 mid-turn steering 注入当前这轮，
  //   下一轮模型调用前生效，不打断正在跑的工具批次。
  if (agent && agent.isRunning && typeof agent.pushSteering === 'function') {
    agent.pushSteering(text)
    return {
      ok: true, name, steering: true,
      message: `${name} 正在执行中 —— 指令已作为 mid-turn steering 注入，下一轮模型调用前生效。没有重复启动。`,
    }
  }

  // 【后台续跑 —— 2026-09-27 新增】
  //
  // 原来只有同步模式（await 到底）。问题是子 Agent 动辄跑几分钟，
  // 而 SendMessage 这个工具调用有 60s 超时 —— 于是必然超时返回。
  // 更糟的是：超时后它**还在后台跑**（promise 已经发出去了），
  // 但调用方拿不到结果、也拿不到 task_id，无法查询进度，
  // 只能靠翻 trace 文件猜它是不是还活着。实际体验就是"不知道它跑没跑"。
  //
  // 后台模式直接复用 BgTask 那套基础设施（和 Agent(run_in_background:true) 一致）：
  // 立刻返回 task_id，之后用 AgentStatus / AgentOutput 查。
  if (background) {
    const task = registerBackgroundTask('local_agent', `续跑 ${name}`)
    task.start()
    task.abortController = new AbortController()
    task.agentType = entry.type
    task.agentName = name
    task.isResume = true
    // 持有实例：AgentStatus 据此读实时 turnCount / messages 长度。
    // 不设的话 running 期间 turns 恒为 0，看起来像卡死（实际在正常干活）。
    task.agent = agent

    runningSubagents++
    const startTime = Date.now()
    ;(async () => {
      try {
        if (maxTurns) agent.maxTurns = maxTurns
        const result = await agent.run(text, { signal: task.abortController.signal })
        entry.lastRunAt = Date.now()
        if (!task.isTerminal()) {
          task.appendOutput(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
          task.complete(result)
        }
      } catch (e) {
        if (!task.isTerminal()) {
          task.appendOutput(`ERROR: ${e?.stack || e?.message || String(e)}`)
          task.fail(e?.message || String(e))
        }
      } finally {
        runningSubagents = Math.max(0, runningSubagents - 1)
      }
    })()

    return {
      ok: true, resumed: true, background: true, name, type: entry.type,
      task_id: task.taskId,
      duration_ms: Date.now() - startTime,
    }
  }

  runningSubagents++
  const startTime = Date.now()
  try {
    if (maxTurns) agent.maxTurns = maxTurns
    const result = await agent.run(text, { signal })
    entry.lastRunAt = Date.now()
    return {
      ok: true, resumed: true, name, type: entry.type,
      result,
      duration_ms: Date.now() - startTime,
      total_messages: agent.messages?.length || 0,
    }
  } catch (e) {
    return { ok: false, resumed: true, name, error: e?.message || String(e) }
  } finally {
    runningSubagents = Math.max(0, runningSubagents - 1)
  }
}

export class SubAgentTool extends Tool {
  constructor({ api, visionApi = null, systemPromptBase, tools, onPermissionRequest, getSubagentTypes, cwd = null, sessionId = null }) {
    super({
      name: 'Agent',
      description: '创建一个子 agent 独立完成任务。子 agent 有独立的上下文窗口，适合处理需要多步骤的独立子任务（避免污染主对话上下文）。',
      input_schema: {
        type: 'object',
        properties: {
          subagent_type: {
            type: 'string',
            description: '子 agent 类型。内置：general-purpose（全工具，独立完成复杂任务）/ Explore（只读，调研代码库）/ Plan（只读+TodoWrite，制定执行计划）/ Coordinator（编排多个 worker 并行）。也可填 .claude/agents 自定义名（见系统提示词）。默认 general-purpose。'
          },
          description: {
            type: 'string',
            description: '对任务的简短描述（3-5 个词），仅做标识用，不影响执行。'
          },
          agent_name: {
            type: 'string',
            description: '给这个子 agent 起个名字（如 worker-1 / reviewer）。之后可用 SendMessage(to:该名字) 唤醒它继续干活，复用它原有的上下文——它还记得自己之前做过什么，不需要你把背景重新讲一遍。省略则用 description 当名字。'
          },
          prompt: {
            type: 'string',
            description: '给子 agent 的完整任务指令。应该是一个自包含的 prompt，子 agent 会以此作为首轮 user message。'
          },
          run_in_background: {
            type: 'boolean',
            description: '是否在后台运行。true=立即返回 placeholder，主 agent 可继续做别的事；false=同步等待结果。默认 false。',
            default: false
          }
        },
        required: ['prompt']
      }
    })
    this.api = api
    this.visionApi = visionApi
    this.systemPromptBase = systemPromptBase
    // tools 可以是数组，也可以是返回数组的函数（惰性）。
    // 必须支持惰性：调用方在 registry 里注册 SubAgentTool 本身之前就要把
    // tools 传进来，若此时取数组快照，快照里就永远没有 'Agent' 自己
    // → 子 Agent 拿不到 Agent 工具，无法再往下 spawn（实测报 Tool not found）。
    this._tools = tools
    this.onPermissionRequest = onPermissionRequest || (async () => true)
    this.getSubagentTypes = getSubagentTypes || (() => BUILTIN_SUBAGENT_TYPES)
    this.cwd = cwd || null
    this.sessionId = sessionId || null
  }

  /** 取当前工具集（惰性时每次求值，才能拿到后注册的 Agent 工具） */
  get tools() {
    return typeof this._tools === 'function' ? (this._tools() || []) : (this._tools || [])
  }

  async execute(input) {
    // 【并发闸门】放在最前面：占额之前不做任何有副作用的事（如 keyPool.advance）
    if (runningSubagents >= MAX_CONCURRENT_SUBAGENTS) {
      return JSON.stringify({
        ok: false,
        rejected: 'concurrency_limit',
        running: runningSubagents,
        limit: MAX_CONCURRENT_SUBAGENTS,
        message: `当前已有 ${runningSubagents} 个子 Agent 在运行，达到并发上限 ${MAX_CONCURRENT_SUBAGENTS}，本次未启动。`,
        hint: '这不是错误、任务也没失败。请任选一种做法：(1) 先用 AgentStatus 等已有子 Agent 完成，再重试这次调用；(2) 把打算并行的子任务改成串行、一个个来；(3) 缩减这一层的扇出数量，或自己直接做掉其中一部分。不要因此放弃整个任务。',
      }, null, 2)
    }

    const { Agent } = await import('./agent.mjs')
    const types = this.getSubagentTypes()
    const type = types[input.subagent_type] ? input.subagent_type : 'general-purpose'
    const cfg = types[type] || BUILTIN_SUBAGENT_TYPES['general-purpose']

    let subTools
    if (cfg.toolNames === null) {
      const DISABLED_FOR_SUBAGENT = ['AskUserQuestion']
      subTools = this.tools.filter(t => !DISABLED_FOR_SUBAGENT.includes(t.name))
    } else {
      subTools = this.tools.filter(t => cfg.toolNames.includes(t.name))
    }

    // AgentMemory 要按「子 Agent 自己的类型」读写，不能沿用主 Agent 的 type=main，
    // 否则所有子 Agent 的经验会混进同一个文件、失去按角色积累的意义。
    try {
      const idx = subTools.findIndex(t => t.name === 'AgentMemory')
      if (idx >= 0) {
        const { AgentMemoryTool } = await import('../tools/tools-agent-memory.mjs')
        subTools = [...subTools]
        subTools[idx] = new AgentMemoryTool({
          getAgentType: () => type,
          cwd: this.cwd || process.cwd(),
        })
      }
    } catch {}

    // 【自动注入同类 Agent 的长期记忆】
    // 不能指望子 Agent 自己想着去 read —— 它开局就该带着前人的经验，
    // 否则同一个 code-reviewer 第十次跑仍然不记得前九次踩过什么坑。
    // 只读一次、有上限（readMemory 内部裁到 6000 字符，取最近的部分）。
    let memoryBlock = ''
    try {
      const { readMemory } = await import('./agent-memory.mjs')
      const mem = readMemory({ type, cwd: this.cwd || process.cwd() })
      if (mem) {
        memoryBlock = `\n\n## 你这类 Agent 的长期记忆\n`
          + `（同类 Agent 历次积累，已自动读入，不必再调 AgentMemory read）\n\n${mem}\n`
          + `\n做完这次任务后，如果有值得留给"未来的自己"的经验，用 AgentMemory({action:"write"}) 记一条。\n`
      }
    } catch {}

    // 【ExtendTurns 必须写进可用工具清单】它是运行时注入的（不在角色卡 tools: 白名单里），
    // 如果这里不提，子 Agent 根本不知道自己能续轮 —— 撞上限时只会交半成品。
    const toolListText = cfg.toolNames === null
      ? '(全部)'
      : [...cfg.toolNames, 'ExtendTurns'].join(', ')
    const subSystemPrompt = this.systemPromptBase + '\n' + cfg.promptAddition +
      `\n\n## 当前子 Agent 类型：${type}\n可用工具：${toolListText}\n`
      + `\n## 轮次预算\n你的工具轮次上限是 ${cfg.maxTurns} 轮。快到上限时会收到系统提示，届时：\n`
      + `任务确实没做完 → 用 **ExtendTurns** 续轮（最多续 4 次、每次最多 +60、硬上限 400）；\n`
      + `已基本完成或发现自己在原地打转 → 立刻收尾，如实交代未完成部分。\n`
      + `**不要交「函数写好了但没接线」这类半成品**：要么做完并自测通过，要么在报告和 TaskUpdate 的 comment 里\n`
      + `写清「未完成的是什么、下一步该怎么做、有哪些已查明的前置结论」，让续做者能直接接手。\n`
      + memoryBlock

    const startTime = Date.now()

    // 子 agent 之间的 key 轮换：共享同一个 KeyPool 的前提下，
    // 每起一个子 agent 就把池指针前进一步，让并行子 agent 落在
    // 不同账号的 key 上——11 个号并行 4 个 agent 只占 4 个号，
    // 不再出现「全部挤同一个账号，429 连环触发」的拥挤。
    // 主 agent 接下来发请求时从池子当前位置取，也是错开的。
    // 单 key 池（size<2）则不 advance，key 转不动。
    try {
      if (this.api?.keyPool && this.api.keyPool.size >= 2) {
        this.api.keyPool.advance()
      }
    } catch {}

    // 计数在 runAndCollect 内增减：后台与同步两条路径都经过它，
    // 且 finally 保证异常/取消时一定归还名额（否则跑几次就永久占满 9 个）
    // onAgentReady：把刚建好的 agent 实例交给调用方（后台分支用它读实时 turnCount）。
    // 不这么做的话 sub 只是局部变量，AgentStatus 只能读 result.turns —— 而 result
    // 要等跑完才有，running 期间 turns 恒为 0，看起来像卡死（实际在正常干活）。
    const runAndCollect = async (signal = null, onAgentReady = null) => {
      runningSubagents++
      try {
        let sub = null
        // 【给子 Agent 自主续轮的能力】它不能用 EnterDeepMode（那是主进程全局单例，
        // 对自己无效）。ExtendTurns 直接改 sub.maxTurns，getAgent 用闭包拿当前实例。
        // 必须在 new Agent 之前把工具接好：工具列表是构造参数，事后动不了。
        const extendTool = new ExtendTurnsTool({ getAgent: () => sub })
        const toolsWithExtend = [...subTools, extendTool]
        sub = new Agent({
          api: this.api,
          visionApi: this.visionApi,
          systemPrompt: subSystemPrompt,
          tools: toolsWithExtend,
          maxTurns: cfg.maxTurns,
          onPermissionRequest: this.onPermissionRequest,
          cwd: this.cwd,
          sessionId: this.sessionId,
        })
        // 子 agent 接近上限的提示：告知两条路（续轮 / 收尾）并要求它自己判断。
        // 原来只说「立即收尾」，于是真的没做完也只能交半成品（实测：CPO 60 轮用尽，
        // 四件事只完成两件的逻辑且未接线）。现在让它分清「真的需要更多轮」和
        // 「在原地打转」，前者续、后者收 —— 判断线索写具体（空转的典型形态）。
        sub.onTurnLimitApproaching = (turns, max) => {
          sub.messages.push({
            role: 'user',
            hidden: true,
            content: `（系统提示：本子任务已执行 ${turns} 轮，距上限 ${max} 只剩不到 10 轮。`
              + `先自查最近几轮是不是在**空转**：反复调用同一个工具却拿不到新信息、同一处改了又改、同一个错误反复出现而没有实质推进。`
              + `① 不是空转、任务确实还需要更多轮 —— 用 ExtendTurns 工具给自己续轮（写明已完成什么、还剩什么、预计几轮收尾），然后继续干，不要草草收尾；`
              + `② 是空转（或已基本完成）—— 立即收尾，把已完成和未完成的部分如实写进最终报告，不要无声中断。`
              + `禁止为了看起来「完成了」而交未接线/未验证的半成品。）`,
          })
        }
        // 留下实例供后续 SendMessage 唤醒续跑（复用上下文）。
        // 放在 run 之前登记：万一中途报错，之后也能唤醒它问"你卡在哪了"。
        keepAgent(input.agent_name || input.description, sub, type)
        try { onAgentReady?.(sub) } catch {}
        try {
          const result = await sub.run(input.prompt, { signal })
          const duration = Date.now() - startTime
          const tokenUsage = sub.getTokenUsage()
          return {
            ok: true,
            type,
            description: input.description || input.prompt.slice(0, 60),
            result: result || '(no output)',
            duration_ms: duration,
            duration_human: duration < 1000 ? `${duration}ms` : `${(duration / 1000).toFixed(1)}s`,
            token_usage: tokenUsage,
            turns: sub.turnCount
          }
        } catch (e) {
          const duration = Date.now() - startTime
          return {
            ok: false,
            type,
            description: input.description || input.prompt.slice(0, 60),
            error: e.message,
            duration_ms: duration,
            duration_human: duration < 1000 ? `${duration}ms` : `${(duration / 1000).toFixed(1)}s`,
            turns: 0
          }
        }
      } finally {
        runningSubagents = Math.max(0, runningSubagents - 1)
      }
    }

    if (input.run_in_background) {
      const task = registerBackgroundTask('local_agent', input.description || input.prompt.slice(0, 60))
      task.start()
      task.abortController = new AbortController()
      task.agentType = type
      task.agentName = input.agent_name || input.description || null
      // 持有实例：AgentStatus 据此读实时 turnCount / messages 长度
      const promise = runAndCollect(task.abortController.signal, (sub) => { task.agent = sub })
      promise.then(result => {
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
      return JSON.stringify({
        task_id: task.taskId,
        status: 'running',
        message: `子 agent [${type}] 已在后台启动，描述：${input.description || '(未命名)'}\n用 /bg-status ${task.taskId} 查看状态`
      })
    }

    const out = await runAndCollect()
    return JSON.stringify(out, null, 2)
  }
}

// 转发任务集合变化钩子（index.mjs 用来刷新活动面板）
export function setOnTasksChanged(fn) { return _setOnTasksChanged(fn) }
