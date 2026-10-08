// Web 命令适配层 —— 把 Web runtime 映射成 core/cmd-*.mjs 认识的 ctx
//
// 【为什么要这一层】
// 2026-09-19 用户要求「不在 web 搞另一套 slash 了，复用 cli」。
// CLI 的命令实现（core/cmd-*.mjs）全部通过 ctx 取依赖，ctx 的形状是
// 「一堆 getter + 回调」。Web 的 runtime 结构不同（providerId/model 在会话上、
// 配置在 web-config.json），所以需要一层翻译。
//
// 【最重要的约束：配置隔离】
// CLI 读 config.json，Web 读 web-config.json，两者**必须互不覆盖**。
// 历史上踩过：Web 执行 /config 时把会话的 Provider 写回了全局 config.current。
// 这里的做法是给 CLI 模块一个「影子 config」——从 web-config 载入、
// 改完写回 web-config，全程不碰 config.json。
//
// 【非交互】
// 终端专属的东西（readline / 全屏界面 / 光标）在这里全部给空实现，
// 需要交互的命令（向导类）改为抛 WizardRequired，由调用方转成 HTTP 响应。

import { loadWebConfig, saveWebConfig } from './config-bridge.mjs'
// 【2026-09-23】命令模块（cmd-queries 的 /clear 等）需要读写文件，
// 但 ctx 里不能暴露裸 fs —— 那样命令模块会依赖 node 内置模块的重导出路径。
// 这里显式挑几个纯函数挂到 ctx 上（放在末尾，见 fsMethods）。
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { withNonInteractive, withDelegatedInteraction } from '../core/commands/wizard.mjs'
import { setSelectDelegate } from '../core/ui/select.mjs'
import { setMarkdownTheme, getMarkdownTheme, markdownThemeNames } from '../core/ui/markdown.mjs'

/**
 * 在「交互由前端接管」的语境里跑一个命令处理器。
 *
 * 【为什么 Web 必须包这一层】
 * CLI 的向导类命令（/model 无参、/config provider add 无参…）在终端里画边框等回车。
 * Web 没有 readline，直接调会拿到 `rl = null` 然后崩在 `null.onEnter`。
 *
 * 【2026-09-20 从 withNonInteractive 改为 withDelegatedInteraction】
 * 原来用 withNonInteractive，导致 `isNonInteractive()` 为 true，
 * 命令**内部**的非交互短路（如 model-list.mjs:228）抢先返回文本，
 * 根本走不到 ctx.runSelect —— 于是 `/model` 只吐一段说明、弹不出模型列表。
 *
 * 用户原话：「做完让你做的web slash向导，这做的啥玩意？打/model应该弹模型列表给我选」。
 *
 * 两者的差别见 core/wizard.mjs 的注释：
 *   withNonInteractive    = 真的没有人能按键（Agent / QQ）→ 命令该失败并给带参写法
 *   withDelegatedInteraction = 有人在浏览器里点，只是不在终端 → 命令照常走到
 *                              runSelect / runWizard，由 ctx 实现序列化给前端
 */
export function runWebCommand(handler, args) {
  // args 传**数组**（和 CLI 的 handleCommand 保持一致）。
  //
  // 【踩过的坑】2026-09-26 我一度在这里把 args join 成字符串，理由是
  // `/device vd status` 报「未知子命令 vd,status」。那确实是 bug，但真因是
  // **个别新命令**按 `String(args).split()` 解析，而全项目 164 处命令都用
  // `args[0]` / `args[1]` 下标取值 —— 归一成字符串会让它们全部读不到参数。
  //
  // 正确做法是让那个命令自己兼容两种形态（见 core/cmd-device.mjs 顶部），
  // 而不是把全局的形态迁就个别实现。
  const argv = Array.isArray(args)
    ? args
    : (typeof args === 'string' ? (args.trim() ? args.trim().split(/\s+/) : []) : [])
  // 注册「选择器委托器」：runSelect 在委托模式下会调它，把列表交给前端。
  //
  // 【为什么要注册而不是走 ctx.runSelect】
  // core/model-list.mjs 是**直接 import** runSelect 的（`import { runSelect } from '../core/ui/select.mjs'`），
  // 签名里没有 ctx —— 为 Web 改它的签名会污染 CLI 侧。所以用模块级注册器，
  // 只在 Web 跑命令期间生效，跑完立刻注销（finally），避免影响其他调用方。
  const prev = setSelectDelegate((o) => {
    throw new SelectRequired(o.title, o.items, {
      initial: o.initial, footer: o.footer, multi: o.multi, action: o.action, meta: o.meta,
    })
  })
  return withDelegatedInteraction(() => handler(argv)).finally(() => setSelectDelegate(prev))
}

