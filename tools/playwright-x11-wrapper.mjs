#!/usr/bin/env node

/**
 * Playwright MCP launcher for Termux:X11.
 *
 * The MCP process starts immediately so it can complete its JSON-RPC
 * handshake, but Termux:X11 is started lazily on the first tools/call.
 * Never write diagnostics to stdout: MCP uses stdout for JSON-RPC.
 */

import { appendFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'

const DISPLAY = process.env.TBP_X11_DISPLAY || process.env.DISPLAY || ':0'
const XDOTOOL_PATH = process.env.TBP_XDOTOOL_PATH || 'xdotool'
const LOG_PATH = process.env.TBP_X11_LOG || `${process.env.HOME || '/data/data/com.termux/files/home'}/.claude-code-mobile/playwright-x11.log`
const X11_PACKAGE = 'com.termux.x11'
const X11_ACTIVITY = `${X11_PACKAGE}/.MainActivity`
const X11_START_TIMEOUT_MS = 12000
const AUTO_START_X11 = process.env.TBP_X11_AUTOSTART !== '0'

function log(message) {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 })
  } catch {}
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
}

function xServerReady() {
  const result = run(XDOTOOL_PATH, ['getdisplaygeometry'], {
    env: { ...process.env, DISPLAY },
    timeout: 1500,
  })
  return result.status === 0
}

function startX11Activity() {
  const result = run('am', ['start', '--user', '0', '-n', X11_ACTIVITY])
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().replace(/\s+/g, ' ')
    log(`无法启动 Termux:X11 Activity: ${detail || `exit ${result.status}`}`)
    return false
  }
  log('已启动 Termux:X11 Activity')
  return true
}

function startXServer() {
  const child = spawn('termux-x11', [DISPLAY, '-ac'], {
    detached: true,
    env: { ...process.env, DISPLAY },
    stdio: 'ignore',
  })
  child.unref()
  log(`已启动 Termux:X11 server ${DISPLAY} (pid ${child.pid ?? 'unknown'})`)
}

async function ensureX11() {
  // 【/x11 off 的语义：只是「不主动把 APP 拉到前台」，不是「不要 X11」】
  //
  // 原实现在 off 时连 X server 都不起，于是用户手动打开 Termux:X11 APP
  // 也是一片空白 —— 浏览器压根没有可画的显示服务。
  // 用户要的是：off 时后台照常有 X server 在跑（浏览器有地方渲染），
  // 想看的时候自己打开 APP 就能盯着；只是 CLI 不会替他把 APP 抢到前台。
  //
  // 所以 AUTO_START_X11 现在只控制 startX11Activity()（拉起 APP），
  // startXServer()（后台显示服务）无论开关都要保证在跑。
  if (xServerReady()) {
    log(`X server ${DISPLAY} 已就绪（xdotool: ${XDOTOOL_PATH}），不重复启动`)
    return
  }

  if (AUTO_START_X11) {
    startX11Activity()
    // Activity 启动和 X server 建立可能有短暂延迟，再检查一次。
    if (xServerReady()) {
      log(`X server ${DISPLAY} 已就绪（xdotool: ${XDOTOOL_PATH}）`)
      return
    }
  } else {
    log('X11 自动拉起 APP 已关闭（/x11 off）：只在后台起 X server，不抢前台')
  }

  startXServer()
  const deadline = Date.now() + X11_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (xServerReady()) {
      log(`X server ${DISPLAY} 已就绪（xdotool: ${XDOTOOL_PATH}）`)
      return
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }

  throw new Error(`Termux:X11 ${DISPLAY} 未就绪，请确认 Termux:X11 App 已安装并可启动`)
}

const [playwrightCli, ...playwrightArgs] = process.argv.slice(2)
if (!playwrightCli) {
  process.stderr.write('Playwright X11 wrapper: missing Playwright MCP CLI path\n')
  process.exit(2)
}

// 只启动 MCP 本身；这里不调用 ensureX11。
const child = spawn(process.execPath, [playwrightCli, ...playwrightArgs], {
  env: { ...process.env, DISPLAY },
  stdio: ['pipe', 'pipe', 'inherit'],
})

child.stdout.pipe(process.stdout)

let x11Promise = null
function ensureX11OnDemand() {
  // ⚠ 这里**不能**按 AUTO_START_X11 提前 return —— 那样 /x11 off 时
  // 连后台 X server 都不起，用户手动打开 Termux:X11 APP 只能看到空白。
  // 开关的语义已改为「是否主动拉起 APP」，由 ensureX11() 内部区分；
  // X server 本身两种情况都要跑（浏览器需要有地方渲染）。
  if (!x11Promise) {
    x11Promise = ensureX11().catch(error => {
      x11Promise = null
      // off 模式下起不来不该让工具调用失败：用户可能压根没装 X11 APP，
      // 那就退回 headless（Playwright 自己能处理无 DISPLAY 的情况）。
      if (!AUTO_START_X11) {
        log(`X server 未就绪（${error.message}），/x11 off 下继续以无显示模式运行`)
        return
      }
      throw error
    })
  }
  return x11Promise
}

function sendError(id, message) {
  if (id === undefined) return
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message },
  }) + '\n')
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
try {
  for await (const line of input) {
    if (!line.trim()) {
      if (!child.stdin.destroyed) child.stdin.write('\n')
      continue
    }

    let request = null
    try { request = JSON.parse(line) } catch {}

    // 初始化/工具列表等握手请求直接转发；第一次真正调用工具时才启动 X11。
    if (request?.method === 'tools/call') {
      try {
        await ensureX11OnDemand()
      } catch (error) {
        log(error.message)
        sendError(request.id, error.message)
        continue
      }
    }

    if (!child.stdin.destroyed) child.stdin.write(line + '\n')
  }
} finally {
  input.close()
  try { child.stdin.end() } catch {}
}

child.on('error', error => {
  log(`Playwright MCP 启动失败: ${error.message}`)
  process.exitCode = 1
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
