// 拉取 Provider 的可用模型列表，给 /model 无参时的选择向导用。
//
// 【为什么单独一个文件】
// index.mjs 的 case 'model' 分支和 /url /name /key 共用一个 case，本身已经很挤，
// 而"拉列表"要处理的东西不少：端点拼接（openai 和 anthropic 的 /v1 位置不一样）、
// 三种响应外形（data[] / models[] / 裸数组）、以及手机上真实会遇到的一堆失败。
// 塞进 index.mjs 会让那个 case 变成两百行，也更容易和别人改同一段时撞车。
//
// 【失败分类为什么要这么细】
// 这功能是给"手机上网络不稳"的场景用的，失败是常态不是异常。用户看到
// "获取模型列表失败" 什么都做不了；看到 "401 key 可能失效" 就知道去 /key 看，
// 看到 "该站没有 /models 端点" 就知道只能手打。所以每种失败都要能指向下一步动作。
//
// 【实测数据（2026-08-31）】
//   sotamodel.net/v1   → 200，data 7 个，字段有 id / owned_by / created
//   www.sharellm.cn/v1 → 401 Invalid token（4 个 key 全挂，正好用来测 auth 分支）
//   ai.furry.vg/v1     → 502（网关抽风，测 http 分支）
// 三种都是真实发生的，别假设"能连上就一定有 data"。

import { runSelect } from './select.mjs'
import { isNonInteractive, isDelegatedInteraction } from './wizard.mjs'
import { resolveProviderKeys } from './env-secrets.mjs'

/** 默认超时。手机上 10s 以内经常还没握完手，15s 是等待上限（再久用户会以为卡死） */
export const MODEL_LIST_TIMEOUT_MS = 12000

/**
 * 拼模型列表端点。
 * openai 协议的 baseUrl 习惯上自带 /v1（如 https://x/v1）→ 直接接 /models；
 * anthropic 协议的 baseUrl 不带（api.mjs 是 `${baseUrl}/v1/messages`）→ 要补 /v1。
 */
export function modelsEndpoint(baseUrl, protocol = 'openai') {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) return ''
  if (/\/models$/.test(base)) return base
  return protocol === 'anthropic' ? `${base}/v1/models` : `${base}/models`
}

