// 命令目录（单一真值源）—— 内置命令名 + 描述表 + 参数提示
//
// 【为什么要有这个文件】
// 2026-10-05 用户指出「web 端其实有点落后了」。
//
// 排查发现：CLI 侧命令早已 58+ 个（且注册表是动态的），但 Web 的
// `getSlashCommands()` 还在用 `web/server.mjs` 里硬编码的 48 条静态列表 ——
// 结果 25 个命令「能跑但没提示」（/plugin /mem /new /resume /style /update …），
// 用户根本不知道它们存在。
//
// 同时 CLI 自己的 `BUILTIN_COMMANDS`（index.mjs:4423）和 `commandDescriptions`
// （index.mjs:5004）也是手维护的两份表 —— 加一个命令要改三处（注册表 + 两处列表）。
//
// 【设计】
// 这个文件**只放数据**，不含任何逻辑，两端各自 import：
//   · CLI（index.mjs）—— BUILTIN_COMMANDS / commandDescriptions / ARG_HINTS
//   · Web（server.mjs）—— getSlashCommands() 直接映射出 {name, description}
//
// 【边界】
// 只收「内置命令」的元数据。自定义命令（.claude/commands/*.md）和 skill
// 由各自的 loader 提供，运行时拼接 —— 它们不在这个文件的职责范围。

import { DEEP_MAX_TURNS } from '../agent/plan.mjs'

/**
 * 内置命令名（顺序即面板里的默认顺序，别随意重排）。
 *
 * 与注册表（cmd-registry.mjs）的关系：
 *   · 注册表 = 「这个命令**怎么执行**」（handler）
 *   · 本列表 = 「这个命令**叫什么、怎么展示**」（name + description）
 * 两者理论上应该一一对应，但不强制 —— 有些命令只有展示意义（如 /exit），
 * 有些注册表命令走的是别名（/plugin 与 /plugins 共用一份实现）。
 */
export const BUILTIN_COMMANDS = [
  'help', 'agents', 'cost', 'cache', 'context', 'context7', 'diff', 'doctor', 'review', 'trace',
  'workflow', 'stats', 'todos', 'goal', 'plan', 'deep', 'coordinate', 'cowork', 'watch', 'qq',
  'undo', 'rewind', 'retry', 'branch', 'export', 'skills', 'memory', 'automem', 'permissions',
  'bg-status', 'bg-list', 'tasks', 'team', 'exit', 'quit', 'clear', 'new', 'incognito',
  'model', 'url', 'name', 'key', 'protocol', 'compact', 'compact-threshold', 'compact-trash',
  'save', 'load', 'resume', 'rename', 'delete', 'copy', 'image', 'editor', 'add-dir', 'workspace',
  'clear-restore', 'config', 'trash', 'keepalive', 'palette', 'web', 'greeting', 'board', 'keys',
  'btw', 'files', 'status', 'summary', 'statusline', 'mem', 'font', 'check', 'plugins', 'x11',
  'hooks', 'tools', 'errors', 'away', 'temperature', 'imagegen', 'mail', 'effort', 'style', 'me',
  'github', 'voice', 'mcp', 'pexels', 'markdown', 'device', 'update', 'replay', 'plugin',
]

/** 内置命令名集合（O(1) 查询用）。 */
export const BUILTIN_COMMAND_NAMES = new Set(BUILTIN_COMMANDS)

/**
 * 命令描述表（补全面板 / 命令列表 / /help 用）。
 *
 * 【写法约定】
 * 描述只回答「这命令干什么」，**不重列子命令** —— 子命令交给 subcommands 面板
 * （敲「/cmd 」空格展开，一个一行各带说明，不会被窄屏截断）。
 * 历史上把子命令又列一遍的结果是：窄屏（40 列）下面板行不折行，
 * 句尾直接被截，而句尾往往才是关键信息 —— 净信息量反而下降。
 */
