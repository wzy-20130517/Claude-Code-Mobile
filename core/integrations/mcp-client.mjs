// Claude Code Mobile - MCP 客户端（多服务器，统一监听器）
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { preview as tracePreview } from '../api/trace.mjs'
import { Tool } from '../tools/tools.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MCP_PATH } from '../infra/paths.mjs'

// MCP 握手时上报的客户端版本。原来硬编码 '0.4.1'，主版本升到 0.7 都没人改，
// 直接从 package.json 读，一处维护。读不到就给个兜底值，不能让握手挂掉。
const PKG_VERSION = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    return JSON.parse(readFileSync(pkgPath, 'utf-8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/**
 * 单个 MCP 请求的超时。
 *
 * 【为什么从 30s 改到 10s】MCP 是本机 stdio 子进程，正常毫秒级返回。
 * 原来 30s 的超时在「子进程压根起不来」时会被完整等满 ——
 * 实测 /tools 因此卡 27 秒（buildAgent → await mcpReady → 两次 _request 超时）。
 * 现在子进程 error/close 会立刻 reject（见 failPending），
 * 这个定时器只兜「起来了但不响应」的极端情况。
 */
const MCP_REQUEST_TIMEOUT_MS = 10_000

export class MCPClient {
  constructor() {
    this.servers = new Map()
  }

  async loadConfig(path = MCP_PATH) {
    try {
      if (!existsSync(path)) return
      const cfg = JSON.parse(readFileSync(path, 'utf-8'))
      for (const [name, srv] of Object.entries(cfg.mcpServers || {})) {
        if (srv?.disabled === true) continue
        // 逐个 try：一个失败不影响其他的（CCM 里路径可能不匹配）
        try {
          await this.addServer(name, srv)
        } catch (e) {
          console.warn(`[mcp] 加载 "${name}" 失败（跳过）: ${e.message}`)
        }
      }
    } catch (e) {
      console.warn(`[mcp] 读配置失败: ${e.message}`)
    }
  }

  async addServer(name, config) {
    // 【容错】spawn 失败不能拖垮整个 MCP 加载。
    //
    // 场景：CCM 模式（proot Ubuntu）里，mcp.json 可能还指向 Termux 的绝对路径
    // （/data/data/com.termux/...），那些路径在 proot 里不存在 → spawn ENOENT。
    // 原来这个异常会冒泡到 loadConfig 的 try/catch，导致**后面的服务器全部跳过**。
    // 现在改成：单个失败只记日志，继续加载其他。
    let proc
    try {
      proc = spawn(config.command, config.args || [], {
        env: { ...process.env, ...config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (e) {
      console.warn(`[mcp] 服务器 "${name}" 启动失败（跳过）: ${e.message}`)
      return null
    }

    // 命令不存在时 spawn 不抛异常，而是在 proc 上触发 error 事件
    proc.on('error', (e) => {
      console.warn(`[mcp] 服务器 "${name}" 进程错误: ${e.message}`)
    })

    const serverState = {
      proc,
      tools: [],
      config,
      buffer: '',
      requestId: 0,
      pending: new Map(),
    }

    // 统一监听器：所有请求共用一个 data 监听器
    proc.stdout.on('data', (chunk) => {
      serverState.buffer += chunk.toString()
      const lines = serverState.buffer.split('\n')
      serverState.buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id !== undefined && serverState.pending.has(msg.id)) {
            const { resolve, reject } = serverState.pending.get(msg.id)
            serverState.pending.delete(msg.id)
            if (msg.error) reject(new Error(msg.error.message || 'MCP error'))
            else resolve(msg.result)
          }
        } catch {}
      }
    })

    proc.stderr.on('data', () => {})

    // 【2026-09-24 修】原来这两行都是空吞：
    //   proc.on('error', () => {})
    //   proc.on('close', () => {})
    // 后果：command 不存在（如 CCM 里 mcp.json 写的 /usr/bin/node 在 proot 中
    // 路径不对）时 spawn 立刻 ENOENT、进程立刻 close，但**没有任何人 reject**，
    // 于是 _request 傻等 30 秒超时 —— 表现为「/tools 卡 27 秒」。
    // 实测：loadConfig 30216ms，而实际失败是**瞬间**发生的。
    const failPending = (reason) => {
      serverState.dead = reason
      for (const [id, { reject }] of serverState.pending) {
        try { reject(new Error(reason)) } catch {}
      }
      serverState.pending.clear()
    }
    proc.on('error', (e) => failPending(`MCP 进程启动失败: ${e?.message || e}`))
    proc.on('close', (code) => {
      if (!serverState.dead) failPending(`MCP 进程已退出（code ${code}）`)
    })

    this.servers.set(name, serverState)

    // 握手
    try {
      await this._request(serverState, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'claude-code-mobile', version: PKG_VERSION },
      })
      const result = await this._request(serverState, 'tools/list', {})
      serverState.tools = result.tools || []
    } catch {
      serverState.tools = []
    }
    return serverState.tools
  }

  _request(serverState, method, params = {}) {
    // 进程已经死了就别发请求 —— 立刻失败，不要等超时。
    // 配合上面的 failPending，把「命令不存在」的失败从 30 秒压到毫秒级。
    if (serverState.dead) return Promise.reject(new Error(serverState.dead))

    const id = ++serverState.requestId
    return new Promise((resolve, reject) => {
      serverState.pending.set(id, { resolve, reject })
      try {
        serverState.proc.stdin.write(JSON.stringify({
          jsonrpc: '2.0', id, method, params,
        }) + '\n')
      } catch (e) {
        serverState.pending.delete(id)
        return reject(new Error(`MCP 写入失败: ${e?.message || e}`))
      }
      setTimeout(() => {
        if (serverState.pending.has(id)) {
          serverState.pending.delete(id)
          reject(new Error(`MCP 请求超时（${MCP_REQUEST_TIMEOUT_MS}ms）: ${method}`))
        }
      }, MCP_REQUEST_TIMEOUT_MS).unref?.()
    })
  }

  getAllTools() {
    const all = []
    for (const [name, srv] of this.servers) {
      for (const tool of srv.tools) {
        all.push({
          name: `mcp_${name}_${tool.name}`,
          description: `[MCP:${name}] ${tool.description || ''}`,
          // 兜底必须是「合法的 object schema」而非 `{}`：Gemini 系后端要求
          // type:'object' 必带 properties，否则整个请求 400（见 api.mjs normalizeToolSchema）。
          // api 层还有一道统一规整，这里先保证 registry 里的定义本身是干净的。
          input_schema: tool.inputSchema || { type: 'object', properties: {} },
          mcpServer: name,
          mcpTool: tool.name,
        })
      }
    }
    return all
  }

  createToolAdapters() {
    return this.getAllTools().map((definition) => {
      const client = this
      const adapter = new Tool({
        name: definition.name,
        description: definition.description,
        input_schema: definition.input_schema,
        isReadOnly: () => true,
        isConcurrencySafe: () => false,
      })
      adapter.mcpServer = definition.mcpServer
      adapter.mcpTool = definition.mcpTool
      adapter.execute = async (input, ctx = {}) => {
        if (ctx.signal?.aborted) throw new Error('Interrupted')
        const result = await client.callTool(definition.mcpServer, definition.mcpTool, input, adapter._activeTrace || null)
        return JSON.stringify(result)
      }
      return adapter
    })
  }

  async callTool(serverName, toolName, args, trace = null) {
    const srv = this.servers.get(serverName)
    if (!srv) throw new Error(`Server ${serverName} not found`)
    const startedAt = Date.now()
    trace?.emit('mcp_call_start', { server: serverName, tool: toolName, arguments: args })
    try {
      const result = await this._request(srv, 'tools/call', { name: toolName, arguments: args })
      trace?.emit('mcp_call_result', { server: serverName, tool: toolName, duration_ms: Date.now() - startedAt, result: tracePreview(result, 500) })
      return result
    } catch (e) {
      trace?.emit('mcp_call_error', { server: serverName, tool: toolName, duration_ms: Date.now() - startedAt, error: e?.message || String(e) })
      throw e
    }
  }

  async stopAll() {
    for (const [, srv] of this.servers) {
      try { srv.proc.kill() } catch {}
    }
    this.servers.clear()
  }
}
