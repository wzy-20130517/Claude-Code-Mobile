// core/version-check.mjs —— 版本检查与自动更新
//
// 【为什么有这个模块】
// 2026-10-03 用户：「启动时从 GitHub 抓最新版版本号，和当前比对，如果 GitHub 上更新
// 就弹个黄色提示。再加个一键更新的 slash 命令，从镜像更，不会覆盖用户数据。」
//
// 两个能力：
//   1. checkForUpdate()  —— 启动时静默检查，有新版返回信息供调用方显示黄字
//   2. performUpdate()   —— /update 命令用，从镜像下载并就地更新
//
// 【关键约束：不覆盖用户数据】
// 用户数据全在 ~/.claude-code-mobile/（见 core/paths.mjs），源码目录里没有。
// 但更新时仍然要小心：
//   · 只解压「源码文件」，绝不碰 ~/.claude-code-mobile/
//   · 保留 config.json / sessions / trash 等（它们在数据目录，天然不受影响）
//   · 项目根若存在用户自建文件（.env、CLAUDE.md 等），更新前先备份清单
//
// 【镜像】
// github.com:443 在国内常被墙，api.github.com 通常可达。
// 下载走 gh-proxy.com 镜像（用户 2026-10-03 明确要求）。
// 镜像地址可配：config.json 的 updateMirror 字段。

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

