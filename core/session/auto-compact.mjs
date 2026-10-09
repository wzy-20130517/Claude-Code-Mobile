// @ts-nocheck
// Claude Code Mobile - 自动上下文压缩
// 策略：默认关闭自动摘要；只认手动 /compact 与 /compact force；
// 已移除 cache-aware 自动摘要（易引发幻觉）；紧急保护依赖 agent 层上下文超长截断。
import { CompactService } from './compact.mjs'
import { backupBeforeCompact } from './compact-trash.mjs'
import { readFileSync, existsSync, statSync } from 'fs'
import { atomicWrite } from '../infra/atomic.mjs'
import { resolveConfigPath } from '../infra/paths.mjs'

// 默认值：固定阈值关闭 + 自动压缩关闭
const DEFAULT_TOKEN_LIMIT = 0
const DEFAULT_MESSAGE_LIMIT = 0
const DEFAULT_MAX_CONTEXT = 1000000 // 当前模型 1M 上下文
const DEFAULT_CACHE_POLICY = {
  enabled: false, // 关键：不自动生成摘要
  minChunkMessages: 8,
  minChunkTokens: 1800,
  pressureRatio: 0.82,
  hardPressureRatio: 0.94,
}

// 【2026-10-03】原为相对路径 → 读写源码目录。配置属用户数据，
// 统一放 ~/.claude-code-mobile/（见 core/paths.mjs）。
// ⚠ 自动压缩阈值（compactThresholdTokens/Messages）就存在这个文件里。
//
// 【2026-10-08 澄清：CLI 与 Web **共享**这一份配置】
// README 写明「与 CLI 共享配置与会话数据——同一个 ~/.claude-code-mobile/」。
// Web 的 loadWebConfig 也是 `{...cli, ...web}` 合并 —— CLI config.json 的
// 字段对 Web 全部可见，web-config.json 只是「Web 覆盖层」（存 current 等
// 会话级字段）。所以本模块**不需要**任何注入机制：Web 直接读这里就是
// 共享值，写也写回共享文件 —— 两边天然一致。
//
// 【踩坑记录】我一度加了 setThresholdSource 注入点，让 Web 写
// web-config.json「各读各的」——方向反了：那样 Web 设的阈值 CLI 看不到、
// CLI 设的 Web 改了也不影响终端，正是「共享配置」要避免的分裂。
const CONFIG_PATH = resolveConfigPath('config.json')

function loadThresholds() {
  try {
    if (!existsSync(CONFIG_PATH)) {
      return {
        tokenLimit: DEFAULT_TOKEN_LIMIT,
        messageLimit: DEFAULT_MESSAGE_LIMIT,
        maxContext: DEFAULT_MAX_CONTEXT,
        cachePolicy: { ...DEFAULT_CACHE_POLICY },
      }
    }
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    return {
      tokenLimit: config.compactThresholdTokens ?? DEFAULT_TOKEN_LIMIT,
      messageLimit: config.compactThresholdMessages ?? DEFAULT_MESSAGE_LIMIT,
      maxContext: config.maxContextTokens ?? DEFAULT_MAX_CONTEXT,
      cachePolicy: { ...DEFAULT_CACHE_POLICY, ...(config.compaction || {}) },
    }
  } catch {
    return {
      tokenLimit: DEFAULT_TOKEN_LIMIT,
      messageLimit: DEFAULT_MESSAGE_LIMIT,
      maxContext: DEFAULT_MAX_CONTEXT,
      cachePolicy: { ...DEFAULT_CACHE_POLICY },
    }
  }
}

function saveThresholds() {
  try {
    let config = {}
    if (existsSync(CONFIG_PATH)) config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    config.compactThresholdTokens = tokenLimit
    config.compactThresholdMessages = messageLimit
    config.maxContextTokens = maxContext
    config.compaction = { ...(config.compaction || {}), ...cachePolicy, enabled: cachePolicy.enabled === true }
    atomicWrite(CONFIG_PATH, JSON.stringify(config, null, 2))
  } catch (e) {
    console.error(`\x1b[2m[警告: 无法保存压缩阈值: ${e.message}]\x1b[0m`)
  }
}

