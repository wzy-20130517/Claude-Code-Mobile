// Claude Code Mobile - 内置插件系统【已废弃，2026-10-04】
//
// 【为什么废弃】
// 官方 Claude Code 的 /plugin 管的是"插件市场"里的插件；CCM 现在的插件体系
// 是 DSH 生态（Cordis 插件框架），通过 dsh-host 兼容层加载，走 /plugin 命令。
// 这套旧的 builtinPlugins 系统只注册过一个 keepalive 占位（无实际功能绑定），
// 而 /keepalive 是独立命令（index.mjs 的 case 'keepalive'），不依赖本模块。
//
// 【保留原因】
// 不激进删除——engine-setup.mjs 还在调 registerBuiltinPlugin（无副作用的空注册），
// cmd-extensions.mjs 还 import 了 listPlugins（但已不被调用）。
// 彻底清理要连这两处一起改，属于独立任务。
//
// 【现状】
// /plugins 命令已改指向新的 DSH 插件实现（index.mjs 的 case 'plugins'），
// 本模块的函数实际上不再被用户路径触达。

// Claude Code Mobile - 内置插件系统
// 支持注册功能模块，可启用/禁用，持久化到 config.json
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolveConfigPath, ensureParentDir } from '../infra/paths.mjs'

// 【2026-10-03】配置属用户数据，统一放 ~/.claude-code-mobile/
const CONFIG_PATH = resolveConfigPath('config.json')

const builtinPlugins = new Map()  // name → definition
let enabledState = {}             // 从 config.json 读取的启用状态

function loadEnabledState() {
  try {
    if (existsSync(CONFIG_PATH)) {
      const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
      enabledState = config.plugins || {}
    }
  } catch {}
}

function saveEnabledState() {
  try {
    let config = {}
    if (existsSync(CONFIG_PATH)) config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    config.plugins = enabledState
    ensureParentDir(CONFIG_PATH)   // 数据目录可能还不存在
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
  } catch {}
}

loadEnabledState()

// 注册内置插件
// definition: { name, description, skills?, hooks?, mcpServers?, defaultEnabled? }
export function registerBuiltinPlugin(definition) {
  builtinPlugins.set(definition.name, definition)
  // 没有配置记录则用默认值
  if (enabledState[definition.name] === undefined) {
    enabledState[definition.name] = definition.defaultEnabled !== false
  }
}

// 启用/禁用插件
export function enablePlugin(name) {
  if (!builtinPlugins.has(name)) return { ok: false, error: `插件不存在: ${name}` }
  enabledState[name] = true
  saveEnabledState()
  return { ok: true, message: `已启用: ${name}` }
}

export function disablePlugin(name) {
  if (!builtinPlugins.has(name)) return { ok: false, error: `插件不存在: ${name}` }
  enabledState[name] = false
  saveEnabledState()
  return { ok: true, message: `已禁用: ${name}` }
}

export function isPluginEnabled(name) {
  return enabledState[name] !== false
}

// 列出所有插件
export function listPlugins() {
  const list = []
  for (const [name, def] of builtinPlugins) {
    list.push({
      name,
      description: def.description,
      enabled: enabledState[name] !== false,
      skills: def.skills?.length || 0,
      hooks: Object.keys(def.hooks || {}).length,
    })
  }
  return list
}

// 获取所有启用插件的 skills
export function getEnabledPluginSkills() {
  const skills = []
  for (const [name, def] of builtinPlugins) {
    if (isPluginEnabled(name) && def.skills) {
      skills.push(...def.skills)
    }
  }
  return skills
}

// 获取所有启用插件的 hooks 配置
export function getEnabledPluginHooks() {
  const hooks = {}
  for (const [name, def] of builtinPlugins) {
    if (isPluginEnabled(name) && def.hooks) {
      Object.assign(hooks, def.hooks)
    }
  }
  return hooks
}

// 获取所有启用插件的 MCP 服务器配置
export function getEnabledPluginMcpServers() {
  const servers = {}
  for (const [name, def] of builtinPlugins) {
    if (isPluginEnabled(name) && def.mcpServers) {
      Object.assign(servers, def.mcpServers)
    }
  }
  return servers
}
