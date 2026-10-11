# claude-code-mobile 项目总览

> 统计日期：2026-09-18 ｜ 口径：源码行数（wc -l）
> 不含 node_modules / venv / .claude-code-mobile（运行时数据）/ web/dist（构建产物）

## 一、规模总览

| 模块 | 文件数 | 行数 |
|---|---:|---:|
| `index.mjs`（CLI 主入口） | 1 | 6,580 |
| `core/`（引擎） | 125 | 35,044 |
| `web/`（Web 应用源码） | ~50 | 31,738 |
| `skills/`（技能包） | 9 | 2,203 |
| `tools/`（辅助脚本） | 4 | 778 |
| 启动脚本与杂项 | 4 | ~600 |
| **合计（源码）** | | **≈77,000** |

补充：

- `web/` 细分：`server.mjs` 1,673 ｜ `src/` 28,433 ｜ 顶层（App.tsx 等）~1,600
- `web/dist/` 为构建产物（205 个文件），不计入源码
- `assets/` 283K（字体）｜ `CLAUDE.md` 786 行 ｜ `docs/` 2,511 行
- `.claude-code-mobile/` 约 227MB：会话、回收站、undo 快照、trace、截图等运行时数据

## 二、core/ 文件分布（125 个文件，35,044 行，按行数降序）

```
api.mjs                   2436
agent.mjs                 1563
cmd-extensions.mjs        1246
fullscreen-adapter.mjs    1244
readline.mjs               939
qq-bridge.mjs              877
tools-phone.mjs            806
fullscreen.mjs             730
prompts.mjs                662
skills.mjs                 651
tools-smart.mjs            619
tools-lookup.mjs           590
lsp.mjs                    573
onboarding.mjs             559
plan.mjs                   527
restart-preflight.mjs      517
compact.mjs                447
key-pool.mjs               428
cmd-agents.mjs             403
text2image.mjs             398
image.mjs                  388
goal.mjs                   385
tools-github.mjs           383
cli-task-state.mjs         368
vscreen.mjs                341
markdown.mjs               336
agent-tools.mjs            322
goal-runtime.mjs           318
status-report.mjs          318
edge-tts.mjs               307
wizard.mjs                 302
voice-read.mjs             292
tools-hashline.mjs         287
tools-teams.mjs            285
undo-multi.mjs             280
model-list.mjs             279
width.mjs                  278
pty.mjs                    273
tools-vision.mjs           271
cmd-key-pool.mjs           267
stream-args.mjs            260
help-topics.mjs            256
tools-imagegen.mjs         256
cmd-goal.mjs               253
termux-tools.mjs           248
cmd-queries.mjs            246
cron.mjs                   246
file-tools.mjs             245
hooks.mjs                  240
tasks.mjs                  238
engine-setup.mjs           234
trash.mjs                  234
tools-agent-status.mjs     230
tools-tasks.mjs            228
tools.mjs                  226
cmd-misc.mjs               224
teams.mjs                  223
agent-workflow.mjs         205
bg-tasks.mjs               204
auto-compact.mjs           197
memdir.mjs                 193
cmd-qq.mjs                 187
tools-goal.mjs             186
stream-md.mjs              182
task-diff.mjs              182
cmd-help.mjs               179
permissions.mjs            178
cmd-integrations.mjs       177
search-tools.mjs           177
select.mjs                 174
at-refs.mjs                171
cmd-small-config.mjs       170
palette.mjs                170
output-styles.mjs          169
mcp-client.mjs             168
trace.mjs                  166
ocr.mjs                    165
repo-map.mjs               158
bg-bash.mjs                155
mail-mcp-config.mjs        153
cmd-backup.mjs             151
overlay.mjs                150
tools-image-search.mjs     149
tavily.mjs                 148
cmd-compact.mjs            145
present-tool.mjs           142
word-diff.mjs              141
github.mjs                 137
hashline.mjs               137
extra-tools.mjs            133
auto-memory.mjs            132
qq-tools.mjs               130
persistence.mjs            128
side-question.mjs          128
mini-highlight.mjs         123
cmd-imagegen.mjs           122
agent-memory.mjs           120
tool-timeout.mjs           115
context-files.mjs          113
plugins.mjs                105
cmd-team-task.mjs           94
custom-commands.mjs         94
cmd-mem.mjs                 93
custom-agents.mjs           91
context7.mjs                90
compact-trash.mjs           88
env-secrets.mjs             86
web-keepalive.mjs           86
git.mjs                     85
tools-agent-memory.mjs      82
cmd-side.mjs                80
tools-cron.mjs              79
spinner-verbs.mjs           78
user-profile.mjs            75
screen-analyze.mjs          73
git-checkpoint.mjs          71
session-auto.mjs            65
status-probe.mjs            62
cmd-permissions.mjs         59
provider-url.mjs            59
cmd-web.mjs                 55
export.mjs                  41
workspace.mjs               30
atomic.mjs                  22
noninteractive.mjs           9
```

