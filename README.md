# Claude Code Mobile

> 在 Android 手机上跑一个 Claude Code 风格的 AI 编程助手 —— 纯 Termux 环境，无需 root，无需电脑。

一个从零实现的 AI Agent 客户端，对齐 Anthropic 官方 Claude Code 的交互习惯与工具协议，
但完全独立开发、运行在 Android/Termux 上。

---

## 这是什么

Claude Code Mobile（简称 CCM）是一个**运行在 Android 手机上的命令行 AI 编程助手**。

它长这样：

```
❯ 帮我看看 core/api.mjs 里的重试逻辑

● Read (core/api.mjs)
  ⎿ 1: // Claude Code Mobile - API 客户端
    2: import { ...

∴ Thinking…
  用户想看重试逻辑，先读文件找到相关代码…

● api.mjs 里的重试分三层，我来梳理一下：

  1. **连接层**（STREAM_CONNECT_TIMEOUT = 150s）—— 只管建连阶段
  2. **API 层**（maxRetries = 3）—— 内部退避重试
  3. **Agent 层** —— 只在特定错误类型上重试

  ⚠️ 这三层会叠加放大：一次 60s 超时实际可能跑 687 秒。
```

**它不是 Anthropic 官方产品**，而是一个独立实现 —— 对齐官方 Claude Code 的交互风格、
工具协议（Read/Write/Edit/Bash/Glob/Grep 等）和 Agent 架构，代码全部自研。

---

## 核心特性

### 🤖 Agent 能力

- **完整工具集**：Read / Write / Edit / MultiEdit / ApplyPatch / Glob / Grep / Bash / WebSearch /
  WebFetch / TodoWrite / Task 等 **60+ 工具**
- **子 Agent 系统**：可派发独立 Agent 并行处理任务，支持递归派生（并发上限 24）
- **多 Agent 协作**：Team 工具组（建组/派活/通信/收工），Task 持久化待办跨重启存活
- **AgentWorkflow**：Explore → Plan → Implement → Review 四阶段工作流
- **长期记忆**：AgentMemory 按类型分池、跨会话保留经验

### 📱 手机特化（这是它和桌面版最大的不同）

- **虚拟副屏操作**：在后台静默操作其他 App（不占用你的屏幕），基于 Shizuku + VirtualDisplay
- **主屏操作模式**：也可以在前台操作，你能看见 AI 点哪
- **元素树快照**：文本格式的 UI 树（比截图快一个数量级），模型直接读文本操作
- **语音播报**：任务开始/关键节点/完成时用 Edge TTS 播报进展
- **手机原生能力**：剪贴板、通知、震动、TTS、GPS、电池、截图

### 💬 交互体验

- **全屏终端 UI**：固定输入框 + 可滚动正文 + 常驻状态栏（对齐官方 Claude Code 布局）
- **流式 markdown 渲染**：边收边渲染，支持代码高亮、表格、列表
- **思维链显示**：`∴ Thinking…` 三态状态机（思考中/已思考/隐藏）
- **工具输出窗口**：长命令实时输出滚动显示，结果到达后写回工具行位置
- **会话管理**：多会话切换、历史回放、分支、检查点回退
- **Prompt Cache 优化**：支持 `prompt_cache_key` 与 24h 保留，显著降低成本

### 🌐 Web 端

同一套内核，也有浏览器界面（Vue 3 + Vite）：
- 完整的对话界面、模型选择器、设置面板
- 与 CLI 共享配置与会话数据
- 可通过局域网在电脑上访问手机里的助手

### 🔌 扩展性

- **MCP 支持**：接入任意 Model Context Protocol 服务器（Playwright、邮件、通知等）
- **Skills 系统**：可插拔的技能包（动画设计、UI 库选择、视频制作等）
- **自定义命令**：`.claude/commands/*.md` 手写 slash 命令
- **自定义 Agent**：`.claude/agents/*.md` 定义专属角色（CTO/QA/产品经理…）
- **Hooks 系统**：SessionStart / PreToolUse / PostToolUse / Stop 等事件钩子
- **Cron 定时任务**：到点自动执行一段 prompt

