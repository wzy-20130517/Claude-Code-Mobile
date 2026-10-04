/**
 * dsh-host server —— DSH 插件宿主服务（常驻进程）。
 *
 * 定位：对齐 wb-hub（:8788）的模式，在 :8790 上提供一个稳定端点。
 *
 * 架构：
 *   CCM ──► http://127.0.0.1:8790/p/<providerId>/v1  ← 稳定地址
 *              │
 *              └─► 插件 loopback shim（随机端口 + 随机 token）
 *                    └─► 上游（WorkBuddy / Trae）
 *
 * 为什么不让 CCM 直连 shim：
 *   shim 的端口和 token 每次重启都变（随机），写进 CCM 配置会失效。
 *   宿主用自己的固定端口 + 固定 token 做门面，把随机性挡在里面。
 *
 * 控制 API（给 Agent 工具用）：
 *   GET  /control/status          宿主与插件状态
 *   GET  /control/providers       provider 清单（含 CCM 接入地址）
 *   POST /control/load            加载插件 { spec, config }
 *   POST /control/unload          卸载插件 { spec }
 */

import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DshHost } from './plugin-loader.mjs'

const PORT = Number(process.env.DSH_HOST_PORT ?? 8790)
const TOKEN = process.env.DSH_HOST_TOKEN ?? 'dsh-local'
// 用户数据在 ~/.claude-code-mobile/dsh-host/（与源码分离）
const DATA_DIR = process.env.DSH_HOST_DATA
  ?? join(homedir(), '.claude-code-mobile', 'dsh-host')
const CONFIG_FILE = join(DATA_DIR, 'plugins.json')

// ---------------------------------------------------------------------------
// 宿主与插件装配
// ---------------------------------------------------------------------------

// dataDir 必须显式传：否则服务（sessionPersistence/fs/sandboxPolicy）会把
// 运行时数据写到源码目录，违反「源码与用户数据分离」原则。
const host = new DshHost({ dataDir: DATA_DIR })
await host.start()

/** providerId → { adapter, token, shimUrl } */
const routeTable = new Map()

async function refreshRoutes() {
  const llm = host.get('llm')
  routeTable.clear()
  // 官方结构：llm.adapters: Map<providerId, { adapter, provider, retryPolicy }>
  //
  // 两种 adapter 形态：
  //   A. PiAiAdapter（如 account-pool）：自带 loopback shim，
  //      baseUrl 藏在 profile.piProvider.getModels() 的模型描述符里
  //   B. 标准 LlmAdapter（如 freeroute）：无 shim，直接实现 stream/resolveModel，
  //      但可能通过 webServer 注册了自己的 OpenAI 端点（如 /freeroute/v1）
  for (const [id, registration] of llm.adapters ?? []) {
    try {
      const adapter = registration.adapter
      let models = []
      let token = null
      let shimUrl = null

      // 形态 A：PiAiAdapter
      const profiles = adapter.config?.profiles?.()
      if (profiles) {
        const profile = profiles?.get?.(id)
        models = profile?.piProvider?.getModels?.() ?? []
        token = await adapter.config?.resolveApiKey?.()
        shimUrl = models[0]?.baseUrl ?? null
      }

      // 形态 B：标准 adapter —— 试 listModels()
      if (!profiles && typeof adapter.listModels === 'function') {
        try {
          const list = await adapter.listModels(id)
          models = (list ?? []).map((m) => ({ id: m.id ?? m, name: m.name ?? m.id ?? m }))
        } catch {}
      }

      // webServer 上注册的插件端点。
      // 只有「非 PiAiAdapter 型」（没 profiles）的插件才可能注册 webEndpoint，
      // 且端点必须真实存在——用 HEAD/GET 探测，别凭约定瞎拼。
      let webEndpoint = null
      if (!profiles) {
        const webPort = host.webServerPort
        if (webPort) {
          const candidate = `http://127.0.0.1:${webPort}/${id}/v1/models`
          try {
            const res = await fetch(candidate, { signal: AbortSignal.timeout(3000) })
            if (res.ok) webEndpoint = `http://127.0.0.1:${webPort}/${id}/v1`
          } catch {}
        }
      }

      routeTable.set(id, {
        id,
        name: registration.provider?.name ?? id,
        models,
        token,
        shimUrl,
        webEndpoint,
      })
    } catch (err) {
      console.error(`[dsh-host] refreshRoutes ${id} 失败:`, err.message)
    }
  }
}