const { tokenLimit: _tl, messageLimit: _ml, maxContext: _mc, cachePolicy: _cp } = loadThresholds()
let tokenLimit = _tl
let messageLimit = _ml
let maxContext = _mc
let cachePolicy = { ...DEFAULT_CACHE_POLICY, ..._cp, enabled: false } // 永远不强开自动摘要

// ══════════════════════════════════════════════════════════════════
//  【2026-10-06 修】阈值热更新 —— 原来只在模块加载时读一次
// ══════════════════════════════════════════════════════════════════
//
// 用户现象：「设了 600k 压缩阈值，但上下文到 654k 都没压缩」。
//
// 根因：`tokenLimit` 是模块级变量，只在**进程启动时**从 config 读一次
// （上面那行 loadThresholds()）。用户运行中改阈值（/compact-threshold）
// 只写了磁盘 —— 内存值还是旧的 0（= 关闭），于是 shouldCompact 恒 false。
//
// 实测时间线：进程启动 21:39:41，config 写入 21:39 —— 差 1 秒，读到了旧值。
//
// 修：每次 get 时比对 config.json 的 mtime，变了就重读。
// 代价：每轮一次 stat（微秒级），远比读盘+JSON 解析便宜。
//
// 【共享配置的意义】CLI 和 Web 读同一份 config.json —— mtime 热更新对
// 两边同时生效：Web 设置页改了阈值，CLI 侧下一轮就能看到（反之亦然）。
let _lastCfgMtime = -1
function refreshIfChanged() {
  try {
    const m = statSync(CONFIG_PATH).mtimeMs
    if (m === _lastCfgMtime) return
    _lastCfgMtime = m
    const fresh = loadThresholds()
    tokenLimit = fresh.tokenLimit
    messageLimit = fresh.messageLimit
    maxContext = fresh.maxContext
    cachePolicy = { ...DEFAULT_CACHE_POLICY, ...fresh.cachePolicy, enabled: false }
  } catch { /* 读不到就保持当前值 */ }
}

export function getTokenLimit() { refreshIfChanged(); return tokenLimit }
export function getMessageLimit() { refreshIfChanged(); return messageLimit }
export function getMaxContext() { refreshIfChanged(); return maxContext }
export function getCachePolicy() {
  return { ...cachePolicy, maxContextTokens: maxContext, enabled: false }
}

/** 是否允许自动压缩：仅当设置了固定阈值 */
export function isAutoCompactEnabled() {
  return tokenLimit > 0 || messageLimit > 0
}

export function setTokenLimit(v) {
  if (typeof v === 'number' && (v > 1000 || v === 0)) {
    tokenLimit = v
    saveThresholds()
    return true
  }
  return false
}

export function setMessageLimit(v) {
  if (typeof v === 'number' && (v >= 5 || v === 0)) {
    messageLimit = v
    saveThresholds()
    return true
  }
  return false
}

export function setMaxContext(v) {
  if (typeof v === 'number' && v > 10000) {
    maxContext = v
    saveThresholds()
    return true
  }
  return false
}

/** 三层水位（对标官方autoCompact.ts）：
 *   warning     = 剩 <20K 时提示（黄字，不阻塞）
 *   error       = 剩 <20K 且超预算 时警告（红字，不阻塞）
 *   blocking    = 剩 <13K 时直接合成错误拒绝（不打 API，防止 413 浪费）
 * 注意：自动压缩默认关，这三层只做状态提示与守门，不主动触发摘要。
 */
export function getContextWaterLevel(lastPromptTokens) {
  if (!lastPromptTokens || lastPromptTokens <= 0) return { level: 'ok', remain: -1 }
  const remain = maxContext - lastPromptTokens
  if (remain <= 13000) return { level: 'blocking', remain }
  if (remain <= 20000) return { level: 'error', remain }
  if (remain <= 33000) return { level: 'warning', remain }
  return { level: 'ok', remain }
}

