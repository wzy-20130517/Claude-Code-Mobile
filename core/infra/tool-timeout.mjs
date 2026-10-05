// Claude Code Mobile - 工具超时分级
// 背景：原先 Agent 层对所有工具硬编码 30s，导致
//   1. Bash/Test 跑 npm install、全量测试必然被误杀；
//   2. 用户给 Bash 显式传了 timeout: 300000 也无效（外层 30s 先到）；
//   3. 超时只 reject，子进程无人通知 → 变孤儿继续跑。
// 这里按工具类型给出合理上限，并允许工具输入里的 timeout 覆盖（带安全上限）。

// 快速只读检索：本地文件/符号操作，超过 15s 基本是卡死
const FAST = 15_000
// 普通本地操作：写文件、补丁、git
const NORMAL = 60_000
// 网络类：搜索、抓取、MCP 调用
const NETWORK = 120_000
// 生成类网络调用：生图/图生图/视频抽帧，单次几分钟是常态（实测 gpt-image-2 图生图 >60s）
const SLOW_GEN = 300_000
// 长任务：shell、测试、构建、子 Agent
const LONG = 600_000
// 主动等待：Sleep 工具自己声明上限 300s，超时档必须 ≥ 它，否则
// 「seconds 最大 300」这个承诺是假的 —— 传 100 会被 60s 的默认档掐断
// （2026-09-04 实测：Sleep(100) 报 Tool timeout (1min)）。
// 留 10s 余量给调度抖动。
const WAIT = 310_000
// 交互等待：要等真人打字/做决定的工具，比机器档宽松，但不能无限等
// 太短（原先走 60s 默认）→ 用户还在打字就被 abort，问题白问；
// 太长（曾设 30min）→ 用户不在场时 agent 干等半小时，整轮假死。
// 2min：正常回答绰绰有余，人不在也能及时超时让 agent 换路走。
const INTERACTIVE = 120_000
// 任何工具的硬上限，防止模型传一个荒谬的值把整轮挂死
export const MAX_TOOL_TIMEOUT = 1_800_000

const TOOL_TIMEOUTS = {
  // 只读检索
  Read: FAST, Glob: FAST, Grep: FAST, CodeSearch: FAST,
  HashlineRead: FAST, HashlineGrep: FAST,
  Symbols: FAST, RepoMap: FAST, Diagnostics: FAST,
  GitStatus: FAST, GitDiff: FAST, GitLog: FAST,
  ClipboardGet: FAST, Battery: FAST, QQInbox: FAST,

  // 本地写入/变更
  Write: NORMAL, Edit: NORMAL, MultiEdit: NORMAL,
  HashlineEdit: NORMAL, ApplyPatch: NORMAL, SafeRename: NORMAL,
  GitAdd: NORMAL, GitCommit: NORMAL,
  Memory: NORMAL, TodoWrite: NORMAL,
  ViewImage: NORMAL, Screencap: NORMAL,

  // 网络
  WebFetch: NETWORK, WebSearch: NETWORK, LSP: NETWORK,
  QQSend: NETWORK, QQReply: NETWORK, QQMute: NETWORK,

  // 长任务
  Bash: LONG, Test: LONG, Agent: LONG, AgentWorkflow: LONG, Task: LONG,

  // 生成类（慢，实测远超 60s）
  ImageGen: SLOW_GEN, ViewVideo: SLOW_GEN,

  // 交互等待：等真人输入/决策，不能按机器速度掐
  AskUserQuestion: INTERACTIVE,

  // 程序内命令：/compact /backup /auto 这类可能很慢（实测 compact force 200 超 60s）
  CommandExec: LONG,

  // 后台任务观察/控制：本身只读状态，很快
  BashOutput: FAST, KillShell: FAST, AgentStatus: FAST,
  UserInputHistory: FAST, StatusLine: FAST,

  // 主动等待：见上方 WAIT 注释，必须覆盖 Sleep 自己声明的 300s 上限
  Sleep: WAIT,

  // 模式切换 / 纯内存操作：瞬时完成
  EnterPlanMode: FAST, ExitPlanMode: FAST,
  EnterDeepMode: FAST, ExitDeepMode: FAST,
  EnterWatch: FAST, ExitWatch: FAST,
  Skill: FAST, Present: FAST,

  // Android 装饰类：调 termux-api 子进程，本身有 15~30s 内部超时
  Toast: NORMAL, Notify: NORMAL, Vibrate: NORMAL, TTS: NORMAL,
  ClipboardSet: NORMAL, Share: NORMAL, OpenUrl: NORMAL,
  Location: NORMAL,
}

const DEFAULT_TIMEOUT = NORMAL

/**
 * 供系统提示词注入的分级摘要（一行）。
 * 提示词不再硬写"工具超时30秒"，避免这里调整后文档变成假信息。
 */
export function describeTimeoutTiers() {
  const s = (ms) => `${Math.round(ms / 1000)}s`
  return `只读检索 ${s(FAST)} / 本地写入 ${s(NORMAL)} / 网络类 ${s(NETWORK)} / 生图·视频 ${s(SLOW_GEN)} / Bash·Test·Agent ${s(LONG)} / 等用户回答 ${Math.round(INTERACTIVE / 60000)}min，默认 ${s(DEFAULT_TIMEOUT)}，硬上限 ${Math.round(MAX_TOOL_TIMEOUT / 60000)}min`
}

/**
 * 解析某次工具调用应使用的超时时间。
 * 优先级：工具输入里的显式 timeout > 工具类型默认 > 通用默认。
 * 显式值仍受 MAX_TOOL_TIMEOUT 限制；<=0 表示"不限时"，用硬上限兜底。
 */
//
// 输入里 timeout 参数语义是**秒**的工具（其余工具一律毫秒）。
// 撞车实录（2026-09-28）：AgentOutput({timeout: 420}) 的 420 是秒，
// 但这里当毫秒 → max(420, 1000) = 1s → 工具刚起跑就被掐，
// 报错还显示 "Tool timeout (1s)" 极具误导性。
const TIMEOUT_IN_SECONDS = new Set(['AgentOutput'])

export function resolveToolTimeout(toolName, input = {}) {
  const base = TOOL_TIMEOUTS[toolName] ?? DEFAULT_TIMEOUT
  const raw = input?.timeout ?? input?.timeout_ms
  if (raw === undefined || raw === null) return base
  let n = Number(raw)
  if (!Number.isFinite(n)) return base
  // 秒语义工具：换算成毫秒再走统一 clamp
  if (TIMEOUT_IN_SECONDS.has(toolName)) n = n * 1000
  // 0 / 负数：调用方明确表示不想被外层掐断（如后台任务），给硬上限
  if (n <= 0) return MAX_TOOL_TIMEOUT
  // 用户显式给的值优先，但不低于 1s、不超过硬上限
  return Math.min(Math.max(n, 1_000), MAX_TOOL_TIMEOUT)
}

/** 供展示/日志用：把毫秒转成易读文本 */
export function describeTimeout(ms) {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}min`
  return `${Math.round(ms / 1000)}s`
}

export const TOOL_TIMEOUT_TABLE = TOOL_TIMEOUTS
export const TIMEOUT_TIERS = { FAST, NORMAL, NETWORK, LONG }