export const COMMAND_DESCRIPTIONS = {
  help: '帮助（输 /help 空格看各主题）',
  mcp: 'MCP 服务器：list/status/enable/disable/tools',
  pexels: '图库搜索 key（FindImage 用）：set/test/clear',
  cost: 'token 用量与花费',
  cache: 'Prompt Cache 开关：/cache on|off|retention 24h',
  context: '上下文占用与上限',
  context7: 'Context7 文档查询：空格看子命令',
  diff: '看 git 改动：空格看子命令',
  doctor: '环境自检',
  review: '工作区审查',
  trace: '执行轨迹查看/回放',
  workflow: '阶段化工作流说明',
  stats: '使用统计',
  todos: '待办列表',
  plan: '计划模式开关',
  deep: `深模式（maxTurns ${DEEP_MAX_TURNS}）`,
  watch: '持续模式：/watch on|off',
  goal: '完成契约：自动跨轮推进直到达成',
  qq: 'QQ 私聊桥：空格看子命令',
  undo: '撤销文件修改',
  rewind: '检查点回退',
  retry: '回到报错前重跑',
  branch: '从当前对话拉分支',
  export: '导出对话（md/html/json）',
  skills: '技能列表/搜索',
  memory: 'CLAUDE.md 项目记忆',
  automem: '自动记忆：/automem on|off',
  permissions: '工具权限与模式',
  'bg-status': '后台任务：/bg-status <id>',
  'bg-list': '后台任务列表',
  exit: '退出程序',
  quit: '退出程序',
  clear: '清空当前对话记录',
  new: '存当前 + 开新对话',
  incognito: '隔离会话（不写盘）',
  model: '换模型（id 省略 = 当前 Provider）',
  url: '改 API 地址（如 …/v1）',
  key: '看/改密钥：无参看现状含冷却',
  compact: '压缩上下文（直接敲=自动选）',
  'compact-threshold': '自动压缩阈值（默认关）',
  'compact-trash': '找回压缩前的完整上下文',
  save: '手动存会话',
  load: '列出所有会话',
  resume: '恢复会话（ID 或名称；省略 = 最近一个）',
  rename: '给当前对话起名',
  delete: '删除会话',
  copy: '复制最后回复',
  image: '识图：/image <路径> [说明]',
  editor: '长消息编辑：/editor 打开外部编辑器',
  'add-dir': '加工作目录：/add-dir /路径',
  workspace: '查看/设置工作区：/workspace [路径]',
  'clear-restore': '找回被 /clear 清掉的对话',
  config: '切 Provider：留空进选择列表',
  trash: '文件回收站：无参看列表',
  keepalive: '息屏保活',
  voice: '把我的正文念出来（工具调用不念）',
  web: 'Web 服务：/web start|status|open',
  greeting: '开场白：/greeting on|off',
  board: '看板显示开关',
  keys: '快捷键速查',
  btw: '顺带问一句（不占上下文）',
  files: '上下文文件：/files 或 /files reset 清',
  status: '一屏汇总状态',
  summary: '生成对话摘要标题',
  statusline: '自定义底部状态行',
  mem: '结构化记忆：/mem list|find <关键词>|save|rm',
  font: '看当前字体；/font reset 恢复默认',
  check: '重启预检（语法/声明）',
  plugins: '已加载插件',
  x11: '浏览器 X11：/x11 on|off|status',
  hooks: '已配置 hooks',
  tools: '已注册工具清单',
  errors: '近期错误记录',
  away: '离场成果报告',
  temperature: '生成温度设置',
  imagegen: '生图配置：配完直接说「画一张…」',
  name: '改显示名（改编号用 /config provider）',
  effort: '思考强度（每 Provider 独立）',
  style: '输出风格（回复方式；可自定义 .claude/output-styles/）',
  me: '用户资料（称呼/职业/偏好；注入提示词）',
  github: 'GitHub 工具集（仓库/issue/PR 读写）',
  tasks: '持久待办（跟轮内 todo 不是一回事）',
  agents: '子 Agent：谁在跑、卡住了吗',
  team: '多 Agent 协作全景（团队名=任务列表名）',
  mail: '邮箱接码 MCP：空格看子命令',
  device: '手机 Shell 通道 / 虚拟副屏 / 操作模式',
  // ── 以下补于 2026-10-05（抽 catalog 时发现这些命令在表里但没描述，
  //    命令面板里显空白；Web 侧同步受益）──
  coordinate: '协调者模式：自己只拆解派活，不写代码',
  cowork: '协调者模式的 Web 叫法（同一个东西）',
  protocol: 'API 协议：openai|anthropic|responses',
  palette: '命令面板：浏览/搜索所有命令',
  markdown: '终端 Markdown 配色：classic|official',
  update: '检查更新（镜像下载，不覆盖用户数据）',
  replay: '进会话时是否显示历史正文',
  plugin: 'DSH 插件：装/卸/启停（/plugins 是别名）',
}

