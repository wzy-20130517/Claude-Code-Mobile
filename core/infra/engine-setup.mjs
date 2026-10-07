/**
 * CLI / Web 共用：工具注册 + 系统提示拼装
 * Web 壳必须走这里，避免和 CLI 两套行为。
 */
import { ToolRegistry } from '../tools/tools.mjs'
import { FileReadTool, FileWriteTool, FileEditTool, MultiEditTool } from '../tools/file-tools.mjs'
import { GlobTool, GrepTool, CodeSearchTool } from '../tools/search-tools.mjs'
import { PTYBashTool } from './pty.mjs'
import { BashOutputTool, KillShellTool } from '../agent/bg-bash.mjs'
import { TodoWriteTool, WebFetchTool, AskUserSimpleTool } from '../tools/extra-tools.mjs'
import { GitStatusTool, GitDiffTool, GitLogTool, GitCommitTool, GitAddTool } from './git.mjs'
import { MultiUndoStore } from '../session/undo-multi.mjs'
import { SkillLoader, SkillTool, ensureGlobalSkillsDir, globalSkillsDir } from '../commands/skills.mjs'
import {
  PlanMode, EnterPlanModeTool, ExitPlanModeTool, CoordinatorMode,
  DeepMode, EnterDeepModeTool, ExitDeepModeTool, SubAgentTool, BUILTIN_SUBAGENT_TYPES,
} from '../agent/plan.mjs'
import { MemoryTool, UserInputHistoryTool, InputHistory } from '../agent/agent-tools.mjs'
import { TavilySearchTool } from '../tools/tavily.mjs'
import { termuxTools } from '../phone/termux-tools.mjs'
import { LspTool } from '../tools/lsp.mjs'
import { HashlineReadTool, HashlineEditTool, HashlineGrepTool } from '../tools/tools-hashline.mjs'
import { ApplyPatchTool, TestTool, DiagnosticsTool, RepoMapTool, SymbolsTool, SafeRenameTool, SleepTool } from '../tools/tools-smart.mjs'
import { ViewImageTool, ViewVideoTool, ScreencapTool } from '../tools/tools-vision.mjs'
import { ImageGenTool } from '../tools/tools-imagegen.mjs'
import { PresentTool } from '../tools/present-tool.mjs'
// 【Web 与 CLI 工具对齐】这五组工具以前只在 index.mjs（CLI 路径）注册，
// web/ 走的 engine-setup 一条都没有 —— 于是 Web 里 AI 看不到目标契约、
// 建不了任务/团队、连不了 GitHub、定不了定时任务。统一在 toolkit 里注册。
import { createGoalTools } from '../tools/tools-goal.mjs'
import { TASK_TOOLS } from '../tools/tools-tasks.mjs'
import { TEAM_TOOLS } from '../tools/tools-teams.mjs'
import { GITHUB_TOOLS } from '../tools/tools-github.mjs'
import { CronCreateTool, CronListTool, CronDeleteTool } from '../tools/tools-cron.mjs'
import { PHONE_TOOLS } from '../tools/tools-phone.mjs'
// 图库检索 + 多源资料搜索（2026-09-19 补）：
// 这四个原来只在 index.mjs（CLI）注册，engine-setup 连 import 都没有 ——
// 于是 Web 端 AI 用不了找图/识图/搜资料/展开全文。而 Web 还实现了 /pexels
// 命令去配 Pexels key，配了却没工具用（用户会以为坏了）。
import { FindImageTool, ReverseImageTool } from '../tools/tools-image-search.mjs'
import { SearchInfoTool, LookupTool } from '../tools/tools-lookup.mjs'
// 子 Agent 管控（2026-09-19 补）：Web 早就能 spawn 子 Agent（Agent 工具在），
// 但拿不到状态/中止/输出/记忆 —— 长任务一旦派出去就失去控制，只能干等或杀掉整个服务。
import { AgentStatusTool, AgentStopTool, AgentOutputTool } from '../tools/tools-agent-status.mjs'
import { AgentMemoryTool } from '../tools/tools-agent-memory.mjs'
import { ClaudeMdLoader } from '../session/persistence.mjs'
import { AgentWorkflowTool } from '../agent/agent-workflow.mjs'
import { SYSTEM_PROMPT, SESSION_START_PROMPT, envPaths } from './prompts.mjs'
import { CustomCommandLoader, ensureCommandsDir } from '../commands/custom-commands.mjs'
import { CustomAgentLoader, ensureAgentsDir } from '../agent/custom-agents.mjs'
import { registerBuiltinPlugin } from '../integrations/plugins.mjs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * @param {object} opts
 * @param {function} [opts.askUser]  Web 可传占位；CLI 传真 askUser
 * @param {string} [opts.skillsDir]
 * @param {string} [opts.cwd]
 * @param {boolean} [opts.includeUserHistory=true]
 * @param {boolean} [opts.includeSubAgent=true]
 * @param {object} [opts.api]  SubAgent 需要
 * @param {function} [opts.onPermissionRequest]  根 Agent 与 SubAgent 共用权限裁决
 * @param {string} [opts.undoRoot]  可选独立 Undo 存储目录
 * @param {function|object} [opts.getRuntimeModelInfo] 当前 Provider/model/protocol（函数可动态刷新）
 */