体量最大的几个及职责：

| 文件 | 行数 | 职责 |
|---|---:|---|
| `api.mjs` | 2436 | LLM API 客户端：三协议（openai/anthropic/responses）、流式解析、重试/换 key、思考策略、连接健康 |
| `agent.mjs` | 1563 | Agent 主循环：轮次、工具调度、流式渲染、错误重试、deep/watch、tracing |
| `cmd-extensions.mjs` | 1246 | `/config` 命令全套（provider/key/vision/stream/profile…） |
| `fullscreen-adapter.mjs` | 1244 | 全屏 UI 适配层 |
| `readline.mjs` | 939 | 输入行编辑（补全、快捷键、CJK 宽度） |
| `qq-bridge.mjs` | 877 | QQ 桥：私聊/群消息、按 turn 回复、CLI 同步 |
| `tools-phone.mjs` | 806 | 手机控制工具（Shizuku/rish） |
| `fullscreen.mjs` | 730 | 全屏渲染主逻辑 |
| `prompts.mjs` | 662 | 系统提示词与运行时变量注入 |
| `skills.mjs` | 651 | Skill 加载器（扫描、缓存、按路径激活） |

## 三、Slash 命令（内置 87 个 + 隐藏 1 个 + 可扩展）

补全来源 = 内置 + `.claude/commands/*.md` 自定义命令 + skill 名（可直接 `/skill名`）。
隐藏命令不进面板与 `/help`。

### 会话管理

| 命令 | 说明 |
|---|---|
| `/new` | 开新会话 |
| `/clear` | 清空当前对话（进 cleared 回收站） |
| `/clear-restore` | 恢复被 /clear 清掉的对话 |
| `/save` `/load` | 保存 / 载入会话 |
| `/resume` | 按列表或名字恢复历史会话 |
| `/rename` | 会话命名（重名会被拦截） |
| `/delete` | 删除会话（all 清空，当前会话保留） |
| `/branch` | 从当前对话分叉新会话 |
| `/rewind` | 回退对话到某轮 |
| `/retry` | 重跑上一轮输入 |
| `/export` | 导出对话为 Markdown |
| `/copy` | 复制最后一条回复 |
| `/incognito` | 隐身模式（不落盘、禁敏感命令） |
| `/exit` `/quit` | 退出 |

### 模型与 Provider

| 命令 | 说明 |
|---|---|
| `/config` | Provider 管理主入口（列表/切换/详情/向导） |
| `/model` `/url` `/name` `/key` | 改模型 / URL / 显示名 / key，立即生效 |
| `/protocol` | 切换协议（openai / anthropic / responses） |
| `/effort` | 思考强度（none→max 七档） |
| `/temperature` | 采样温度 |
| `/key` 无参 | key 池运行时状态（谁在用/冷却/成败） |
| `/keys` | 快捷键表 |
| `/config profile` | 整套配置保存/载入 |

### 上下文与压缩

| 命令 | 说明 |
|---|---|
| `/compact` | 手动压缩（micro 无损回收 / force 摘要压缩） |
| `/compact-threshold` | 自动压缩触发阈值 |
| `/compact-trash` | 压缩前完整快照的回收站 |
| `/context` | 上下文占用与上限明细 |
| `/cost` | token 用量与费用估算 |
| `/status` | 一屏状态汇总 |
| `/summary` | 当前对话的一句话摘要（侧问模型） |

### 模式与自动化