/**
 * 参数格式提示（对齐官方 argumentHint，如官方 /add-dir 是 '<path>'）。
 *
 * 只给真正需要参数的命令写，纯开关类命令留空更干净。
 *
 * 【为何要控宽】面板行不折行，而且当 "/cmd argHint" 这个头部就已超屏宽时，
 * 渲染逻辑会把描述**整条丢掉**（fullscreen-adapter 里的 visibleLen > cols 分支）。
 * 所以 argHint 写长不是「多给了点信息」，是「把描述挤掉了」——净信息量反而下降。
 * 「留空进选择列表」这类说明搬到描述里，这里只留参数形状。
 *
 * 【改 argHint 必须回到实现里逐个核对】历史上 /statusline 的 hint 写
 * '[compact|standard|detailed|off]'，这四个子命令**实现里一个都不认**
 * （只认 show|set|test|off）—— 照着提示敲会得到「不认识的子命令」，
 * 错提示比没提示更伤。
 */
export const ARG_HINTS = {
  'add-dir': '<路径>', workspace: '[路径]', resume: '[ID|名称]', delete: '<ID|all>',
  rename: '<名称>', branch: '<名称>', save: '[名称]', compact: '[N|micro|force|status]',
  'compact-threshold': '[数字|0 0]', model: '[配置ID] <模型名>', url: '[配置ID] <地址>',
  key: '[ID] <sk-...|pool|clear>', name: '[配置ID] <显示名>',
  config: '[ID|list|provider|…]', effort: '[强度|off|show|hide|replay]', style: '[风格名|off]',
  me: '[set <字段> <值>|clear <字段>]',
  github: '[login|repo|test|logout]',
  permissions: '[mode|allow|deny <名>]', font: '[reset]',
  statusline: '[show|set <命令>|test|off]',
  trash: '[restore <序号>|clear]',
  voice: '[on|off|<音色>|rate <+10%>]',
  qq: '[on|off|setup|…]', mail: '[status|set|…]',
  imagegen: '[setup|url|key|…]', memory: '[init|append <内容>]',
  image: '<图片路径> [说明]', watch: '[on|off]', greeting: '[on|off]',
  // 9 个子命令用 | 挤一行，在 40-60 列窄屏上会被直接截断 —— 尾部的
  // proof / bound / budget 用户根本看不到，而它们正是 /goal 与普通待办的区别
  // （四要素契约：目标/判据/边界/预算）。细节交给 subcommands 面板，
  // 那里一个子命令一行、各带说明。
  goal: '[目标描述|子命令]',
  // 注：slashCommands 里只有 /skills（复数），没有 /skill，别再给 skill 写 hint
  'bg-status': '<任务ID>', skills: '[技能名]', team: '[名称]', tasks: '[列表名]',
  agents: '[cards|reload|new]',
  help: '[主题]', copy: '', undo: '', rewind: '',
  device: '[mode 主屏|副屏|选择|shell|vd|test]',
}

/**
 * 从 catalog 生成补全条目（供 Web 的 /api/commands 用）。
 *
 * @param {object} [opts]
 * @param {string[]} [opts.extra]  额外命令名（自定义命令 + skill），追加在后面
 * @returns {{name: string, description: string, builtin: boolean}[]}
 */
export function listCommandEntries(opts = {}) {
  const builtin = BUILTIN_COMMANDS.map(name => ({
    name,
    description: COMMAND_DESCRIPTIONS[name] || '',
    builtin: true,
  }))
  const extra = (opts.extra || []).map(name => ({
    name,
    description: COMMAND_DESCRIPTIONS[name] || '',
    builtin: false,
  }))
  return [...builtin, ...extra].sort((a, b) => a.name.localeCompare(b.name))
}
