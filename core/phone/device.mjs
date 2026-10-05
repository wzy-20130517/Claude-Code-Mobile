// Claude Code Mobile - 设备 shell 通道抽象层
//
// 【要解决什么】
// phone use / 截屏 / 读 UI 树都需要「以 shell 身份跑命令」。取这个身份有两条路：
//   · shizuku  —— ~/rish/rish -c '<cmd>'          权限最完整，官方推荐
//   · adb      —— adb -s 127.0.0.1:<port> shell   本机回环，三端通用，不依赖第三方 App
// 以前每个模块各自写死 rish，Shizuku 一挂就全废。这里收口成一处。
//
// 【为什么不自动探测端口 / 不缓存判定】
// adb 端口是本机环境的事，不属于项目代码；而且判定结果缓存会在通道切换后失效，
// 反而制造「明明配好了却还用旧的」这类怪问题。所以：
//   · 通道由配置显式决定（auto / shizuku / adb），auto 就是「每次如实试一次」
//   · adb 地址由 ~/.claude-code-mobile/device.json 提供，谁写进去的不管
//   · 不写端口扫描、不写属性读取、不写重连逻辑
//
// 【配置】
//   ~/.claude-code-mobile/device.json
//   {
//     "shell": "auto",                                  // auto | shizuku | adb
//     "rish": "~/rish/rish",                            // 可省，默认此值
//     "adb": { "host": "127.0.0.1", "port": 5555 }      // shell=adb 或 auto 时需要
//   }
// 用 /device 命令改，或跑 ~/.claude-code-mobile/adb-setup.sh 写 adb 段。

import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const DEVICE_CONFIG_DIR = join(homedir(), '.claude-code-mobile')
export const DEVICE_CONFIG_PATH = join(DEVICE_CONFIG_DIR, 'device.json')

const DEFAULT_RISH = join(homedir(), 'rish', 'rish')
const MAX_BUFFER = 12 * 1024 * 1024

/** 读配置。文件不存在/损坏都返回默认值，不抛。 */
export function loadDeviceConfig() {
  const def = { shell: 'auto', rish: DEFAULT_RISH, adb: null, phoneMode: null }
  try {
    if (!existsSync(DEVICE_CONFIG_PATH)) return def
    const raw = JSON.parse(readFileSync(DEVICE_CONFIG_PATH, 'utf8'))
    return {
      shell: ['auto', 'shizuku', 'adb'].includes(raw.shell) ? raw.shell : 'auto',
      rish: typeof raw.rish === 'string' && raw.rish.trim() ? expandHome(raw.rish) : DEFAULT_RISH,
      adb: raw.adb && raw.adb.port ? { host: raw.adb.host || '127.0.0.1', port: Number(raw.adb.port) } : null,
      // 手机操作模式的**偏好**：'foreground' | 'background' | 'ask' | null
      //   foreground/background → 以后固定用那个屏，不再弹选择
      //   ask                   → 每次都弹
      //   null                  → 从没设过，第一次弹选择后写入
      // ⚠️ 这个函数的返回值是**白名单** —— 新增字段必须同时加在这里和下面的
      //    saveDeviceConfig，否则读回来永远是 undefined。
      //    （这个坑踩过一次：phoneMode 存进去了但读不到。）
      phoneMode: ['foreground', 'background', 'ask'].includes(raw.phoneMode) ? raw.phoneMode : null,
    }
  } catch { return def }
}

/** 写配置（合并式，只覆盖传入的字段）。 */
export function saveDeviceConfig(patch = {}) {
  const cur = loadDeviceConfig()
  const next = { ...cur, ...patch }
  if (patch.adb !== undefined) next.adb = patch.adb
  if (patch.phoneMode !== undefined) next.phoneMode = patch.phoneMode
  mkdirSync(DEVICE_CONFIG_DIR, { recursive: true })
  writeFileSync(DEVICE_CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  return next
}

function expandHome(p) {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

/** adb 的设备串，如 127.0.0.1:5555 */
export function adbTarget(cfg = null) {
  const c = cfg || loadDeviceConfig()
  if (!c.adb?.port) return null
  return `${c.adb.host || '127.0.0.1'}:${c.adb.port}`
}

// ── 底层执行 ────────────────────────────────────────────────

function exec(cmd, args, timeout, extraEnv = null) {
  return new Promise(resolve => {
    try {
      const opts = { timeout, maxBuffer: MAX_BUFFER }
      if (extraEnv) opts.env = { ...process.env, ...extraEnv }
      execFile(cmd, args, opts, (err, stdout, stderr) => {
        resolve({
          ok: !err,
          out: String(stdout || ''),
          err: err ? (String(stderr || '') || err.message) : '',
        })
      })
    } catch (e) { resolve({ ok: false, out: '', err: e.message }) }
  })
}

/**
 * 二进制安全的执行：拿原始 Buffer，不做任何编码转换。
 * 只给截图这类「输出是二进制」的场景用；普通命令走 exec 拿字符串。
 */
function execBinary(cmd, args, timeout) {
  return new Promise(resolve => {
    try {
      execFile(cmd, args, { timeout, maxBuffer: MAX_BUFFER, encoding: 'buffer' }, (err, stdout, stderr) => {
        const stderrText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '')
        resolve({
          ok: !err,
          buf: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || ''),
          err: err ? (stderrText || err.message) : stderrText,
        })
      })
    } catch (e) { resolve({ ok: false, buf: Buffer.alloc(0), err: e.message }) }
  })
}