| 命令 | 说明 |
|---|---|
| `/plan` | 计划模式开关（只读探查 + 计划） |
| `/deep` | deep 模式（普通 300 轮 → deep 3000 轮） |
| `/watch` | 持续模式（不因无工具调用结束） |
| `/goal` | 目标模式：设目标/边界/预算，跨轮推进 |
| `/away` | 团队 away 模式 |
| `/automem` | 自动记忆提取开关 |

### 多 Agent 与任务

| 命令 | 说明 |
|---|---|
| `/agents` | 子 Agent 状态一览 |
| `/team` | 团队协作状态 |
| `/tasks` | 持久任务列表（可跨重启认领） |
| `/todos` | 本会话待办面板 |
| `/bg-status` `/bg-list` | 后台任务（Bash 后台、子 Agent） |
| `/workflow` | AgentWorkflow 说明（Explore→Plan→Implement→Review） |

### 工具与集成

| 命令 | 说明 |
|---|---|
| `/tools` | 已注册工具清单（含只读/可并发标记） |
| `/skills` | 技能浏览 |
| `/plugins` | 插件管理 |
| `/mcp` | MCP 服务器管理（增删、启停、工具） |
| `/hooks` | 钩子事件状态 |
| `/context7` | Context7 文档源 |
| `/github` | GitHub 集成配置 |
| `/mail` | 邮件（QQ 邮箱 MCP） |
| `/qq` | QQ 桥配置 |
| `/imagegen` | 生图配置向导 |
| `/image` | 发图给模型（视觉/OCR） |
| `/pexels` | 图库（找图） |
| `/x11` | X11 服务（vscreen） |
| `/web` | Web 界面管理 |
| `/voice` | 语音朗读开关 |

### 界面与外观

| 命令 | 说明 |
|---|---|
| `/style` | 输出风格（Explanatory / Learning…） |
| `/statusline` | 状态行配置 |
| `/greeting` | 开场白开关 |
| `/font` | 字体查看/恢复默认 |
| `/board` | 看板面板切换（todo/activity） |
| `/palette` `/p` | 命令面板 |
| `/me` | 用户资料（称呼等） |
| `/files` | 上下文文件记录 |
| `/btw` | 旁问：顺嘴问一句，不打断主对话、不进上下文 |

### 系统与诊断

| 命令 | 说明 |
|---|---|
| `/help` | 分层帮助（`/help <主题>`） |
| `/doctor` | 环境体检（git/依赖/配置） |
| `/check` | 重启预检（Ctrl+X 前跑的那套） |
| `/review` | 工作区静态审查（git 状态、可疑文件） |
| `/diff` | 查看工作区改动 |
| `/errors` | 最近错误记录 |
| `/trace` | 运行 trace 查看 |
| `/stats` | 使用统计 |
| `/memory` | CLAUDE.md 记忆查看/追加 |
| `/mem` | 结构化记忆（增删查） |
| `/permissions` | 工具权限管理 |
| `/undo` | 撤销最近文件改动 |
| `/trash` | 文件回收站（恢复删除的文件） |
| `/keepalive` | 息屏保活（wake-lock + 静音音频） |
| `/backup` | 备份（隐藏命令） |
| `/editor` | 外部编辑器写长 prompt |
| `/add-dir` `/workspace` | 工作区目录管理 |

### 扩展机制

- **自定义命令**：`.claude/commands/*.md` 自动作为 `/命令名`
- **Skill 直调**：`skills/<名字>/SKILL.md` 可直接 `/名字` 调起（与 Skill 工具同一实现）

## 四、Agent 侧工具（~103 个，另加 MCP 动态工具）

主注册在 `index.mjs`（Web 版由 `core/engine-setup.mjs` 的 createEngineToolkit 共享大部分）。

### 文件与编辑（12）

| 工具 | 说明 |
|---|---|
| `Read` | 读文件（支持行范围） |
| `Write` | 写文件（整文件覆盖） |
| `Edit` | 精确字符串替换 |
| `MultiEdit` | 原子多处替换 |
| `ApplyPatch` | unified diff 打补丁（多文件原子） |
| `HashlineRead` | 带锚点读（防并发改动） |
| `HashlineEdit` | 按锚点编辑（比字符串匹配安全） |
| `HashlineGrep` | 搜索（结果带锚点，可直接编辑） |
| `SafeRename` | 重命名标识符（全库扫描预览） |
| `Glob` | 文件名匹配查找 |
| `Grep` | 内容正则搜索 |
| `CodeSearch` | 语义/索引搜索（找"那个函数叫什么"） |

