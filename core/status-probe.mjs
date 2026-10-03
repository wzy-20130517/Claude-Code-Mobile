// Claude Code Mobile - 命令/服务状态探测（参考 OpenHands 登录探测）
// 把外部命令探测结果归类为三态：available / unavailable / unknown
// 探测方式：--json 输出 + 双流（stdout+stderr）+ 退出码兜底
import { execFileSync } from 'node:child_process'

// 探测单个命令/服务
// opts:
//   bin      可执行文件路径或命令名
//   args     参数数组（如 ['--json', 'status']）
//   parse    (stdout, stderr, exitCode) => 'available' | 'unavailable' | 'unknown'（可选，默认按退出码）
//   timeout  ms 默认 5000
// 返回 { status: 'available'|'unavailable'|'unknown', stdout, stderr, exitCode }
export function probeCommand(bin, args = [], opts = {}) {
  const { parse = null, timeout = 5000, cwd = null } = opts
  let stdout = ''
  let stderr = ''
  let exitCode = null
  try {
    const r = execFileSync(bin, args, {
      encoding: 'utf-8',
      timeout,
      cwd: cwd || undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    stdout = String(r || '')
    exitCode = 0
  } catch (e) {
    // execFileSync 抛错时：stdout/stderr 在 e.stdout/e.stderr
    stdout = String(e?.stdout || '')
    stderr = String(e?.stderr || '')
    exitCode = typeof e?.status === 'number' ? e.status : (e?.code === 'ENOENT' ? -1 : null)
  }

  let status
  if (parse) {
    try { status = parse(stdout, stderr, exitCode) } catch { status = 'unknown' }
  } else {
    // 默认：退出码 0 = available；ENOENT = unavailable；其他 = unknown
    if (exitCode === 0) status = 'available'
    else if (exitCode === -1) status = 'unavailable'
    else status = 'unknown'
  }
  return { status, stdout, stderr, exitCode }
}

// 便捷：探测 HTTP 服务端口是否活着（用 bash -c 'echo > /dev/tcp/host/port' 或 nc）
// 返回 { status, exitCode }
export function probePort(host, port, timeout = 3000) {
  try {
    const r = execFileSync('/system/bin/sh', ['-c', `echo > /dev/tcp/${host}/${port}`], {
      encoding: 'utf-8', timeout, stdio: ['ignore', 'pipe', 'ignore'],
    })
    return { status: 'available', exitCode: 0 }
  } catch (e) {
    return { status: 'unavailable', exitCode: typeof e?.status === 'number' ? e.status : -1 }
  }
}

// 三态归类为可读文本
export function statusText(status) {
  return status === 'available' ? '✅ 正常' : status === 'unavailable' ? '❌ 不可用' : '❓ 未知'
}
