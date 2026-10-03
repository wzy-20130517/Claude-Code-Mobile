---
name: slash-wizard
description: 交互式向导（wizard）的使用说明 —— 那些「敲了命令后一步步问你」的流程，如 /qq setup、/config provider add、/imagegen setup、/mail add、手机操作模式选择。当用户问「为什么命令没反应」「怎么退出来」「向导卡住了」或 Agent 需要理解为什么某个命令会阻塞输入时使用。
---

# 交互式向导

## 什么是向导

有些命令**光敲命令名不够**，需要一步步问你参数。这类命令敲下去后会进入**向导模式**：

- 底部出现**固定的输入行**（不是普通提示符）
- 一步步问，每步有默认值（直接回车用默认）
- 有的步骤可以**回退**（上一步填错了）

## 哪些命令是向导

| 命令 | 问什么 |
|---|---|
| `/qq setup` | 主人号 / 端口 / NapCat API 地址 |
| `/config provider add`（无参） | Provider ID / 名称 / URL / 模型 / key / 协议 |
| `/imagegen setup` | 生图 API 地址 / key / 模型 / 尺寸 |
| `/mail add`（无参） | 别名 / 邮箱 / 授权码 / IMAP 服务器 / 端口 |
| `/mcp`（首次配） | MCP 服务器信息 |
| **手机操作模式选择** | 首次调用手机工具时弹（前台 / 后台 / 每次问） |

**带参数的调用不走向导**，直接执行：

```bash
/qq setup                    # 向导
/qq owner 3843364195         # 直接设，不向导

/config provider add         # 向导
/config provider add myid name=xxx url=xxx model=xxx key=xxx   # 一行式，不向导
```

## 向导里的操作

| 按键 | 作用 |
|---|---|
| **回车** | 用当前值 / 默认值，进入下一步 |
| **打字** | 输入内容 |
| **Ctrl+C** | **中止向导**（不保存任何改动） |
| 上下箭头 | 有的向导支持选项列表，用箭头选 |

## 常见问题

**Q: 向导卡住了 / 没反应？**

多半是**非交互环境**（比如通过 QQ 发命令、或管道输入）。向导需要真实终端（TTY）。
- 用**一行式**代替：`/config provider add id name=... url=...`
- 或在终端里直接敲

**Q: 能中途退出吗？**

**Ctrl+C** 中止（不保存）。已经填的步骤会丢弃。

**Q: 填错了想改？**

- 向导**没结束时**：有的步骤支持回退（看提示）
- 向导**已结束**：用单项修改命令，不用重跑向导：
  - `/qq owner <新号>` · `/qq port <新端口>`
  - `/model <模型>` · `/url <地址>` · `/key <key>` · `/name <显示名>` · `/protocol <协议>`
  - `/mail pass <别名> <新授权码>`

**Q: 为什么这个命令把输入框占了？**

向导运行时**独占输入**（它要读你的键盘输入）。期间发别的消息会**排队**，向导结束后才处理。

## 给 Agent 的提示

**向导类命令不能在 Agent 运行时插队执行** —— 它们要抢 readline。
`core/agent-tools.mjs` 里有注释说明：向导的 Promise 只能由用户回车兑现，
Agent 如果在自己跑的时候调 `/key pool` 这类命令会**永久挂起**。

**Agent 应该用一行式**，不要触发向导：

| 别用 | 用 |
|---|---|
| `/qq setup` | `/qq owner <号>` + `/qq port <端口>` |
| `/config provider add`（无参） | `/config provider add id name=... url=... model=... key=...` |
| `/imagegen setup` | `/imagegen url <地址>` + `/imagegen key <key>` + `/imagegen model <模型>` |
| `/mail add`（无参） | `/mail add <别名> <邮箱> <授权码>` |

## 手机操作模式向导

首次调用手机工具（`phone_snapshot` 等）时会弹一个选择：

```
用哪块屏操作手机？
  1. 前台（操作主屏）—— 你能看见 AI 点哪，但占你的屏幕
  2. 后台（操作虚拟副屏）—— 静默跑，不占屏
  3. 每次问
```

**这是每次会话重新问的**（不落盘）—— 免得上次选的"前台"一直粘着。

改偏好：`/device mode 主屏|副屏|选择`，`/device mode off` 清掉重新问。
