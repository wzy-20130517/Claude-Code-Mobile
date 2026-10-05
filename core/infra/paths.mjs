// Claude Code Mobile - 统一数据目录（2026-10-03）
//
// ══════════════════════════════════════════════════════════════
//  【设计目标】源码与用户数据完全分离
// ══════════════════════════════════════════════════════════════
//
// 用户要求：「把源码和用户数据完全分开，直到把 claude-code-mobile 里的
// .claude-code-mobile 文件夹去掉就是完整的项目源码」。
//
// 【为什么之前会混在一起】`new SessionStore()` 的默认参数是**相对路径**
// `.claude-code-mobile`，而 CLI 启动时 cwd 就是项目目录 →
// 数据被写进 `~/claude-code-mobile/.claude-code-mobile/`（584MB）。
// web/server.mjs 更直接：所有路径都是 `join(ROOT, '.claude-code-mobile', ...)`，
// ROOT 就是项目根。
//
// 【现在的规则】所有用户数据一律放 `~/.claude-code-mobile/`：
//   · 源码目录 = 干净的 git 仓库，`git status` 不再有数据文件噪音
//   · 数据跟着用户走，项目可以随便复制/重装
//   · 需要备份/清理时只动一个目录
//
// 【两种路径的语义】
//   · DATA_DIR      —— 用户数据根（~/.claude-code-mobile），可写
//   · PROJECT_DIR   —— 源码根（本文件所在目录的上级），只读代码
//   · CONFIG_PATH   —— 项目配置（config.json 在源码根，因为它是"项目的一部分"：
//                      用户会把它提交/分享，且首启向导要写它）
//
// ⚠ 不要在这里引入任何会读 config 的依赖 —— 本模块要能被最底层模块安全引用。

import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, cpSync, rmSync, statSync,
} from 'node:fs'

/** 源码根目录（core/ 的上级） */
export const PROJECT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/** 用户数据根目录（固定在家目录，与源码无关） */
export const DATA_DIR = join(homedir(), '.claude-code-mobile')

/**
 * 数据子目录/文件路径。例：dataPath('sessions') → ~/.claude-code-mobile/sessions
 * 传多段也可以：dataPath('web', 'uploads') → ~/.claude-code-mobile/web/uploads
 */
export function dataPath(...parts) {
  return parts.length ? join(DATA_DIR, ...parts) : DATA_DIR
}

/** 确保数据目录（或指定子目录）存在 */
export function ensureDataDir(...parts) {
  const p = dataPath(...parts)
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
  return p
}

/**
 * 确保某个文件路径的**父目录**存在（写文件前调）。
 *
 * 【为什么需要】2026-10-03 实测：全新用户（数据目录还不存在）走首次向导时
 * `writeFileSync(configPath)` 直接 ENOENT 崩溃 —— 目录没建就写文件。
 * 凡是往数据目录写文件的地方，写之前都要过这个函数。
 *
 * @param {string} filePath 目标文件完整路径
 */