export function createEngineToolkit(opts = {}) {
  const cwd = opts.cwd || process.cwd()
  const skillsDir = opts.skillsDir || join(cwd, 'skills')
  // 全局 skills：与 commands/agents 一样挂在 ~/.claude/skills；项目目录优先
  const globalSkills = opts.globalSkillsDir || globalSkillsDir()
  try { ensureGlobalSkillsDir() } catch {}
  const askUser = opts.askUser || (async (q) => `(no UI) ${q}`)
  const baseSystemPrompt = opts.systemPromptBase || SYSTEM_PROMPT
  const sessionStartPrompt = opts.sessionStartPrompt || SESSION_START_PROMPT
  const contextFiles = opts.contextFiles === false
    ? []
    : (Array.isArray(opts.contextFiles) ? opts.contextFiles : ClaudeMdLoader.load(cwd))

  const multiUndo = new MultiUndoStore(opts.undoRoot)
  multiUndo.init()
  const inputHistory = new InputHistory(100, opts.historyFile, opts.sessionsDir)
  const planMode = new PlanMode()
  const deepMode = new DeepMode()
  // 协调者模式（对齐官方 Coordinator Mode）—— 见 core/plan.mjs 的 CoordinatorMode 注释
  const coordinatorMode = new CoordinatorMode()
  // 当前活跃 Agent 实例。调用方创建 Agent 后调 toolkit.attachAgent(agent) 接上，
  // 这样模式切换工具能立刻改到「正在跑的那一个」的 maxTurns（而不是只翻标志位）。
  let liveAgent = null
  const skillLoader = new SkillLoader(
    opts.skillsDirs || [skillsDir, globalSkills].filter(Boolean)
  )
  const commandRoots = opts.commandsDirs || [ensureCommandsDir(cwd), join(homedir(), '.claude', 'commands')]
  const agentRoots = opts.agentsDirs || [ensureAgentsDir(cwd), join(homedir(), '.claude', 'agents')]
  const customCommands = new CustomCommandLoader(commandRoots)
  const customAgents = new CustomAgentLoader(agentRoots)

  // 注册内置插件（示例：keepalive 提供保活状态命令）
  registerBuiltinPlugin({
    name: 'keepalive',
    description: '保活状态：显示 termux-wake-lock / 静音音频循环是否在运行',
    defaultEnabled: true,
  })

  const registry = new ToolRegistry()
  registry.register(new FileReadTool())
  registry.register(new FileWriteTool(multiUndo))
  registry.register(new FileEditTool(multiUndo))
  registry.register(new MultiEditTool(multiUndo))
  registry.register(new PTYBashTool())
  registry.register(new BashOutputTool())
  registry.register(new KillShellTool())
  registry.register(new GlobTool())
  registry.register(new GrepTool())
  registry.register(new CodeSearchTool())
  registry.register(new TodoWriteTool())
  registry.register(new WebFetchTool())
  registry.register(new AskUserSimpleTool(askUser))
  registry.register(new GitStatusTool())
  registry.register(new GitDiffTool())
  registry.register(new GitLogTool())
  registry.register(new GitAddTool())
  registry.register(new GitCommitTool())
  registry.register(new SkillTool(skillLoader))
  if (opts.includeUserHistory !== false) {
    registry.register(new UserInputHistoryTool(inputHistory))
  }
  registry.register(new MemoryTool(opts.memoryPath || null, opts.memoryLabel || 'CLAUDE.md'))
  registry.register(new TavilySearchTool())
  registry.register(new LspTool())
  registry.register(new HashlineReadTool())
  registry.register(new HashlineEditTool(multiUndo))
  registry.register(new HashlineGrepTool())
  registry.register(new ApplyPatchTool(multiUndo))
  registry.register(new TestTool())
  registry.register(new DiagnosticsTool())
  registry.register(new RepoMapTool())
  registry.register(new SymbolsTool())
  registry.register(new SafeRenameTool(multiUndo))
  registry.register(new SleepTool())
  registry.register(new ViewImageTool())
  registry.register(new ViewVideoTool())
  if (opts.includeScreencap !== false) registry.register(new ScreencapTool())
  registry.register(new ImageGenTool({ onPresent: opts.onPresent }))
  // Present：Web 在 extraTools 里传了带 onPresent 的实例（防重复注册）；
  // 没传的宿主注册一个降级版（execute 返回文字提示，不报错）。
  if (!(opts.extraTools || []).some(t => t && t.name === 'Present')) {
    registry.register(new PresentTool({ cwd: opts.cwd || process.cwd(), onPresent: opts.onPresent || null }))
  }
  if (opts.includeTermuxTools !== false) for (const t of termuxTools) registry.register(t)
  // 目标契约（跨轮自动推进的三件套：读契约 / 改状态 / 加预算）
  for (const t of createGoalTools(() => opts.sessionId || null)) registry.register(t)
  // 持久化待办（多 Agent 共享，跨重启存活）
  for (const t of TASK_TOOLS) registry.register(t)
  // 团队协作 + 定时任务 + GitHub
  for (const t of TEAM_TOOLS) registry.register(t)
  for (const T of GITHUB_TOOLS) registry.register(new T())
  // 图库检索与资料搜索：FindImage(以文找图) / ReverseImage(以图识图) /
  // SearchInfo(多源资料搜索) / Lookup(展开全文)。与 CLI index.mjs:915-919 对齐。
  // 子 Agent 管控：查状态 / 中止 / 取输出 / 读写长期记忆。
  // getAgentType 返回 'main' —— Web 侧的调用者就是主 Agent（与 index.mjs:1193 一致）。
  registry.register(new AgentStatusTool())
  registry.register(new AgentStopTool())
  registry.register(new AgentOutputTool())
  registry.register(new AgentMemoryTool({ getAgentType: () => 'main' }))
  registry.register(new FindImageTool())
  registry.register(new ReverseImageTool())
  registry.register(new SearchInfoTool())
  registry.register(new LookupTool())
  registry.register(new CronCreateTool())
  registry.register(new CronListTool())
  registry.register(new CronDeleteTool())
  // 手机控制工具（Termux:API）：看屏/点屏/输入/滑动/按键/播报等 10 个。
  //
  // 【2026-09-19】原注释写「Web 默认也开，除非显式关掉」，但实现是 `=== true` 才注册
  // —— 注释与代码矛盾，而 Web 的 createEngineToolkit 调用（web/server.mjs:1679）
  // 根本没传这个参数，导致**整个 Web 端这 10 个工具全缺**。
  // CLI 不受影响：它在 index.mjs:911 自己无条件注册。
  // 现在 Web 已显式传 true；语义保持「显式开启」，避免无意间给 AI 本机控制权。
  if (opts.includePhoneTools === true) for (const T of PHONE_TOOLS) registry.register(new T())
  for (const t of (opts.extraTools || [])) registry.register(t)
  registry.register(new EnterPlanModeTool(() => planMode.enable()))
  registry.register(new ExitPlanModeTool(() => planMode.disable()))
  // 【和 index.mjs 同样的坑，这里原来漏了】只翻 deepMode 标志的话，**正在跑的那个
  // Agent 实例**的 maxTurns 还是旧值 —— 模型自己调 EnterDeepMode 后照样在原地被截停，
  // 它却以为续上了。CLI 侧 2026-09-17 修过同样的 bug（index.mjs:935），
  // Web / 其他 toolkit 使用者走的是本文件这条路径，必须一起同步。
  registry.register(new EnterDeepModeTool(() => {
    deepMode.enable()
    if (liveAgent) liveAgent.maxTurns = deepMode.getMaxTurns()
  }))
  registry.register(new ExitDeepModeTool(() => {
    deepMode.disable()
    if (liveAgent) liveAgent.maxTurns = deepMode.getMaxTurns()
  }))

  let subAgentTool = null
  if (opts.includeSubAgent !== false) {
    // 同 index.mjs：传函数而非快照，否则子 Agent 工具集里没有 'Agent' 自己，
    // 无法递归 spawn（SubAgentTool 在下面第 138 行才注册进 registry）
    subAgentTool = new SubAgentTool({
      api: opts.api || null,
      systemPromptBase: '',
      tools: () => registry.list(),
      onPermissionRequest: opts.onPermissionRequest || (async () => true),
      getSubagentTypes: () => customAgents.mergeInto(BUILTIN_SUBAGENT_TYPES),
      cwd,
      sessionId: opts.sessionId || null,
    })
    registry.register(subAgentTool)

    // 与 index.mjs 对齐：context: fork 的 skill 借 Agent 工具隔离执行。
    // SkillTool 注册得比 Agent 早，所以延迟到这里绑定。
    const skillToolRef = registry.get('Skill')
    if (skillToolRef) {
      skillToolRef.forkRunner = async ({ name, prompt, agent, model, effort, allowedTools }) => {
        const constraints = []
        if (model) constraints.push(`本次请使用模型 ${model}`)
        if (effort) constraints.push(`思考强度设为 ${effort}`)
        if (allowedTools && allowedTools.length) constraints.push(`只允许使用这些工具：${allowedTools.join(', ')}`)
        const finalPrompt = constraints.length
          ? `（执行约束：${constraints.join('；')}）\n\n${prompt}`
          : prompt
        const r = await subAgentTool.execute({
          description: `skill:${name}`,
          prompt: finalPrompt,
          subagent_type: agent || 'general-purpose',
        })
        return typeof r === 'string' ? r : JSON.stringify(r)
      }
    }

    registry.register(new AgentWorkflowTool({
      api: opts.api || null,
      systemPrompt: () => getSystemPrompt(),
      tools: registry.list().filter(t => t.name !== 'Agent' && t.name !== 'AgentWorkflow'),
      onPermissionRequest: opts.onPermissionRequest || (async () => true),
      cwd,
      sessionId: opts.sessionId || null,
    }))
  }

  function getRuntimeModelInfo() {
    const raw = typeof opts.getRuntimeModelInfo === 'function'
      ? opts.getRuntimeModelInfo()
      : (opts.getRuntimeModelInfo || {})
    const api = raw.api || opts.api || {}
    return {
      providerId: raw.providerId ?? raw.current ?? '(unknown)',
      providerName: raw.providerName ?? raw.name ?? '(未命名)',
      model: raw.model ?? api.model ?? '(unknown)',
      protocol: raw.protocol ?? api.protocol ?? 'openai',
    }
  }

  function formatRuntimeModelInfo() {
    const info = getRuntimeModelInfo()
    return `\n# 当前底层模型配置（运行时动态捕捉）\nProvider ID: ${info.providerId}\nProvider 名称: ${info.providerName}\nModel: ${info.model}\nProtocol: ${info.protocol}\n注意：这是当前 API 请求配置，不是 Agent 身份；回答“当前用什么模型”时以此为准。\n`
  }
  /**
   * 把提示词里的 {{占位符}} 替换成实际值。
   *
   * 【为什么需要】
   * 提示词模板里有 {{WORKSPACE}} {{HOME}} 这类占位符，
   * 但它们从来没被替换过 —— 模型看到的就是字面的 "{{WORKSPACE}}"。
   * 而且 Termux / CCM 两种环境的路径约定不同，必须动态填。
   */
  function interpolatePrompt(text) {
    const p = envPaths()
    const envNote = p.env === 'ccm'
      ? `你运行在 **CCM 原生外壳**里（App 内嵌的 proot Ubuntu），不是 Termux。\n` +
        `- 外部存储：\`${p.external}\`（App 专属目录）${p.sdcardNote}\n` +
        `- ${p.phoneNote}\n` +
        `- 用户的 \`/sdcard\` 只有在 App 里授权后才可见。`
      : `你运行在 **Termux** 里。\n` +
        `- 家目录：\`${p.home}\`\n` +
        `- 外部存储：\`${p.external}\`\n` +
        `- ${p.phoneNote}`
    const envLabel = p.env === 'ccm' ? 'CCM 原生外壳（proot Ubuntu）' : 'Termux 环境'

    // ⚠️ 只替换**白名单**里的占位符，不要用正则扫全部 {{...}}。
    //
    // 【为什么】提示词里还有别的 {{}} 用法：
    //   · Present 工具说明里的 {{speed}} —— 那是给用户看的语法示例，
    //     前端渲染时会替换，服务端**绝不能碰**
    //   · sessionStartPrompt 里的 {{DATE}} {{CWD}} —— 由调用方单独处理
    // 用白名单能保证不误伤。
    // 【平台相关的工具清单】
    //
    // prompts.mjs 是**单份通用提示词**，但有些工具只在特定环境存在：
    //   · playwright 的 browser_* —— 需要 X11 + Chromium。
    //     Termux 里通过 MCP 提供；CCM（APK）的 mcp.json 里没配它
    //     （注释写明「依赖 X11/Chromium，在 CCM 里不适用」）。
    //
    // 不裁剪的后果：AI 看到提示词里列了 browser_navigate，会以为能用，
    // 尝试调用 → 报「工具不存在」→ 用户困惑「不是说支持吗」。
    // 这类错误很隐蔽：模型会归因成自己用错了参数，反复重试。
    const browserTools = p.env === 'ccm'
      ? `### 浏览器自动化工具
本环境（CCM 原生外壳）**没有** playwright 的 browser_* 工具 —— 它们依赖 X11 + Chromium，
而 proot Ubuntu 里跑不了。需要看网页时用 \`WebFetch\` 工具（抓取内容），
需要真实浏览器交互则要先切到 Termux 环境。
（提示词里不再列具体工具名，免得模型以为能调）`
      : `### 浏览器自动化工具（playwright）
- browser_navigate, browser_click, browser_type, browser_snapshot, browser_evaluate
- browser_network_requests, browser_network_request, browser_console_messages
- browser_navigate_back, browser_fill_form, browser_select_option, browser_drag, browser_hover`

    const map = {
      '{{WORKSPACE}}': cwd || p.workspace,
      '{{HOME}}': p.home,
      '{{ENV_NOTE}}': envNote,
      '{{ENV_LABEL}}': envLabel,
      '{{KEEPALIVE_NOTE}}': p.keepaliveNote,
      '{{BROWSER_TOOLS_SECTION}}': browserTools,
    }
    let out = text
    for (const [k, v] of Object.entries(map)) {
      out = out.split(k).join(v)   // split/join 避免 replace 的 $ 特殊处理
    }
    return out
  }

  function getSystemPrompt() {
    const date = new Date().toISOString().slice(0, 10)
    return interpolatePrompt(baseSystemPrompt)
      + sessionStartPrompt.replace('{{DATE}}', date).replace('{{CWD}}', cwd)
      + ClaudeMdLoader.format(contextFiles)
      + skillLoader.format()
      + customCommands.formatForPrompt()
      + customAgents.formatForPrompt()
      + formatRuntimeModelInfo()
      + (planMode.getSystemPromptAddition?.() || '')
      + (deepMode.getSystemPromptAddition?.() || '')
      + (coordinatorMode.getSystemPromptAddition?.() || '')
      + (opts.systemPromptSuffix || '')
  }

  function bindApi(api) {
    if (subAgentTool) {
      subAgentTool.api = api
      Object.defineProperty(subAgentTool, 'systemPromptBase', {
        configurable: true,
        get: () => getSystemPrompt(),
      })
    }
    const workflowTool = registry.get('AgentWorkflow')
    if (workflowTool) {
      workflowTool.api = api
      workflowTool.systemPrompt = () => getSystemPrompt()
      workflowTool.tools = registry.list().filter(t => t.name !== 'Agent' && t.name !== 'AgentWorkflow')
    }
  }

  return {
    registry,
    tools: () => registry.list(),
    multiUndo,
    inputHistory,
    planMode,
    deepMode,
    coordinatorMode,
    attachAgent: (a) => { liveAgent = a; if (a && deepMode) a.maxTurns = deepMode.getMaxTurns() },
    skillLoader,
    customCommands,
    customAgents,
    reloadExtensions: () => { customCommands.reload(); customAgents.reload() },
    getSystemPrompt,
    bindApi,
  }
}
