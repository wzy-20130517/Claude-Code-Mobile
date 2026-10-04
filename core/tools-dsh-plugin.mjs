// Claude Code Mobile - DSH 插件管理工具
// 对齐官方 plugin_manager（packages/boot/plugin-manager/src/tools.ts）
//
// 官方 action 集（8 个）：
//   list_plugins / list_bundles / set_plugin / set_bundle /
//   install_bundle / remove_bundle / list_version_exemptions / set_version_exemption
//
// CCM 版映射：
//   list_plugins    → 列已加载插件（宿主 plugins.json 的表）
//   list_bundles    → 列可用插件包（npm 上 dsh-* 的清单，走本地缓存）
//   set_plugin      → 启用/禁用（改 plugins.json 的 enabled 字段）
//   install_bundle  → 装包（npm install + 写 plugins.json）
//   remove_bundle   → 卸包（改 plugins.json + 提示手动 npm remove）
//   list_version_exemptions / set_version_exemption → 版本豁免（CCM 版暂不适用，返回说明）
//
// 后端：dsh-host 控制 API（默认 http://127.0.0.1:8790/control/*）

import { Tool } from './tools.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)
const START_SCRIPT = join(homedir(), 'claude-code-mobile', 'dsh-host', 'start.sh')

/**
 * 尝试拉起 dsh-host（后台）。
 * 只在「连接失败」时调用——正常路径不该付这个开销。
 */
async function tryStartHost() {
  try {
    // start.sh 自己会等到 API 就绪才返回（内部轮询，约 6-15 秒），
    // 所以这里不用再固定 sleep——直接看返回后能否连上。
    await execFileAsync('bash', [START_SCRIPT, 'start'], { timeout: 60000 })
    // 兜底：万一 start.sh 返回时刚好在临界点，再探几次
    for (let i = 0; i < 5; i++) {
      const probe = await ctrl('/status', { timeout: 2000 })
      if (probe.ok) return true
      await new Promise((r) => setTimeout(r, 1000))
    }
    return false
  } catch {
    return false
  }
}

const DEFAULT_HOST = process.env.DSH_HOST_URL ?? 'http://127.0.0.1:8790'

async function ctrl(path, options = {}) {
  const url = `${DEFAULT_HOST}/control${path}`
  try {
    const res = await fetch(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal: AbortSignal.timeout(options.timeout ?? 15000),
    })
    const text = await res.text()
    try {
      return { ok: res.ok, status: res.status, data: JSON.parse(text) }
    } catch {
      return { ok: res.ok, status: res.status, data: text }
    }
  } catch (err) {
    return { ok: false, status: 0, error: err.message }
  }
}

