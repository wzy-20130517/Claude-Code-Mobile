---
name: key-pool
description: 多 API key 轮换池使用说明 —— 一个 Provider 配多个 key 自动轮换，某个 key 额度耗尽/报错时自动切下一个。当用户问「key 用完了怎么办」「怎么配多个 key」「为什么自动换 key 了」「冷却是什么」时使用。
---

# 多 Key 轮换池

## 解决什么问题

很多免费/低价中转站给的是**按量计费**的 key —— 用完了就 403/503。
手上攒了十个八个 key 的话，手动换太累。

**轮换池**：一个 Provider 挂多个 key，Agent 自动轮换，某个用完就切下一个。

## 怎么配

### 方式一：一行式

```bash
/key pool sk-aaa sk-bbb sk-ccc     # 给当前 Provider 设 3 个 key
```

### 方式二：交互向导

```bash
/config provider add      # 无参进向导，其中一步就是填 key（可填多个）
```

### 方式三：环境变量引用

```bash
/key setenv OPENAI_KEYS    # 引用环境变量（key 存 ~/.claude-code-mobile/.env）
```

适合把 key 放 `.env` 里、不写进 config.json。

## 查看状态

```bash
/key               # 看当前 Provider 的 key 池状态
/config list       # 看所有 Provider（含 key 池概况）
```

输出里会显示：

- 池里几个 key、当前用的第几个
- 每个 key 的状态（可用 / **冷却中**）
- 冷却剩余时间

## 自动轮换怎么工作

| 时机 | 行为 |
|---|---|
| **每 N 次请求** | 主动轮换到下一个（N = `keyRotateEvery`，默认 0 = 不主动轮换） |
| **某个 key 报错** | 自动切下一个 + 记冷却 |
| **全部冷却中** | 用最早解冻的那个 |

**冷却时间**：默认 **5 小时**（`core/key-pool.mjs` 的 `DEFAULT_COOLDOWN_MS`）。

冷却状态存 `~/.claude-code-mobile/key-pool-state.json`，**重启保留**。

## ⚠️ 关于「冷却中」

**冷却 ≠ 当前不可用**。它是**上次失败时的历史记录**：

- 免费额度通常**按天重置** —— 昨天 503 的 key，今天可能已经能用了
- 冷却只是「最近失败过」的标记，不代表现在一定失败

**判断 key 能不能用，看最近一次请求结果，别拿冷却记录下结论。**

## 切换时的提示

Agent 自动切 key 时会打一行提示（不静默）：

```
⇄ API key 切换: sk-aaa... → sk-bbb...（剩余可用 3 个）
  原因: HTTP 403: quota exhausted
```

**正常轮换**（`reason='rotate'`，每 N 次请求一次）**不打提示** —— 那是噪音。

## 配置字段

| 字段 | 位置 | 说明 |
|---|---|---|
| `apiKeys` | `config.json` 的 provider 内 | key 数组（池） |
| `apiKey` | 同上 | 单个 key（**与 apiKeys 互斥**，别同时存在） |
| `keyRotateEvery` | `config.json` 顶层 | 每 N 次请求主动轮换，0 = 不主动换 |

## 常见问题

**Q: 我改了 key 但没生效？**
改 key 用 `/key` 命令（进程内 + 文件同步）。**直接编辑 config.json 会被运行中的进程覆盖** —— 它持有配置对象，回写时把外部改动盖掉。

**Q: 池里 key 全冷却了怎么办？**
它会用最早解冻的那个。你也可以 `/key pool sk-new1 sk-new2` 直接换一批。

**Q: 怎么知道哪个 key 快用完了？**
`/config list` 看池状态。或者看请求报错（403/503 会自动切）。

**Q: 轮换会影响 prompt cache 吗？**
会。换 key 后服务端可能视为不同会话，缓存命中率下降。所以**不要设太小的 `keyRotateEvery`**。
