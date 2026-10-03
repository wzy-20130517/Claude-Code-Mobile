// /model · /url · /name · /key —— 统一快捷命令（handleCommand 拆分第十二批）
//
// 【为什么抽出来】
// 2026-09-19 用户要求「不在 web 搞另一套 slash 了，复用 cli」。
// 这四个命令原来在 index.mjs 的 handleCommand 里是一个共享 case（135 行），
// web/server.mjs 又各写了一遍（语法还有细微差异）。
// 抽成纯函数后两端共用，语法天然一致。
//
// 【语法（两端统一）】
//   /model [providerId] <模型名>    /url [providerId] <地址>
//   /name  [providerId] <显示名>    /key [providerId] <sk-...>
//   /key [providerId] set|setenv|pool|clear ...
// providerId 省略 = 当前 Provider。
//
// ⚠ /name 改的是显示名（name 字段），不是 Provider ID；改 ID 用 /config provider rename。
//
// 【依赖注入】交互部分（选模型 / 管理 key 池）通过 ctx 回调，
// CLI 传 runModelWizard / runKeyPoolWizard，Web 传 WizardRequired 抛错版。

import { normalizeProviderUrl, providerEndpointPreview } from './provider-url.mjs'
import { syncActiveProvider, recordConfigEvent } from './cmd-extensions.mjs'
import { renderModelList, runModelWizard } from './model-list.mjs'
import { renderPoolStatus, runKeyPoolWizard, keyPoolNonInteractiveHint } from './cmd-key-pool.mjs'

/**
 * @param {string} kind 'model' | 'url' | 'name' | 'key'
 * @param {string[]} args 命令参数（不含命令名本身）
 * @param {object} ctx
 * @param {object} ctx.config
 * @param {Function} ctx.saveConfig
 * @param {object} [ctx.api]
 * @param {Function} [ctx.runModelWizard]  无参时进模型列表/向导
 * @param {Function} [ctx.runKeyPoolWizard] /key 无值时进池管理向导
 * @param {Function} [ctx.renderModelList]
 * @param {Function} [ctx.renderPoolStatus]
 * @param {Function} [ctx.keyPoolDescribe]
 * @returns {Promise<string>|string}
 */
