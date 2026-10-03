# Web 端 —— 来源与许可说明

## ⚠️ 重要：本目录代码有独立的许可

本目录（`web/`）的**前端代码**派生自开源项目
**[claude-desktop-app](https://github.com/pretend1111/claude-desktop-app)**（作者 [pretend1111](https://github.com/pretend1111)）。

上游采用 **Non-Commercial License（非商用许可）**，完整条款见同目录的
[`LICENSE-claude-desktop-app`](./LICENSE-claude-desktop-app)。

### 这意味着

| 用途 | 是否允许 |
|---|---|
| 个人使用、学习、修改 | ✅ 允许 |
| 在相同条款下分享 | ✅ 允许 |
| **商业用途**（售卖、变现、作为商业服务的一部分） | ❌ **不允许** |

**具体到本项目**：

- 仓库根目录的 `LICENSE`（MIT）**仅覆盖 CLI 部分**（`index.mjs`、`core/`、`tools/` 等）
- **`web/` 目录的前端代码受 Non-Commercial 许可约束**，不能用于商业目的
- 如需商用 Web 端，请联系上游作者获取授权，或自行实现前端

## 我们改了什么

原版是**桌面应用**（Electron + 自带引擎），我们把它改造成了**浏览器访问的 Web 服务**：

- **后端**：`server.mjs` 全部重写 —— 从 Electron 主进程改为 HTTP + SSE 服务
  （提供 REST API、SSE 事件流、静态资源服务）
- **连接层**：新增 `command-adapter.mjs`、`config-bridge.mjs` —— 把前端的调用
  桥接到 CLI 内核（共享 `~/.claude-code-mobile/` 的配置与会话）
- **适配改动**：组件里涉及 Electron IPC 的调用改为 HTTP 请求；
  部分 UI 细节按手机端使用场景做了调整（窄屏适配、触摸交互等）
- **新增组件**：在原版 39 个组件基础上增加了若干（共 45 个）

## 致谢

感谢 [pretend1111](https://github.com/pretend1111) 开源的
[claude-desktop-app](https://github.com/pretend1111/claude-desktop-app) ——
它的界面实现（对话流、Artifacts 面板、文档系统、侧边栏等）质量很高，
为本项目的 Web 端提供了坚实基础。

## 如果你要基于本目录开发

1. 遵守上游的 Non-Commercial 条款
2. 保留 `LICENSE-claude-desktop-app` 与本说明文件
3. 如果你的项目也是开源的，建议采用相同的许可条款