/** 上下文长度可能叫好几个名字，取到就格式化成 128k 这种短形式 */
function pickContext(m) {
  const n = Number(
    m?.context_length ?? m?.context_window ?? m?.max_context_length ??
    m?.max_input_tokens ?? m?.meta?.context_length
  )
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n >= 1000000) return `${(n / 1000000).toFixed(n % 1000000 ? 1 : 0)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/**
 * GET {baseUrl}/models，解析出模型列表。
 *
 * @returns {Promise<{ok:true, models:Array, endpoint:string} | {ok:false, code:string, message:string, endpoint:string, status?:number}>}
 *   code: no_url | no_key | timeout | network | auth | not_found | http | bad_json | empty
 */
export async function fetchModels({
  url, apiKey, protocol = 'openai', timeoutMs = MODEL_LIST_TIMEOUT_MS, fetchImpl,
} = {}) {
  const endpoint = modelsEndpoint(url, protocol)
  if (!endpoint) return { ok: false, code: 'no_url', message: '这个 Provider 还没配 URL', endpoint: '' }
  const key = String(apiKey || '').trim()
  // key 为空也照发：有些自建反代（如本地 FreeDeepseekAPI）压根不校验，
  // 直接拒掉会让这类站点用不上向导。真需要 key 的站会回 401，走 auth 分支。
  if (key.includes('${')) {
    return { ok: false, code: 'no_key', message: 'key 是未解析的 ${ENV} 占位符，请确认 .env 里有对应变量', endpoint }
  }

  const doFetch = fetchImpl || fetch
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs))
  let res, text
  try {
    const headers = { Accept: 'application/json' }
    if (key) {
      if (protocol === 'anthropic') {
        headers['x-api-key'] = key
        headers['anthropic-version'] = '2023-06-01'
      } else {
        headers.Authorization = 'Bearer ' + key
      }
    }
    res = await doFetch(endpoint, { method: 'GET', headers, signal: ctrl.signal })
    text = await res.text()
  } catch (e) {
    const aborted = e?.name === 'AbortError' || /abort/i.test(String(e?.message || ''))
    if (aborted) {
      return { ok: false, code: 'timeout', message: `请求超时（${Math.round(timeoutMs / 1000)}s）`, endpoint }
    }
    return { ok: false, code: 'network', message: `连不上: ${String(e?.message || e).slice(0, 120)}`, endpoint }
  } finally {
    clearTimeout(timer)
  }

  const status = res.status
  if (status === 401 || status === 403) {
    return { ok: false, code: 'auth', status, endpoint, message: `HTTP ${status} ${briefBody(text)}` }
  }
  if (status === 404 || status === 405) {
    return { ok: false, code: 'not_found', status, endpoint, message: `HTTP ${status}（该站没有这个端点）` }
  }
  if (!res.ok) {
    return { ok: false, code: 'http', status, endpoint, message: `HTTP ${status} ${briefBody(text)}` }
  }

  let json
  try { json = JSON.parse(text) } catch {
    return { ok: false, code: 'bad_json', status, endpoint, message: `返回的不是 JSON: ${briefBody(text)}` }
  }
  // 有的站 HTTP 200 但 body 里塞 error（sharellm 就这样）
  if (json && json.error) {
    const msg = String(json.error.message || json.error).slice(0, 120)
    const authish = /invalid|unauthor|token|key|expired|forbidden/i.test(msg)
    return { ok: false, code: authish ? 'auth' : 'http', status, endpoint, message: msg }
  }

  const raw = Array.isArray(json) ? json
    : Array.isArray(json?.data) ? json.data
    : Array.isArray(json?.models) ? json.models
    : null
  if (!raw) {
    return { ok: false, code: 'bad_json', status, endpoint, message: '响应里找不到模型数组（既没有 data 也没有 models）' }
  }

  const models = raw.map((m) => {
    const id = typeof m === 'string' ? m : String(m?.id || m?.name || m?.model || '').trim()
    if (!id) return null
    return { id, ownedBy: typeof m === 'string' ? '' : String(m?.owned_by || m?.owner || '').trim(), context: typeof m === 'string' ? '' : pickContext(m) }
  }).filter(Boolean)

  if (!models.length) {
    return { ok: false, code: 'empty', status, endpoint, message: '该站开放了 /models 但返回空列表' }
  }
  return { ok: true, models, endpoint }
}

/** 报错正文可能是整页 HTML，截短并压掉换行，免得糊满窄屏 */
function briefBody(text) {
  const s = String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  return s.length > 110 ? s.slice(0, 109) + '…' : s
}

/**
 * 排序：当前在用的模型永远排第一（选择器的 initial 指向它，用户按 Enter 就是"不改"，
 * 是最安全的默认动作）；其余按 id 自然序，数字段按数值比（免得 gpt-5 排在 gpt-40 后面）。
 */
export function sortModels(models, currentModel = '') {
  const cur = String(currentModel || '').trim()
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
  return models.slice().sort((a, b) => {
    if (a.id === cur) return -1
    if (b.id === cur) return 1
    return collator.compare(a.id, b.id)
  })
}

/** 组装成 runSelect 要的 items，并算出光标该停在哪 */
export function buildModelItems(models, currentModel = '') {
  const cur = String(currentModel || '').trim()
  const sorted = sortModels(models, cur)
  const items = sorted.map((m) => {
    const bits = []
    if (m.id === cur) bits.push('当前在用')
    if (m.context) bits.push(m.context)
    if (m.ownedBy) bits.push(m.ownedBy)
    return { value: m.id, label: m.id, hint: bits.length ? '· ' + bits.join(' · ') : '' }
  })
  let initial = items.findIndex(it => it.value === cur)
  if (initial < 0) initial = 0
  return { items, initial, sorted }
}

/**
 * 失败时给用户的话。每条都必须落到"下一步能做什么"，
 * 否则用户只能干瞪眼 —— 这功能的失败率本来就高（手机网络 + 白嫖站点）。
 */
export function describeFailure(fail, { provId, isCurrent, model }) {
  const manual = `  /model ${isCurrent ? '' : provId + ' '}<模型名>   直接手打指定`
  const head = {
    no_url: `Provider ${provId} 没有 URL，无法拉列表`,
    no_key: `Provider ${provId} 的 key 没解析出来`,
    timeout: `拉取模型列表超时`,
    network: `连不上 Provider ${provId}`,
    auth: `Provider ${provId} 鉴权失败，key 可能已失效`,
    not_found: `Provider ${provId} 没有开放 /models 端点`,
    http: `Provider ${provId} 返回错误`,
    bad_json: `Provider ${provId} 的 /models 响应看不懂`,
    empty: `Provider ${provId} 未开放模型列表`,
  }[fail.code] || `拉取模型列表失败`

  const out = [head]
  if (fail.message) out.push(`  ${fail.message}`)
  if (fail.endpoint) out.push(`  端点: ${fail.endpoint}`)
  out.push('')
  if (fail.code === 'auth') {
    out.push(`  /key ${isCurrent ? '' : provId + ' '}          看 key 现状（谁在冷却）`)
    out.push(`  /key ${isCurrent ? '' : provId + ' '}pool      进向导换一批 key`)
  } else if (fail.code === 'not_found' || fail.code === 'empty' || fail.code === 'bad_json') {
    out.push('  这个站不支持列模型，只能手打:')
  } else if (fail.code === 'timeout' || fail.code === 'network') {
    out.push('  网络问题，可以重试 /model 或直接手打:')
  } else if (fail.code === 'no_url') {
    out.push(`  /url ${isCurrent ? '' : provId + ' '}<https://站点/v1>`)
  }
  out.push(manual)
  out.push(`  当前模型: ${model || '(未设置)'}`)
  return out.join('\n')
}

