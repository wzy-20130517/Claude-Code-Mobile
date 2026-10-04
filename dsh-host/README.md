# dsh-host —— DSH 插件宿主

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）生态的
Cordis 插件能在 CCM 环境里加载运行。

## 架构

```
CCM ──► http://127.0.0.1:8790/p/<providerId>/v1   ← 稳定门面
           │
           ├─ 插件 loopback shim（随机端口 + 随机 token）
           └─ 插件 webEndpoint（webServer 上注册的端点）
                 └─► 上游（WorkBuddy / Trae / OpenCode Zen / ...）
```

**为什么需要门面**：插件的 shim 端口和 token 每次重启都变（随机），
写进 CCM 配置会失效。宿主用固定端口 + 固定 token 做门面，把随机性挡在里面。

## 组件

| 组件 | 说明 |
|---|---|
| `plugin-loader.mjs` | 宿主核心：官方 Cordis + Loader + 插件挂载 |
| `services.mjs` | **服务注册表**（数据驱动 + 依赖拓扑 + 容错）|
| `server.mjs` | 门面 HTTP 服务 + 控制 API |
| `start.sh` | 启停脚本 |

### 服务注册表设计（services.mjs）

```js
export const SERVICE_TABLE = [
  { name: 'llm', Klass: LlmRuntime, desc: 'LLM 路由注册' },
  { name: 'tools', Klass: ToolRuntime, deps: ['systemPrompt'], desc: '工具注册' },
  // ...
]
```

三个特性：
1. **数据驱动** —— 加服务 = 表里加一行（不用改三处）
2. **依赖拓扑** —— `deps` 声明依赖，注册器按序注册（自动处理 SystemPrompt→ToolRuntime 这类顺序）
3. **容错** —— 单个服务构造失败只记入 `failed`，不影响其他服务；依赖死锁记入 `skipped`

**提供的服务**（全部官方实现类）：

| 服务 | 来源 | 用途 |
|---|---|---|
| `ctx.llm` | `LlmRuntime`（dsh-llm）| LLM 路由注册 |
| `ctx.settings` | `SettingsProvider`（dsh-settings）| 插件配置 |
| `ctx.timer` | `TimerService`（cordis-plugin-timer）| 定时器 |
| `ctx.credentials` | `CredentialProvider`（dsh-credentials）| 凭据存取 |
| `ctx.subprocess` | `LocalSubprocessRuntime`（dsh-subprocess-local）| 子进程 |
| `ctx.webServer` | `WebServer`（dsh-host-webserver）| 插件 HTTP 端点 |
| `ctx.systemPrompt` | `SystemPrompt`（dsh-system-prompt）| 提示词组装 |
| `ctx.tools` | `ToolRuntime`（dsh-tools）| 工具注册 |
| `ctx.skills` | `SkillRegistry`（dsh-skill）| 技能注册 |
| `ctx.fs` | `LocalFileSystem`（dsh-fs-local）| 文件系统 |
| `ctx.shell` | `LocalBashExecutor`（dsh-bash-local）| Shell 执行 |
| `ctx.agents` | `AgentRegistry`（dsh-agent）| Agent 注册 |
| `ctx.jobs` | `LocalJobRegistry`（dsh-jobs-local）| 后台作业 |
| `ctx.sessions` | `SessionStore`（dsh-session）| 会话存储 |
| `ctx.sessionProjections` | `SessionProjectionRegistry` | 会话投影 |
| `ctx.workspaceRegistry` | `WorkspaceRegistry`（dsh-workspace）| 工作区 |
| `ctx.goals` | `GoalService`（dsh-goal）| 目标服务 |
| `ctx.web` | `WebRuntime`（dsh-web）| 搜索/抓取 |
| `ctx.sandbox` / `ctx.sandboxPolicy` | Sandbox* | 沙箱 |
| `ctx.storage` | Storage（dsh-storage）| 存储中心 |
| `ctx.shellEnv` | ShellEnvRegistry | Shell 环境变量 |
| `ctx.sessionPersistence` | JsonlSessionPersistence | 会话持久化 |
| `ctx.commands` | CommandRuntime（dsh-commands）| 命令注册 |
| `ctx.deepseekLlmApiExtensions` | DeepSeekLlmApiExtensionRegistry | DeepSeek API 扩展 |
| `ctx.ptcRuntime` | NodePtcRuntime | PTC 运行时 |
| `ctx.workflowEngine` | PtcWorkflowEngine | 工作流引擎 |
| `ctx.subagents` | SubagentRuntime | 子 agent 运行时 |
| `ctx.typert` | TypertRegistry | 类型化 RPC |

