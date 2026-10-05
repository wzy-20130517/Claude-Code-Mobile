// 工作区路径统一管理
//
// 解析顺序（从高到低）：
//   1. config.json 的 workspacePath —— /workspace 命令或 onboarding 写入的用户意图
//   2. 环境变量 CCM_WORKSPACE —— 部署/测试用（CCM_* 是本项目环境变量前缀惯例）
//   3. 动态默认（defaultWorkspacePath）：探测当前环境，不写死任何绝对路径 ——
//        Android 共享存储可见 → /sdcard/Download/claude-workspace
//        Termux 只有 storage 软链 → ~/storage/downloads/claude-workspace
//        桌面 Linux/macOS      → ~/claude-workspace
// 旧版把 /sdcard/Download/claude-workspace 写死在常量里，换台设备就是错的（用户指出）。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { resolveConfigPath, ensureParentDir } from './paths.mjs'

// 【2026-10-03】配置属用户数据，统一放 ~/.claude-code-mobile/
const CONFIG_PATH = resolveConfigPath('config.json')

/** 动态默认工作区（环境变量 > 平台探测，均不写死路径） */
export function defaultWorkspacePath() {
  const env = String(process.env.CCM_WORKSPACE || '').trim()
  if (env) return env
  // Android：共享存储的 Download 下建工作区（手机文件管理可见）
  if (existsSync('/sdcard/Download')) return '/sdcard/Download/claude-workspace'
  // 有些 Termux 环境只有 storage 软链、没挂 /sdcard
  const termuxDownloads = join(homedir(), 'storage', 'downloads')
  if (existsSync(termuxDownloads)) return join(termuxDownloads, 'claude-workspace')
  // 桌面环境兜底：家目录
  return join(homedir(), 'claude-workspace')
}

export function getWorkspacePath() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    if (cfg.workspacePath && typeof cfg.workspacePath === 'string' && cfg.workspacePath.trim()) {
      return cfg.workspacePath.trim()
    }
  } catch {}
  return defaultWorkspacePath()
}

export function setWorkspacePath(path) {
  const p = String(path || '').trim()
  if (!p) return { ok: false, error: '路径不能为空' }
  if (!/^\//.test(p)) return { ok: false, error: '必须是绝对路径（以 / 开头）' }
  let cfg = {}
  try { cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) } catch {}
  cfg.workspacePath = p
  ensureParentDir(CONFIG_PATH)   // 数据目录可能还不存在
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
  return { ok: true, path: p }
}