/** 把一坨堆栈压成一行摘要 —— 调用方只需要知道「为什么不可用」。 */
function firstLine(s) {
  return String(s || '').split('\n').map(l => l.trim()).filter(Boolean)[0]?.slice(0, 120) || '无响应'
}

/** 经 Shizuku 跑。需要 rish 存在。 */
async function viaShizuku(cfg, cmd, timeout) {
  const rish = cfg.rish || DEFAULT_RISH
  if (!existsSync(rish)) {
    return { ok: false, out: '', err: `rish 不存在：${rish}`, channel: 'shizuku', unavailable: true }
  }
  const r = await exec(rish, ['-c', cmd], timeout, {
    // rish 要求声明「是谁在调用」，否则直接拒绝：
    //   RISH_APPLICATION_ID is not set, set this environment variable ...
    // 用 Termux 包名（它才是真正持有 rish 的那一方）。
    RISH_APPLICATION_ID: cfg.rishAppId || 'com.termux',
  })
  // Shizuku 掉线的典型特征，识别出来好让 auto 模式干净地落到 adb
  if (/Request timeout|Waiting for Shizuku|Failed to load shell class|Class not found|Shizuku.*授权/i.test(r.out + r.err)) {
    return { ...r, ok: false, channel: 'shizuku', unavailable: true }
  }
  return { ...r, channel: 'shizuku' }
}

/** 经本机 adb 跑。 */
async function viaAdb(cfg, cmd, timeout) {
  const target = adbTarget(cfg)
  if (!target) {
    return { ok: false, out: '', err: '未配置 adb 端口（跑 ~/.claude-code-mobile/adb-setup.sh 或手填 device.json 的 adb.port）', channel: 'adb', unavailable: true }
  }
  const r = await exec('adb', ['-s', target, 'shell', cmd], timeout)
  if (/device (not found|unauthorized)|failed to authenticate|cannot connect/i.test(r.out + r.err)) {
    return { ...r, ok: false, channel: 'adb', unavailable: true }
  }
  return { ...r, channel: 'adb' }
}

// ── 对外接口 ────────────────────────────────────────────────

/**
 * 跑一条 shell 命令。
 * 按配置选通道；auto 时先 shizuku，不可用则 adb。
 * 返回 { ok, out, err, channel } —— channel 是实际用的那条，方便排查。
 */
export async function runShell(cmd, timeout = 45000) {
  const cfg = loadDeviceConfig()
  const mode = cfg.shell

  if (mode === 'adb') return await viaAdb(cfg, cmd, timeout)
  if (mode === 'shizuku') return await viaShizuku(cfg, cmd, timeout)

  // auto
  const s = await viaShizuku(cfg, cmd, timeout)
  if (s.ok || !s.unavailable) return s
  const a = await viaAdb(cfg, cmd, timeout)
  return { ...a, fellBack: true, shizukuErr: firstLine(s.err || s.out) }
}

/**
 * 截屏并直取到本地文件。
 * adb 有 exec-out，能绕开 /sdcard 中转、不受存储权限影响；
 * rish 只能用 screencap 落盘再读（原来的做法）。
 * 返回 { ok, err, path, channel, via }
 */
/**
 * 截屏。
 *
 * @param localPath 落盘路径
 * @param timeout   超时
 * @param displayId 目标屏。**不传就截主屏（0）** ——
 *   background 模式想截副屏必须显式传，否则会截到用户正在看的主屏。
 *   （2026-09-26 用户报「你截图截的是我主屏」就是这个：screencap 没带 -d，
 *     而 phone_snapshot 走的是另一条路（vd 的 targetDisplayId），两条路没打通。）
 */
