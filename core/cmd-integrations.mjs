// 外部服务配置类 slash 命令（handleCommand 拆分第五批）
//
// 跟 cmd-queries.mjs 的区别：那边是只读查询 + 本地开关，
// 这边管的是**外部服务**（图库 key、MCP 服务器进程），有网络调用和进程操作。
// 分成两个模块而不是堆一起，是为了让 ctx 的依赖面各自收窄 ——
// queries 不需要 mcpClient，integrations 不需要 agent/todos。
//
// 【迁移纪律】逐字照抄原实现。第一批拆分时凭印象重写，
// 把 recentErrors 当函数、contextFiles.reset 写成 clear，行为悄悄漂移了。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { MCP_PATH } from './paths.mjs'

/**
 * @param {object} ctx
 *   C          颜色表
 *   maskKey    密钥打码函数（index.mjs 的全局工具）
 *   mcpClient  MCP 客户端实例（活对象：servers 是 Map，会被增删）
 */
export function makeIntegrationCommands(ctx) {
  const ENV_PATH = join(homedir(), '.claude-code-mobile', '.env')
  const MCP_CONFIG_PATH = MCP_PATH

  const readEnv = () => {
    try { return readFileSync(ENV_PATH, 'utf-8') } catch { return '' }
  }
  const writePexelsKey = (k) => {
    const txt = readEnv()
    const lines = txt.split('\n').filter((l) => l && !/^PEXELS_API_KEY=/.test(l))
    lines.push(`PEXELS_API_KEY=${k}`)
    try { mkdirSync(join(homedir(), '.claude-code-mobile'), { recursive: true }) } catch {}
    writeFileSync(ENV_PATH, lines.join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 })
    process.env.PEXELS_API_KEY = k     // 当前进程立即生效，不用重启
  }

  return {
    /** /pexels — FindImage 用的图库 key（存 ~/.claude-code-mobile/.env） */
    async pexels(args) {
      const { maskKey } = ctx
      const sub = String(args[0] || '').toLowerCase()
      const cur = process.env.PEXELS_API_KEY || ''

      if (!sub || sub === 'status') {
        return `Pexels（FindImage 图库搜索）:\n`
          + `- Key: ${cur ? maskKey(cur) : '未配置'}\n`
          + `- 存储: ${ENV_PATH}\n`
          + `- 免费额度: 200 次/小时、20000 次/月\n`
          + `用法: /pexels set <key> · /pexels test · /pexels clear\n`
          + `注册拿 key: https://www.pexels.com/api/（支持 Google 一键注册）`
      }
      if (sub === 'set') {
        const k = String(args[1] || '').trim()
        if (!k) return '用法: /pexels set <key>'
        if (k.length < 20) return `key 太短（${k.length} 字符），Pexels key 通常 56 字符`
        writePexelsKey(k)
        return `Pexels key 已保存: ${maskKey(k)}\n（已写入 ${ENV_PATH}，当前会话立即生效）`
      }
      if (sub === 'clear') {
        if (!cur) return 'Pexels key 本来就没配'
        const txt = readEnv()
        const lines = txt.split('\n').filter((l) => l && !/^PEXELS_API_KEY=/.test(l))
        writeFileSync(ENV_PATH, lines.length ? lines.join('\n') + '\n' : '', { encoding: 'utf-8', mode: 0o600 })
        delete process.env.PEXELS_API_KEY
        return 'Pexels key 已清空'
      }
      if (sub === 'test') {
        if (!cur) return 'Pexels key 未配置，先 /pexels set <key>'
        try {
          const r = await fetch('https://api.pexels.com/v1/search?query=test&per_page=1', {
            headers: { Authorization: cur }, signal: AbortSignal.timeout(15000),
          })
          if (r.status === 401) return `key 无效（401）: ${maskKey(cur)}`
          if (r.status === 429) return 'key 有效但已超限（429），额度按小时/月重置'
          if (!r.ok) return `测试失败: HTTP ${r.status}`
          const d = await r.json()
          // Pexels 在响应头返回剩余额度
          const left = r.headers.get('x-ratelimit-remaining')
          const limit = r.headers.get('x-ratelimit-limit')
          return `Pexels key 正常 ✓ ${maskKey(cur)}\n`
            + `- 搜到 ${d?.total_results ?? '?'} 个结果\n`
            + (left ? `- 剩余额度: ${left}/${limit}` : '')
        } catch (e) { return `测试失败: ${e.message}` }
      }
      return `用法:\n  /pexels          看当前 key 与额度说明\n  /pexels set <key>\n  /pexels test     测连通性和剩余额度\n  /pexels clear`
    },

    /**
     * /mcp — 管理 MCP 服务器（对齐官方 commands/mcp）
     *
     * 官方定位是 'Manage MCP servers'，argumentHint '[enable|disable [server-name]]'。
     * MCP 的**工具**不做成 slash 命令（走 mcp_<server>_<tool> 工具通道），
     * 这个命令只管服务器的启停与状态查看。
     */
    mcp(args) {
      const { C, mcpClient } = ctx
      const sub = String(args[0] || '').toLowerCase()
      const readMcpCfg = () => {
        try { return JSON.parse(readFileSync(MCP_CONFIG_PATH, 'utf-8')) } catch { return { mcpServers: {} } }
      }
      const writeMcpCfg = (cfg) => {
        writeFileSync(MCP_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf-8')
      }
      const cfg = readMcpCfg()
      const configured = Object.entries(cfg.mcpServers || {})

      if (!sub || sub === 'list' || sub === 'status') {
        if (configured.length === 0) {
          return 'MCP: 未配置任何服务器\n配置文件: mcp.json\n用法: /mcp enable|disable <名字> · /mcp tools <名字>'
        }
        const lines = ['MCP 服务器：']
        for (const [name, srv] of configured) {
          const live = mcpClient.servers.get(name)
          const disabled = srv?.disabled === true
          // 三种状态要分清：配置里禁用 / 配了但没连上 / 正常运行
          const state = disabled
            ? `${C.dim}已禁用${C.reset}`
            : live
              ? `${C.green}运行中${C.reset} · ${live.tools?.length || 0} 个工具`
              : `${C.yellow}未连接${C.reset}`
          lines.push(`  ${name}  ${state}`)
          if (live?.tools?.length && sub === 'status') {
            lines.push(`    ${live.tools.map(t => t.name).join(', ')}`)
          }
        }
        const running = configured.filter(([n, s]) => s?.disabled !== true && mcpClient.servers.get(n)).length
        lines.push('')
        lines.push(`${C.dim}共 ${configured.length} 个配置 · ${running} 个运行中 · 工具总数 ${mcpClient.getAllTools().length}${C.reset}`)
        lines.push(`${C.dim}/mcp status 看工具清单 · /mcp enable|disable <名字> · 改动需重启生效${C.reset}`)
        return lines.join('\n')
      }

      if (sub === 'tools') {
        const target = String(args[1] || '').trim()
        const all = mcpClient.getAllTools()
        const picked = target ? all.filter(t => t.mcpServer === target) : all
        if (picked.length === 0) {
          return target ? `MCP 服务器 "${target}" 没有工具（或未连接）` : 'MCP: 当前没有任何工具'
        }
        return `MCP 工具（${picked.length} 个）：\n`
          + picked.map(t => `  ${t.name}\n    ${String(t.description || '').slice(0, 90)}`).join('\n')
      }

      if (sub === 'enable' || sub === 'disable') {
        const target = String(args[1] || '').trim()
        if (!target) return `用法: /mcp ${sub} <服务器名>\n可用: ${configured.map(([n]) => n).join(', ') || '(无)'}`
        if (!cfg.mcpServers?.[target]) {
          return `没有名为 "${target}" 的 MCP 服务器\n可用: ${configured.map(([n]) => n).join(', ') || '(无)'}`
        }
        const wantDisabled = sub === 'disable'
        if ((cfg.mcpServers[target].disabled === true) === wantDisabled) {
          return `MCP "${target}" 已经是${wantDisabled ? '禁用' : '启用'}状态`
        }
        if (wantDisabled) cfg.mcpServers[target].disabled = true
        else delete cfg.mcpServers[target].disabled
        try { writeMcpCfg(cfg) } catch (e) { return `写入 mcp.json 失败: ${e.message}` }
        // 禁用可以立即停掉进程；启用需要重启（addServer 要重新握手+拉工具清单，
        // 且 registry 里的工具适配器是启动时一次性注册的）
        if (wantDisabled) {
          const live = mcpClient.servers.get(target)
          if (live?.proc) { try { live.proc.kill() } catch {} }
          mcpClient.servers.delete(target)
          return `已禁用 MCP "${target}"（进程已停止，工具下轮请求起不再可见）`
        }
        return `已启用 MCP "${target}"，按 Ctrl+X 重启后生效`
      }

      return `用法:\n`
        + `  /mcp                看服务器列表与状态\n`
        + `  /mcp status         同上，并列出每个服务器的工具名\n`
        + `  /mcp tools [名字]   看工具详情（省略名字=全部）\n`
        + `  /mcp enable <名字>  启用（需重启）\n`
        + `  /mcp disable <名字> 禁用（立即停进程）\n`
        + `配置文件: mcp.json`
    },
  }
}
