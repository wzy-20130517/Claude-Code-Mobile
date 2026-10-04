/**
 * plugin-loader —— DSH 插件宿主（对齐官方 app-boot 的最小实现）。
 *
 * 参照：~/cc-src/deepseek-harness/packages/boot/app-boot/src/index.ts
 * 官方 boot 流程：
 *   const ctx = new Context()
 *   ctx.provide('dshHomePath', dshHomePath)
 *   await ctx.plugin(Loader)
 *   await prepare?.(ctx)
 *   await mountRootInclude(...)      ← 挂配置树
 *
 * 本宿主与官方一致，只把「配置树」简化成直接挂目标插件。
 *
 * 服务全部用官方实现（不手写），注册表见 services.mjs：
 *   - 数据驱动（加服务 = 表里加一行）
 *   - 依赖拓扑（deps 声明，按序注册）
 *   - 容错（单个服务失败不拖垮宿主）
 */

import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { registerServices, SERVICE_TABLE } from './services.mjs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export class DshHost {
  constructor(options = {}) {
    /** 官方根上下文 */
    this.ctx = new Context()
    this.ctx.dataDir = options.dataDir ?? process.cwd()
    this.loaded = []
    /** 服务注册结果（供控制 API 展示） */
    this.serviceReport = null
    /** 详细日志开关 */
    this.verbose = options.verbose ?? false
  }

  /**
   * 初始化：对齐官方 boot() 的顺序——
   * 先 provide 基础值，再挂 Loader，最后装服务。
   */
  async start() {
    const ctx = this.ctx
    const log = this.verbose ? (m) => console.log(m) : () => {}

    // 官方做法：暴露 dshHomePath 给配置表达式用
    const dshHome = resolveDshHome()
    ctx.provide('dshHomePath', (p) => path.join(dshHome, p))

    // 官方 boot 会设 ctx.baseUrl（配置树锚点，用于解析相对模块路径）。
    // 参照 app-boot/src/index.ts:995：pathToFileURL(配置目录) + '/'
    // typert-loader 等插件会检查它（报错：ctx.baseUrl is unset）。
    ctx.baseUrl = pathToFileURL(this.ctx.dataDir ?? process.cwd()).href + '/'

    // 官方 Loader（配置文件驱动的插件加载器）
    await ctx.plugin(Loader)

    // 核心服务：数据驱动注册（拓扑 + 容错），表见 services.mjs
    this.serviceReport = registerServices(ctx, { log })

    // ctx.webServer —— 必须用 ctx.plugin() 挂载（不是 new）：
    // 它的监听逻辑在 [Service.init] 生命周期钩子里，只有作为插件挂载才会被调用。
    // 插件用它暴露 OpenAI 端点（如 dsh-freeroute 的 /freeroute/v1）。
    try {
      await ctx.plugin(WebServer, { host: '127.0.0.1', port: this.webPort ?? 0, compression: 'none' })
    } catch (err) {
      this.serviceReport.failed.push({ name: 'webServer', error: String(err?.message ?? err).slice(0, 120) })
    }

    return this
  }

  /** webServer 的实际监听端口（0 = 系统分配） */
  get webServerPort() {
    return this.ctx.get('webServer')?.port ?? null
  }

  /** 服务注册摘要（控制 API / 调试用） */
  get services() {
    return this.serviceReport ?? { ok: [], failed: [], skipped: [] }
  }

  /**
   * 加载一个 DSH 插件（等价于往配置树里加一条 entry）。
   * @param {string} spec 模块名或路径
   * @param {object} config 插件配置（cordis.patch.yml 的 config 段）
   */
  async load(spec, config = {}) {
    const mod = await import(spec)
    // Cordis 插件形态：模块带 apply 导出
    const plugin = typeof mod.apply === 'function' ? mod : (mod.default ?? mod)
    const fiber = await this.ctx.plugin(plugin, config)
    this.loaded.push(spec)
    /** spec → fiber（供卸载用） */
    this.fibers ??= new Map()
    this.fibers.set(spec, fiber)
    return this
  }

  /**
   * 卸载一个插件（Cordis 语义：fiber.dispose()，
   * 插件注册的所有副作用按逆序撤销）。
   */
  async unload(spec) {
    const fiber = this.fibers?.get(spec)
    if (!fiber) return false
    await fiber.dispose()
    this.fibers.delete(spec)
    this.loaded = this.loaded.filter((s) => s !== spec)
    return true
  }

  /** 取服务 */
  get(name) {
    return this.ctx.get(name)
  }

  /**
   * 插件运行状态（fiber.state：2=活跃，0=挂起等依赖）。
   * cordis 的 inject 语义是「等待服务就绪」——缺依赖时插件挂起而非报错，
   * 所以「加载成功」≠「在工作」，要看这个。
   */
  pluginState(spec) {
    const fiber = this.fibers?.get(spec)
    if (!fiber) return null
    return { state: fiber.state, active: fiber.state === 2 }
  }

  async dispose() {
    await this.ctx.fiber.dispose()
    this.loaded = []
  }
}

export { SERVICE_TABLE }