/** PNG 魔数（89 50 4E 47 0D 0A 1A 0A）—— 用来识别 screencap 把错误文本当图吐出来的情况。 */
function isPng(buf) {
  return buf && buf.length > 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
}

export async function captureScreen(localPath, timeout = 30000, displayId = null) {
  const cfg = loadDeviceConfig()
  const mode = cfg.shell
  // screencap 的 display 参数。
  //
  // ⚠️ 虚拟屏要传 **SurfaceFlinger token**，不是 DisplayManager 的 displayId。
  // 两者是不同编号体系，传错了报 "Display Id 'N' is not valid"（实测）。
  // 主屏（不传 / 传 0）走默认，不加 -d —— 加 `-d 0` 反而会失败，
  // 因为主屏在 SurfaceFlinger 里的 token 不是 0。
  let dFlag = ''
  const wantVirtual = displayId !== null && Number.isFinite(Number(displayId)) && Number(displayId) > 0
  if (wantVirtual) {
    const token = await vdDisplayToken()
    dFlag = token ? ` -d ${token}` : ` -d ${Number(displayId)}`
  }

  const tryAdb = async () => {
    const target = adbTarget(cfg)
    if (!target) return { ok: false, err: '未配置 adb 端口', channel: 'adb', unavailable: true }
    // exec-out 是二进制安全的：它不做 \n 转换。
    // 注意不能让 execFile 按 utf8 解码（那会把 PNG 字节洗坏，
    // 存出来的文件 `file` 只认成 data），所以走 Buffer 直取这条独立路径。
    const args = ['-s', target, 'exec-out', `screencap -p${dFlag}`]
    const buf = await execBinary('adb', args, timeout)
    if (!buf.ok || !buf.buf?.length) return { ok: false, err: firstLine(buf.err || '截图为空'), channel: 'adb' }
    // ⚠️ screencap 对**不存在的 display** 不报非零退出码，而是把错误信息
    // 当"图片"从 stdout 吐出来（实测：80 字节 ASCII，内容是
    // "Failed to take screenshot. Display Id '23' is not valid."）。
    // 不判这个的话会把它当 PNG 存盘，后面 OCR/图片解码再报一堆看不懂的错。
    if (!isPng(buf.buf)) {
      const msg = buf.buf.toString('utf8').replace(/[^\x20-\x7e]/g, ' ').trim()
      const invalidDisplay = /Display Id .* is not valid|not valid/i.test(msg)
      return {
        ok: false,
        err: invalidDisplay
          ? `目标屏 ${displayId ?? 0} 已失效（${msg.slice(0, 120)}）`
          : `截屏返回的不是图片：${msg.slice(0, 120)}`,
        channel: 'adb',
        invalidDisplay,
      }
    }
    try {
      writeFileSync(localPath, buf.buf)
      return { ok: true, path: localPath, channel: 'adb', via: 'exec-out', displayId: displayId ?? 0 }
    } catch (e) { return { ok: false, err: `写文件失败：${e.message}`, channel: 'adb' } }
  }

  const tryShizuku = async () => {
    const remote = `/sdcard/.ccm-shot-${Date.now()}.png`
    const a = await viaShizuku(cfg, `screencap -p${dFlag} ${remote}`, timeout)
    if (!a.ok) return a
    // 用 cat 把内容读回来（rish 跑在 shell 用户下，Termux 读 /sdcard 受 scoped storage 限制）
    const b = await viaShizuku(cfg, `cat ${remote}; rm -f ${remote}`, timeout)
    if (!b.ok || !b.out.length) return { ok: false, err: b.err || '读取截图内容为空', channel: 'shizuku' }
    try {
      writeFileSync(localPath, Buffer.from(b.out, 'binary'))
      return { ok: true, path: localPath, channel: 'shizuku', via: 'cat' }
    } catch (e) { return { ok: false, err: `写文件失败：${e.message}`, channel: 'shizuku' } }
  }

  if (mode === 'adb') return await tryAdb()
  if (mode === 'shizuku') return await tryShizuku()

  const s = await tryShizuku()
  if (s.ok) return s
  const a = await tryAdb()
  return { ...a, fellBack: true, shizukuErr: firstLine(s.err) }
}

