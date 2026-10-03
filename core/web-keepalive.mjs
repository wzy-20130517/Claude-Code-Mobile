// Claude Code Mobile - Web 后端保活
// Android 会冻结/杀掉长时间无前台活动的后台进程，导致 Web 服务在锁屏后断流。
// 三层保活：
//   1. termux-wake-lock —— 阻止 CPU 深睡
//   2. 静音音频循环 —— 让系统把 Termux 当"正在播放音乐的应用"（最有效的一层）
//   3. 常驻通知 —— poor man's foreground service，同时给用户一个可见入口
//
// 静音音频复用项目已有的 core/audio-keepalive.sh（CLI 的 /keepalive 也用它）：
// 两边共享同一个 pgrep 判断，幂等且不会互相 stop。
// 任何一层失败都不影响服务启动（全部 fail-open）。
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const AUDIO_SCRIPT = join(HERE, 'audio-keepalive.sh')
const NOTIF_ID = 'claude-code-mobile-web'

let started = false
let audioStarted = false

function run(cmd, args, timeout = 15000) {
  return new Promise(resolve => {
    try {
      execFile(cmd, args, { timeout }, (err, stdout) => resolve(err ? null : String(stdout || '')))
    } catch { resolve(null) }
  })
}

/**
 * 启动保活。
 * @param {object} opts
 * @param {boolean} opts.audio 是否开启静音音频（耗电，默认开；可用 WEB_KEEPALIVE_AUDIO=0 关闭）
 */
export async function startKeepalive({ port, host, audio = true } = {}) {
  if (started) return { audioStarted }
  started = true

  // 【CCM 模式：跳过全部保活】
  //
  // 这套三层保活（wake-lock + 静音音频 + 通知）是为了解决
  // 「Termux 里跑 Node，被 Android 冻结/杀掉」的问题。
  //
  // 但 CCM（Android 原生外壳）模式下：
  //   - Kotlin 侧有真·前台服务（CcmService）—— 系统级保活，不需要 hack
  //   - termux-* 命令在 proot Ubuntu 里根本不存在，调用会失败
  //   - 静音音频那层尤其耗电，白白浪费
  //
  // 检测方式：CCM 启动 Node 时会设 CCM_MODE=native
  if (process.env.CCM_MODE === 'native') {
    console.log('[keepalive] CCM 模式：跳过（Kotlin 前台服务已保活）')
    return { audioStarted: false, skipped: true }
  }

  // 1. wake lock
  run('termux-wake-lock', [])

  // 2. 静音音频（复用 CLI 那套脚本，start 本身幂等）
  if (audio && process.env.WEB_KEEPALIVE_AUDIO !== '0' && existsSync(AUDIO_SCRIPT)) {
    const out = await run('bash', [AUDIO_SCRIPT, 'start'], 30000)
    audioStarted = !!out && /已启动|已在运行/.test(out)
  }

  // 3. 常驻通知
  const url = `http://${host || '127.0.0.1'}:${port || 3456}`
  run('termux-notification', [
    '--id', NOTIF_ID,
    '--title', 'Claude Code Mobile Web',
    '--content', `运行中 · ${url}`,
    '--ongoing',
    '--priority', 'low',
  ])

  return { audioStarted }
}

/**
 * 停止保活并清理（退出前调用，必须同步以便在 process.exit 前跑完）。
 * 注意：不停音频——CLI 可能也开着 /keepalive，Web 退出不该把它关掉。
 * 音频由用户用 /keepalive off 显式关闭。
 */
export function stopKeepalive() {
  if (!started) return
  started = false
  try { execFileSync('termux-notification-remove', [NOTIF_ID], { stdio: 'ignore', timeout: 3000 }) } catch { }
  try { execFileSync('termux-wake-unlock', [], { stdio: 'ignore', timeout: 3000 }) } catch { }
}

/** 查询状态（含音频脚本的真实运行情况）。 */
export function keepaliveStatus() {
  let audio = 'unknown'
  try {
    if (existsSync(AUDIO_SCRIPT)) {
      const out = execFileSync('bash', [AUDIO_SCRIPT, 'status'], { encoding: 'utf8', timeout: 8000 })
      audio = /运行中/.test(out) ? 'running' : 'stopped'
    } else {
      audio = 'missing'
    }
  } catch { }
  return { started, audio }
}
