// /help 的主题文本表（handleCommand 拆分第七批）
//
// 【为什么单独成文件】这 195 行是**纯静态文本**，零依赖、零逻辑，
// 却占了 handleCommand 的 4%。搬出来之后 /help 那个 case 只剩分发逻辑。
//
// 【维护约定】
//   - 只写「每天真的会用」的命令。原来一次泼 180 行 / 110 条，
//     /config 分散出现 4 次、/image 重复两遍，常用命令埋在里面找不到
//     —— 用户反馈「太乱了，没几个人看了会用」，所以才分了主题。
//   - 加新命令时对应主题里加一行；不确定归哪类就先不加，
//     /help all 有兜底的「未分类命令」清单会列出来。
//   - 隐藏命令**不要**写进这里，见 index.mjs 的 HIDDEN_COMMANDS（当前为空）。
//
// ⚠ 模板字符串里的 ${ENV} 是给用户看的占位符文本，不是变量插值 ——
//   所以整个表用普通对象字面量，不接受任何参数。

export const HELP_TOPICS = {
      model: `模型 / Provider
━━━━━━━━━━━━━━━━━━━━━━━━
/config                       进选择列表挑 Provider（上下选，Enter 切换）
/config list                  看详情：当前 Provider 全字段 + key 池 + 可用列表
/config <数字>                切换 Provider（如 /config 3）
/config model <名称>          改当前 Provider 的 model（转发到 /model）
/config [ID] test             测连通性（ID 省略 = 当前 Provider）
/config provider add                 交互式向导新增 Provider（分步填写）
/config provider add [ID] name=<名> url=<地址> model=<模型> key=<sk-...>
                                 一行式：顺序无关；key 给多个 = 轮换池
/config provider rm|rename|list      删除/重命名/列出 Provider
/config vision on|off|set <id>  识图路由（本模型优先 / 指定兜底）
/config stream on|off         流式输出（默认 on）

/model /url /name /key —— 统一语法（立即生效，无需重启）
/model [id] <名称>            改模型；id 省略 = 当前 Provider
/url [id] <地址>              改 URL
/name [id] <显示名>           改显示名（只改名字，不动编号）
/protocol [id] <协议>         改协议：openai | anthropic | responses
/key [id]                     看 key 现状：谁在用、谁在冷却、各自 ok/fail
/key [id] <sk-...>            设单 key
/key [id] pool                进管理向导：加一批 / 按序号删 / 清冷却
/key [id] pool <k1> <k2>...   直接设整池（知道要什么时更快）
/key [id] setenv <ENV名>      引用环境变量（key 存 .env）
/key [id] clear               清空 key
/id 可为数字或字母 ID（/config 列表里冒号前的就是）。省略 id 时操作当前 Provider。
省略值只查看不修改，例 /name 2 查看 Provider 2 的显示名。
例: /model gpt-5.5                改当前 Provider 的模型
/model 2 gpt-4o              改指定 Provider 的模型
/name 2 我的中转站            给 Provider 2 起个显示名
/key pool                    进向导（能一次贴一批 key，空格或换行分隔）
/key pool sk-a sk-b sk-c     给当前 Provider 设多 key 轮换
/key setenv MY_KEY           引用环境变量
注: /name 改显示名，/config provider rename 改编号（如 2 → piexian），两者不同。

思考强度
/effort <档位>           设思考强度（每 Provider 独立）
档位：none|minimal|low|medium|high|xhigh|max
/effort off              关闭思考
/effort show|hide        是否在终端显示思考内容
/effort replay on|off    历史思考是否回传给模型（默认 off；仅当前 Provider）

输出风格
/style [名字]            选择输出风格（影响回复方式；无参进列表）
/style off               回到默认（无额外风格提示词）
自定义：在 .claude/output-styles/ 放 .md（文件名即风格名）
  或 ~/.claude/output-styles/（用户级，所有项目共用）

用户资料
/me                      查看（称呼/职业/偏好）
/me set <字段> <值>      设置，如 /me set display_name 小杰
/me clear <字段>         清除某项；/me clear-all 全清

GitHub
/github                  查看状态（token / 已配仓库）
/github login [token]    设置 token（省略则交互输入；先验证再保存）
/github repo <owner/name> 配一个仓库
/github test             验证连通性
/github logout           清除 token
工具：GitHubRepo/Issues/IssueView/PRs/PRComments/Comment/CreateIssue/File
字段：display_name / full_name / work_function / personal_preferences
/temperature [0.0-2.0]        生成温度`,

      context: `上下文 / 压缩
━━━━━━━━━━━━━━━━━━━━━━━━
/context              上下文使用量可视化
/cost                 Token 用量
/files                当前上下文里的文件（~ = 改动过）
/compact status       只看建议，不执行
/compact [N]          按策略压缩，保留最后 N 条（默认 10）
/compact force [N]    强制压缩
/compact-trash        压缩回收站：list/view/restore/delete/clear
/compact-threshold    查看自动压缩阈值（默认关闭）
/compact-threshold <tokens> <messages>
                  设阈值并开启，如 50000 50
/compact-threshold 0 0  完全关闭
/mem                  结构化记忆库（按需检索，不每轮注入）
/memory               查看/编辑 CLAUDE.md
/automem on|off       自动记忆：每轮结束自动提炼长期记忆
/summary              生成会话摘要标题（--apply 直接命名）`,

      session: `会话管理
━━━━━━━━━━━━━━━━━━━━━━━━
/clear            清空当前对话记录（会话 ID 不变，内容进对话回收站）
/clear-restore [n] 查看 / 恢复被 /clear 清掉的对话（保留最近 50 份）
/new              保存当前并开始新对话
/resume [id|名称]  切到上一个或指定会话（无参=上一个；切过去后回放最近 60 条历史）
/load             列出所有会话
/save             手动保存
/rename <名称>     给当前对话命名
/delete <id|all>  删除指定 / 全部（保留当前）
/branch [名称]     从当前对话创建分支
/export [文件]     导出对话（.md/.html/.json）
/incognito        隔离对话：不加载 CLAUDE.md，禁写本项目
/undo             撤销文件修改（支持跨文件）
/rewind           检查点恢复（文件或消息）
/retry            回到上次报错前并带报错重跑
/trash            回收站：restore <序号> / clear
/btw <问题>        顺嘴问一句，不打断主对话、不进主上下文
/replay           进入会话时是否显示历史（on|off，默认不显示）
                  想看历史用 /replay on；关时重启续接完全静默

自动行为：每 30 秒自动保存，启动默认新对话（Ctrl+X 重启则续接当前会话）`,

      tools: `工具 / 诊断
━━━━━━━━━━━━━━━━━━━━━━━━
/status       版本/模型/上下文/工具 一屏汇总
/doctor       诊断安装与配置问题
/check        重启预检：语法 + 未声明变量
/tools        已注册工具及只读/并发属性
/errors       最近运行错误
/stats        使用统计
/trace        Agent trace（list/show/status/path）
/hooks        Hooks 配置与事件数量
/diff         git diff（--staged 看暂存，--task 只看本轮改动）
/review       工作区审查（git/大文件/TODO/安全）
/workflow     Explore→Plan→Implement→Review 说明
/skills       Skills 摘要（<关键词> 搜索，page <页> 分页）
/plugin      插件（DSH 生态宿主；/plugins 别名）
/permissions  工具权限规则（allow/deny/ask）
/permissions mode <default|acceptEdits|plan|bypassPermissions>
/context7     Context7 MCP（setup/enable/disable/status）
/bg-list      后台任务列表（/bg-status <id> 看单个）
/tasks        持久化任务（跨重启存活，子 Agent 可领取协作）
          /tasks [列表名] · lists 看所有列表 · clear 清空
/agents       子 Agent 状态：谁在跑、跑了多久、卡住了吗
          cards 看角色卡 · reload 改完立刻生效 · new 进向导建卡
/team         多 Agent 协作团队（团队名 = 任务列表名）
          /team 看全部 · /team <名称> 看详情 · /team disband <名称>
/todos        待办列表
/away [all|clear]  你不在时自动接续做了什么
/goal <目标描述>    目标契约：自动跨轮推进直到达成/预算用尽
/goal              看当前目标与进度（/goal help 看全部子命令）
/goal proof <判据>  设完成判据（怎么证明做完了）
/goal bound <禁区>  设边界   /goal budget <12|30m|200k> 改预算
/goal pause|resume|clear     暂停 / 继续 / 放弃
/watch [on|off]    持续模式：不主动结束，盯队列继续做
/deep              复杂任务模式（轮数上限 300 → 3000）
/plan              计划模式
/coordinate        协调者模式：主对话只拆解/派活/汇总，自己不写代码
          /coordinate on|off · /coordinate <任务> 开启并跑首个任务
          Web 端叫 /cowork（同一个东西）`,

      ui: `界面 / 输入
━━━━━━━━━━━━━━━━━━━━━━━━
行末加 \\ 回车        换行继续输入
Ctrl+J / Shift+Enter / Alt+Enter  插入换行
Ctrl+I               补全命令名或文件路径（启动后首次按下=填入 /resume）
Ctrl+A/E             行首 / 行尾
Ctrl+L               清屏（不清对话历史）
Ctrl+C（空行）       退出程序（同 /exit、/quit）
Ctrl+X               重启
/palette             命令面板：模糊搜全部命令，回车直接执行（别名 /p）
Ctrl+T/Y/O           折叠待办/活动/全部看板
Ctrl+H               收起/展开顶部欢迎页
Ctrl+P/N             处理中翻排队消息（选中后回车写回；改字=变成新消息）
Ctrl+S               把排队消息【立即注入当前任务】（模型下一轮就能看到，不打断当前工具批次）
                     普通消息 → 作为补充指令注入；slash 命令 → 白名单内立即插队执行
Ctrl+G               删除当前翻到的排队消息（发错了不用干等）
长粘贴自动折叠，Ctrl+I 展开
/keys                快捷键速查（按手机常用度排序）

/board [todo|activity|all]  全屏侧边看板
/statusline           自定义底部状态行
/font [reset]         看当前字体 / 恢复默认（不支持换字体）
/greeting on|off      开场白（关闭省一次 API 调用）
/markdown [样式]      Markdown 渲染样式（影响正文里的标题/代码/表格配色）
  classic               经典 —— ANSI 16 色，兼容性最好（默认）
  official              官方 —— 对齐 claude-code darkTheme 的真彩色
  也认中文：/markdown 经典 · /markdown 鲜艳
/voice                正文语音朗读（像豆包那样念给你听）
  on | off              开关（工具调用不念，只念正文）
  <音色>                 yunxia 少年音(默认) / xiaoxiao 女声温和
                        yunxi 男声沉稳 / yunjian 男声浑厚
                        xiaoyi 女声活泼 / liaoning 东北 / shaanxi 陕西
  rate <+10%>           调语速（±100%）
  stop                  停掉当前朗读，不改开关
/editor [初始文字]     外部编辑器写长消息
/copy                 复制最后回复到剪贴板`,

      ext: `扩展 / 集成
━━━━━━━━━━━━━━━━━━━━━━━━
@路径              消息里写 @core/api.mjs 自动附文件内容
.claude/commands/*.md   自定义 slash（$ARGUMENTS / $1）
.claude/agents/*.md     自定义 subagent_type

/qq       QQ 桥（在 QQ 上直接跟我说话）
      on / off / status / send <内容>
      setup                           向导：主人号 / 端口 / API 一次配完
      owner <QQ号> / port <端口> / api <URL>
/web      Web 服务（start/status/open）
/mail     邮箱账号（收验证码/读邮件/发邮件，支持多账号，改完需重启）
      /mail                          看所有账号（授权码打码）
      add                            向导添加；或一行式
                                     add <别名> <邮箱> <授权码> [imap] [端口]
      rm <别名> · default <别名>      删除 / 设默认
      pass|user|host|port [别名] <值>  单项修改
/mcp      MCP 服务器（list/status/tools/enable/disable）
      status                          附带每个服务器的工具名
      tools [名字]                    看工具详情
      enable|disable <名字>           启/禁用（disable 立即停进程，enable 需重启）
/plugin   插件（DSH 生态，Cordis 插件框架；/plugins 是别名）
      /plugin                        看宿主状态（服务数 / 插件活跃度 / provider）
      providers                      看 provider 的 CCM 接入地址
      bundles                        看可安装插件包（含描述与状态）
      install <包名>                 安装并加载（如 dsh-freeroute）
      remove <包名>                  卸载（npm 包保留）
      enable|disable <包名>          启停（重启宿主生效）
      宿主未运行时自动拉起；源码在 ~/claude-code-mobile/dsh-host/
/pexels   图库搜索 key（FindImage 用）
      set <key> / test / clear        test 会显示剩余额度
/keepalive  息屏保活（on|off|auto on|auto off，自动保活默认开）
/device   手机 Shell 通道 / 虚拟副屏 / 操作模式
      /device                    看总览（通道探测 + 副屏 + 模式）
      shell auto|shizuku|adb     选通道（默认 auto：试 shizuku，失败落 adb）
      adb <host:port>            配 adb 回环（如 127.0.0.1:5555）
      test                       测当前通道能否用
      vd start|stop|status       虚拟副屏进程（后台操作手机用）
      mode                       看手机操作模式
      mode 主屏|副屏|选择        设了就固定用那个屏、不再弹选择；
                                 「选择」= 每次用手机工具都问你；off 清掉偏好
/x11 on|off|status  浏览器是否拉起 Termux:X11（off 时仍起后台 X server，可手动开 APP 盯）
/update   检查并更新到最新版（从镜像下载，不覆盖用户数据）
      /update                  检查 + 更新（更新完按 Ctrl+X 重启生效）
      /update check            只看有没有新版，不下载
      /update mirror <url>     设置镜像前缀（默认 gh-proxy.com）
      /update mirror off       直连 GitHub（国内可能不通）
      启动时会自动静默检查，有新版会打黄色提示
/add-dir <路径>     添加工作目录
/workspace [路径]   查看/设置工作区（默认 /sdcard/Download/claude-workspace）

/image [路径|序号] [说明]  发图给我看（无参=最新截图；/image 3=最近第3张；/image list 挑图；vision on 时原图直入）

/imagegen 生图配置（Agent 的 ImageGen 工具用哪个 API 画图）
      无参数 = 查看当前配置
      setup                     向导：url/key/model/size/dir 一次配完
      url <完整URL>             生图 API 地址：填 base（https://中转站/v1，自动拼 /images/generations）
                                或填完整端点（https://中转站/v1/images/generations）
      key <密钥或\${ENV}>       密钥（支持环境变量引用）
      model <模型名>            模型（如 gpt-image-2、dall-e-3 等，看你的中转站支持什么）
      size <宽x高|auto>         默认尺寸
      dir <目录>                保存目录（默认 /sdcard/Download/claude-workspace）
      clear                     清空配置
      配置存 config.json 的 imageGen 字段；配好后直接说「画一张xxx」就行

MCP：项目根建 mcp.json
{
  "mcpServers": {
"服务名": { "command": "python3", "args": ["-m", "server"] }
  }
}

Skills：项目 skills/ 或 ~/.claude/skills/ 放 .md（同名项目优先）
---
description: 技能描述
---
内容（支持 {{query}} {{file}}）`,
}

/**
 * 命令名 → 主题的别名映射。
 *
 * 【为什么要有】用户不知道主题名叫什么，卡住时敲的是「/help goal」「/help key」
 * —— 手里正在用的那个命令名。原来一律回「没有这个主题」，
 * 等于把「不知道怎么用」变成「连帮助都找不到」。
 * 主题名是我们的内部分类，不该要求用户先猜对。
 */
export const HELP_TOPIC_ALIASES = {
  goal: 'tools', watch: 'tools', deep: 'tools', plan: 'tools', away: 'tools',
  key: 'model', url: 'model', name: 'model', config: 'model', provider: 'model',
  agents: 'tools', team: 'tools', tasks: 'tools', mcp: 'ext', skills: 'ext',
  compact: 'context', memory: 'context', mem: 'context',
  save: 'session', load: 'session', resume: 'session', rewind: 'session',
  font: 'ui', board: 'ui', statusline: 'ui', keys: 'ui', editor: 'ui', markdown: 'ui',
  update: 'ext', replay: 'session',
}