/** 探测当前能用哪条通道（给 /device status 和 /doctor 用，不做缓存）。 */
export async function probe() {
  const cfg = loadDeviceConfig()
  const out = { mode: cfg.shell, rish: cfg.rish, rishExists: existsSync(cfg.rish || DEFAULT_RISH), adb: adbTarget(cfg), channels: {} }

  if (cfg.shell !== 'adb' && out.rishExists) {
    const r = await viaShizuku(cfg, 'echo __ccm_ok__', 15000)
    out.channels.shizuku = r.ok && /__ccm_ok__/.test(r.out)
      ? { usable: true }
      : { usable: false, reason: firstLine(r.err || r.out) }
  } else {
    out.channels.shizuku = { usable: false, reason: out.rishExists ? '配置为 adb-only' : `rish 不存在：${cfg.rish}` }
  }

  if (out.adb) {
    const r = await viaAdb(cfg, 'echo __ccm_ok__', 15000)
    out.channels.adb = r.ok && /__ccm_ok__/.test(r.out)
      ? { usable: true }
      : { usable: false, reason: firstLine(r.err || r.out) }
  } else {
    out.channels.adb = { usable: false, reason: '未配置端口' }
  }

  out.active = out.channels.shizuku.usable ? 'shizuku' : (out.channels.adb.usable ? 'adb' : null)
  return out
}

/** 给人看的一行摘要，CLI/Web 状态区都用它。 */
export async function describeDevice() {
  const p = await probe()
  const mark = c => p.channels[c]?.usable ? '✅' : '❌'
  const why = c => p.channels[c]?.usable ? '' : `（${p.channels[c]?.reason || '不可用'}）`
  const vd = await vdAlive(1200)
  return [
    `通道模式：${p.mode}    当前生效：${p.active || '无'}`,
    `  ${mark('shizuku')} Shizuku  ${p.rishExists ? p.rish : `rish 不存在：${p.rish}`}${why('shizuku')}`,
    `  ${mark('adb')} adb       ${p.adb || '未配置（跑 ~/.claude-code-mobile/adb-setup.sh）'}${why('adb')}`,
    `  ${vd.alive ? '✅' : '○'} 虚拟副屏  ${vd.alive ? `运行中（display ${vd.displayId}，端口 ${VD_HTTP_PORT}）` : '未启动（/device vd start）'}`,
  ].join('\n')
}

/** 临时截图路径（/device test 用）。放 Termux 私有目录，避免 /sdcard 权限问题。 */
export function tmpShotPath() {
  const dir = join(homedir(), 'tmp')
  try { mkdirSync(dir, { recursive: true }) } catch {}
  return join(dir, `device-test-${Date.now()}.png`)
}

// ── 虚拟副屏（adb 通道）──────────────────────────────────────
//
// 【为什么 CLI/Web 也能有副屏】
// 一度以为不行：建虚拟屏要 shell uid，而 Termux 没有 Shizuku 的 binder。
// 后来实测发现 adb 就是 shell uid，且 app_process 带类名启动**不会**碰
// /data/local/tmp 之外的东西 —— AOSP app_main.cpp 里那个 dalvik-cache chown
// 只在 zygote 分支（不带类名）跑。所以这条路成立：
//
//   adb shell → app_process 加载我们的 dex → 建屏 → 开 3458 端口 → Termux 连它
//
// 【已知限制】那个进程里 UiAutomation.connect() 会被系统 SIGKILL
//（AccessibilityManagerService 等不到窗口就绪信号，超时后杀进程）。
// 所以元素树不走 UiAutomation，改用 dumpsys。建屏/截图/input 都不受影响。
//
// dex 由 tools/vd/build.sh 编译，随内核包分发。

export const VD_HTTP_PORT = 3458

/**
 * 帧缓存超过这个时间没更新才怀疑副屏失效（毫秒）。
 *
 * 【为什么不能用「帧是否在动」判断屏死没死】副屏上界面静止时（没动画、
 * 没滚动），ImageReader 就是不产帧 —— 实测一个静止的 CCM 界面帧缓存能到
 * 83 秒。按 30 秒判定会把好好的屏误判成失效，然后错误地落回主屏
 * （2026-09-26 实测踩到：明明副屏能用，截图却回落到主屏报 "Display Id 0 not valid"）。
 *
 * 真正的失效信号是 **screencap 自己报 invalid**（那说明 SurfaceFlinger 里
 * 真没这个屏了），所以这里只用一个很大的阈值兜底极端情况，
 * 主判据交给 captureScreen 的 invalidDisplay 返回值。
 */