/**
 * 命令需要交互式向导时抛这个。
 * 调用方（executeSlashCommand）捕获后转成 { kind: 'wizard', ... }，
 * 前端据此弹窗 —— 而不是像终端那样在 stdout 里画边框等输入。
 */
export class WizardRequired extends Error {
  constructor(wizardId, title, steps) {
    super(`需要交互：${title}`)
    this.name = 'WizardRequired'
    this.wizardId = wizardId
    this.title = title
    this.steps = steps
  }
}

/**
 * 命令需要一个**选择列表**（CLI 的 runSelect）时抛这个。
 *
 * 【为什么不能复用 WizardRequired】
 * WizardRequired 承载的是「表单」语义（steps 是输入框/单选项），而 runSelect
 * 是「从一批里挑一个」——列表可能几十项（模型列表动辄 50+），且常常是
 * **动态拉取的**（`/model` 要先请求 `{url}/models`）。用表单的 radio 渲染
 * 会挤成一坨，也没有搜索。
 *
 * 所以单独走一条通道：把 items 原样传给前端，前端用可滚动、可搜索的列表渲染。
 *
 * 【2026-09-20 用户反馈「做完让你做的web slash向导，这做的啥玩意？打/model应该弹模型列表给我选」】
 * 原来的实现是：`runSelect: async () => { throw new WizardRequired('select', '需要选择', []) }`
 * —— items 被直接丢弃，前端拿到空 steps，什么都弹不出来。
 */
export class SelectRequired extends Error {
  /**
   * @param {string} title  列表标题（如「选择模型 · Provider 6」）
   * @param {Array}  items  选项，[{ value, label, desc? }]
   * @param {object} opts   { initial?: number, footer?: string, multi?: boolean, action?: string }
   */
  constructor(title, items, opts = {}) {
    super(`需要选择：${title}`)
    this.name = 'SelectRequired'
    this.title = title
    this.items = items
    this.initial = opts.initial || 0
    this.footer = opts.footer || ''
    this.multi = !!opts.multi
    /**
     * 选中之后要执行什么命令 —— 这是让「选完能落盘」的关键。
     *
     * runSelect 只返回一个字符串，调用方拿到后通常接着做别的事
     *（如 `/model` 会把选中值塞回 rest 走既有的赋值路径）。
     * 但 Web 端这里是**跨请求**的：这次请求抛出选择，用户在前端点完，
     * 前端再发一次请求 —— 中间没有保留那个调用栈。
     *
     * 所以用 action 描述「选完要干什么」：
     *   'provider-set'  → 把 value 作为 <field> 写到 Provider <provId> 上
     *   'raw'           → 把 value 当作用户新输入的一条命令重新执行
     * 由 server 端在回填时按 action 分派。
     */
    this.action = opts.action || 'raw'
    this.meta = opts.meta || {}
  }
}

/** 终端 ANSI 颜色 —— Web 输出是纯文本进 Markdown 渲染，一律给空串。 */
const NO_COLOR = new Proxy({}, { get: () => '' })