// ── 常量 ────────────────────────────────────────────────
export const REPO = 'wzy-20130517/Claude-Code-Mobile'
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`
const DEFAULT_MIRROR = 'https://gh-proxy.com'

// 检查结果缓存时长（毫秒）——避免同一进程反复请求
const CACHE_TTL = 30 * 60 * 1000
let _cache = { at: 0, result: null }

// ── 版本号比较 ──────────────────────────────────────────
/**
 * 语义化版本比较（支持 0.8.147 这种三段式，也容忍 v 前缀）
 * @returns {number} a>b 返回 1，a<b 返回 -1，相等返回 0
 */
export function compareVersions(a, b) {
  const norm = (v) => String(v || '').trim().replace(/^v/i, '').split(/[.\-+]/).map(x => {
    const n = parseInt(x, 10)
    return Number.isFinite(n) ? n : 0
  })
  const va = norm(a), vb = norm(b)
  const len = Math.max(va.length, vb.length)
  for (let i = 0; i < len; i++) {
    const x = va[i] || 0, y = vb[i] || 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

/** 判断 remote 是否比 local 新 */
export function isNewer(remote, local) {
  return compareVersions(remote, local) > 0
}

// ── 读取远端最新版本 ────────────────────────────────────
/**
 * 从 GitHub API 抓最新 release 的 tag。
 * 失败（网络/限流/无 release）返回 null，不抛错——启动检查不能阻塞主流程。
 *
 * @param {object} opts
 *   timeout    超时毫秒，默认 5000（启动路径不能等太久）
 *   useCache   是否用缓存，默认 true
 */
export async function fetchLatestVersion(opts = {}) {
  const { timeout = 5000, useCache = true } = opts

  if (useCache && _cache.result && Date.now() - _cache.at < CACHE_TTL) {
    return _cache.result
  }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeout)
  try {
    const res = await fetch(API_URL, {
      signal: ac.signal,
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'claude-code-mobile-version-check',
      },
    })
    if (!res.ok) return null
    const data = await res.json()
    const tag = String(data.tag_name || '').replace(/^v/i, '').trim()
    if (!tag) return null

    const result = {
      version: tag,
      name: data.name || '',
      url: data.html_url || '',
      notes: String(data.body || '').slice(0, 500),
      publishedAt: data.published_at || '',
    }
    _cache = { at: Date.now(), result }
    return result
  } catch {
    return null   // 网络失败静默——启动检查不该报错打扰用户
  } finally {
    clearTimeout(timer)
  }
}

// ── 启动时检查 ──────────────────────────────────────────
/**
 * 检查是否有新版。返回 { hasUpdate, current, latest, url } 或 null（检查失败/无新版）。
 * 调用方拿 hasUpdate=true 就显示黄字提示。
 */
export async function checkForUpdate(currentVersion, opts = {}) {
  const latest = await fetchLatestVersion(opts)
  if (!latest) return null

  const hasUpdate = isNewer(latest.version, currentVersion)
  if (!hasUpdate) return null

  return {
    hasUpdate: true,
    current: currentVersion,
    latest: latest.version,
    url: latest.url,
    publishedAt: latest.publishedAt,
  }
}

// ── 更新执行 ────────────────────────────────────────────
/**
 * 执行更新：从镜像下载最新版 tar.gz，解压到临时目录，然后就地覆盖源码文件。
 *
 * 【不覆盖用户数据的设计】
 *   - 用户数据在 ~/.claude-code-mobile/，源码目录里没有 → 天然安全
 *   - 只覆盖「上游包里存在的文件」，不动包外的任何东西
 *   - 更新前列出将被覆盖的文件，执行后报告清单
 *
 * @param {object} opts
 *   version    目标版本号（如 '0.8.147'）
 *   projectDir 项目目录
 *   mirror     镜像前缀，默认 https://gh-proxy.com
 *   onLog      日志回调 (line) => void
 * @returns {Promise<{ok, error?, updated?, backupDir?}>}
 */
export async function performUpdate(opts) {
  const {
    version,
    projectDir,
    mirror = DEFAULT_MIRROR,
    onLog = () => {},
  } = opts

  if (!version) return { ok: false, error: '未指定目标版本' }
  if (!projectDir || !existsSync(projectDir)) return { ok: false, error: `项目目录不存在: ${projectDir}` }

  const tmpBase = join(tmpdir(), `ccm-update-${Date.now()}`)
  const tarPath = join(tmpBase, 'src.tar.gz')
  const extractDir = join(tmpBase, 'extract')

  try {
    mkdirSync(tmpBase, { recursive: true })

    // ── 1. 下载 ──────────────────────────────────────
    const tag = `v${String(version).replace(/^v/i, '')}`
    const upstream = `https://codeload.github.com/${REPO}/tar.gz/refs/tags/${tag}`
    const url = mirror ? `${mirror}/${upstream}` : upstream

    onLog(`下载: ${url}`)

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 180000)   // 3 分钟
    let buf
    try {
      const res = await fetch(url, { signal: ac.signal })
      if (!res.ok) return { ok: false, error: `下载失败 HTTP ${res.status}` }
      buf = Buffer.from(await res.arrayBuffer())
    } finally {
      clearTimeout(timer)
    }

    if (buf.length < 1024) return { ok: false, error: `下载内容异常（${buf.length} 字节）` }
    writeFileSync(tarPath, buf)
    onLog(`已下载 ${(buf.length / 1024 / 1024).toFixed(1)} MB`)

    // ── 2. 解压 ──────────────────────────────────────
    mkdirSync(extractDir, { recursive: true })
    try {
      execFileSync('tar', ['-xzf', tarPath, '-C', extractDir], { stdio: 'pipe', timeout: 120000 })
    } catch (e) {
      return { ok: false, error: `解压失败: ${e?.message || e}` }
    }

    // tar 包顶层是 Claude-Code-Mobile-<version>/
    const entries = readdirSync(extractDir).filter(n => !n.startsWith('.'))
    if (entries.length !== 1) return { ok: false, error: `解压结果异常（顶层 ${entries.length} 个条目）` }
    const srcRoot = join(extractDir, entries[0])
    if (!existsSync(join(srcRoot, 'index.mjs'))) {
      return { ok: false, error: '解压结果里没有 index.mjs，可能不是本项目的包' }
    }
    onLog(`已解压: ${entries[0]}`)

    // ── 3. 备份将要覆盖的文件 ────────────────────────
    // 只备份「本次会被改动的文件」，放数据目录下，出问题能回滚
    const backupDir = join(homedir(), '.claude-code-mobile', 'update-backup', tag)
    const changed = []

    const walk = (dir, rel = '') => {
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name)
        const relPath = rel ? `${rel}/${name}` : name
        const st = statSync(abs)
        if (st.isDirectory()) {
          // 跳过不该覆盖的目录
          if (['node_modules', '.git', '.claude-code-mobile'].includes(name)) continue
          walk(abs, relPath)
        } else {
          const target = join(projectDir, relPath)
          if (existsSync(target)) {
            const oldSize = statSync(target).size
            if (oldSize !== st.size) changed.push(relPath)
          } else {
            changed.push(relPath + ' (新增)')
          }
        }
      }
    }
    walk(srcRoot)

    if (changed.length) {
      mkdirSync(backupDir, { recursive: true })
      for (const relPath of changed) {
        const clean = relPath.replace(' (新增)', '')
        const src = join(projectDir, clean)
        if (!existsSync(src)) continue
        const dst = join(backupDir, clean)
        mkdirSync(dirname(dst), { recursive: true })
        copyFileSync(src, dst)
      }
      onLog(`已备份 ${changed.length} 个将改动的文件 → ${backupDir}`)
    }

    // ── 4. 就地覆盖 ──────────────────────────────────
    let written = 0
    const copyTree = (dir, rel = '') => {
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name)
        const relPath = rel ? `${rel}/${name}` : name
        const st = statSync(abs)
        if (st.isDirectory()) {
          if (['node_modules', '.git', '.claude-code-mobile'].includes(name)) continue
          mkdirSync(join(projectDir, relPath), { recursive: true })
          copyTree(abs, relPath)
        } else {
          const target = join(projectDir, relPath)
          mkdirSync(dirname(target), { recursive: true })
          copyFileSync(abs, target)
          written++
        }
      }
    }
    copyTree(srcRoot)
    onLog(`已更新 ${written} 个文件`)

    return { ok: true, updated: written, backupDir, changed: changed.length }

  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  } finally {
    try { rmSync(tmpBase, { recursive: true, force: true }) } catch {}
  }
}

// ── 供命令层使用的单例缓存清理（测试用）──────────────────
export function _clearCache() {
  _cache = { at: 0, result: null }
}