const VD_FRAME_STALE_MS = 10 * 60 * 1000
const VD_DEX_NAME = 'vd.dex'
const VD_PKG = 'ccm-vd'

/** 本地 dex 路径（构建产物）。 */
export function vdDexPath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'vd', 'build', VD_DEX_NAME)
}

/** 副屏进程在设备上的落点。/data/local/tmp 是 adb shell 可写的位置。 */
export const VD_REMOTE_DEX = '/data/local/tmp/vd.dex'

/** 通过 HTTP 调副屏进程。 */
export async function vdCall(method, params = {}, timeout = 30000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const r = await fetch(`http://127.0.0.1:${VD_HTTP_PORT}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }),
      signal: ctrl.signal,
    })
    return await r.json()
  } catch (e) {
    return { ok: false, error: `副屏进程无响应：${e.message}`, unreachable: true }
  } finally { clearTimeout(timer) }
}

/** 副屏进程是否在跑。 */
/**
 * 副屏进程是否**真的可用**。
 *
 * ⚠️ 不能只看 `/ping` 通不通。进程活着 ≠ 它建的 display 还在：
 * 系统会在内存压力 / 进程切后台时回收虚拟屏，而 vd 进程自己**察觉不到** ——
 * 它照样自报 display_id，于是：
 *   · screencap 报 "Display Id '24' is not valid"
 *   · am start --display 24 静默失败
 *   · 帧缓存 frame_age_ms 停在几百秒不动
 * （2026-09-26 实测：vd 报 display 24 正常，系统里查无此屏。）
 *
 * 所以这里额外验两件事：帧缓存是否还在更新、系统是否认这个 display。
 * 帧缓存是更可靠的信号 —— 查系统要跑 dumpsys，慢且不稳。
 */
export async function vdAlive(timeout = 3000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const r = await fetch(`http://127.0.0.1:${VD_HTTP_PORT}/ping`, { signal: ctrl.signal })
    const j = await r.json()
    if (!(j && j.ok)) return { alive: false }
    // 帧缓存超过阈值没更新 = 屏已被系统回收（正常滚动时每帧几十毫秒）
    const age = Number(j.frame_age_ms)
    const stale = Number.isFinite(age) && age > VD_FRAME_STALE_MS
    return {
      alive: true,
      port: VD_HTTP_PORT,
      displayId: j?.display_id ?? -1,
      frameAgeMs: Number.isFinite(age) ? age : null,
      // usable = 进程活 + 帧还在动。调用方要判断「能不能往上操作」用这个
      usable: !stale,
      stale,
      warn: stale ? `副屏帧缓存已 ${Math.round(age / 1000)} 秒未更新，屏可能已被系统回收（重启副屏：/device vd stop && /device vd start）` : null,
    }
  } catch {
    return { alive: false }
  } finally { clearTimeout(timer) }
}

/**
 * 取虚拟屏在 **SurfaceFlinger** 里的 display token。
 *
 * 【为什么不能直接用 displayId 截屏】`screencap -d` 要的是 SurfaceFlinger 的
 * display token，而 DisplayManager 报的 displayId 是另一套编号：
 *   DisplayManager  → displayId = 26
 *   SurfaceFlinger  → Display 11529215049690880960 (Virtual display)
 * 拿 26 去截屏得到 "Display Id '26' is not valid"，拿后者才出图。
 * （2026-09-26 用户报「截的是我主屏」→ 顺藤摸瓜查出来的。）
 *
 * 直接查 SurfaceFlinger（它在 shell 权限下可读），不去反射 Display.getAddress()——
 * 那条路实测返回 -1（隐藏 API 受限）。
 */
export async function vdDisplayToken() {
  const cfg = loadDeviceConfig()
  const target = adbTarget(cfg)
  if (!target) return -1
  const r = await adbExec(target, ['shell', 'dumpsys SurfaceFlinger --display-id'], 20000)
  if (!r.ok) return -1
  // 形如：Display 11529215049773094898 (Virtual display): displayName="TermuxVirtualDisplay"
  const m = r.out.match(/Display\s+(\d+)\s+\(Virtual display\)/)
  // ⚠️ 必须返回**字符串**。这个 token 有 20 位（11529215049690880960），
  // 超过 JS 的 Number.MAX_SAFE_INTEGER(9007199254740991)，转 Number 会精度丢失
  // （实测 11529215049773094898 → ...095000），拿它去截屏当然无效。
  // shell 命令里当字符串拼就行，没必要当数字。
  return m ? m[1] : null
}

