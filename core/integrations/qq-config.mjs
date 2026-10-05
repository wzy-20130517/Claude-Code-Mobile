/**
 * QQ 桥配置（端点感知）。
 *
 * ═══════════════════════════════════════════════════════════════
 * 【要解决的问题】
 *
 * QQ 桥最初只有 CLI 一个使用者，配置写成一维结构：
 *     { enabled: true, port: 3000, owner: '...', napcatApi: '...' }
 *
 * 现在有三个地方能跑桥：
 *     cli  — Termux 里的 index.mjs
 *     web  — web/server.mjs（Termux 侧）
 *     ccm  — CCM APK 的 proot 内核（homedir 是 /root，配置天然隔离）
 *
 * 一维结构在多个使用者下会坏掉，具体坏在两处：
 *
 *   ① `enabled` 一个布尔值被 cli 和 web 同时读 ——
 *      在 CLI 敲 /qq on 会让 **Web 下次启动也自动开桥**。
 *      用户根本没在 Web 上开过，凭什么它自己开？
 *      （反过来更常见：在 Web 开 → CLI 启动时抢端口）
 *
 *   ② `port` 三端共用 —— 而 proot 与 Termux 共享网络命名空间，
 *      三端抢同一个端口时先起的独占，后起的 EADDRINUSE。
 *      这个失败还是**静默**的，用户只看到「QQ 消息没反应」。
 *
 * ═══════════════════════════════════════════════════════════════
 * 【设计：开关按端分，端口共用】
 *
 *     {
 *       "owner": "123456789",           // 共用：一个 QQ 账号，不分端
 *       "napcatApi": "http://...",     // 共用：NapCat 地址
 *       "port": 3000,                  // 共用：同一时间只允许一个端监听
 *       "endpoints": {
 *         "cli": { "enabled": true },
 *         "web": { "enabled": false },
 *         "ccm": { "enabled": false }
 *       }
 *     }
 *
 * · **开关按端分**：每个端只看自己的 enabled。CLI on 不会让 Web 也 on。
 * · **端口共用**：因为只允许一个端在监听 —— 想换端就得先在原端 off。
 *   端口不按端错开是刻意的：三端同时收消息意味着同一条 QQ 指令
 *   被执行三次（三个 agent 同时改文件、烧三份 token），几乎不会是用户想要的。
 *
 * 【用户不需要手改配置】每个端的 /qq on|off 只写自己那一份。
 * 用户视角就是「在哪个端敲的 on，就哪个端收消息」，不需要理解 endpoints 结构。
 *
 * ═══════════════════════════════════════════════════════════════
 * 【旧配置迁移】
 *
 * 旧文件：{ "enabled": true, "port": 3000, "owner": "..." }
 *      或 { "qqActive": true, "owner": "..." }（更早的 Web 手写分支写的）
 *
 * 读取时若没有 endpoints 字段，把旧值当成 **cli** 的开关
 *（历史上只有 CLI 会写这两个字段），其他端一律 false。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

/**
 * 配置文件路径。
 *
 * ⚠ CCM 里 homedir() 是 /root（proot 的 rootfs 内），与 Termux 的
 * /data/data/com.termux/files/home 天然隔离 —— 也就是说 CCM 读的是
 * 另一份文件，这本身没问题（它就是独立环境），但要注意：
 * 在 Termux 改的配置不会影响 CCM，反之亦然。
 */
export const QQ_CONFIG_PATH = join(homedir(), '.claude-code-mobile', 'qq-config.json')

const DEFAULT_PORT = 3000
// 【开源版】默认不预设主人号 —— 用户用 /qq owner <QQ号> 自己配。
const DEFAULT_OWNER = ''
const DEFAULT_NAPCAT_API = 'http://127.0.0.1:5700'

/** 所有已知端点 */
export const ENDPOINTS = ['cli', 'web', 'ccm']

/** 端标识 → 中文名（给用户看的文案用） */
export function endpointLabelOf(name) {
  return ({
    cli: 'CLI（Termux 终端）',
    web: 'Web 界面',
    ccm: 'CCM App',
  })[name] || name || '未知端'
}

