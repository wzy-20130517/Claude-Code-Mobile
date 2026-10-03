// Web 服务命令 /web（handleCommand 拆分第十一批）
//
// 【零 ctx 依赖】这个命令完全自包含：只用 node 内置模块 + 固定端口，
// 不碰 config / agent / 渲染状态。所以不需要工厂函数注入 ctx，
// 直接导出一个 async 函数即可 —— 拆分不是为了套统一形式，
// 依赖少的就该写得更简单。

import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export async function webCommand(args) {
        const sub = String(args[0] || 'status').toLowerCase()
        const webUrl = 'http://127.0.0.1:3456'
        const healthUrl = `${webUrl}/api/health`
        const queryHealth = async () => {
          try {
            const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2500) })
            if (!response.ok) return null
            const data = await response.json()
            return data?.ok ? data : null
          } catch { return null }
        }
        if (!['start', 'status', 'open', 'help'].includes(sub)) {
          return '用法：/web [start|status|open]\n  /web start   启动 Web 服务（已运行则不重复启动）\n  /web status  查看 Web 服务与保活状态\n  /web open    用系统浏览器打开 Web'
        }
        let health = await queryHealth()
        if (sub === 'start') {
          if (!health) {
            const script = join(process.cwd(), 'start-web.sh')
            if (!existsSync(script)) return `Web 启动脚本不存在：${script}`
            try {
              // start-web.sh 自带守护循环；detached + unref 让 CLI 退出后 Web 仍可存活。
              const child = spawn('bash', [script], { cwd: process.cwd(), detached: true, stdio: 'ignore' })
              child.unref()
              // 给 HTTP 服务最多 3 秒绑定端口；不阻塞太久，失败时可用 /web status 看详情。
              for (let i = 0; i < 6 && !health; i++) {
                await new Promise(resolve => setTimeout(resolve, 500))
                health = await queryHealth()
              }
            } catch (error) {
              return `Web 启动失败：${error?.message || String(error)}`
            }
          }
          if (!health) return `Web 启动进程已发起，但暂未就绪。稍后执行 /web status 查看。\n地址：${webUrl}`
          return `Web 已启动 ✓\n地址：${webUrl}\nPID：${health.pid || '—'}\n保活：${health.keepalive?.audio === 'running' ? 'wake-lock + 静音音频运行中 ✓' : '服务运行中（静音音频未确认）'}`
        }
        if (sub === 'open') {
          if (!health) return `Web 尚未运行。请先执行 /web start。`
          try { execFileSync('termux-open-url', [webUrl], { timeout: 5000, stdio: 'ignore' }) } catch { }
          return `已请求打开 Web：${webUrl}`
        }
        if (!health) return `Web 未运行 ✗\n执行 /web start 启动。\n地址：${webUrl}`
        return `Web 运行中 ✓\n地址：${webUrl}\nPID：${health.pid || '—'} · 运行 ${health.uptimeSec || 0}s\n内存：RSS ${health.rssMB ?? '—'}MB · Heap ${health.heapMB ?? '—'}MB\n会话：${health.runtimes ?? 0} 个内存 runtime，其中 ${health.runningSessions ?? 0} 个生成中；SSE ${health.sseClients ?? 0} 条\n保活：${health.keepalive?.started ? 'wake-lock/通知已启用' : '未启用'} · 静音音频 ${health.keepalive?.audio === 'running' ? '运行中 ✓' : (health.keepalive?.audio || '未知')}`
}
