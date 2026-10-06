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
import { MCP_PATH } from '../infra/paths.mjs'
// /tvly 用：读取走 getTavilyKey（与 WebSearch 实际那条取值链同一实现），
// 写完必须 resetTavilyKeyCache —— 模块级 cachedKey 不会因为文件变了自己失效。
import { getTavilyKey, resetTavilyKeyCache } from '../tools/tavily.mjs'

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
  const writeTavilyKey = (k) => {
    const txt = readEnv()
    const lines = txt.split('\n').filter((l) => l && !/^TAVILY_API_KEY=/.test(l))
    lines.push(`TAVILY_API_KEY=${k}`)
    try { mkdirSync(join(homedir(), '.claude-code-mobile'), { recursive: true }) } catch {}
    writeFileSync(ENV_PATH, lines.join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 })
    process.env.TAVILY_API_KEY = k   // 当前进程立即生效
    resetTavilyKeyCache()             // WebSearch 的模块级缓存一起失效
  }
  const clearTavilyKey = () => {
    const txt = readEnv()
    const lines = txt.split('\n').filter((l) => l && !/^TAVILY_API_KEY=/.test(l))
    try { writeFileSync(ENV_PATH, lines.join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 }) } catch {}
    delete process.env.TAVILY_API_KEY
    resetTavilyKeyCache()
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
    /**
     * /tvly — Tavily 搜索 key（WebSearch 用；存 ~/.claude-code-mobile/.env）
     *
     * 【为什么存 .env 不存 config.json】
     * config.json 的 saveConfig 是白名单序列化（index.mjs），登记新字段
     * 很容易漏 —— 漏了就是「设完下次任何 saveConfig 又没了」的老坑。
     * .env 与 /pexels 同一条路：CLI / Web 两个进程读同一份文件，
     * 且 getTavilyKey 的取值链第一优先就是它，写完立即生效。
     *
     * key 形如 tvly-xxxxxxxx（Tavily 官方前缀）。
     */
    async tvly(args) {
      const { maskKey } = ctx
      const sub = String(args[0] || '').toLowerCase()

      if (!sub || sub === 'status') {
        const cur = getTavilyKey()
        return `Tavily（WebSearch 联网搜索）:\n`
          + `- Key: ${cur ? maskKey(cur) : '未配置'}\n`
          + `- 存储: ${ENV_PATH}\n`
          + `- key 格式: \`tvly-xxxxxxxx\`\n`
          + `用法: /tvly <tvly-...> 设置 · /tvly clear 清空\n`
          + `注册拿 key: https://app.tavily.com/`
      }
      if (sub === 'clear') {
        clearTavilyKey()
        return 'Tavily key 已清空（WebSearch 会提示「未配置」）'
      }
      // 支持 /tvly <key> 和 /tvly set <key>（两种写法等价）
      const parts = sub === 'set' ? args.slice(1) : args
      const key = String(parts.join(' ') || '').trim()
      if (!key) return '用法: /tvly <tvly-...> 或 /tvly set <tvly-...>'
      writeTavilyKey(key)
      return `Tavily key 已设置（${maskKey(key)}）· 本端立即生效\n`
        + `注意：CLI 与 Web 是两个进程，另一端重启后生效（与 /pexels 同）`
    },
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

    /**
     * /plugin — 管理插件（对齐官方 Claude Code 的 /plugin）
     *
     * 当前插件体系是 DSH 生态（DeepSeek Harness，Cordis 插件框架），
     * CCM 通过 dsh-host 兼容层加载它们（如 dsh-account-pool 多账号池）。
     *
     * 与 /mcp 的分工：
     *   /mcp 管 MCP 服务器（协议级工具接入）
     *   /plugin 管插件（Cordis 插件，常驻宿主进程）
     */
    async plugin(args) {
      const { C } = ctx
      const sub = String(args[0] || '').toLowerCase()
      const HOST = process.env.DSH_HOST_URL ?? 'http://127.0.0.1:8790'
      const START_HINT = 'bash ~/claude-code-mobile/dsh-host/start.sh start'

      const ctrl = async (path, options = {}) => {
        try {
          const res = await fetch(`${HOST}/control${path}`, {
            method: options.method ?? 'GET',
            headers: options.headers,
            body: options.body,
            signal: AbortSignal.timeout(options.timeout ?? 15000),
          })
          const text = await res.text()
          try { return { ok: res.ok, status: res.status, data: JSON.parse(text) } }
          catch { return { ok: res.ok, status: res.status, data: text } }
        } catch (err) {
          return { ok: false, status: 0, error: err.message }
        }
      }

      // 自愈：宿主未运行时自动拉起（手机重启/进程被杀后不用手动 start）
      const ensureHost = async () => {
        const probe = await ctrl('/status', { timeout: 3000 })
        if (probe.ok) return true
        try {
          const { execFile } = await import('node:child_process')
          const { promisify } = await import('node:util')
          const { homedir } = await import('node:os')
          const { join } = await import('node:path')
          // start.sh 内部会等到 API 就绪才返回，不用再固定 sleep
          await promisify(execFile)('bash', [join(homedir(), 'claude-code-mobile', 'dsh-host', 'start.sh'), 'start'], { timeout: 60000 })
          // 兜底探测
          for (let i = 0; i < 5; i++) {
            const p2 = await ctrl('/status', { timeout: 2000 })
            if (p2.ok) return true
            await new Promise((r) => setTimeout(r, 1000))
          }
          return false
        } catch { return false }
      }

      if (!sub || sub === 'status' || sub === 'list') {
        const r = await ctrl('/status')
        if (!r.ok) {
          return `DSH 宿主未运行（${r.error ?? `HTTP ${r.status}`}）\n`
            + `启动: ${START_HINT}\n`
            + `宿主源码: ~/claude-code-mobile/dsh-host/`
        }
        const d = r.data
        const svcCount = d.services?.count ?? 0
        const lines = ['DSH 插件宿主：']
        lines.push(`  ${C.green}运行中${C.reset} · 服务 ${svcCount} 个 · 插件 ${d.plugins.length} 个 · provider ${d.providers.length} 个`)
        lines.push('')
        for (const p of d.plugins) {
          const st = d.pluginStates?.[p]
          // fiber.state：2=活跃，0=挂起等依赖（cordis inject 语义）
          const badge = st?.active
            ? `${C.green}活跃${C.reset}`
            : `${C.yellow}挂起${C.reset}`
          lines.push(`  插件  ${p}  ${badge}`)
        }
        for (const p of d.providers) {
          const be = p.ready
            ? `${C.green}ready${C.reset}`
            : `${C.yellow}未就绪${C.reset}`
          lines.push(`  provider  ${p.id} "${p.name}" ${be} models=${p.modelCount}`)
        }
        if (d.services?.failed?.length) {
          lines.push('')
          lines.push(`${C.yellow}服务注册失败: ${d.services.failed.map(f => f.name).join(', ')}${C.reset}`)
        }
        lines.push('')
        lines.push(`${C.dim}/plugin providers 看接入地址 · /plugin bundles 看可用插件 · /plugin install <包名> 安装${C.reset}`)
        return lines.join('\n')
      }

      if (sub === 'providers') {
        if (!(await ensureHost())) return `DSH 宿主未运行，自动拉起失败\n手动启动: ${START_HINT}`
        const r = await ctrl('/providers')
        if (!r.ok) return `DSH 宿主未运行（${r.error ?? `HTTP ${r.status}`}）\n启动: ${START_HINT}`
        const list = r.data.providers ?? []
        if (list.length === 0) return 'DSH: 没有已注册的 provider'
        const lines = ['DSH provider（CCM 接入地址）：']
        for (const p of list) {
          lines.push('')
          lines.push(`  ${p.id}  (${p.name})`)
          lines.push(`    baseUrl : ${p.ccmBaseUrl}`)
          lines.push(`    apiKey  : ${p.ccmApiKey}`)
          const backend = p.shimReady ? 'shim' : (p.webEndpoint ? 'webEndpoint' : '未就绪')
          lines.push(`    backend : ${backend}${p.ready ? '' : '（无账号/未配置上游）'}`)
          if (p.models?.length) lines.push(`    models  : ${p.models.join(', ')}`)
        }
        lines.push('')
        lines.push(`${C.dim}接入: /config provider add dsh-<id> url=<baseUrl> model=<模型> key=${list[0]?.ccmApiKey ?? ''}${C.reset}`)
        return lines.join('\n')
      }

      if (sub === 'bundles') {
        if (!(await ensureHost())) return `DSH 宿主未运行，自动拉起失败\n手动启动: ${START_HINT}`
        const r = await ctrl('/bundles')
        if (!r.ok) return `DSH 宿主未运行（${r.error ?? `HTTP ${r.status}`}）\n启动: ${START_HINT}`
        const list = r.data.bundles ?? []
        const lines = ['DSH 插件包：']
        for (const b of list) {
          const st = b.loaded ? `${C.green}已加载${C.reset}` : b.installed ? `${C.yellow}已装未加载${C.reset}` : '未安装'
          lines.push(`  ${b.name}  ${st}`)
          lines.push(`    ${b.description}`)
        }
        lines.push('')
        lines.push(`${C.dim}/plugin install <包名> 安装并加载${C.reset}`)
        return lines.join('\n')
      }

      if (sub === 'install') {
        const spec = String(args[1] || '').trim()
        if (!spec) return '用法: /plugin install <插件包名>（如 dsh-account-pool）'
        const r = await ctrl('/install', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spec }),
          timeout: 240000,
        })
        if (!r.ok) return `安装失败: ${JSON.stringify(r.data ?? r.error)}`
        const d = r.data
        return d.loaded
          ? `已安装并加载: ${spec}`
          : `已安装: ${spec}（加载失败: ${d.loadError ?? '未知'}，重启宿主后重试）`
      }

      if (sub === 'remove') {
        const name = String(args[1] || '').trim()
        if (!name) return '用法: /plugin remove <插件包名>'
        const r = await ctrl('/remove', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        })
        if (!r.ok) return `卸载失败: ${JSON.stringify(r.data ?? r.error)}`
        return `已卸载: ${name}（npm 包保留，需彻底删除用 npm remove）`
      }

      if (sub === 'enable' || sub === 'disable') {
        const name = String(args[1] || '').trim()
        if (!name) return `用法: /plugin ${sub} <插件名>`
        const r = await ctrl('/set-plugin', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, enabled: sub === 'enable' }),
        })
        if (!r.ok) return `操作失败: ${JSON.stringify(r.data ?? r.error)}`
        return `已${sub === 'enable' ? '启用' : '禁用'}: ${name}（重启宿主生效: bash ~/claude-code-mobile/dsh-host/start.sh restart）`
      }

      return `用法:\n`
        + `  /plugin             看插件宿主状态（插件 + provider）\n`
        + `  /plugin providers   看 provider 的 CCM 接入地址\n`
        + `  /plugin bundles     看可安装的插件包\n`
        + `  /plugin install <包名>   安装并加载插件\n`
        + `  /plugin remove <包名>    卸载插件\n`
        + `  /plugin enable|disable <包名>  启用/禁用（重启生效）\n`
        + `宿主: ~/claude-code-mobile/dsh-host/ · 端口 ${HOST}`
    },
  }
}
