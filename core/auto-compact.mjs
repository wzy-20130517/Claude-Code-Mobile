// @ts-nocheck
// Claude Code Mobile - 自动上下文压缩
// 策略：默认关闭自动摘要；只认手动 /compact 与 /compact force；
// 已移除 cache-aware 自动摘要（易引发幻觉）；紧急保护依赖 agent 层上下文超长截断。
import { CompactService } from './compact.mjs'
import { backupBeforeCompact } from './compact-trash.mjs'
import { readFileSync, existsSync } from 'fs'
import { atomicWrite } from './atomic.mjs'
import { resolveConfigPath } from './paths.mjs'

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

export function getTokenLimit() { return tokenLimit }
export function getMessageLimit() { return messageLimit }
export function getMaxContext() { return maxContext }
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
    const result = await compactService.compact(history, {
      lastPromptTokens,
      maxContextTokens: maxContext,
      policy: getCachePolicy(),
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