export function ensureParentDir(filePath) {
  try {
    const dir = dirname(filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch {}
  return filePath
}

/**
 * 配置文件路径 —— **全部在用户数据目录**（2026-10-03 用户纠正）。
 *
 * 【为什么改】我第一版把 config.json 留在源码根，理由是「用户会手动编辑/分享」——
 * 用户当场否掉：「还有意的设计，这是用户数据啊，应该放 . 里面」。
 * 他说得对：config.json 装的是 provider/key/开关，是**用户数据**，
 * 源码目录应该是「clone 下来能直接跑」的纯代码。
 *
 * 【兼容旧位置】readConfigPath() 优先用数据目录，不存在时回退源码根
 * （老用户升级上来，配置还在项目里，不能装作看不见）。
 */
export const CONFIG_PATH = join(DATA_DIR, 'config.json')
export const HOOKS_PATH = join(DATA_DIR, 'hooks.json')
export const MCP_PATH = join(DATA_DIR, 'mcp.json')
export const PERMISSIONS_PATH = join(DATA_DIR, 'permissions.json')
export const WEB_CONFIG_PATH = join(DATA_DIR, 'web-config.json')
export const ENV_PATH = join(DATA_DIR, '.env')

/** 旧位置（源码根）的配置文件路径 —— 仅用于迁移检测 */
export function legacyConfigPath(name) {
  return join(PROJECT_DIR, name)
}

/**
 * 解析配置路径：优先数据目录，数据目录没有但源码根有 → 返回源码根那个
 * （老用户升级场景），两者都没有则返回数据目录路径（新建用）。
 *
 * @param {string} name 文件名，如 'config.json'
 */
export function resolveConfigPath(name) {
  const inData = join(DATA_DIR, name)
  if (existsSync(inData)) return inData
  const inProject = join(PROJECT_DIR, name)
  if (existsSync(inProject)) return inProject
  return inData   // 都没有 → 用数据目录（写入时会创建）
}

/**
 * 老位置（源码目录内的 .claude-code-mobile）。存在则返回路径，否则 null。
 * 仅用于迁移与兼容检测，**新代码不要往这里写**。
 */
export function legacyDataDir() {
  const old = join(PROJECT_DIR, '.claude-code-mobile')
  return existsSync(old) ? old : null
}

/**
 * 把老位置（源码内）的数据迁移到新位置（家目录）。
 *
 * 【合并策略】逐项搬：
 *   · 新位置没有 → 直接 rename（同盘，瞬时）
 *   · 新位置已有同名 → 跳过（不覆盖更新的数据），旧文件留在原地
 *   · 全部搬空后删掉老目录（用户要求：源码里不留 .claude-code-mobile）
 *
 * @param {object} [opts]
 *   log     (msg) => void  迁移日志（默认静默）
 *   dryRun  true 时只报告不搬
 * @returns {{moved: string[], skipped: string[], errors: string[]}}
 */
export function migrateLegacyData({ log = () => {}, dryRun = false } = {}) {
  const result = { moved: [], skipped: [], errors: [] }
  const old = legacyDataDir()
  if (!old) return result

  let entries = []
  try {
    entries = readdirSync(old)
  } catch (e) {
    result.errors.push(`读取旧目录失败: ${e.message}`)
    return result
  }

  ensureDataDir()

  for (const name of entries) {
    const from = join(old, name)
    const to = join(DATA_DIR, name)
    if (dryRun) {
      result.moved.push(name)
      log(`  [dry] 会迁移 ${name}`)
      continue
    }
    if (existsSync(to)) {
      // 【同名时做合并，不是简单跳过】2026-10-03 实测踩到：
      // 家目录已有 sessions/（里面是旧的嵌套空目录），而用户的 4 个真实会话
      // 在项目内 —— 简单跳过会让会话"消失"。目录就递归合并（逐文件搬，
      // 已存在的文件不覆盖），文件才跳过。
      let isDir = false
      try { isDir = statSync(from).isDirectory() } catch {}
      if (isDir) {
        const sub = mergeDir(from, to, log)
        if (sub.moved > 0) result.moved.push(`${name}(${sub.moved} 个文件)`)
        if (sub.skipped > 0) result.skipped.push(`${name}(${sub.skipped} 个同名保留)`)
        if (sub.errors.length) result.errors.push(...sub.errors)
      } else {
        result.skipped.push(name)
        log(`  跳过 ${name}（新位置已存在同名文件，保留旧的一份）`)
      }
      continue
    }
    try {
      renameSync(from, to)
      result.moved.push(name)
      log(`  迁移 ${name}`)
    } catch (e) {
      // rename 失败（跨设备/权限）→ 递归复制再删
      try {
        cpSync(from, to, { recursive: true })
        rmSync(from, { recursive: true, force: true })
        result.moved.push(name)
        log(`  迁移 ${name}（复制模式）`)
      } catch (e2) {
        result.errors.push(`${name}: ${e2.message}`)
        log(`  失败 ${name}: ${e2.message}`)
      }
    }
  }

  if (!dryRun) {
    try {
      const rest = readdirSync(old)
      if (rest.length === 0) {
        rmdirSync(old)
        log('  已删除源码内的 .claude-code-mobile（数据已全部迁出）')
      } else {
        log(`  源码内仍有 ${rest.length} 项未迁移：${rest.join(', ')}`)
      }
    } catch {}
  }

  return result
}

/**
 * 递归合并目录：把 src 里的内容搬进 dst，**已存在的同名文件不覆盖**。
 *
 * 【为什么需要】实测踩到：家目录已有 sessions/（里面是旧的嵌套空目录），
 * 而用户的真实会话文件在项目内 —— 简单跳过会让会话"消失"。
 * 逐文件搬既能保留两边数据，又不会用旧文件盖掉新文件。
 *
 * @returns {{moved:number, skipped:number, errors:string[]}}
 */
function mergeDir(src, dst, log) {
  const out = { moved: 0, skipped: 0, errors: [] }
  let items = []
  try { items = readdirSync(src) } catch (e) {
    out.errors.push(`读取 ${src} 失败: ${e.message}`)
    return out
  }
  for (const name of items) {
    const from = join(src, name)
    const to = join(dst, name)
    let isDir = false
    try { isDir = statSync(from).isDirectory() } catch { continue }
    if (isDir) {
      // 子目录：目标不存在就整体搬，存在就递归合并
      if (!existsSync(to)) {
        try { renameSync(from, to); out.moved++; log(`    ↳ ${name}/`) } catch (e) {
          out.errors.push(`${name}: ${e.message}`)
        }
      } else {
        const sub = mergeDir(from, to, log)
        out.moved += sub.moved
        out.skipped += sub.skipped
        out.errors.push(...sub.errors)
        // 子目录搬空后删掉，保持源码目录干净
        try { if (readdirSync(from).length === 0) rmdirSync(from) } catch {}
      }
    } else {
      if (existsSync(to)) { out.skipped++; continue }
      try { renameSync(from, to); out.moved++; log(`    ↳ ${name}`) } catch (e) {
        out.errors.push(`${name}: ${e.message}`)
      }
    }
  }
  return out
}

export default { PROJECT_DIR, DATA_DIR, dataPath, ensureDataDir, CONFIG_PATH, legacyDataDir, migrateLegacyData }
