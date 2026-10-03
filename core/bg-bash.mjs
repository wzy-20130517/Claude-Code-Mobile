// 后台 Bash：run_in_background + BashOutput + KillShell（对标原版 Claude Code）
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { Tool } from './tools.mjs'
import { maybeBackupRm } from './trash.mjs'
import { trackChild } from './pty.mjs'
import {
  registerBackgroundTask,
  getBackgroundTask,
  listBackgroundTasks,
  killBackgroundTask,
} from './bg-tasks.mjs'

const MAX_OUTPUT_CHARS = 200_000
// shell 路径自适应（Termux / proot Ubuntu 都能用）
// 逻辑见 core/shell-path.mjs，这里包一层保持调用点不变
import { getShellPath } from './shell-path.mjs'
function shellPath() {
  return getShellPath()
}

function startBackgroundBash(command, { timeout = 0, cwd = process.cwd() } = {}) {
  const task = registerBackgroundTask('local_bash', command.slice(0, 80))
  task.start()

  const { command: cmd } = maybeBackupRm(command, cwd)
  const proc = spawn(cmd, [], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: shellPath(),
  })
  task.proc = proc
  trackChild(proc)

  const append = (chunk) => {
    task.appendOutput(chunk.toString())
    // 只裁剪内存副本，不再递归 appendOutput（原写法会无限增长/重复写盘）
    if (task.output.length > MAX_OUTPUT_CHARS) {
      task.output = '…[earlier output truncated]…\n' + task.output.slice(-MAX_OUTPUT_CHARS)
      if (task.outputOffset > task.output.length) task.outputOffset = 0
    }
  }
  proc.stdout.on('data', append)
  proc.stderr.on('data', append)

  let timer = null
  if (timeout && timeout > 0) {
    timer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch {}
      if (!task.isTerminal()) {
        task.appendOutput(`\n(超时 ${timeout}ms，已 kill)\n`)
        task.fail(`timeout ${timeout}ms`)
      }
    }, timeout)
    if (typeof timer.unref === 'function') timer.unref()
  }

  proc.on('close', (code) => {
    if (timer) clearTimeout(timer)
    if (task.isTerminal()) return
    task.exitCode = code
    task.complete({ exitCode: code, output_len: task.output.length })
  })
  proc.on('error', (e) => {
    if (timer) clearTimeout(timer)
    if (!task.isTerminal()) task.fail(e.message)
  })

  return task
}

/** 给 PTYBashTool 注入：支持 run_in_background
 *  （2026-09-26：原 confirm_dangerous 机制已删，后台模式同样不再做高危判定。）*/
export function runBashMaybeBackground(input, ctx = {}) {
  if (input.run_in_background) {
    const task = startBackgroundBash(input.command, { timeout: input.timeout || 0, cwd: ctx.cwd || process.cwd() })
    return [
      `后台 Bash 已启动`,
      `  task_id: ${task.taskId}`,
      `  command: ${input.command.slice(0, 120)}`,
      `用 BashOutput(task_id="${task.taskId}") 读输出；KillShell 终止。`,
    ].join('\n')
  }
  return null // 调用方走同步路径
}

export class BashOutputTool extends Tool {
  constructor() {
    super({
      name: 'BashOutput',
      description: '读取后台 Bash 任务的输出（增量）。配合 Bash(run_in_background:true) 使用。',
      input_schema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '后台任务 id' },
          timeout: { type: 'number', description: '可选：最多等待多少 ms 再返回（等有新输出或结束）' },
        },
        required: ['task_id'],
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    })
  }
  async execute(input) {
    const task = getBackgroundTask(input.task_id)
    if (!task) {
      const list = listBackgroundTasks().filter(t => t.type === 'local_bash')
      return `未找到任务 ${input.task_id}。当前 bash 后台: ${list.length ? list.map(t => t.id).join(', ') : '(无)'}`
    }
    const waitMs = Math.min(Number(input.timeout) || 0, 30000)
    if (waitMs > 0 && !task.isTerminal() && task.outputOffset >= task.output.length) {
      await new Promise(resolve => {
        const t = setTimeout(resolve, waitMs)
        const iv = setInterval(() => {
          if (task.isTerminal() || task.output.length > task.outputOffset) {
            clearInterval(iv); clearTimeout(t); resolve()
          }
        }, 100)
      })
    }
    const delta = task.getOutputDelta()
    const status = {
      task_id: task.taskId,
      status: task.status,
      exitCode: task.exitCode ?? task.result?.exitCode ?? null,
      duration_ms: task.startTime ? (task.endTime || Date.now()) - task.startTime : 0,
      total_output_len: task.output.length,
    }
    return JSON.stringify({ ...status, output: delta || '(no new output)' }, null, 2)
  }
}

export class KillShellTool extends Tool {
  constructor() {
    super({
      name: 'KillShell',
      description: '终止后台 Bash 任务。',
      input_schema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
        },
        required: ['task_id'],
      },
      isDestructive: () => true,
    })
  }
  async execute(input) {
    const ok = killBackgroundTask(input.task_id)
    if (!ok) return `未找到或无法终止任务: ${input.task_id}`
    return `已终止任务 ${input.task_id}`
  }
}