// 加载配置里的插件
await mkdir(DATA_DIR, { recursive: true })
let pluginsConfig = { plugins: [] }
try {
  pluginsConfig = JSON.parse(await readFile(CONFIG_FILE, 'utf8'))
} catch {
  console.log('[dsh-host] 无 plugins.json，跳过插件加载')
}

for (const entry of pluginsConfig.plugins ?? []) {
  // enabled: false 的插件跳过（set_plugin 写的字段，重启生效）
  if (entry.enabled === false) {
    console.log(`[dsh-host] 跳过已禁用的插件 ${entry.spec}`)
    continue
  }
  try {
    await host.load(entry.spec, entry.config ?? {})
    console.log(`[dsh-host] 已加载插件 ${entry.spec}`)
  } catch (err) {
    console.error(`[dsh-host] 加载 ${entry.spec} 失败:`, err.message)
  }
}

// 等插件装配（shim 起端口）
await new Promise((r) => setTimeout(r, 3000))
await refreshRoutes()

// ---------------------------------------------------------------------------
// 门面 HTTP 服务
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname

  // ---- 控制 API ----
  if (path.startsWith('/control/')) {
    if (path === '/control/status') {
      const svc = host.services
      return json(res, {
        ok: true,
        plugins: host.loaded,
        // 插件运行状态（fiber.state：2=活跃 0=挂起等依赖）
        pluginStates: Object.fromEntries(
          host.loaded.map((s) => [s, host.pluginState(s)]),
        ),
        services: {
          count: svc.ok.length,
          ok: svc.ok,
          ...(svc.failed.length ? { failed: svc.failed } : {}),
          ...(svc.skipped.length ? { skipped: svc.skipped } : {}),
        },
        providers: [...routeTable.values()].map((r) => ({
          id: r.id,
          name: r.name,
          shimReady: r.shimUrl !== null,
          webEndpoint: r.webEndpoint,
          ready: r.shimUrl !== null || r.webEndpoint !== null,
          modelCount: r.models.length,
        })),
      })
    }
    if (path === '/control/providers') {
      return json(res, {
        providers: [...routeTable.values()].map((r) => ({
          id: r.id,
          name: r.name,
          // CCM 接入地址（稳定门面，自动路由到 shim 或 webEndpoint）
          ccmBaseUrl: `http://127.0.0.1:${PORT}/p/${r.id}/v1`,
          ccmApiKey: TOKEN,
          // 两种后端：shim（PiAiAdapter 型）或 webEndpoint（标准 adapter + webServer 型）
          shimReady: r.shimUrl !== null,
          webEndpoint: r.webEndpoint,
          ready: r.shimUrl !== null || r.webEndpoint !== null,
          models: r.models.map((m) => m.id),
        })),
      })
    }
    if (path === '/control/load' && req.method === 'POST') {
      const body = await readBody(req)
      try {
        const { spec, config } = JSON.parse(body)
        await host.load(spec, config ?? {})
        await new Promise((r) => setTimeout(r, 3000))
        await refreshRoutes()
        return json(res, { ok: true, loaded: spec })
      } catch (err) {
        return json(res, { ok: false, error: err.message }, 500)
      }
    }
    if (path === '/control/unload' && req.method === 'POST') {
      const body = await readBody(req)
      try {
        const { spec } = JSON.parse(body)
        const ok = await host.unload(spec)
        await refreshRoutes()
        return json(res, { ok, unloaded: spec })
      } catch (err) {
        return json(res, { ok: false, error: err.message }, 500)
      }
    }

    // ---- 插件包管理（对齐官方 plugin_manager）----
    if (path === '/control/bundles') {
      return json(res, { bundles: await listAvailableBundles() })
    }
    if (path === '/control/set-plugin' && req.method === 'POST') {
      const body = await readBody(req)
      try {
        const { name, enabled } = JSON.parse(body)
        return json(res, await setPluginEnabled(name, enabled))
      } catch (err) {
        return json(res, { ok: false, error: err.message }, 500)
      }
    }
    if (path === '/control/install' && req.method === 'POST') {
      const body = await readBody(req)
      try {
        const { spec, config } = JSON.parse(body)
        return json(res, await installBundle(spec, config))
      } catch (err) {
        return json(res, { ok: false, error: err.message }, 500)
      }
    }
    if (path === '/control/remove' && req.method === 'POST') {
      const body = await readBody(req)
      try {
        const { name } = JSON.parse(body)
        return json(res, await removeBundle(name))
      } catch (err) {
        return json(res, { ok: false, error: err.message }, 500)
      }
    }

    return json(res, { error: 'not found' }, 404)
  }

  // ---- 门面转发：/p/<providerId>/v1/... ----
  const m = path.match(/^\/p\/([^/]+)\/v1(\/.*)?$/)
  if (m) {
    const providerId = m[1]
    const route = routeTable.get(providerId)
    if (!route) return json(res, { error: `unknown provider: ${providerId}` }, 404)

    // 鉴权：CCM 用固定 token
    const auth = req.headers.authorization ?? ''
    if (auth !== `Bearer ${TOKEN}`) {
      return json(res, { error: 'unauthorized' }, 401)
    }

    const subPath = m[2] ?? ''

    // 后端选择：
    //   1. shim（PiAiAdapter 型，如 account-pool）—— 需要 shim 的真 token
    //   2. webEndpoint（标准 adapter + webServer，如 freeroute）—— 无需 token
    if (route.shimUrl) {
      return forward(req, res, `${route.shimUrl}${subPath}`, route.token)
    }
    if (route.webEndpoint) {
      return forward(req, res, `${route.webEndpoint}${subPath}`, null)
    }
    return json(res, { error: `provider ${providerId} 无可用后端（shim 未就绪且无 webEndpoint）` }, 503)
  }

  json(res, { error: 'not found', hint: 'try /control/status or /p/<provider>/v1/...' }, 404)
})

