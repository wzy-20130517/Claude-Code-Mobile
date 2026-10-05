// Web 配置桥 —— 独立成模块，供 command-adapter 使用
//
// 【为什么不直接在 command-adapter.mjs 里读写文件】
// 那两个函数（loadWebConfig / saveWebConfig）原本定义在 web/server.mjs 内部。
// 适配层需要它们，但 server.mjs 会 import 适配层 —— 直接引用就循环依赖。
// 抽到这里的第三个文件是最干净的解法。
//
// 【配置模型（既定设计，别改）】
//   · providers：Web 与 CLI **共用** config.json（唯一来源）
//   · current + 各种 Web 设置：存 web-config.json（与 CLI 的 current 隔离）
// 所以「在 Web 改 Provider」会同时影响 CLI —— 这是用户要的（一份 provider 池两边用），
// 但「在 Web 切当前 Provider」不会动 CLI 的 current。

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { atomicWrite } from '../core/infra/atomic.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')
const CLI_CONFIG_PATH = join(PROJECT_ROOT, 'config.json')

/** Web 专属配置（current + 设置），与 CLI 的 current 隔离。 */
export const WEB_CONFIG_PATH = process.env.CLAUDE_WEB_CONFIG
  || join(homedir(), '.claude-code-mobile', 'web-config.json')

/**
 * 读配置：providers 来自 CLI config.json，其余来自 web-config.json。
 * 缺 current 或 current 指向不存在的 provider 时回退到第一个。
 */
export function loadWebConfig() {
  let web
  try {
    web = JSON.parse(readFileSync(WEB_CONFIG_PATH, 'utf8'))
  } catch {
    web = {}
  }
  let cli
  try {
    cli = JSON.parse(readFileSync(CLI_CONFIG_PATH, 'utf8'))
  } catch (e) {
    throw new Error(`config.json 读取失败: ${e.message}`)
  }
  if (!cli?.providers || typeof cli.providers !== 'object') throw new Error('config.json 缺少 providers')
  const config = { ...cli, ...web }
  config.providers = cli.providers
  if (!config.current || !config.providers[config.current]) config.current = Object.keys(config.providers)[0]
  return config
}

/**
 * 写配置：providers 落 CLI config.json，其余落 web-config.json。
 *
 * ⚠ 这里会写 config.json 的 providers 字段 —— 与 CLI 共用是有意为之。
 * 但**绝不写 config.json 的 current**：那会改掉 CLI 当前用的 Provider，
 * 属于跨端越权（CLAUDE.md 明确禁止 AI 主动切 Provider）。
 */
export function saveWebConfig(config) {
  if (!config?.providers || typeof config.providers !== 'object') throw new Error('config.json 缺少 providers')
  // 【必须先拍平成普通对象】command-adapter 传进来的是 Proxy（为了让 config.current
  // 跟随会话级 Provider）。直接对它做 `{ providers, ...webOnly }` 展开会触发
  // ownKeys → getOwnPropertyDescriptor → 读 shadowConfig → 再触发…… **无限递归**
  // （实测 "Maximum call stack size exceeded"）。
  // JSON 往返是最省事的拍平方式，也顺带剥掉所有 getter/Proxy 陷阱。
  const plain = JSON.parse(JSON.stringify(config))
  const cli = JSON.parse(readFileSync(CLI_CONFIG_PATH, 'utf8'))
  cli.providers = plain.providers
  atomicWrite(CLI_CONFIG_PATH, JSON.stringify(cli, null, 2), 'utf8')
  const { providers, ...webOnly } = plain
  atomicWrite(WEB_CONFIG_PATH, JSON.stringify(webOnly, null, 2), 'utf8')
  return plain
}

export function webConfigExists() {
  return existsSync(WEB_CONFIG_PATH)
}

export { CLI_CONFIG_PATH, PROJECT_ROOT }