**总计 28 个服务** + Cordis 核心 18 个 API。

**官方插件兼容性实测：31/31 活跃**（0 挂起 0 失败）。

**⚠️ 抽象 vs 实现（重要）**：官方服务分包时「抽象 seam」和「本地实现」分开，
注册必须用**实现类**，否则插件调用时报 `xxx is not a function`：

| 抽象（别用） | 实现（用这个） |
|---|---|
| `dsh-shell` 的 `ShellExecutor` | `dsh-bash-local` 的 `LocalBashExecutor` |
| `dsh-subprocess` 的 `SubprocessRuntime` | `dsh-subprocess-local` 的 `LocalSubprocessRuntime` |
| `dsh-fs` 的 `FileSystem` | `dsh-fs-local` 的 `LocalFileSystem` |
| `dsh-jobs` 的 `JobRegistry` | `dsh-jobs-local` 的 `LocalJobRegistry` |

**npm latest 陷阱**：部分包的 `latest` tag 指向依赖未发布包的老版，
装包要显式指定版本线（如 `@deepseek-ai/dsh-bash-local@0.1.6-alpha.2`）。

**服务依赖顺序（重要）**：
- `SystemPrompt` → `ToolRuntime`（后者构造读前者）
- `SessionProjections` → `GoalService`（后者注册投影定义）

外加 Cordis 核心自带：`logger` / `events` / `fiber` / `registry` / `reflect` /
`on` / `emit` / `waterfall` / `parallel` / `serial` / `bail` / `plugin` / `inject` /
`effect` / `get` / `provide` / `set`。

## 用法

```bash
bash start.sh start     # 启动（后台）
bash start.sh stop      # 停止
bash start.sh restart   # 重启
bash start.sh status    # 状态
bash start.sh log       # 日志
```

CCM 侧：`/plugin` 系列命令，或 `DshPlugin` 工具。

**自愈机制**：宿主进程被杀/手机重启后，`/plugin` 和 `DshPlugin` 工具会
**自动拉起宿主**（约 7 秒），不用手动 start。

**start.sh 会等到真正就绪才返回**（轮询 `/control/status`，最长 20 秒）——
进程活着 ≠ 服务可用，实测服务完全就绪要 6-15 秒。

## 控制 API

| 端点 | 说明 |
|---|---|
| `GET /control/status` | 宿主与插件状态 |
| `GET /control/providers` | provider 清单（含 CCM 接入地址）|
| `GET /control/bundles` | 可安装插件包 |
| `POST /control/install` | 安装插件 `{ spec, config }` |
| `POST /control/remove` | 卸载插件 `{ name }` |
| `POST /control/set-plugin` | 启停 `{ name, enabled }`（重启生效）|
| `POST /control/load` | 加载插件 `{ spec, config }` |
| `POST /control/unload` | 卸载插件 `{ spec }` |

## 已装插件（14 个）

**核心插件（常驻加载）**：
- **dsh-account-pool** —— WorkBuddy / Trae 多账号池（选号、熔断、OAuth 登录）
- **dsh-freeroute** —— 免费额度聚合（OpenCode Zen / OpenRouter / SenseNova 等），
  自带 `/freeroute/v1` OpenAI 端点

**已验证可加载（第三方）**：
- `dsh-plugin-model-proxy` —— 模型级代理路由
- `dsh-plugin-mgr` —— 设置页插件管理
- `dsh-plugin-observatory` —— 兼容性审计
- `dsh-find-plugin` —— 插件搜索
- `dsh-plugin-tool-management` —— MCP/技能/场景统一面板
- `dsh-plugin-guide` —— 知识库
- `@goodandready/dsh-time-machine` —— 检查点与工作区守卫
- `@goodandready/dsh-context-lens` —— 语义 AST 骨架化
- `@goodandready/dsh-shadow-auditor` —— 后台安全审计
- `dsh-plan-and-execute` —— 计划执行编排

## 数据目录

- 源码：`~/claude-code-mobile/dsh-host/`
- 用户数据：`~/.claude-code-mobile/dsh-host/`（`plugins.json` / `server.log` / `server.pid`）

## 测试

```bash
node test-registry.mjs      # 28 个服务注册（含依赖拓扑）
node test-load.mjs          # 单插件回归（account-pool）
node test-official-all.mjs  # 官方插件全量（31 个）
node test-third-party.mjs   # 第三方插件（10 个）
node test-tool-bash.mjs     # bash 工具实际执行验证
```

测试脚本用系统临时目录作 dataDir，不污染源码目录。