export async function runQuickProviderCommand(kind, args, ctx) {
  const { config, saveConfig } = ctx
  const api = ctx.api || null
  const C = ctx.C || new Proxy({}, { get: () => '' })
  // 这几个原来靠 handleCommand 的词法作用域（模块级 import），现在显式从 ctx 取 ——
  // 允许调用方覆盖（Web 端可以传自己的实现），缺省回退到本模块 import 的版本。
  const renderModelListFn = ctx.renderModelList || renderModelList
  const runModelWizardFn = ctx.runModelWizard || runModelWizard
  const renderPoolStatusFn = ctx.renderPoolStatus || renderPoolStatus
  const runKeyPoolWizardFn = ctx.runKeyPoolWizard || runKeyPoolWizard
  const keyPoolHint = ctx.keyPoolNonInteractiveHint || keyPoolNonInteractiveHint
  // 终端交互件：CLI 传真实 rl / fsSession，Web 传 null（向导走 WizardRequired）。
  const rl = ctx.rl ? ctx.rl() : null
  const fsSession = ctx.fsSession ? ctx.fsSession() : null
  // notify：把向导过程中的提示行推给用户（CLI 是写终端，Web 可以忽略或转 SSE）
  const emit = ctx.emit || (() => {})

  // 统一语法：/model [providerId] <值>  /url [providerId] <地址>  /name [providerId] <显示名>
  //          /key [providerId] <sk-...>  |  /key [providerId] set|setenv|pool|clear ...
  // providerId 可省略 = 当前 Provider。与 /config model|url 等价（快捷形式）。
  // 注：/name 改的是显示名（name 字段），不是 Provider ID；改 ID 用 /config provider rename。
  const providers = config.providers || {}
  let provId = config.current
  let rest = args.slice()
  // 第一个参数若是已存在的 providerId，则消费它
  if (rest.length && rest[0] !== 'set' && rest[0] !== 'pool' && rest[0] !== 'setenv' && rest[0] !== 'clear' && providers[rest[0]]) {
    provId = rest.shift()
  }
  const prov = providers[provId]
  if (!prov) return `Provider ${provId} 不存在`
  const isCurrent = provId === config.current

  // ---- /key 的子命令形态 ----
  if (kind === 'key' && rest.length && ['set', 'pool', 'setenv', 'clear'].includes(rest[0])) {
    const act = rest[0]
    if (act === 'clear') {
      delete prov.apiKey
      delete prov.apiKeys
      saveConfig(config)
      if (isCurrent) syncActiveProvider(config, api, prov)
      return `Provider ${provId} key 已清空`
    }
    if ((act === 'set' || act === 'setenv') && !rest[1]) return `用法: /key ${provId === config.current ? '' : provId + ' '}${act} <${act === 'set' ? '密钥' : 'ENV名'}>`
    if (act === 'setenv') {
      const envName = rest[1]
      prov.apiKey = '${' + envName + '}'
      if (Array.isArray(prov.apiKeys)) prov.apiKeys[0] = prov.apiKey
      saveConfig(config)
      if (isCurrent) syncActiveProvider(config, api, prov)
      return `Provider ${provId} apiKey 已改为引用 \${${envName}}（请确保 .env 里有 ${envName}=真实key）`
    }
    if (act === 'set') {
      const k = rest[1]
      prov.apiKey = k
      if (Array.isArray(prov.apiKeys)) prov.apiKeys[0] = k
      else if (prov.apiKeys === undefined && Array.isArray(prov.apiKeys)) {}
      saveConfig(config)
      if (isCurrent) syncActiveProvider(config, api, prov)
      return `Provider ${provId} apiKey 已设置: ${k.slice(0, 8)}...${k.slice(-4)}`
    }
    if (act === 'pool') {
      // 不带 key 时进管理向导。原来这里是「整池替换」单一动作：先摆一个空
      // 输入框让用户从零贴一遍，看不到现有几个、谁在冷却。真实场景多半是
      // 「十个 key 里死了一个」，整池重贴等于为救一个换掉九个好的。
      // 现在先显示现状再选动作：加一批 / 按序号删 / 清冷却 / 整池换 / 清空。
      if (!rest[1]) {
        try {
          return await runKeyPoolWizardFn({
            provId, prov, isCurrent, config, api, saveConfig, syncActiveProvider,
            rl, fsSession, C,
          })
        } catch (e) {
          // 非交互（Agent 的 CommandExec）不能挂着等回车，给带参写法
          if (e?.nonInteractive) return keyPoolHint(provId, isCurrent)
          throw e
        }
      }
      prov.apiKeys = rest.slice(1)
      prov.apiKey = prov.apiKeys[0]
      saveConfig(config)
      if (isCurrent) syncActiveProvider(config, api, prov)
      return `Provider ${provId} key 池已设: ${prov.apiKeys.length} 个（轮换使用）`
    }
  }

  // ---- /model list：纯文本列出可选模型（非交互也能用，Agent 走这条） ----
  if (kind === 'model' && rest.length === 1 && rest[0].toLowerCase() === 'list') {
    return await renderModelListFn({ provId, prov, isCurrent, C })
  }

  // ---- /model 无参 = 进选择向导（拉 {url}/models → ↑↓ 选 → Enter 切换） ----
  // 为什么它进向导而 /key 无参不进：模型名是"从站点给定的一批里挑一个"，
  // 手打就得先知道有哪些，而站点的模型名往往长且带日期后缀（deepseek-ai/
  // deepseek-v4-pro-0813）——触屏上照抄极易打错。key 无参是纯查询，见 cmd-key-pool.mjs。
  // 拉列表失败/非交互时返回 { message }，退化成原来的「看一眼 + 用法」。
  if (kind === 'model' && !rest.length) {
    const picked = await runModelWizardFn({
      provId, prov, isCurrent, rl, fsSession, C,
      notify: (line) => { try { emit(line + '\n') } catch {} },
    })
    if (picked.message) return picked.message
    // 选中后不自己存：塞回 rest 走下面「直接赋值形态」那条既有路径，
    // 保证落盘/同步/文案只有一份实现（见 model-list.mjs 的注释）
    rest = [picked.model]
  }

  // ---- 无值：查看当前状态 ----
  if (!rest.length) {
    if (kind === 'url') return `Provider ${provId} URL: ${prov.url}\n用法: /url ${provId === config.current ? '' : provId + ' '}<https://中转站/v1>`
    if (kind === 'name') return `Provider ${provId} 显示名: ${prov.name || '(未设置)'}\n用法: /name ${provId === config.current ? '' : provId + ' '}<显示名>\n说明: 只改显示名；改 Provider 编号用 /config provider rename <旧ID> <新ID>`
    // /key 无参 = 看现状。原来只打「key: sk-xx...  key 池: 5 个」，
    // 而用户敲 /key 的时机几乎都是「请求报错了，想知道是哪个 key 的问题」——
    // 恰恰是运行时状态（谁在用、谁在冷却、各自 ok/fail）。这些 KeyPool 一直
    // 在记，之前唯一出口是 /config list，跟用户的动线错开了。
    let keyDesc = null
    if (isCurrent && typeof api?.describeKeys === 'function') {
      try { keyDesc = api.describeKeys() } catch {}
    }
    return renderPoolStatusFn({ provId, prov, describe: keyDesc, isCurrent, C })
  }

  // ---- 直接赋值形态 ----
  const value = rest.join(' ').trim()
  const old = kind === 'model' ? prov.model : kind === 'url' ? prov.url : kind === 'name' ? prov.name : prov.apiKey
  if (kind === 'model') {
    prov.model = value
    if (config.model !== undefined && isCurrent) config.model = value
  } else if (kind === 'url') {
    // 用户可贴根地址、/v1、/v1/chat、完整 /chat/completions；统一存 canonical base。
    // 防止 ApiClient 后续再拼 endpoint 时得到 /v1/chat/chat/completions 一类错路径。
    prov.url = normalizeProviderUrl(value, prov.protocol || 'openai')
  } else if (kind === 'name') {
    prov.name = value
  } else {
    // /key <sk-...> = set 单 key；若已有池则替换池首
    prov.apiKey = value
    if (Array.isArray(prov.apiKeys)) prov.apiKeys[0] = value
  }
  saveConfig(config)
  if (isCurrent) syncActiveProvider(config, api, prov)
  const label = kind === 'model' ? '模型' : kind === 'url' ? 'URL' : kind === 'name' ? '显示名' : 'API Key'
  const show = (v) => kind === 'key' ? `${(v || '').slice(0, 6)}...${(v || '').slice(-4)}` : (v || '(未设置)')
  const shownValue = kind === 'url' ? prov.url : value
  const endpointHint = kind === 'url' ? `\n实际请求端点: ${providerEndpointPreview(prov.url, prov.protocol || 'openai')}` : ''
  recordConfigEvent(`/${kind} ${provId === config.current ? '' : provId + ' '}${value} → Provider ${provId} ${label}已更新: ${show(old)} → ${show(shownValue)}`)
  return `Provider ${provId} ${label}已切换: ${show(old)} → ${show(shownValue)}` + endpointHint +
    (isCurrent ? '' : '\n切换到该 Provider 时生效')
}