function json(res, obj, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj, null, 2))
}

// ---------------------------------------------------------------------------
// 插件包管理（对齐官方 plugin_manager 的 action 语义）
// ---------------------------------------------------------------------------

/** 已加载插件的清单（plugins.json 里的 entries） */
function readPluginEntries() {
  return pluginsConfig.plugins ?? []
}

/** 写回 plugins.json */
async function writePluginEntries(entries) {
  pluginsConfig = { ...pluginsConfig, plugins: entries }
  await writeFile(CONFIG_FILE, JSON.stringify(pluginsConfig, null, 2))
}

/**
 * 列出「可安装的 DSH 插件包」。
 * 官方 list_bundles 列的是 profile 里可装的组合包；
 * CCM 版列本地已装的 dsh-* 包 + 推荐清单（从 npm 搜太重，先静态）。
 */
async function listAvailableBundles() {
  const loadedSet = new Set(host.loaded)
  const entries = readPluginEntries()
  const configSet = new Set(entries.map((e) => e.spec))

  // 1. 已装的第三方插件（从 node_modules 扫，排除官方 @deepseek-ai）
  const { readdir } = await import('node:fs/promises')
  const found = []
  try {
    const dir = new URL('./node_modules/', import.meta.url).pathname

    /** 读包描述（失败返回空串） */
    const readDesc = async (pkgPath) => {
      try {
        const raw = await readFile(join(pkgPath, 'package.json'), 'utf8')
        return JSON.parse(raw).description ?? ''
      } catch { return '' }
    }

    /**
     * 判断一个包是不是「可加载的插件」。
     * 标准：模块有 apply 导出（Cordis 插件形态）。
     * 排除共享库（如 dsh-plugin-ops-core 是 dsh-plugin-ops-bundle 的依赖，无 apply）。
     */
    const isPlugin = async (pkgName) => {
      try {
        const m = await import(pkgName)
        return typeof m.apply === 'function'
      } catch { return false }
    }

    for (const name of await readdir(dir)) {
      // 只列第三方插件（排除官方 @deepseek-ai/*，那是宿主依赖不是插件）
      if (name.startsWith('@') || !name.startsWith('dsh-')) continue
      if (!(await isPlugin(name))) continue   // 跳过共享库
      found.push({
        name,
        description: await readDesc(join(dir, name)),
        installed: true,
        loaded: loadedSet.has(name),
        inConfig: configSet.has(name),
      })
    }
    // scoped 包（如 @goodandready/*），排除官方
    for (const scope of await readdir(dir)) {
      if (!scope.startsWith('@') || scope === '@deepseek-ai') continue
      try {
        for (const name of await readdir(join(dir, scope))) {
          if (!name.startsWith('dsh-')) continue
          const full = `${scope}/${name}`
          if (!(await isPlugin(full))) continue   // 跳过共享库
          found.push({
            name: full,
            description: await readDesc(join(dir, scope, name)),
            installed: true,
            loaded: loadedSet.has(full),
            inConfig: configSet.has(full),
          })
        }
      } catch {}
    }
  } catch {}

  // 2. 推荐清单（未装的）
  const RECOMMENDED = [
    { name: 'dsh-freeroute', description: '免费额度聚合（OpenCode Zen / OpenRouter / SenseNova）' },
    { name: 'dsh-account-pool', description: 'WorkBuddy / Trae 多账号池' },
    { name: 'dsh-plugin-model-proxy', description: '模型级代理路由' },
    { name: 'dsh-plugin-mgr', description: '设置页插件管理' },
  ]
  const foundNames = new Set(found.map((f) => f.name))
  const notInstalled = RECOMMENDED
    .filter((r) => !foundNames.has(r.name))
    .map((r) => ({ name: r.name, description: r.description, installed: false, loaded: false }))

  return [...found.sort((a, b) => a.name.localeCompare(b.name)), ...notInstalled]
}