---

## 快速开始

### 环境要求

- **Android 手机**（已在 REDMI Note 15 Pro / Android 15 上验证）
- **Termux**（从 [F-Droid](https://f-droid.org/packages/com.termux/) 安装，不要用 Play 商店版）
- **Node.js 18+**（`pkg install nodejs`）
- 一个 **OpenAI 兼容的 API 端点**（官方 OpenAI / 中转站 / 本地反代均可）

### 安装

```bash
# 1. 装依赖（nodejs 必需，termux-api 可选但推荐，见下）
pkg install nodejs git termux-api

# 2. 克隆项目
cd ~
git clone https://github.com/wzy-20130517/Claude-Code-Mobile.git claude-code-mobile
cd claude-code-mobile

# 3. 装 npm 依赖
npm install

# 4. 启动（首次会进配置向导）
bash start.sh
```

首次启动会引导你填：
- **API 地址**（如 `https://api.openai.com/v1`，或你的中转站地址）
- **API Key**
- **模型名**（如 `gpt-4o`、`claude-sonnet-4`，取决于你的端点支持什么）
- **终端字体**（字体已内置在项目里，选完直接装、无需联网）

配置存在 `~/.claude-code-mobile/config.json`，**源码目录不含任何用户数据**。

### 启动方式

**首次启动必须用 `bash start.sh`**（它会做两件事：装依赖、把 `claude` 命令注册到 `$PREFIX/bin`）。
之后就可以用全局命令了：

```bash
claude          # 启动 CLI（等同于 bash start.sh）
claude web      # 启动 Web 端（后台守护 + 自动打开浏览器）
```

`claude web` 会在 `http://127.0.0.1:3456` 起一个 Web 服务，手机浏览器或局域网内的电脑都能访问。

> 全局命令的安装逻辑在 `start.sh` 里：它把启动器写进 `$PREFIX/bin/claude`，
> 且**不会覆盖**已有的同名命令（如果你装过官方 Claude Code，两者不冲突）。

### 可选依赖：Termux API

部分功能依赖 **termux-api**（Termux 的 Android 能力桥）：

```bash
pkg install termux-api
# 还要装 Termux:API 应用（F-Droid 搜索 "Termux:API"）
```

装好后可用：

| 功能 | 对应工具 |
|---|---|
| 系统通知 | `Notify` |
| 剪贴板读写 | `ClipboardGet` / `ClipboardSet` |
| 语音播报 | `say` / `TTS` |
| 震动、电量、GPS | `Vibrate` / `Battery` / `Location` |
| 分享到其他 App | `Share` |

**不装也能用**，只是这些工具会报「未安装 termux-api」。

### 可选：手机操作能力（虚拟副屏）

需要额外安装 **Shizuku**（[官网](https://shizuku.rikka.app/)）并授权给 Termux：

```bash
# 装 rish（Shizuku 的命令行工具）
# 在 Shizuku 应用内：「使用 Shizuku 的应用程序」→ Termux → 授权
# 然后导出 rish
```

装好后 AI 就能在后台操作其他 App 了。

---

## 常用命令

### 会话管理

| 命令 | 作用 |
|---|---|
| `/new` | 保存当前会话，开始新对话 |
| `/resume [ID\|名称]` | 切到指定或上一个会话（带历史回放） |
| `/load` | 列出所有会话 |
| `/rename <名称>` | 给当前会话起名 |
| `/branch <名称>` | 从当前对话创建分支 |
| `/rewind` | 查看检查点 / 回退消息 |
| `/compact` | 压缩上下文（自动选策略） |
| `/clear` | 清空当前对话记录 |

### 配置

| 命令 | 作用 |
|---|---|
| `/config` | Provider 管理（切换/添加/删除） |
| `/model <名称>` | 改模型 |
| `/url <地址>` | 改 API 地址 |
| `/key <sk-...>` | 改 API Key（支持多 key 轮换池） |
| `/effort <级别>` | 深度思考强度（none/minimal/low/medium/high/xhigh/max） |
| `/style <名字>` | 输出风格（default/Explanatory/Learning 或自定义） |
| `/markdown <样式>` | 终端 Markdown 渲染样式（classic/official） |

### 工具与扩展

| 命令 | 作用 |
|---|---|
| `/mcp` | 管理 MCP 服务器 |
| `/skills` | 查看可用技能 |
| `/agents` | 管理自定义 Agent |
| `/hooks` | 查看 Hooks 配置 |
| `/permissions` | 工具权限（allow/deny/ask） |
| `/goal <目标>` | 设定完成契约，自动推进直到达成 |

### 手机相关

| 命令 | 作用 |
|---|---|
| `/device` | 手机操作通道状态（Shizuku/adb） |
| `/device mode` | 主屏 / 副屏 / 每次询问 |
| `/voice` | 正文语音朗读开关与音色 |
| `/say <文本>` | 让 AI 主动语音播报 |

**共 91 个内置命令**（上表只列了常用的），另有 9 个内置技能包。
按 `/help` 看全部，`/help <主题>` 看详细说明，`/palette` 开模糊搜索面板。

### 快捷键

| 按键 | 作用 |
|---|---|
| `Ctrl+I` | 补全命令名 / 文件路径（首次按=填入 `/resume`） |
| `Ctrl+J` | 插入换行（也支持 `Shift+Enter`） |
| `Ctrl+P/N` | 上一条 / 下一条历史 |
| `Ctrl+L` | 清屏 |
| `Ctrl+C` | 清行 / 退出 / 打断当前任务 |
| `Ctrl+X` | 保存会话并重启 |
| `Ctrl+T/Y/O` | 折叠待办 / 活动 / 全部看板 |

---

## 项目结构

```
claude-code-mobile/
├── index.mjs              # CLI 主入口（约 6800 行）
├── start.sh               # 启动脚本（含重启循环、全局命令安装）
├── start-web.sh           # Web 端启动
│
├── core/                  # 核心模块（137 个文件，约 4.1 万行）
│   ├── agent.mjs          # Agent 主循环（工具调用、多轮、并发执行）
│   ├── api.mjs            # API 客户端（OpenAI/Anthropic/Responses 三协议）
│   ├── prompts.mjs        # 系统提示词（工具说明、行为准则）
│   ├── tools-*.mjs        # 各类工具实现
│   ├── cmd-*.mjs          # Slash 命令实现
│   ├── fullscreen*.mjs    # 全屏终端 UI（虚拟屏幕、diff 渲染）
│   ├── readline.mjs       # 输入处理（手机快捷键、多行、补全）
│   ├── markdown.mjs       # Markdown 渲染器
│   ├── plan.mjs           # 子 Agent 系统
│   ├── tools-phone.mjs    # 手机操作工具集
│   └── paths.mjs          # 统一路径解析（数据目录）
│
├── web/                   # Web 端（Vue 3 + Vite）
│   ├── server.mjs         # HTTP/SSE 服务
│   └── src/               # 前端源码
│
├── skills/                # 内置技能包
├── tools/                 # 辅助脚本（MCP server、备份 worker 等）
├── assets/                # 字体等静态资源
└── docs/                  # 开发文档
```

### 数据目录

**用户数据全部在 `~/.claude-code-mobile/`，与源码完全分离**：

```
~/.claude-code-mobile/
├── config.json            # Provider / Key / 各种开关
├── CLAUDE.md              # 项目记忆（AI 的行为准则与踩坑记录）
├── hooks.json             # Hooks 配置
├── mcp.json               # MCP 服务器
├── permissions.json       # 工具权限
├── sessions/              # 会话存档
├── trash/                 # 文件回收站
├── undo/                  # 撤销快照
├── agents/                # 自定义 Agent 角色
└── agent-memory/          # 子 Agent 长期记忆
```

这样设计的好处：**源码目录可以随便复制/重装**，配置和记忆跟着用户走。

---

## 技术要点

### 三协议支持

同一个 API 客户端支持三种协议，适配不同供应商：

| 协议 | 端点 | 说明 |
|---|---|---|
| `openai` | `/chat/completions` | 兼容性最好，中转站基本都认 |
| `anthropic` | `/v1/messages` | Claude 原生（thinking/cache 语义最准） |
| `responses` | `/responses` | OpenAI 新协议（推理项回传、服务端会话） |

### Prompt Cache

精确前缀匹配 + `prompt_cache_key`，缓存键按 **workspace 粒度**（不是 session），
跨会话复用系统提示词前缀。支持 24h 保留。状态栏实时显示命中率。

### 全屏终端 UI

自实现的虚拟屏幕（`core/vscreen.mjs`）+ diff 渲染：
- 只输出变化的单元格（而不是整屏重绘），手机上省电省流量
- 折行缓存按影响范围**局部失效**（实测把单帧 334ms 降到 0.2ms）
- 固定 header（欢迎页）+ 滚动 body + 固定 footer（输入框/状态栏）

### 手机操作架构

```
CCM (Termux)
  └─ rish (Shizuku) ─→ shell uid
       └─ VirtualDisplay（虚拟副屏）
            └─ UiAutomation（元素树 + 手势注入）
```

元素树以**平铺文本**返回（`#e12 Button "发送" 940,2100,1180,2200 c`），
模型直接读文本、用 id 点击，不用算坐标。

---

## 常见问题

**Q: 和官方 Claude Code 什么关系？**

独立实现。交互风格、工具协议对齐官方，但代码全部自研，**不是** Anthropic 官方产品，
也不包含任何官方代码。

**Q: 需要 root 吗？**

不需要。手机操作功能用 Shizuku（免 root 的 ADB 权限方案）。
不用手机操作的话，Shizuku 也可以不装。

**Q: 支持哪些模型？**

任何 OpenAI / Anthropic 兼容的端点。官方 API、中转站、本地反代都行。
通过 `/config` 可配多个 Provider 随时切换。

**Q: 数据存在哪？会不会上传？**

全在 `~/.claude-code-mobile/`，**不会上传到任何地方**。
API 请求只发给你自己配置的端点。

**Q: 我装过官方 Claude Code，`claude` 命令会冲突吗？**

不会。`start.sh` 安装全局命令时会先检查——如果 `$PREFIX/bin/claude` 已存在
且不是本项目的，就跳过安装，你的官方版不受影响。这时用 `bash start.sh` 启动本项目。

**Q: 为什么用 Node 而不是原生？**

Termux 环境用 Node 最容易装、最容易改。整个项目就是一堆 `.mjs` 文件，
改完重启即生效，不需要编译。

---

## 开发

```bash
# 改完代码后
node --check index.mjs     # 语法检查
# Ctrl+X 重启（会跑预检：语法 + 未声明变量 + import/export 链接）

# 查看运行状态
/status                    # 一屏汇总
/context                   # 上下文占用
/trace list                # 运行 trace（排查用）
```

**代码风格**：单文件优先、注释写「为什么」不写「是什么」、踩过的坑记进 CLAUDE.md。

---

## 许可

MIT

---

## 致谢

- 交互设计与工具协议参考 [Anthropic Claude Code](https://claude.com/claude-code)
- 手机操作架构参考 [agent-mobile-use](https://github.com/AcidGr/agent-mobile-use)
- 终端 UI 设计参考 [Kimi Code](https://kimi.moonshot.cn/)
