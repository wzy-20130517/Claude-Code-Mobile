// Claude Code Mobile - PTY 伪终端 + 进程树清理
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { getShellPath } from './shell-path.mjs'

const activeChildren = new Set()

export function trackChild(proc) {
  activeChildren.add(proc)
  proc.on('exit', () => { activeChildren.delete(proc) })
}

export function killAllChildren() {
  for (const proc of activeChildren) {
    try { proc.kill('SIGKILL') } catch {}
  }
  activeChildren.clear()
}

// 只注册一次 exit 清理，不要单独处理 SIGINT/SIGTERM
// 信号处理由 index.mjs 和 session-auto.mjs 统一协调
process.on('exit', killAllChildren)

export class PTYBox {
  constructor(command, args = [], options = {}) {
    this.command = command
    this.args = args
    this.cwd = options.cwd || process.cwd()
    this.env = options.env || {}
    this.timeout = options.timeout || 30000
    this.process = null
    this.output = ''
  }

  // signal: 外部取消（Agent 层超时或用户 Ctrl+C）—— abort 时立即 kill 子进程，
  // 避免只 reject 而子进程变孤儿继续在后台跑。
  async run({ signal, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        resolve({ stdout: '', stderr: '', exitCode: -1, timedOut: false, cancelled: true })
        return
      }
      const proc = spawn(this.command, this.args, {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: getShellPath(),
      })
      this.process = proc
      trackChild(proc)

      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch {}
        resolve({ stdout, stderr, exitCode: -1, timedOut: true })
      }, this.timeout)

      // 外部取消：真杀进程并带回已有输出，不丢失半截结果
      let abortListener = null
      if (signal) {
        abortListener = () => {
          clearTimeout(timer)
          try { proc.kill('SIGKILL') } catch {}
          resolve({ stdout, stderr, exitCode: -1, timedOut: false, cancelled: true })
        }
        signal.addEventListener('abort', abortListener, { once: true })
      }
      const cleanup = () => {
        clearTimeout(timer)
        if (signal && abortListener) {
          try { signal.removeEventListener('abort', abortListener) } catch {}
        }
      }

      // 边收边回报：长命令（npm install、构建、测试）不该让用户干等，
      // onProgress 由 agent 注入，UI 侧只显示最后一行（对齐 Kimi 的 liveOutputTail）。
      proc.stdout.on('data', (data) => {
        const s = data.toString()
        stdout += s
        if (onProgress) { try { onProgress(s) } catch {} }
      })
      proc.stderr.on('data', (data) => {
        const s = data.toString()
        stderr += s
        // stderr 也报：很多工具（ffmpeg/npm）的进度就走 stderr
        if (onProgress) { try { onProgress(s) } catch {} }
      })
      proc.on('close', (code) => {
        cleanup()
        resolve({ stdout, stderr, exitCode: code, timedOut: false })
      })
      proc.on('error', (e) => { cleanup(); reject(e) })
    })
  }

  kill() {
    if (this.process) {
      try { this.process.kill('SIGKILL') } catch {}
      this.process = null
    }
  }
}

// 基于 PTY 的 Bash 工具
import { Tool } from './tools.mjs'
import { maybeBackupRm } from './trash.mjs'

export class PTYBashTool extends Tool {
  constructor() {
    super({
      name: 'Bash',
      description: '执行 shell 命令（基于 PTY，支持交互式命令）。设 run_in_background=true 可后台跑，再用 BashOutput/KillShell 管理。',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout: { type: 'number', description: '同步超时 ms（默认 30000）；后台模式 0=不超时' },
          run_in_background: { type: 'boolean', description: '后台执行，立即返回 task_id' },
        },
        required: ['command'],
      },
    })
  }

  // 供 Agent 层超时/中断时主动调用，双保险干掉子进程
  cancel() {
    try { this._activePty?.kill() } catch {}
    this._activePty = null
  }

  async execute(input, ctx = {}) {
    // 后台模式
    if (input.run_in_background) {
      const { runBashMaybeBackground } = await import('./bg-bash.mjs')
      return runBashMaybeBackground(input, ctx)
    }

    // 拦截 rm 命令，备份要删的文件到回收站
    //
    // cwd 保护：engine 传的工作区路径可能还没创建（首次运行 / 用户删了目录），
    // 直接 spawn 会 ENOENT。退回到进程当前目录（在 CCM 里是内核目录，一定存在）。
    let cwd = ctx?.cwd || process.cwd()
    try {
      if (!existsSync(cwd)) {
        // 尝试创建（工作区本该存在，缺了多半是首次）
        mkdirSync(cwd, { recursive: true })
      }
    } catch {
      cwd = process.cwd()
    }
    const { command, backed } = maybeBackupRm(input.command, cwd)
    // 回收站备份信息不能直写 stderr：全屏模式下输入框画在固定位置，
    // 绕过渲染层的输出会怼到输入框那一行（用户反馈「[回收站] 跑输入框那里」）。
    // 并进工具返回值，作为正常工具结果走渲染层。
    const trashNote = backed.length
      ? backed.map(b => `  [回收站] ${b}`).join('\n') + '\n'
      : ''
    // 内层超时与 Agent 层分级超时保持一致：用户显式 timeout 优先，
    // 未给时给个较宽的默认（旧值 30s 对 npm install / 全量测试太短）。
    this._activePty = new PTYBox(command, [], {
      timeout: input.timeout || 600000,
      cwd,
    })
    const result = await this._activePty.run({ signal: ctx?.signal, onProgress: ctx?.onProgress })
    this._activePty = null

    // 用 String 包装对象带出真实成败：模型侧仍拿到纯文本（toString），
    // 渲染层可读 __ok/__exitCode。不这么做的话下游只能按输出文本猜，
    // 于是 grep 到一行 `throw new Error(...)` 就被误判成命令失败（踩过）。
    const withStatus = (text, ok, extra = {}) => {
      const s = new String(trashNote + text)
      s.__ok = ok
      s.__exitCode = result.exitCode
      Object.assign(s, extra)
      return s
    }

    if (result.cancelled) {
      return withStatus(`(已取消，子进程已终止) ${result.stdout}${result.stderr ? `\nstderr:\n${result.stderr}` : ''}`, false, { __cancelled: true })
    }
    if (result.timedOut) {
      return withStatus(`(超时) ${result.stdout}\n${result.stderr}`, false, { __timedOut: true })
    }
    const output = result.stdout + (result.stderr ? `\nstderr:\n${result.stderr}` : '')
    return withStatus(output || '(no output)', result.exitCode === 0)
  }
}