### Shell 与进程（4）

| 工具 | 说明 |
|---|---|
| `Bash` | PTY shell 执行 |
| `BashOutput` | 读后台命令增量输出 |
| `KillShell` | 终止后台命令 |
| `Sleep` | 等待（限 300s） |

### Git（5）

`GitStatus` `GitDiff` `GitLog` `GitAdd` `GitCommit`

### 搜索与联网（4）

| 工具 | 说明 |
|---|---|
| `WebFetch` | 抓网页 |
| `WebSearch` | Tavily 联网搜索 |
| `SearchInfo` | 十源资料搜索（B站/知乎/CSDN/HN/GitHub…） |
| `Lookup` | 打开资料卡条目抓全文 |

### 交互与记忆（6）

`AskUserQuestion`（问用户）｜`UserInputHistory`（翻输入历史）｜`Memory`（写 CLAUDE.md）｜`AgentMemory`（跨会话 Agent 记忆）｜`Skill`（载入技能正文）｜`TodoWrite`（待办面板）

### 图像与媒体（6）

`ViewImage`｜`ViewVideo`（关键帧抽帧）｜`Screencap`（Shizuku 截图+OCR）｜`ImageGen`（生图/改图）｜`FindImage`（Pexels 找图）｜`ReverseImage`（以图识图）

### 手机控制（9，Shizuku/rish）

`phone_snapshot`｜`phone_screenshot`｜`phone_click`｜`phone_tap_xy`｜`phone_type`｜`phone_swipe`｜`phone_key`｜`phone_wait`｜`phone_app`

### Termux 集成（10）

`ClipboardSet`｜`ClipboardGet`｜`Toast`｜`Notify`｜`Share`｜`Vibrate`｜`Location`｜`Battery`｜`OpenUrl`｜`TTS`

### 持久任务（6）

`TaskCreate`｜`TaskList`｜`TaskGet`｜`TaskUpdate`｜`TaskClaim`｜`TaskDelete`（跨轮/跨重启/可被其它 agent 认领）

### 团队协作（7）

`TeamCreate`｜`TeamJoin`｜`SendMessage`（支持 wake 唤醒子 agent）｜`CheckMessages`｜`TeamStatus`｜`TeamLeave`｜`TeamDisband`

### 子 Agent（5）

| 工具 | 说明 |
|---|---|
| `Agent` | 起独立子 agent（独立上下文，可后台） |
| `AgentWorkflow` | 多阶段工作流（Explore→Plan→Implement→Review） |
| `AgentStatus` | 查后台子 agent 状态/耗时 |
| `AgentStop` | 中止子 agent |
| `AgentOutput` | 取子 agent 输出（支持阻塞等待） |

### Goal（3）

`GetGoal`（读目标与预算余量）｜`GoalStatus`（complete/blocked/paused 唯一出口）｜`SetGoalBudget`（追加预算）

### GitHub（8）

`GitHubRepo`｜`GitHubIssues`｜`GitHubIssueView`｜`GitHubPRs`｜`GitHubPRComments`｜`GitHubComment`｜`GitHubCreateIssue`｜`GitHubFile`

### 开发辅助（8）

| 工具 | 说明 |
|---|---|
| `Test` | 跑测试/检查命令（结构化返回） |
| `Diagnostics` | 代码诊断（LSP/语法） |
| `RepoMap` | 代码库结构地图 |
| `Symbols` | 符号检索（类/函数/常量） |
| `LSP` | LSP 直调（诊断/悬浮/定义/补全） |
| `CommandExec` | 执行 slash 命令（程序内） |
| `Present` | 内联展示（svg/html/mermaid/视频帧）※ Web 专用 |
| `ExtendTurns` | 计划模式运行时注入的续轮工具 |

### 定时任务（3）

`CronCreate`｜`CronList`｜`CronDelete`（跨会话持久）

### 模式控制（4）

`EnterPlanMode`｜`ExitPlanMode`｜`EnterDeepMode`｜`ExitDeepMode`

### QQ（2）

