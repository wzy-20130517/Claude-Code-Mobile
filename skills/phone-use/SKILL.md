---
name: phone-use
description: 手机操作（phone use）完整说明 —— Agent 如何看屏幕、点按、输入、滑动，前台/后台模式的区别，虚拟副屏，息屏限制。当用户问「你能操作我手机吗」「为什么点不动」「副屏是什么」「手机工具怎么用」时使用。Agent 自己操作手机前也该读这个。
---

# 手机操作（Phone Use）

## 能做什么

Agent 可以直接操作 Android 手机：

| 能力 | 工具 |
|---|---|
| 看当前界面 | `phone_snapshot`（元素树）· `phone_screenshot`（截图） |
| 点击 | `phone_click`（按元素）· `phone_tap_xy`（按坐标） |
| 输入 | `phone_type`（中英文都行） |
| 滑动 / 翻页 | `phone_swipe` · `phone_scroll` |
| 系统按键 | `phone_key`（back/home/recent/enter…） |
| 启动应用 | `phone_app` |
| 等界面就绪 | `phone_wait` |
| **在 Android 里跑 shell** | `phone_shell`（uid=2000，可 am/pm/dumpsys/run-as） |
| 副屏管理 | `phone_vd` · `phone_device` |

## 两种模式

模式由**用户**选（首次用手机工具时会问），Agent 不能自己改：

| 模式 | 行为 | 什么时候用 |
|---|---|---|
| **foreground**（前台） | 操作**主屏**，用户看得见 | 需要用户盯着、或 App 只允许主屏 |
| **background**（后台） | 操作**虚拟副屏**，静默 | 不想占用户屏幕，跑自动化 |
| **idle** | 这次不操作手机 | 用户选的 |

### ⚠️ 开工前必做（每次动手机前）

1. **先看屏幕状态** —— 调 `phone_device` 确认当前模式、目标屏、副屏是否可用。
   不要凭记忆假设目标屏是哪个。
2. **用户选主屏就用主屏** —— 模式是 foreground 时直接在主屏操作，别去碰副屏。
3. **用户选副屏且副屏不可用 → 修副屏，不许改用主屏**：
   - 副屏进程没起 → `phone_vd start`
   - 帧缓存过期/画面不更新 → `phone_vd restart`
   - 修完再 `phone_device` 确认，然后继续在副屏干活
   - **绝对不要因为副屏有问题就偷偷换主屏操作** —— 那会占用用户屏幕、
     违背他「静默操作」的意图。副屏实在修不好就如实报告，等用户决定。

## 元素树 vs 截图

**优先用 `phone_snapshot`**（元素树）：

| | snapshot | screenshot |
|---|---|---|
| 速度 | 百毫秒级 | 几秒 |
| Token | ~1K | 几千 |
| 适用 | 原生界面（Android 控件） | WebView / Flutter / Canvas / 游戏 |

**元素树拿不到内容时才截图** —— 比如网页、Flutter 应用、广告页。

元素树格式：
```
#e12 Button "发送" 940,2100,1180,2200 c
```
**直接用 `#e12` 点击**（`phone_click({ref:'e12'})`），不用自己算坐标。

flags：`c`=可点 · `e`=可输入 · `s`=可滚 · `k±`=选中 · `off`=禁用 · `focus`=聚焦

## 关键限制

### 息屏时仍可用（实测确认）

Shizuku / adb 通道**不依赖屏幕状态**，息屏下 snapshot、点击、输入照常工作。

两个注意点：
- **虚拟副屏**在息屏下会暂停合成 → 表现「帧缓存过期」或「屏幕已关闭」→ `phone_vd restart` 或点亮屏幕恢复
- **adb 回环**可能在息屏期间掉线 → `adb connect 127.0.0.1:5555` 重连即可

### 元素会失效

**界面一变，旧 ref 就失效**。点了没反应或报「已失效」→ **重新 snapshot**。

### 中文输入

`phone_type` **支持中文**（内部走剪贴板 + 粘贴键，绕开 `input text` 的中文限制）。

## 通道（背后怎么连的）

| 通道 | 说明 |
|---|---|
| **Shizuku** | 首选。需要 Shizuku 跑起来 + 授权 |
| **本机 adb** | 备选（`/device adb <host:port>` 配回环） |

查看/切换：`/device` 看总览 · `/device test` 实测 · `/device shell auto\|shizuku\|adb`

## 虚拟副屏

后台模式操作的是**虚拟副屏**（用 `app_process` 起的独立 display）。

- `/device vd start\|stop\|status` 管理进程
- **帧缓存过期**时 snapshot 会读到旧画面 → `phone_vd restart`

## 实战经验（踩过的坑）

| 坑 | 教训 |
|---|---|
| 全程用截图 + 识图 → 一个搜歌任务花 27 分钟 | **默认用元素树**，只有 WebView/游戏才截图 |
| App 弹窗层数多（开屏广告 → 挽留弹窗 → 签到弹窗 → 推广弹窗） | 纯文本快照对付不了 WebView 广告，该截图就截图 |
| 坐标算错 | 截图缩放过的坐标要标 `from_screenshot: true`，工具自动换算 |
| `phone_wait` 参数名 | 用 `max_wait_ms`（不是 `timeout`，那个会撞工具超时） |

## 给 Agent 的操作纪律

1. **先 snapshot，再决定**（不要一上来就截图）
2. **用 ref 点击**（不要自己算坐标）
3. **界面变化后重新 snapshot**（旧 ref 失效）
4. **找不到元素再截图**（WebView/Canvas）
5. **息屏也能干活**（Shizuku/adb 不依赖屏幕；只有副屏合成会暂停，restart 即可）