/**
 * /model 无参 → 拉列表 + 选择。
 *
 * 【为什么不在这里落盘】
 * 返回 `{ model }` 让调用方把它当成"用户手打的那个值"继续走 `/model <名称>` 的既有
 * 赋值路径（prov.model= / config.model= / saveConfig / syncActiveProvider / 结果文案）。
 * 如果这里自己存一遍，就会出现两套保存逻辑 —— 将来改 sync 规则必然漏掉一边。
 *
 * @returns {Promise<{model:string} | {message:string}>}
 *   model  → 用户选定，调用方去落盘
 *   message → 已经有结论（取消/失败/非交互/没变），直接回显
 */
export async function runModelWizard({
  provId, prov, isCurrent, rl, fsSession, C = {}, notify = null, timeoutMs,
}) {
  const dim = C.dim || '', reset = C.reset || ''
  // 【2026-09-20 改】非交互要分两种，别一刀切短路：
  //   · 真·非交互（Agent CommandExec / QQ 桥）→ 返回文本提示，因为它等不到人按键
  //   · Web 委托交互（浏览器弹窗）→ **照常走下面的拉列表 + runSelect**，
  //     ctx.runSelect 会把列表序列化给前端，用户点完回填
  //
  // 原来只有 `if (isNonInteractive()) return {message}` 一条路，Web 被误判成
  // 「用不了交互」，于是 `/model` 无参只吐一段说明、弹不出模型列表。
  // 用户原话：「打/model应该弹模型列表给我选，其他命令你也注意」。
  if (isNonInteractive() && !isDelegatedInteraction()) {
    return { message: [
      `Provider ${provId} 模型: ${prov.model || '(未设置)'}`,
      '',
      `${dim}  /model 无参会弹交互式选择列表，非交互环境用不了。${reset}`,
      `  /model ${isCurrent ? '' : provId + ' '}<模型名>    直接指定`,
      `  /model ${isCurrent ? '' : provId + ' '}list        列出可选模型（纯文本，可用）`,
    ].join('\n') }
  }

  const { apiKey } = resolveProviderKeys(prov)
  if (typeof notify === 'function') {
    try { notify(`${dim}正在拉取 Provider ${provId} 的模型列表…${reset}`) } catch {}
  }
  const r = await fetchModels({
    url: prov.url, apiKey, protocol: prov.protocol || 'openai', timeoutMs,
  })
  if (!r.ok) return { message: describeFailure(r, { provId, isCurrent, model: prov.model }) }

  const { items, initial } = buildModelItems(r.models, prov.model)
  const picked = await runSelect({
    rl, fsSession,
    title: `选择模型 · Provider ${provId}${prov.name ? ' (' + prov.name + ')' : ''}`,
    items, initial,
    footer: '↑↓ 移动 · 数字键直选 · Enter 确认 · Ctrl+C 取消',
    // 【Web 用】选中后要干什么。终端里 runSelect 直接返回字符串、调用方接着跑；
    // 但 Web 是跨请求的（这次请求抛出列表 → 用户在前端点 → 前端再发一次请求），
    // 中间没有保留调用栈。所以把「选完执行 /model <id> <值>」这个意图带上，
    // 由 server 端在回填时重新执行。
    action: 'rerun',
    meta: { command: 'model', provId, isCurrent },
  })
  if (!picked) return { message: `已取消（模型仍是 ${prov.model || '未设置'}）` }
  if (picked === prov.model) return { message: `${dim}模型没变，仍是 ${picked}${reset}` }
  return { model: picked }
}

/**
 * /model list → 纯文本列出，给非交互场景（Agent CommandExec）和"我只想看看有啥"用。
 */
export async function renderModelList({ provId, prov, isCurrent, C = {}, timeoutMs }) {
  const dim = C.dim || '', green = C.green || '', reset = C.reset || ''
  const { apiKey } = resolveProviderKeys(prov)
  const r = await fetchModels({
    url: prov.url, apiKey, protocol: prov.protocol || 'openai', timeoutMs,
  })
  if (!r.ok) return describeFailure(r, { provId, isCurrent, model: prov.model })
  const { sorted } = buildModelItems(r.models, prov.model)
  const lines = [`Provider ${provId} 可用模型 ${sorted.length} 个`]
  sorted.forEach((m, i) => {
    const cur = m.id === prov.model ? `${green} ← 当前${reset}` : ''
    const meta = [m.context, m.ownedBy].filter(Boolean).join(' · ')
    lines.push(`  ${String(i + 1).padStart(2)} ${m.id}${cur}${meta ? `${dim}  ${meta}${reset}` : ''}`)
  })
  lines.push('')
  lines.push(`${dim}  切换: /model ${isCurrent ? '' : provId + ' '}<模型名>${reset}`)
  return lines.join('\n')
}
