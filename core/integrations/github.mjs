// GitHub 工具集（独立模块，跟备份功能无关）
//
// 【为什么跟 tools/backup.mjs 分开】
// 备份是"把整份配置打包传到仓库"，属于运维；这里是"读仓库/开 issue/看 PR"，
// 属于日常开发操作。共用 token 配置没问题，但代码和语义要分开 ——
// 混在一起会让备份模块背上十几个跟备份无关的函数。
//
// 【为什么不用 gh CLI】
// 官方那些命令（/pr-comments 等）走 `gh` —— 那是给有 gh 的桌面环境设计的。
// Termux 上装 gh 要编译 Go 工具链，且它在手机上输入体验很差。
// 直接用 REST API + fetch（零依赖）反而更可靠，也让工具体验跟 Bash 一致。
//
// 【token 来源】
// 优先读环境变量 GITHUB_TOKEN / GH_TOKEN，其次读 GitHub 工具自己的配置文件
// `~/.claude-code-mobile/github.json`（/github login 写入）。
// **不读备份配置里的 token** —— 那属于另一个模块的私有配置，
// 跨模块读私有字段会让"改备份配置"意外影响工具集（用户明确要求别复用）。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CFG_DIR = join(homedir(), '.claude-code-mobile')
const CFG_PATH = join(CFG_DIR, 'github.json')
const API = 'https://api.github.com'

// ── 配置 ────────────────────────────────────────────────

export function loadGithubConfig() {
  try {
    const raw = JSON.parse(readFileSync(CFG_PATH, 'utf-8'))
    return (raw && typeof raw === 'object') ? raw : {}
  } catch { return {} }
}

export function saveGithubConfig(patch) {
  const cur = loadGithubConfig()
  const next = { ...cur, ...patch }
  try {
    if (!existsSync(CFG_DIR)) mkdirSync(CFG_DIR, { recursive: true })
    writeFileSync(CFG_PATH, JSON.stringify(next, null, 2), { encoding: 'utf-8', mode: 0o600 })
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
}

/**
 * 取 token。环境变量优先（便于临时切换/CI 用法），其次配置文件。
 * 返回空串表示未配置 —— 调用方据此给出「先 /github login」的提示，
 * 而不是发一个空 token 出去换个 401 回来。
 */
export function getGithubToken() {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (env && env.trim()) return env.trim()
  return String(loadGithubConfig().token || '').trim()
}

export function getGithubConfigPath() { return CFG_PATH }

/** 配置状态（供 /github status 展示；token 不回显明文） */
export function githubStatus() {
  const cfg = loadGithubConfig()
  const t = getGithubToken()
  const fromEnv = !!(process.env.GITHUB_TOKEN || process.env.GH_TOKEN)
  return {
    configured: !!t,
    tokenFrom: fromEnv ? 'env' : (cfg.token ? 'config' : 'none'),
    masked: t ? `${t.slice(0, 8)}…${t.slice(-4)}` : '',
    defaultRepo: cfg.defaultRepo || '',
    path: CFG_PATH,
  }
}

// ── HTTP 层 ─────────────────────────────────────────────

/**
 * 调 GitHub REST API。
 *
 * 两个刻意的设计：
 *   1. **返回结构化结果而不是抛异常** —— 工具要如实报告"哪个失败、错误是什么"，
 *      抛异常会被上层包成 "Tool error"，丢失 status/body 这些关键信息。
 *   2. **超时自己控**（默认 20s）—— 手机网络抖动比桌面常见，
 *      不设超时会让工具挂到框架的 600s 上限，用户干等。
 */
export async function ghApi(pathOrUrl, { method = 'GET', body = null, token = null, timeoutMs = 20000 } = {}) {
  const tk = token || getGithubToken()
  if (!tk) return { ok: false, status: 0, error: '未配置 GitHub token（先 /github login，或设 GITHUB_TOKEN 环境变量）' }
  const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${API}${pathOrUrl}`
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${tk}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch {}
    if (!res.ok) {
      // GitHub 的错误体统一是 { message, documentation_url, ... }，
      // 取出 message 比丢一整坨 JSON 有用得多（401 时就是 "Bad credentials"）。
      const msg = json?.message || text.slice(0, 200) || `HTTP ${res.status}`
      return { ok: false, status: res.status, error: msg, data: json }
    }
    return { ok: true, status: res.status, data: json }
  } catch (e) {
    const kind = e.name === 'TimeoutError' ? `超时（${timeoutMs}ms）` : (e.cause?.code || e.message)
    return { ok: false, status: 0, error: String(kind) }
  }
}

// ── 仓库解析 ────────────────────────────────────────────

/**
 * 把 "owner/repo" 或 GitHub URL 解析成 { owner, repo }。
 * 认不出返回 null（调用方给提示，不猜）。
 */
export function parseRepo(input) {
  const s = String(input || '').trim().replace(/\.git$/, '')
  if (!s) return null
  // 完整 URL：https://github.com/owner/repo(/...)
  const m = s.match(/github\.com[/:]([\w.-]+)\/([\w.-]+)/)
  if (m) return { owner: m[1], repo: m[2] }
  // owner/repo
  const m2 = s.match(/^([\w.-]+)\/([\w.-]+)$/)
  if (m2) return { owner: m2[1], repo: m2[2] }
  return null
}

/** 取仓库：显式参数 > 配置的 defaultRepo */
export function resolveRepo(input) {
  const p = parseRepo(input) || parseRepo(loadGithubConfig().defaultRepo)
  return p
}