`QQPush`（推送到主人 QQ）｜`QQRecall`（回溯群消息）

### MCP（动态）

`mcp__<服务器>__<工具>`：按配置动态注册，CLI 与 Web 共享。

## 五、其他功能（按模块）

**多 Provider 与容错**
key 池轮换（401/403 自动换）、三协议自动适配、连接健康探测与坏连接弃池、maxOutputTokens 自动夹取、vision 路由（本模型/兜底模型）、profile 整套配置存取、provider 向导（交互 + 一行式）。

**上下文与压缩**
micro 无损回收 + force 摘要压缩、自动压缩阈值、压缩前快照（compact-trash 可恢复）、摘要分段与限额、token 真值计量（API 返回）、状态条实时速率（tok/s）。

**会话**
30s 自动保存、resume/latest、会话重名保护、/clear 与文件双回收站、undo/rewind/branch/retry、导出 Markdown、会话文件超量自动清理（保留最近 N 个）。

**多 Agent 协作**
子 agent（独立上下文、可后台、可取输出）、四阶段工作流、团队（inbox 自动送达、任务板、空闲统计）、持久任务（claim 机制防重复认领）。

**模式系统**
plan（只读探查）、deep（3000 轮）、watch（持续）、goal（四要素 + 预算 + blocked 收尾）、away（团队）、incognito（隐私）。

**记忆系统**
CLAUDE.md（Memory 工具 + /memory）、automem 自动提取（每轮后台）、结构化 /mem（独立记忆文件）、AgentMemory（按 agent 类型的跨会话经验）。

**工具生态**
MCP 客户端（stdio + http，/mcp 管理，CLI/Web 共享）、插件系统、hooks（SessionStart/PreToolUse/PostCompact 等 8 事件）、自定义命令（.claude/commands）、skills（SKILL.md + 缓存 + 按路径激活）。

**移动端**
Shizuku/rish 手机控制（快照式 UI 操作，不截图识图）、Termux 十件套、X11/vscreen（跑桌面程序）、playwright-x11 包装。

**消息通道**
QQ 桥（私聊 + 群 @，按 turn 发消息、超长转图、未完成必回执）、CLI 对话同步到 QQ、QQPush/QQRecall 工具、邮件（QQ 邮箱 MCP）。

**渲染与输入**
Markdown 流式渲染、word-diff、CJK 宽度处理、readline 编辑（补全/历史/多行）、全屏模式（备用屏、看板、状态条）、spinner 动词库、overlay/select 交互组件。

**运维与诊断**
重启预检（scan/syntax/references/module-links）、Ctrl+X 重启（start.sh exit 250 自动拉起）、crash.log、trace 运行记录、/doctor 体检、备份系统（backup 工具 + worker + 回收站）。

**Web 界面（web/）**
React + Vite（会话/项目/设置/定制页、工具思考链、TodoPanel）、server.mjs（会话管理、SSE 流式、MCP 共享、Present 内联展示——svg/html/mermaid/参数滑块）、pyodide 运行器。

**定时任务**
Cron 工具（5 字段表达式、跨会话持久、一次性/循环）。

## 六、运行时数据目录（.claude-code-mobile/，约 227MB）

| 目录/文件 | 内容 |
|---|---|
| `sessions/` | 会话 JSON（自动保存、resume、重名索引） |
| `trash/` | 文件回收站（/trash 恢复，rm 自动进） |
| `undo/` | 文件改动 undo 快照（/undo） |
| `cleared/` | /clear 清掉的对话快照 |
| `screen-shots/` | 截图历史 |
| `automem.json` | 自动记忆提取游标 |
| `preflight-ok.json` | 重启预检缓存（sha1 快速通道） |

## 七、如何重新生成统计

```bash
# 总规模
wc -l index.mjs && wc -l core/*.mjs | tail -1
find web -type f \( -name '*.tsx' -o -name '*.mjs' \) | grep -v node_modules | grep -v /dist/ | xargs wc -l | tail -1

# core 分布
wc -l core/*.mjs | sort -rn

# slash 命令清单
node -e "const s=require('fs').readFileSync('index.mjs','utf8');console.log(s.match(/BUILTIN_COMMANDS = \[.*?\]/s)[0])"

# 工具清单（运行时）：node index.mjs 然后 /tools
```
