// Claude Code Mobile - Context7 可选接入
// 只负责 mcp.json 配置，不自动安装、不自动启动、不把 API key 写入配置文件。
import { existsSync, readFileSync } from 'node:fs'
import { atomicWrite } from './atomic.mjs'
import { MCP_PATH } from './paths.mjs'

const DEFAULT_SERVER = {
  command: 'npx',
  args: ['-y', '@upstash/context7-mcp@latest'],
  env: {},
  disabled: true,
}

function readMcp(path) {
  try {
    if (!existsSync(path)) return { mcpServers: {} }
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('mcp.json 顶层必须是对象')
    if (!data.mcpServers || typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers)) data.mcpServers = {}
    return data
  } catch (e) {
    throw new Error(`读取 mcp.json 失败: ${e.message}`)
  }
}

function saveMcp(path, data) {
  atomicWrite(path, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

export function context7Status(path = MCP_PATH) {
  try {
    const data = readMcp(path)
    const server = data.mcpServers.context7
    if (!server) return { configured: false, enabled: false, path }
    return {
      configured: true,
      enabled: server.disabled !== true,
      disabled: server.disabled === true,
      command: server.command || '(未配置)',
      args: Array.isArray(server.args) ? server.args : [],
      hasInlineApiKey: JSON.stringify(server).includes('CONTEXT7_API_KEY') && JSON.stringify(server).includes('sk-'),
      path,
    }
  } catch (e) {
    return { configured: false, enabled: false, path, error: e.message }
  }
}

export function setupContext7(path = MCP_PATH) {
  const data = readMcp(path)
  const old = data.mcpServers.context7
  data.mcpServers.context7 = {
    ...DEFAULT_SERVER,
    ...(old && typeof old === 'object' ? old : {}),
    // setup 只补缺省值，不覆盖已有 command/args/env/disabled 自定义项。
    disabled: old?.disabled === false ? false : true,
  }
  saveMcp(path, data)
  return {
    ok: true,
    created: !old,
    enabled: data.mcpServers.context7.disabled !== true,
    path,
  }
}

export function setContext7Enabled(enabled, path = MCP_PATH) {
  const data = readMcp(path)
  if (!data.mcpServers.context7) {
    data.mcpServers.context7 = { ...DEFAULT_SERVER, disabled: !enabled }
  } else {
    data.mcpServers.context7 = { ...data.mcpServers.context7, disabled: !enabled }
  }
  saveMcp(path, data)
  return { ok: true, enabled: !!enabled, path }
}

export function context7Help() {
  return `Context7（可选 MCP）:
  /context7 setup    写入默认配置（默认禁用，不启动）
  /context7 enable   启用，重启后加载
  /context7 disable  禁用，重启后卸载
  /context7 status   查看配置状态

说明:
  · 首次启用可能由 npx 下载 @upstash/context7-mcp@latest
  · 需要更高限额时，可在 shell 设置 CONTEXT7_API_KEY，再重启
  · API key 不会写入 mcp.json；当前 mcp.json 中已有其他服务器不会被覆盖`
}

export { DEFAULT_SERVER as CONTEXT7_DEFAULT_SERVER }