/** 启用/禁用插件（改 plugins.json 的 enabled，重启后生效） */
async function setPluginEnabled(name, enabled) {
  const entries = readPluginEntries()
  const entry = entries.find((e) => e.spec === name)
  if (!entry) return { ok: false, error: `插件未在 plugins.json 中: ${name}` }
  entry.enabled = enabled
  await writePluginEntries(entries)
  return { ok: true, name, enabled, note: '下次宿主重启生效（bash start.sh restart）' }
}

/** 安装插件：npm install + 写入 plugins.json + 热加载 */
async function installBundle(spec, config) {
  // npm install（在 dsh-host 目录）
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const dir = new URL('.', import.meta.url).pathname
  try {
    await run('npm', ['install', '--no-audit', '--no-fund', '--legacy-peer-deps', spec], {
      cwd: dir, timeout: 240000,
    })
  } catch (err) {
    return { ok: false, error: `npm install 失败: ${err.message}` }
  }
  // 写配置
  const entries = readPluginEntries()
  if (!entries.find((e) => e.spec === spec)) {
    entries.push({ spec, config: config ?? {}, enabled: true })
    await writePluginEntries(entries)
  }
  // 热加载
  try {
    await host.load(spec, config ?? {})
    await new Promise((r) => setTimeout(r, 3000))
    await refreshRoutes()
    return { ok: true, installed: spec, loaded: true }
  } catch (err) {
    return { ok: true, installed: spec, loaded: false, loadError: err.message, note: '重启宿主后生效' }
  }
}

/** 卸载插件：从配置移除 + 热卸载（不删 npm 包，保守） */
async function removeBundle(name) {
  const entries = readPluginEntries().filter((e) => e.spec !== name)
  await writePluginEntries(entries)
  const unloaded = await host.unload(name)
  await refreshRoutes()
  return { ok: true, name, unloaded, note: 'npm 包未删除（如需彻底移除: npm remove ' + name + '）' }
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/** 转发请求到后端（shim 或 webEndpoint），流式管道回传 */
async function forward(req, res, target, token) {
  try {
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req)
    const headers = {
      'content-type': req.headers['content-type'] ?? 'application/json',
      accept: req.headers.accept ?? '*/*',
    }
    // shim 需要真 token；webEndpoint 不需要（本地回环端点按设计无鉴权）
    if (token) headers.authorization = `Bearer ${token}`
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
    })
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    })
    if (upstream.body) {
      for await (const chunk of upstream.body) res.write(chunk)
    }
    res.end()
  } catch (err) {
    json(res, { error: `forward failed: ${err.message}` }, 502)
  }
}

server.listen(PORT, '127.0.0.1', () => {
  console.log('')
  console.log('='.repeat(60))
  console.log(`[dsh-host] 门面服务已启动: http://127.0.0.1:${PORT}`)
  console.log(`[dsh-host] 控制 API: http://127.0.0.1:${PORT}/control/status`)
  for (const [id, r] of routeTable) {
    const backend = r.shimUrl ? 'shim ready' : (r.webEndpoint ? 'webEndpoint ready' : '未就绪（无账号/未配置上游）')
    console.log(`[dsh-host] provider ${id}: http://127.0.0.1:${PORT}/p/${id}/v1 (${backend})`)
  }
  console.log('='.repeat(60))
})

process.on('SIGINT', async () => {
  console.log('\n[dsh-host] 关闭中...')
  server.close()
  await host.dispose()
  process.exit(0)
})