/**
 * 识别当前跑在哪个端。
 *
 * 判断依据（按优先级）：
 *   · CCM_MODE  —— ccm-start.mjs 在 proot 里设的（'native'）
 *   · CCM_WEB   —— web/server.mjs 顶部设的（Termux 侧的 Web 服务）
 *   · 都没有     —— index.mjs，也就是 CLI
 *
 * 【为什么不靠 cwd 或文件名】都不可靠：CLI 和 Web 的代码在同一目录下，
 * 靠进程启动参数区分才是准的。
 */
export function detectEndpoint() {
  if (process.env.CCM_MODE) return 'ccm'
  if (process.env.CCM_WEB === '1') return 'web'
  return 'cli'
}

function readRaw() {
  try { return JSON.parse(readFileSync(QQ_CONFIG_PATH, 'utf-8')) || {} }
  catch { return {} }
}

/**
 * 读出某个端点的配置。
 *
 * @param {string} [endpoint] 不传则自动识别
 * @returns {{endpoint, enabled, port, owner, napcatApi, allowInterrupt, openMode, raw}}
 */
export function loadQqConfig(endpoint = detectEndpoint()) {
  const raw = readRaw()

  let ep = raw.endpoints?.[endpoint]
  if (!ep) {
    if (endpoint === 'cli') {
      // 旧配置迁移：一维字段属于 CLI（历史上只有它写这些）。
      // 注意 enabled 的语义 —— 旧版本里「没配过」等同于「默认开」
      //（index.mjs 的 qqAutoStart 默认 true），但那会让新装用户
      // 莫名其妙被占端口。现在统一成「只有明确写过 true 才算开」。
      ep = { enabled: raw.enabled === true || raw.qqActive === true }
    } else {
      ep = { enabled: false }
    }
  }

  return {
    endpoint,
    enabled: !!ep.enabled,
    // 端口共用：同一时间只允许一个端监听（见文件头说明）
    port: Number(raw.port) || DEFAULT_PORT,
    owner: String(raw.owner || DEFAULT_OWNER),
    napcatApi: String(raw.napcatApi || DEFAULT_NAPCAT_API),
    allowInterrupt: raw.allowInterrupt === true,
    openMode: raw.openMode === true,
    raw,
  }
}

/**
 * 写入配置。
 *
 * 【字段路由】调用方只关心「我要改什么」，不用管该写哪一层：
 *   · enabled            → 写进**当前端点**（关键：不会影响别的端）
 *   · port/owner/...     → 写进共用层
 *
 * @param {object} patch
 * @param {string} [endpoint]
 */
export function saveQqConfig(patch = {}, endpoint = detectEndpoint()) {
  try {
    mkdirSync(dirname(QQ_CONFIG_PATH), { recursive: true })
    const raw = readRaw()

    const shared = {}
    for (const k of ['port', 'owner', 'napcatApi', 'allowInterrupt', 'openMode']) {
      if (k in patch) shared[k] = patch[k]
    }

    const next = { ...raw, ...shared }
    if ('enabled' in patch) {
      next.endpoints = {
        ...(raw.endpoints || {}),
        [endpoint]: { ...(raw.endpoints?.[endpoint] || {}), enabled: !!patch.enabled },
      }
    }

    // 兼容层：cli 端点的开关同步到旧的一维字段。
    // 万一用户回退到旧版本，CLI 侧仍能读到正确的开关（旧代码只认这两个字段）。
    if (endpoint === 'cli' && next.endpoints?.cli) {
      next.enabled = !!next.endpoints.cli.enabled
    }

    writeFileSync(QQ_CONFIG_PATH, JSON.stringify(next, null, 2))
    return { ok: true, config: next }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/**
 * 列出各端点的开关状态。
 *
 * 【用途】/qq 无参时展示 —— 用户能看到「CLI 开着、Web 关着」，
 * 换端前就知道该去哪关。这也是冲突报错文案的数据来源。
 */
export function listEndpoints() {
  const raw = readRaw()
  return ENDPOINTS.map(name => {
    const c = loadQqConfig(name)
    return { name, enabled: c.enabled, port: c.port }
  })
}

/**
 * 找出「除自己以外，还有哪些端开着」。
 *
 * 【用途】启动前检查 —— 有别的端开着就意味着端口会被占，
 * 与其等 EADDRINUSE 静默失败，不如提前给出可操作的提示。
 */
export function otherEnabledEndpoints(self = detectEndpoint()) {
  return listEndpoints().filter(e => e.name !== self && e.enabled)
}