/**
 * 构造 Web 端 ctx。
 *
 * @param {object} runtime Web 会话 runtime（见 web/server.mjs 的 getRuntime）
 * @param {object} deps 由 server.mjs 注入的外部能力
 * @param {Function} deps.getAgent        () => runtime.agent
 * @param {Function} deps.saveSession     () => Promise<void>  会话落盘
 * @param {Function} deps.sessionStore    SessionStore 实例
 * @param {Function} deps.listTeams       团队列表（cmd-team-task 用）
 * @param {Function} deps.listTasks       任务列表
 * @param {Function} deps.teamOverview    团队总览
 * @param {Function} deps.formatTeamOverview
 * @param {Function} deps.inboxCounts
 * @param {Function} deps.deleteTeam
 * @param {Function} deps.listTaskLists
 * @param {Function} deps.resetTaskList
 * @param {Function} deps.skillLoader      SkillLoader 实例（或 getter）
 * @param {Function} deps.compactService   CompactService 实例（或 getter）
 * @param {Function} deps.getMaxContext    () => number
 * @param {Function} deps.setMaxContext    (n) => void
 * @param {Function} deps.getMemoryDir     记忆目录相关（cmd-mem 用）
 * @param {Function} deps.listMemories
 * @param {Function} deps.formatMemoryList
 * @param {Function} deps.findRelevantMemories
 * @param {Function} deps.saveMemory
 * @param {Function} deps.deleteMemory
 * @param {Function} deps.voiceStatus      语音状态（cmd-small-config 用）
 * @param {Function} deps.getVoice
 * @param {Function} deps.setVoice
 * @param {Function} deps.isVoiceEnabled
 * @param {Function} deps.setVoiceEnabled
 * @param {Function} deps.setVoiceRate
 * @param {Function} deps.stopVoice
 * @param {Function} deps.mailStatus
 * @param {Function} deps.onWizard          (id, title, steps) => never  仅用于测试注入
 */