/** 跑一条 adb 命令（内部用）。 */
function adbExec(target, args, timeout = 60000) {
  return new Promise(resolve => {
    const p = spawn('adb', ['-s', target, ...args], { timeout })
    let out = '', err = ''
    p.stdout.on('data', d => out += d)
    p.stderr.on('data', d => err += d)
    p.on('close', code => resolve({ ok: code === 0, out, err, code }))
    p.on('error', e => resolve({ ok: false, out, err: e.message, code: -1 }))
  })
}

/**
 * 启动副屏进程。
 *
 * 步骤：把编译产物推到设备 → chmod 400 → adb shell 起 app_process → 等端口就绪
 *
 * 【为什么 chmod 400】Android 14 起 app_process 拒绝加载可写的 dex
 *（防止运行时被替换）。不加这步进程起不来或行为异常。
 */
export async function vdStart({ timeout = 40000 } = {}) {
  const cfg = loadDeviceConfig()
  if (cfg.shell === 'shizuku') {
    return { ok: false, error: '当前通道是 shizuku-only。副屏进程需要 adb（用 /device shell auto 或 adb）' }
  }
  const target = adbTarget(cfg)
  if (!target) return { ok: false, error: '未配置 adb（跑 ~/.claude-code-mobile/adb-setup.sh）' }

  const alive = await vdAlive(1500)
  // already 分支也要带 port —— 原来漏了，导致 /device vd start 在「已在运行」时
  // 打印「端口 undefined」（用户看到的是一条正常的成功信息里夹个 undefined）。
  if (alive.alive) return { ok: true, already: true, displayId: alive.displayId, port: VD_HTTP_PORT, frameAgeMs: alive.frameAgeMs }

  const dex = vdDexPath()
  if (!existsSync(dex)) {
    return { ok: false, error: `副屏 dex 不存在：${dex}\n先编译：bash tools/vd/build.sh` }
  }

  const push = await adbExec(target, ['push', dex, VD_REMOTE_DEX])
  if (!push.ok) return { ok: false, error: `推送 dex 失败：${push.err || push.out}` }

  await adbExec(target, ['shell', `chmod 400 ${VD_REMOTE_DEX}`])
  // 清掉可能残留的旧进程（同名进程会占着端口）
  await adbExec(target, ['shell', `pkill -f ${VD_PKG} >/dev/null 2>&1; true`])

  // 后台起。要 nohup，否则 adb shell 一退子进程就被带走。
  //
  // 【stdout 写文件而不是 /dev/null —— 2026-09-26】
  // VdMain.log() 走 System.out.println，原来被丢进 /dev/null，
  // 排查「副屏读不到元素」时完全没有线索（logcat 也抓不到 app_process 的输出）。
  // 写到 /data/local/tmp/ccm-vd.log（shell 可写、Termux 侧也能 cat 到）。
  // 每次启动清空，避免无限增长。
  const VD_LOG = '/data/local/tmp/ccm-vd.log'
  await adbExec(target, ['shell', `: > ${VD_LOG}; chmod 666 ${VD_LOG}`])
  await adbExec(target, ['shell',
    `nohup sh -c 'CLASSPATH=${VD_REMOTE_DEX} /system/bin/app_process /system/bin ` +
    `--nice-name=${VD_PKG} vd.VdMain' >> ${VD_LOG} 2>&1 &`])

  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 700))
    const a = await vdAlive(1500)
    if (a.alive) return { ok: true, displayId: a.displayId, port: VD_HTTP_PORT }
  }
  return {
    ok: false,
    error: '副屏进程启动超时（40s）。可能原因：dex 不可执行、或建屏阶段被系统拒绝。'
      + '可用 /device test 看通道是否通。',
  }
}

/** 停掉副屏进程（副屏随之销毁）。 */
export async function vdStop() {
  const cfg = loadDeviceConfig()
  const target = adbTarget(cfg)
  if (!target) return { ok: false, error: '未配置 adb' }
  const r = await adbExec(target, ['shell', `pkill -f ${VD_PKG} >/dev/null 2>&1; echo done`])
  return { ok: r.ok, out: (r.out || '').trim() }
}

/** 副屏状态（进程在不在 + displayId + 帧缓存情况）。 */
export async function vdStatus() {
  const alive = await vdAlive()
  if (!alive.alive) return { running: false }
  const st = await vdCall('status', {}, 10000)
  return { running: true, ...st }
}
