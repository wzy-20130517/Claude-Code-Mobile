---
name: subagent-orchestration
description: 子 Agent 编排完整说明 —— 怎么派活、怎么等、怎么管理并发、团队协作、任务交接、记忆传递。当用户问「能不能同时做几件事」「子 Agent 是什么」「为什么任务卡住了」或需要多 Agent 协作时使用。
---

# 子 Agent 编排

## 能做什么

主对话可以**派生独立的子 Agent** 干活：

- 每个子 Agent 有**独立上下文窗口**（不污染主对话）
- 可以**并行**（多个同时跑）
- 可以**递归**（子 Agent 再派子 Agent）
- 可以**后台**跑（主对话继续做别的）

## 五种角色（builtin）

| 类型 | 工具权限 | 用途 |
|---|---|---|
| **general-purpose** | 全工具 | 独立完成复杂任务 |
| **Explore** | 只读 | 调研代码库 |
| **Plan** | 只读 + TodoWrite | 制定执行计划 |
| **Coordinator** | 编排工具 | 自己再派 worker 并行 |

**自定义角色**：放 `.claude/agents/<名字>.md`，`subagent_type` 填文件名。

## 基本用法

```
Agent({
  description: "调研登录流程",
  prompt: "完整任务指令（自包含，子 Agent 看不到你的对话历史）",
  subagent_type: "Explore",
  run_in_background: true,        // 后台跑
  agent_name: "explorer-1"        // 起名字，之后能唤醒
})
```

**关键**：`prompt` 必须**自包含** —— 子 Agent 看不到你读过什么、推理过什么。

## 并发上限 24

**全局上限 24 个**（含递归派生的下级）。

超限时返回 `rejected: "concurrency_limit"` —— **这不是错误、任务也没失败**：

- 等已有子 Agent 完成后重试
- 改成串行
- 缩减本层扇出

用 `AgentStatus` 看当前在跑几个。

## 怎么等（重要）

**正确方式**：

```
AgentOutput({ task_id, block: true, wait: 120 })
```

它内部轮询，对你**只是一次调用**。超时返回不代表失败，可以再等一次。

**❌ 别这么干**：

```
Bash sleep 30          ← 白等固定秒数
AgentStatus            ← 反复轮询，每次都是一次模型调用
```

## 后台 vs 同步

| 模式 | 行为 |
|---|---|
| `run_in_background: true` | 立即返回 task_id，主对话继续 |
| `run_in_background: false`（默认） | 同步等结果 |

**长任务必须后台** —— 同步等会撞工具 60 秒超时。

## 唤醒复用（省上下文）

给了 `agent_name` 后，可以用 `SendMessage` **唤醒它继续干**：

```
SendMessage({ to: "worker-1", wake: true, text: "再补个测试" })
```

**它保留原有上下文** —— 还记得自己做过什么，不用重讲背景。
比重新 spawn 一个省得多。

⚠️ **重启后失效**（wake 要求原实例还在内存里）。

## 团队协作

需要多个 Agent **互相沟通**时建团队：

```
TeamCreate({ team: "my-team" })
TaskCreate({ list: "my-team", subject: "任务描述" })   // 派活
SendMessage({ from: "main", to: "*", text: "广播" })   // 广播
```

| 工具 | 作用 |
|---|---|
| `TeamCreate` / `TeamJoin` | 建组 / 报到 |
| `TaskCreate` / `TaskClaim` / `TaskUpdate` | 建任务 / 领任务 / 改状态 |
| `SendMessage` | 发消息（`to: "*"` = 广播） |
| `TeamStatus` | 看全景（谁闲着、谁卡住） |
| `TeamLeave` / `TeamDisband` | 收工 / 解散 |

**团队名 = 任务列表名**，`TaskCreate` 的 `list` 填同一个值。

**队友消息自动送达** —— TeamJoin 后，别人发来的消息下一轮自动出现。**不要写 sleep + CheckMessages 轮询**。

## 三种「继承」路径（名字无关）

| 载体 | 跨重启 | 内容 |
|---|---|---|
| 运行时上下文 | ✗ | 读过的文件、推理过程 |
| **AgentMemory** | ✓ | 按**类型**分池的经验（同名类型自动读到） |
| **Task 的 comment** | ✓ | 交接：做到哪、待办、已查明的前置结论 |

**最可靠的交接是 Task comment** —— 写清「做到哪、试过什么、卡在哪」，续做者 `TaskGet` 一次就能接手。

## 写任务的纪律

**并行按「资源冲突」分组，不是按个数**：

- 只读任务（调研/搜索/读代码）→ 放开并行
- **写同一批文件的任务必须串行** —— 否则两个 worker 各自读旧内容再写回，
  后写的**静默覆盖**前面的改动，**不报错但工作丢失**，最难查

派活前想清楚每个 worker 会碰哪些文件，在 prompt 里写明「**只准改 X、别碰 Y**」。

## 中止与收尾

| 情况 | 动作 |
|---|---|
| 派错方向 / 需求变了 / 在浪费时间 | `AgentStop({ task_id })` —— **别干等它跑完白烧 token** |
| 完成后 | 用 `AgentOutput` 取结果，抽查不要照抄 |
| 值得留给未来同类 | `AgentMemory({ action: "write" })` |

## 成本提醒

- 每个子 Agent 都是**独立的模型调用**，token 照烧
- **单个 Agent 能完成的任务不要建团队** —— 纯属开销
- 简单的三步任务，自己干比派活快

## 验证结果的纪律

**子 Agent 的结论要核实** —— 它会犯错、会漏看、会想当然。

实例：某次子 Agent 报告「PhoneAppTool 没校验 package 参数」，
实际代码里第 765-766 行**有校验**（它漏看了）。
**逐条核实**，别直接采信。