export function buildWebCtx(runtime, deps = {}) {
  // ── 影子配置 ──
  // CLI 模块会直接改传进去的 config 对象（如 provider.model = xxx），
  // 然后调 ctx.saveConfig(config)。我们让这个对象就是 web-config 的实例，
  // saveConfig 写回 web-config.json。**全程不碰 config.json**。
  let shadowConfig = loadWebConfig()

  const saveConfig = (config) => {
    // 【必须先拍平】调用方传进来的往往是 configProxy 本身（命令里写的是
    // `saveConfig(config)`，而那个 config 就是代理）。
    // 如果直接把代理存回 shadowConfig，get trap 里的 `shadowConfig[key]`
    // 就变成「读代理 → 触发 get → 再读代理」，**无限递归**
    // （实测 RangeError: Maximum call stack size exceeded，栈里全是同一行 get）。
    const plain = JSON.parse(JSON.stringify(config))
    shadowConfig = plain
    saveWebConfig(plain)
  }

  // 会话级的 Provider/模型覆盖：CLI 的 cmdConfig 用 config.current 定位"当前 Provider"，
  // Web 里这个概念在 runtime 上。每次取 config 时做一次临时对齐，
  // 用完由 cmdConfig 内部还原（见 web/server.mjs 原有处理）。
  const configProxy = new Proxy({}, {
    get(_t, key) {
      const c = shadowConfig
      if (key === 'current') return runtime.providerId || c.current
      return c[key]
    },
    set(_t, key, value) {
      shadowConfig[key] = value
      return true
    },
    has(_t, key) { return key in shadowConfig },
    ownKeys() { return Reflect.ownKeys(shadowConfig) },
    getOwnPropertyDescriptor(_t, key) {
      return Object.getOwnPropertyDescriptor(shadowConfig, key) || { configurable: true, enumerable: true, value: undefined }
    },
  })

  // 非交互占位：终端命令里那些 `await rl.question(...)` 在 Web 走不到，
  // 真走到说明这个命令需要向导 —— 抛 WizardRequired 让上层转成 HTTP 响应。
  const notInteractive = (what) => () => {
    throw new WizardRequired(what, `${what} 需要交互`, [])
  }

  return {
    // ── 渲染 ──
    C: NO_COLOR,
    CLI_VERSION: deps.cliVersion || 'web',

    // ── 设备 shell 通道（/device）──
    // 由 server.mjs 的 getWebCtxDeps 注入 core/device.mjs。
    // 缺省时 /device 会被 cmd-registry 跳过（不是报错），符合「缺字段则跳过」的约定。
    device: deps.device || null,

    // ── 配置 ──
    config: configProxy,
    saveConfig,

    // ── 会话 ──
    get agent() { return runtime.agent },
    sessionId: () => runtime.id,
    sessionTitle: () => runtime.title,
    setSessionTitle: (t) => { runtime.title = t },
    sessionStore: deps.sessionStore,
    // /resume 无参时用（deps 里由 server.mjs 提供，见 getWebCtxDeps）
    tryResume: () => deps.tryResume?.() ?? null,

    // ── 撤销栈（/rewind 用）──
    // toolkit.multiUndo 在 buildAgent 之后才有；用 getter 延迟取，
    // 否则命令首次执行时拿到 undefined（实测 /rewind 报 "Cannot read
    // properties of undefined (reading 'list')" 就是这个原因）。
    get multiUndo() { return runtime.toolkit?.multiUndo || null },

    // ── 会话控制（/new 用）──
    // runtime 在 Web 侧持有 id / title / todos / incognito，改用 setter 回调改，
    // 因为命令模块拿到的 ctx 是只读投影，没法直接给 runtime 赋值。
    newSessionId: () => randomUUID().slice(0, 8),
    setSessionId: (id) => { runtime.id = id },
    setTodos: (list) => { runtime.todos = list },
    setIncognito: (on) => { runtime.incognito = !!on },

    // ── 文件读写（给命令模块用，不是给用户看的）──
    // 这些是 node:fs 的直接透传，命令模块里写 ctx.existsSync(...) 而不是 import fs，
    // 这样同一个模块能在 CLI（也有这些字段）和 Web 上跑。
    existsSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
    readdirSync,
    rmSync,
    join,

    // ── 其他模块透传（2026-09-24 批量补）──
    //
    // 【为什么会有这一批】getWebCtxDeps 已经在提供这些依赖了，
    // 但 buildWebCtx 没有转发到 ctx 上 —— 于是命令模块里 ctx.xxx 全是
    // undefined，一调就报 "is not a function"。
    //
    // 实测受影响的命令：/backup /imagegen /pexels /permissions /mcp
    //   （注册表执行失败 → 静默回退手写分支 → 用户看到的是「命令没反应」）
    //
    // 这批字段分两类：
    //   1. 纯转发（server.mjs 已给，这里接上）—— getBackupStatus 等
    //   2. Web 侧没有的（Termux 专属）—— 给安全的降级值，避免崩
    maskKey: deps.maskKey,
    PROJECT_CONFIG_PATH: deps.PROJECT_CONFIG_PATH,
    // 【已删除 2026-10-03】备份（/backup 功能下线）
    // 生图（/imagegen 用）
    getImageGenConfig: deps.getImageGenConfig,
    setImageGenConfig: deps.setImageGenConfig,
    // 权限（/permissions 用）—— Web 没有 CLI 的 permManager，给只读快照
    permManager: deps.permManager ?? {
      getMode: () => 'web（Web 端权限由 canRunWebTool 控制，见 server.mjs）',
    },
    // MCP（/mcp 用）—— Web 侧通过 mcpClient 查服务器状态
    // MCP 客户端（/mcp 用）。
    // 需要 getAllTools() —— cmd-integrations 里会调它统计工具总数。
    // Web 侧 runtime.mcpClient 由 server.mjs 注入（真实的 MCPClient 实例）；
    // 兜底值也要实现这个接口，否则降级路径一调就崩。
    get mcpClient() {
      const real = runtime.mcpClient
      if (real) return real
      return { servers: new Map(), getAllTools: () => [] }
    },
    // 会话内错误收集（/errors 用）—— 已由 recentErrors 覆盖，这里补 recordError
    recordError: deps.recordError ?? (() => {}),
    // 其他（各自命令用到）
    HIDDEN_COMMANDS: deps.HIDDEN_COMMANDS ?? new Set(),
    slashCommands: deps.slashCommands ?? [],
    openOverlay: deps.openOverlay ?? (() => '（Web 端无覆盖层）'),
    getMarkdownTheme: deps.getMarkdownTheme,
    markdownThemeNames: deps.markdownThemeNames,
    setMarkdownTheme: deps.setMarkdownTheme,
    // key 池（/key 用）
    keyPoolDescribe: deps.keyPoolDescribe,
    keyPoolNonInteractiveHint: deps.keyPoolNonInteractiveHint,
    renderModelList: deps.renderModelList,
    renderPoolStatus: deps.renderPoolStatus,
    runModelWizard: deps.runModelWizard,
    runKeyPoolWizard: deps.runKeyPoolWizard,
    // 侧问（/btw 用）
    runSideQuestion: deps.runSideQuestion,
    // 目标（/goal 用）
    cols: deps.cols ?? (() => 60),
    getTokens: deps.getTokens,
    // 子 agent 刷新（/agents 用）
    onReload: deps.onReload,
    // 受保护路径判断（/add-dir 用）
    isProtectedPath: deps.isProtectedPath ?? (() => false),
    // QQ 桥（/qq 用）。
    // 【2026-09-24 更新】Web/CCM 现在也有桥了（web/qq-integration.mjs）。
    // 用 getter 而不是直接传值：桥是异步启动的，ctx 可能先于桥存在；
    // 而且 /qq on 之后桥会**从无到有**，getter 每次现取才能拿到最新状态。
    get qqBridge() { return deps.getQqBridge?.() ?? null },
    saveQqConfig: deps.saveQqConfig ?? (() => {}),
    loadQqConfig: deps.loadQqConfig ?? (() => ({})),
    // 各端开关一览（/qq status 显示用）—— 开关按端分，端口共用，
    // 用户换端前需要知道另一个端是否还开着。
    listQqEndpoints: deps.listQqEndpoints ?? (() => []),
    detectQqEndpoint: deps.detectQqEndpoint ?? (() => null),
    labelQqEndpoint: deps.labelQqEndpoint ?? ((n) => n),
    // /qq on 需要真的把桥拉起来（不只是写配置）—— 由 server.mjs 提供
    startQqBridge: deps.startQqBridge ?? (async () => ({ ok: false, reason: '当前环境不支持' })),
    stopQqBridge: deps.stopQqBridge ?? (() => {}),
    refreshQueueLength: () => {},
    // provider 快捷命令（/model 等用）
    emit: deps.emit ?? (() => {}),
    saveSession: () => (deps.saveSession ? deps.saveSession(runtime) : Promise.resolve()),
    get history() { return runtime.history },
    get api() { return runtime.agent?.api || runtime._api || null },

    // ── 待办（TodoWrite 维护的当轮清单）──
    todos: () => runtime.todos || [],

    // ── 上下文 ──
    getMaxContext: deps.getMaxContext || (() => 200000),
    setMaxContext: deps.setMaxContext || (() => {}),
    getLastPromptTokens: () => runtime.lastPromptTokens || 0,

    // ── 压缩 ──
    get compactService() { return runtime.compactService },
    backupBeforeCompact: deps.backupBeforeCompact,
    // /compact 用：判断能否做缓存感知压缩的策略对象。
    // Web 侧没有 CLI 的 prompt cache 优化，给中性空策略。
    // 原来透传 undefined → /compact 一进来就 "is not a function"。
    getCachePolicy: deps.getCachePolicy ?? (() => ({ cacheAware: false })),
    newCompactAbort: deps.newCompactAbort,
    clearCompactAbort: deps.clearCompactAbort,

    // ── 技能 ──
    get skillLoader() { return runtime.skillLoader },
    /**
     * Skill 命令名列表（/help 要用）。
     *
     * 【为什么要单独暴露】cmd-help 里有个逻辑：兜底清单要排除 skill 名，
     * 否则 832 个 skill 会把帮助列表淹没。Termux 侧由 index.mjs 提供这个函数，
     * Web 侧原来没提供 → ctx.skillCommandNames() 抛 "is not a function"
     * → /help 直接崩（实测：注册表执行 help 失败，回退手写分支）。
     *
     * 用 listNames() 而不是 list()：前者只 readdir + stat，后者会把
     * 823 个 skill 文件的正文全读一遍（冷盘上要 3 秒）。帮助列表只需要名字。
     */
    skillCommandNames: () => {
      try {
        return runtime.skillLoader?.listNames?.()
          ?.filter(s => s.userInvocable !== false)
          ?.map(s => s.name) || []
      } catch { return [] }
    },

    // ── 团队 / 任务 ──
    listTeams: deps.listTeams || (() => []),
    listTasks: deps.listTasks || (() => []),
    listTaskLists: deps.listTaskLists || (() => []),
    teamOverview: deps.teamOverview,
    formatTeamOverview: deps.formatTeamOverview,
    inboxCounts: deps.inboxCounts,
    deleteTeam: deps.deleteTeam,
    resetTaskList: deps.resetTaskList,

    // ── 记忆 ──
    getMemoryDir: deps.getMemoryDir,
    listMemories: deps.listMemories,
    formatMemoryList: deps.formatMemoryList,
    findRelevantMemories: deps.findRelevantMemories,
    saveMemory: deps.saveMemory,
    deleteMemory: deps.deleteMemory,

    // ── 系统配置（/cache /compact-threshold /workspace /me /check /context7）──
    // 【2026-10-05 加】这批命令原来只在 index.mjs 手写，Web 敲了报「未知命令」。
    // 拆进 core/commands/cmd-system-config.mjs 后两端共用，这里补上依赖。
    //
    // 【为什么部分给降级值而不是透传】
    // CLI 侧这些回调干的是「刷新系统提示词 / 同步运行中 api 实例」——
    // Web 的提示词与 agent 是懒建 + 每次重建，没有需要手动失效的常驻缓存，
    // 所以给空实现（no-op）即可，给了真实现反而可能改错对象。
    // 工作区则必须给真实现（Web 有 /api/workspace 端点，是真实功能）。
    getWorkspacePath: () => runtime.workspacePath || deps.workspacePath?.() || '',
    setWorkspacePath: (p) => {
      try {
        const resolved = deps.normalizeWorkspace?.(p)
        if (!resolved) return { ok: false, error: '工作区路径不可用' }
        runtime.workspacePath = resolved
        deps.saveWebSettings?.(resolved)
        return { ok: true, path: resolved }
      } catch (err) {
        return { ok: false, error: err?.message || String(err) }
      }
    },
    // Web 的提示词每轮重建，无缓存段需要手动失效 —— 这两个回调给 no-op。
    // （CLI 侧它们会调 agent.systemPrompt = getCurrentSystemPrompt()）
    onWorkspaceChanged: () => {},
    onProfileChanged: () => {},
    // 【2026-10-08】/style（回复偏好）用：Web 的资料是 web-profile.json，
    // 与 CLI 的 cli-profile.json 是两个文件（见 core/session/user-profile.mjs
    // 顶部说明）。cmd-style.mjs 两端共用，不能直接 import CLI 那份 ——
    // 通过这两个函数注入 Web 自己的读写实现（deps 由 server.mjs 提供）。
    getProfile: deps.getProfile,
    setProfile: deps.setProfile,
    // /cache 用：CLI 侧同步到常驻 api 实例；Web 的 ApiClient 每次请求现读配置，
    // 所以只需把配置写回（saveConfig 已做），同步动作是 no-op。
    syncActiveProvider: () => {},
    syncSessionCacheKey: () => {},
    // /check 用：预检的工作目录 —— Web 的源码根（ROOT），不是用户工作区
    cwd: () => deps.sourceRoot || process.cwd(),
    // /context7 用
    mcpPath: deps.mcpPath,

    // ── 语音 / 状态行 / 邮件 ──
    voiceStatus: deps.voiceStatus,
    getVoice: deps.getVoice,
    setVoice: deps.setVoice,
    isVoiceEnabled: deps.isVoiceEnabled,
    setVoiceEnabled: deps.setVoiceEnabled,
    setVoiceRate: deps.setVoiceRate,
    stopVoice: deps.stopVoice,
    mailStatus: deps.mailStatus,
    // 状态行是终端底部 UI，Web 没有对应物 —— 给个说明而不是崩
    runStatusLineCommand: async () => '状态行是终端特性，Web 端没有对应设置。',
    statusLinePayload: () => ({}),
    updateFsStatus: () => {},
    updateFsSpinner: () => {},
    resetMdRenderer: () => {},
    forceFlushPending: () => {},
    clearThinkTimers: () => {},
    clearHiddenThinkingTimer: () => {},

    // ── 杂项（keepalive / compact-trash / 字体 / context）──
    // 【2026-09-24】这两个是 Termux 侧的保活机制（wake-lock + 电池白名单检查）。
    // CCM 里由 Kotlin 的前台服务负责保活，不需要 Node 侧再做 ——
    // 所以返回「已由原生层接管」而不是报错。
    // 原来直接透传 undefined → /keepalive 里调 ctx.acquireMainWakeLock()
    // 抛 "is not a function"。
    acquireMainWakeLock: deps.acquireMainWakeLock ?? (async () => '（CCM 里由 Kotlin 前台服务保活）'),
    checkBatteryWhitelist: deps.checkBatteryWhitelist ?? (async () => '（CCM 里无需检查，保活由原生层负责）'),
    listCompactTrash: deps.listCompactTrash,
    readCompactTrash: deps.readCompactTrash,
    restoreCompactTrash: deps.restoreCompactTrash,
    deleteCompactTrash: deps.deleteCompactTrash,
    readTtfFullName: deps.readTtfFullName,
    cmdContext: deps.cmdContext,

    // ── 交互（向导类）──
    // 终端是 runWizard 画边框等输入；Web 走 WizardRequired → 前端弹表单。
    runWizard: async ({ title, steps }) => {
      if (deps.onWizard) return deps.onWizard(title, steps)
      throw new WizardRequired(slugify(title), title, steps)
    },
    /**
     * runSelect → SelectRequired（把列表原样交给前端渲染）。
     *
     * 【2026-09-20 修复】原来是 `async () => { throw new WizardRequired('select','需要选择',[]) }`
     * —— 参数直接丢掉，前端拿到空列表，`/model` 无参时什么都弹不出来。
     * 用户原话：「打/model应该弹模型列表给我选，其他命令你也注意」。
     *
     * 现在把 { title, items, initial, footer, multi } 原样带出去。
     * 顺带修正两个细节：
     *   1. title 不能为空 —— CLI 的 runSelect 默认值 '请选择'，这里保持
     *   2. items 要规整成 [{value,label,desc}] —— runSelect 允许传纯字符串数组
     *      （见 core/select.mjs:41 的 `typeof it === 'string' ? {...} : it`），
     *      前端统一按对象处理，这里先归一化，省得前端再判一次类型
     */
    runSelect: async (opts = {}) => {
      const { title = '请选择', items = [], initial = 0, footer = '', multi = false, action, meta } = opts
      const normalized = (Array.isArray(items) ? items : [])
        .map((it) => (typeof it === 'string' ? { value: it, label: it } : it))
        .filter(Boolean)
      throw new SelectRequired(title, normalized, { initial, footer, multi, action, meta })
    },
    isNonInteractive: () => true,
    rl: () => null,
    fsSession: () => null,

    // ── /style 输出风格 ──
    // cwd 用会话的 workspace：项目级风格在 <workspace>/.claude/output-styles/
    cwd: () => runtime.workspacePath || process.cwd(),
    // Web 没有交互选择器 → runSelect 不注入，模块会返回列表文本

    // ── Markdown 样式（/markdown）──
    // Web 端的正文是浏览器渲染的，这套主题只影响 CLI 终端输出。
    // 但配置字段要能读能写（用户在 Web 改了，CLI 重启后跟着变）。
    setMarkdownTheme,
    getMarkdownTheme,
    markdownThemeNames,

    // ── 自动记忆 ──
    setAutoMemEnabled: deps.setAutoMemEnabled,
    getAutoMemStatus: deps.getAutoMemStatus,

    // ── 权限 ──
    cmdPermissions: deps.cmdPermissions,
    customCommands: deps.customCommands,
    customAgents: deps.customAgents,
    getCurrentSystemPrompt: deps.getCurrentSystemPrompt,

    // ── 其它 ──
    trace: deps.trace,
    cmdStats: deps.cmdStats,
    cmdTemperature: deps.cmdTemperature,
    // 【2026-09-24】原来直接透传 deps.recentErrors，而 getWebCtxDeps 没提供它
    // → ctx.recentErrors 是 undefined → cmd-queries 的 /errors 里
    // `arr.length` 抛 "Cannot read properties of undefined"。
    // Web 侧没有 index.mjs 那种「本进程错误收集器」，给空数组即可。
    recentErrors: deps.recentErrors ?? [],
    contextFiles: deps.contextFiles,
    formatContextFiles: deps.formatContextFiles,
    incognito: () => !!runtime.incognito,
    // 【2026-09-24 加别名】cmd-misc 的 /summary 读 ctx.incognitoMode()，
    // 而这里提供的是 ctx.incognito() —— 名字对不上就报 "is not a function"。
    // 实测：/summary 在 Web 上直接崩（回退手写分支）。
    // 两个名字都留着：cmd-queries 的 /incognito 用 ctx.incognito，
    // cmd-misc 的 /summary 用 ctx.incognitoMode，各有各的调用点。
    incognitoMode: () => !!runtime.incognito,
    sessionStartTime: runtime.createdAt ? new Date(runtime.createdAt).getTime() : Date.now(),

    // ── Web 专属：让模块知道自己在 Web 上跑 ──
    platform: 'web',
    runtime,
  }
}

/** 把向导标题转成 URL 安全的 id。 */
function slugify(text) {
  return String(text || 'wizard')
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'wizard'
}