/** 兼容占位：不再启用 cache-aware 自动摘要，始终返回 false */
export function setCacheAwareEnabled(v) {
  return false
}

// 多档阈值：warning → error → blocking（仅用于状态显示，不驱动自动摘要）
const MARGIN_AUTOCOMPACT = 13000
const MARGIN_WARNING = 33000
const MARGIN_ERROR = 53000

// getCompactLevel 已废弃，改用 getContextWaterLevel 后逐字段映射
export function getCompactLevel(lastPromptTokens) {
  return getContextWaterLevel(lastPromptTokens).level
}

/**
 * 是否在本轮结束后尝试自动压缩。
 * 默认 false。只有用户设置固定阈值（tokenLimit/messageLimit）才会 true。
 * 上下文超长紧急保护走 agent 层截断，不在这里生成摘要。
 */
export function shouldCompact(messages, tokenUsage, lastPromptTokens) {
  if (!isAutoCompactEnabled()) return false

  // 固定消息条数
  if (messageLimit > 0 && messages.length > messageLimit) return true
  // 固定 token
  if (tokenLimit > 0 && lastPromptTokens > 0 && lastPromptTokens > tokenLimit) return true

  return false
}

// 断路器：连续 3 次压缩失败则停止
let _consecutiveFailures = 0
export function getConsecutiveFailures() { return _consecutiveFailures }
export function resetFailures() { _consecutiveFailures = 0 }

export async function autoCompact(agent, compactService, { print = console.log } = {}) {
  const history = agent.getHistory()
  // CLI 全屏模式传入 fsSession 的输出通道；不能让 console.log 直接把光标
  // 写进固定 footer。普通调用不传时保持原行为。
  const announce = (text) => {
    try { print(text) } catch {}
  }
  const lastPromptTokens = agent.getLastPromptTokens?.() || 0

  // 默认关闭：直接跳过，不评估、不打日志打扰用户
  if (!shouldCompact(history, null, lastPromptTokens)) return false

  if (_consecutiveFailures >= 3) {
    announce(`\n\x1b[2m[自动压缩已停用: 连续 3 次失败，用 /compact 手动压缩]\x1b[0m`)
    return false
  }

  const before = history.length
  try {
    // ══════════════════════════════════════════════════════════════════
    //  【2026-10-06 修】force: true —— 否则两层判据打架
    // ══════════════════════════════════════════════════════════════════
    //
    // 用户现象：「设了 600k 阈值，上下文 660k 了还不压」。
    //
    // 根因：两条判据独立，后者否决前者 ——
    //   · shouldCompact（本函数开头）：tokenLimit=600000，660k > 600k → true ✓
    //   · compactService.analyze（内部）：pressure = 660k/1M = 0.66，
    //     低于 0.82 软阈值 → recommendation='defer' → **不压缩**
    //
    // 两条都对，但语义不同：analyze 的 82% 是「按模型上下文比例」自动判断，
    // 而用户设固定阈值（600k）是**明确表达「到这个数就压」** —— 应该尊重。
    //
    // force 只跳过「够不够格」的判断，不影响压缩策略选择（micro/摘要）
    // 和 keepLast 等参数。
    const result = await compactService.compact(history, {
      lastPromptTokens,
      maxContextTokens: maxContext,
      policy: getCachePolicy(),
      force: true,
    })
    if (!result.compacted) return false
    backupBeforeCompact(history, { reason: 'auto', meta: { before: history.length, after: result.messages.length } })
    agent.setHistory(result.messages)
    _consecutiveFailures = 0
    const level = getCompactLevel(lastPromptTokens)
    announce(`\n\x1b[2m[自动压缩: ${before} → ${result.messages.length} 条消息 (${result.strategy}, ${level})]\x1b[0m`)
    return true
  } catch (e) {
    _consecutiveFailures++
    announce(`\n\x1b[2m[自动压缩失败 (${_consecutiveFailures}/3): ${e.message}]\x1b[0m`)
    return false
  }
}