export class DshPluginTool extends Tool {
  constructor() {
    super({
      name: 'DshPlugin',
      description: [
        '管理 DSH 插件宿主（dsh-host）里的插件。',
        'action=list_plugins: 列出已加载插件与 provider 状态（支持 offset/limit 分页）',
        'action=list_bundles: 列出可安装的 DSH 插件包',
        'action=set_plugin: 启用/禁用插件（target=插件名，enabled=true/false）',
        'action=install_bundle: 安装插件（target=模块名）',
        'action=remove_bundle: 卸载插件（target=模块名）',
        'action=providers: 列出 provider 及其 CCM 接入地址（baseUrl/apiKey）',
        'action=status: 宿主健康检查',
        '宿主未运行时先启动: bash ~/claude-code-mobile/dsh-host/start.sh start',
      ].join(' '),
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'list_plugins', 'list_bundles', 'set_plugin',
              'install_bundle', 'remove_bundle',
              'providers', 'status',
            ],
            description: '操作类型（对齐官方 plugin_manager，外加 providers/status 两个 CCM 专用查询）',
          },
          target: {
            type: 'string',
            description: 'set_plugin/install_bundle/remove_bundle 的目标（插件模块名）',
          },
          enabled: {
            type: 'boolean',
            description: 'set_plugin 时必填：true=启用 false=禁用',
          },
          config: {
            type: 'object',
            description: 'install_bundle 时的插件配置（如 { regions: ["global"] }）',
          },
          offset: { type: 'number', description: 'list 分页起始（0-based，默认 0）' },
          limit: { type: 'number', description: 'list 分页大小（1-100，默认 25）' },
          autoStart: {
            type: 'boolean',
            description: '宿主未运行时自动拉起（默认 true；拉起需等约 14 秒）',
          },
        },
        required: ['action'],
      },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
    })
  }

  async execute(input) {
    const { action, target, enabled, config, offset = 0, limit = 25, autoStart = true } = input

    if (!Number.isInteger(offset) || offset < 0) return 'offset 必须是非负整数'
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return 'limit 必须是 1-100 的整数'

    // 自愈：宿主未运行时自动拉起（手机重启/进程被杀后不用手动 start）
    // 只有 status 动作跳过（它就是用来查状态的，拉起会让结果失真）
    if (autoStart && action !== 'status') {
      const probe = await ctrl('/status', { timeout: 3000 })
      if (!probe.ok) {
        const started = await tryStartHost()
        if (!started) {
          return `宿主未运行，自动拉起失败。手动启动: bash ${START_SCRIPT} start`
        }
      }
    }

    switch (action) {
      case 'status': {
        const r = await ctrl('/status')
        if (!r.ok) return `宿主未运行或不可达: ${r.error ?? `HTTP ${r.status}`}\n启动: bash ~/claude-code-mobile/dsh-host/start.sh start`
        return JSON.stringify(r.data, null, 2)
      }

      case 'list_plugins': {
        const r = await ctrl('/status')
        if (!r.ok) return `宿主未运行: ${r.error ?? `HTTP ${r.status}`}`
        const d = r.data
        const rows = (d.plugins ?? []).map((name) => {
          const st = d.pluginStates?.[name]
          return {
            name,
            // fiber.state: 2=活跃, 0=挂起等依赖（cordis inject 语义）
            active: st?.active ?? null,
            state: st?.state ?? null,
            ...(st && !st.active ? { hint: '挂起中：依赖的服务未就绪' } : {}),
          }
        })
        const page = rows.slice(offset, offset + limit)
        return JSON.stringify({
          entries: page,
          total: rows.length,
          nextOffset: offset + page.length < rows.length ? offset + page.length : null,
          services: d.services?.count ?? 0,
        }, null, 2)
      }

      case 'list_bundles': {
        const r = await ctrl('/bundles')
        if (!r.ok) return `获取失败: ${r.error ?? `HTTP ${r.status}`}`
        const rows = r.data?.bundles ?? []
        const page = rows.slice(offset, offset + limit)
        return JSON.stringify({
          entries: page,
          total: rows.length,
          nextOffset: offset + page.length < rows.length ? offset + page.length : null,
        }, null, 2)
      }

      case 'set_plugin': {
        if (!target) return 'set_plugin 需要 target'
        if (typeof enabled !== 'boolean') return 'set_plugin 需要 enabled（true/false）'
        const r = await ctrl('/set-plugin', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: target, enabled }),
        })
        if (!r.ok) return `操作失败: ${JSON.stringify(r.data ?? r.error)}`
        return `已${enabled ? '启用' : '禁用'}: ${target}`
      }

      case 'install_bundle': {
        if (!target) return 'install_bundle 需要 target（插件模块名）'
        const r = await ctrl('/install', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spec: target, config }),
          timeout: 180000,   // npm install 可能慢
        })
        if (!r.ok) return `安装失败: ${JSON.stringify(r.data ?? r.error)}`
        return `已安装并加载: ${target}`
      }

      case 'remove_bundle': {
        if (!target) return 'remove_bundle 需要 target'
        const r = await ctrl('/remove', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: target }),
        })
        if (!r.ok) return `卸载失败: ${JSON.stringify(r.data ?? r.error)}`
        return `已卸载: ${target}`
      }

      case 'providers': {
        const r = await ctrl('/providers')
        if (!r.ok) return `宿主未运行: ${r.error ?? `HTTP ${r.status}`}`
        const list = r.data.providers ?? []
        if (list.length === 0) return '没有已注册的 provider'
        const lines = []
        for (const p of list) {
          lines.push(`${p.id}  (${p.name})`)
          lines.push(`  baseUrl : ${p.ccmBaseUrl}`)
          lines.push(`  apiKey  : ${p.ccmApiKey}`)
          const backend = p.shimReady ? 'shim ready' : (p.webEndpoint ? 'webEndpoint ready' : '未就绪（无账号/未配置上游）')
          lines.push(`  backend : ${backend}`)
          if (p.models?.length) lines.push(`  models  : ${p.models.join(', ')}`)
          lines.push('')
        }
        return lines.join('\n').trimEnd()
      }

      default:
        return `未知 action: ${action}`
    }
  }
}
