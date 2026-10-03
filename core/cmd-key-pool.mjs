// /key 池的现状展示 + 交互式管理
//
// 【为什么单独做这个】
// 原来配多 key 只有一条路：`/key <id> pool k1 k2 k3` —— 要求把所有 key 一次打完。
// 用户的真实处境是：白嫖来的免费站点给一批 key（十几个也常见），存在某个 txt 里，
// 手机上从别的 App 复制过来。逐个手打 sk- 长串在触屏上不现实，而一行贴一串
// 又完全看不到"贴对了没、贴了几个"。
//
// 更要命的是**看不到现状**：哪个 key 在用、哪个 403 了正在冷却、哪个从来没成功过。
// 这些运行时信息 KeyPool 一直在记（describe()），但唯一的出口是 /config list，
// 而用户在处理 key 问题时敲的是 /key。于是典型场景变成："请求一直报错，
// 我不知道是哪个 key 死了，只能整池重贴一遍" —— 换掉九个好的去救一个坏的。
//
// 【为什么 /key 无参不进向导】
// 无参是「看一眼」，是纯查询，非破坏性，而且 Agent 会用 CommandExec 调它。
// 无参直接弹向导会让只想看状态的用户被卡在交互里（手机上还得找 Esc），
// 也会让非交互调用直接失败。所以：/key 看，/key pool 管。
//
// 【数据结构约定，别改】
// apiKeys（数组）= 轮换池，apiKey（字符串）= 当前在用的那个 / 单 key。
// 长度 1 的池是个既不是单 key 也不是池的中间态，会让 /config list 的显示和
// api.setKeys 的 fallback 逻辑都变别扭 —— 所以降到 1 个时主动删掉 apiKeys。

import { runWizard, NonInteractiveError } from './wizard.mjs'
import { runSelect } from './select.mjs'
import { maskKey } from './key-pool.mjs'

/** 冷却原因往往是整段 HTTP body，窄屏上必须截 */
function shortReason(r) {
  const s = String(r || '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  return s.length > 26 ? s.slice(0, 25) + '…' : s
}

/**
 * key 池现状。窄屏（40-60 列）设计：一个 key 一行，附加信息缩进另起一行，
 * 且只在有内容时才出现 —— 全 0 的 ok/fail 是噪音，冷却才是用户要找的东西。
 *
 * @param {object} o
 * @param {string} o.provId
 * @param {object} o.prov      config.providers[provId]
 * @param {Array}  [o.describe] api.describeKeys() 的结果，只有当前 Provider 才有
 * @param {boolean} o.isCurrent
 */
export function renderPoolStatus({ provId, prov, describe = null, isCurrent = false, C = {} }) {
  const dim = C.dim || '', reset = C.reset || '', green = C.green || '', yellow = C.yellow || ''
  const keys = Array.isArray(prov.apiKeys) ? prov.apiKeys.filter(k => String(k || '').trim()) : []
  const single = String(prov.apiKey || '').trim()
  const out = []

  if (!keys.length && !single) {
    out.push(`Provider ${provId} 还没有 key`)
    out.push('')
    out.push(`  /key ${isCurrent ? '' : provId + ' '}<sk-...>   设一个`)
    out.push(`  /key ${isCurrent ? '' : provId + ' '}pool       进向导贴一批`)
    return out.join('\n')
  }

  // 单 key：没必要摆出池子的架势
  if (!keys.length) {
    out.push(`Provider ${provId} key: ${maskKey(single)}${single.includes('${') ? dim + ' (环境变量引用)' + reset : ''}`)
    const st = isCurrent && Array.isArray(describe) ? describe[0] : null
    if (st && (st.ok || st.fail)) out.push(`  ${dim}ok ${st.ok} fail ${st.fail}${reset}`)
    if (st?.cooling) out.push(`  ${yellow}冷却中 ${st.cooldownMinutes}m${reset}${st.reason ? dim + ' · ' + shortReason(st.reason) + reset : ''}`)
    out.push('')
    out.push(`  /key ${isCurrent ? '' : provId + ' '}pool       改成多 key 轮换池`)
    out.push(`  /key ${isCurrent ? '' : provId + ' '}<sk-...>   换成另一个`)
    return out.join('\n')
  }

  // 运行时状态按下标对齐 config 里的顺序。api.setKeys 就是按这个数组建池的，
  // 但用户可能在别处改过 config 而没切 Provider，所以长度不一致时退化成不显示统计
  const rt = (isCurrent && Array.isArray(describe) && describe.length === keys.length) ? describe : null
  const cooling = rt ? rt.filter(d => d.cooling).length : 0

  out.push(`Provider ${provId} · key 池 ${keys.length} 个${rt ? '' : dim + '（非当前 Provider，无运行时统计）' + reset}`)
  keys.forEach((k, i) => {
    const st = rt ? rt[i] : null
    const inUse = st ? st.active : (k === single)
    out.push(`  ${String(i + 1).padStart(2)} ${maskKey(k)}${inUse ? green + ' ← 在用' + reset : ''}`)
    if (st?.cooling) {
      out.push(`     ${yellow}冷却中 ${st.cooldownMinutes}m${reset}${st.reason ? dim + ' · ' + shortReason(st.reason) + reset : ''}`)
    } else if (st && (st.ok || st.fail)) {
      out.push(`     ${dim}ok ${st.ok} fail ${st.fail}${reset}`)
    }
  })
  out.push('')
  if (cooling) {
    // 冷却是"上次失败时记的账"，免费额度多半按天重置。不提示可清，用户会以为 key 废了
    out.push(`  ${yellow}${cooling} 个在冷却${reset}${dim}（免费额度多按天重置，可清）${reset}`)
  }
  out.push(`  /key ${isCurrent ? '' : provId + ' '}pool       管理（加/删/清冷却）`)
  return out.join('\n')
}

/**
 * 把一批 key 规范化成 config 里该存的形状。抽成纯函数是为了能单测——
 * 这段规则（长度 1 降级、保留在用的 key）藏在向导闭包里就没法验证，
 * 而它错了会静默产生「长度 1 的池」或「无谓地换掉正在用的 key」。
 *
 * @param {string[]} list 目标 key 列表（可含空/重复）
 * @param {string} activeKey 当前在用的 key
 * @returns {{keys:string[], apiKey:string, apiKeys:string[]|null}}
 */
export function normalizePool(list, activeKey = '') {
  const clean = []
  for (const raw of (Array.isArray(list) ? list : [list])) {
    const s = String(raw || '').trim()
    if (s && !clean.includes(s)) clean.push(s)
  }
  if (!clean.length) return { keys: [], apiKey: '', apiKeys: null }
  if (clean.length === 1) return { keys: clean, apiKey: clean[0], apiKeys: null }
  // 在用的那个还在池里就不动它：换 key 会丢掉它已建立的额度/预热状态，
  // 而用户只是「加了个新 key」，没要求换当前请求走哪一个
  const apiKey = clean.includes(activeKey) ? activeKey : clean[0]
  return { keys: clean, apiKey, apiKeys: clean }
}

/**
 * /key [id] pool 无参 → 管理向导。
 * 先摆出现状，再让用户选动作 —— 而不是一上来就问"你要贴哪些 key"。
 *
 * @returns {Promise<string>} 给用户看的结果文本
 */
export async function runKeyPoolWizard(ctx) {
  const {
    provId, prov, isCurrent, config, api, saveConfig, syncActiveProvider,
    rl, fsSession, C = {},
  } = ctx
  const dim = C.dim || '', reset = C.reset || '', green = C.green || ''

  let describe = null
  if (isCurrent && typeof api?.describeKeys === 'function') {
    try { describe = api.describeKeys() } catch {}
  }
  const keys = Array.isArray(prov.apiKeys) ? prov.apiKeys.filter(k => String(k || '').trim()) : []
  const single = String(prov.apiKey || '').trim()
  // 单 key 也纳入管理：用户想"再加一个"时不该被要求先手工造出池子
  const current = keys.length ? keys.slice() : (single ? [single] : [])
  const rt = (describe && describe.length === current.length) ? describe : null
  const coolingCount = rt ? rt.filter(d => d.cooling).length : 0

  // 落盘 + 生效。单点收口，避免每个分支各写一遍漏掉 sync
  const commit = (list) => {
    const n = normalizePool(list, prov.apiKey)
    if (!n.keys.length) { delete prov.apiKey; delete prov.apiKeys }
    else {
      prov.apiKey = n.apiKey
      if (n.apiKeys) prov.apiKeys = n.apiKeys
      else delete prov.apiKeys
    }
    saveConfig(config)
    if (isCurrent && typeof syncActiveProvider === 'function') syncActiveProvider(config, api, prov)
    return n.keys
  }

  const items = [
    { value: 'add', label: '加 key', hint: '可一次贴多个' },
  ]
  if (current.length) {
    items.push({ value: 'del', label: '删掉某个 key', hint: '按序号选，不用打全串' })
    items.push({ value: 'replace', label: '整池替换', hint: '清掉现有的重新贴' })
    if (coolingCount) items.push({ value: 'cool', label: `清除冷却标记`, hint: `${coolingCount} 个在冷却` })
    items.push({ value: 'clear', label: '清空（一个不留）', hint: '之后这个 Provider 不可用' })
  } else {
    items.push({ value: 'replace', label: '整池替换', hint: '清掉现有的重新贴' })
  }

  const header = renderPoolStatus({ provId, prov, describe, isCurrent, C })
    .split('\n').slice(0, -1).join('\n')   // 去掉末行的「/key pool 管理」自指提示

  const act = await runSelect({
    rl, fsSession,
    title: current.length ? `key 池管理 · Provider ${provId}（${current.length} 个）` : `key 池 · Provider ${provId}（空）`,
    items,
    footer: '↑↓ 选择 · Enter 确认 · Esc 取消',
  })
  if (!act) return '已取消\n\n' + header

  if (act === 'cool') {
    if (!api?.keyPool?.resetCooldown) return '当前 Provider 没有运行中的 key 池，无冷却可清'
    api.keyPool.resetCooldown()
    let after = null
    try { after = api.describeKeys() } catch {}
    return `${green}✓${reset} 已清除 ${coolingCount} 个 key 的冷却标记\n\n`
      + renderPoolStatus({ provId, prov, describe: after, isCurrent, C })
  }

  if (act === 'clear') {
    commit([])
    return `${green}✓${reset} Provider ${provId} 的 key 已清空\n${dim}  重新配: /key ${isCurrent ? '' : provId + ' '}<sk-...>${reset}`
  }

  if (act === 'del') {
    const picked = await runSelect({
      rl, fsSession,
      title: `删哪个？（Provider ${provId}）`,
      items: current.map((k, i) => {
        const st = rt ? rt[i] : null
        let hint = ''
        if (st?.cooling) hint = `冷却 ${st.cooldownMinutes}m`
        else if (st && (st.ok || st.fail)) hint = `ok ${st.ok} fail ${st.fail}`
        if (st?.active) hint = hint ? `在用 · ${hint}` : '在用'
        return { value: String(i), label: `${i + 1} ${maskKey(k)}`, hint }
      }),
      footer: '↑↓ 选择 · Enter 删除 · Esc 取消',
    })
    if (picked === null) return '已取消'
    const idx = Number(picked)
    const removed = current[idx]
    const left = current.filter((_, i) => i !== idx)
    const clean = commit(left)
    return `${green}✓${reset} 已删掉 ${maskKey(removed)}\n`
      + (clean.length
        ? `  剩 ${clean.length} 个${clean.length === 1 ? dim + '（已降为单 key）' + reset : ''}`
        : `  ${dim}池已空，这个 Provider 现在不可用${reset}`)
  }

  // add / replace 都是收一批 key，差别只在于要不要保留现有的
  const isAdd = act === 'add'
  const a = await runWizard({
    rl, fsSession, C,
    title: isAdd
      ? `加 key · Provider ${provId}（现有 ${current.length} 个）`
      : `整池替换 · Provider ${provId}`,
    steps: [
      {
        key: 'keys', label: 'API Key', multi: true, secret: true, required: true,
        hint: 'sk-...',
        desc: '从别处复制的一整批可以直接贴，空格或换行分隔都认',
        // 已在池里的直接拦掉，不然用户贴一批混着旧的，得自己去数哪些重复
        validate: (v) => {
          if (v.length < 8 && !v.includes('${')) return 'key 太短了，是不是贴漏了'
          if (isAdd && current.includes(v)) return `${maskKey(v)} 已在池里`
          return null
        },
      },
    ],
  })
  if (!a) return '已取消'

  const incoming = Array.isArray(a.keys) ? a.keys : [a.keys]
  const merged = isAdd ? current.concat(incoming.filter(k => !current.includes(k))) : incoming
  const clean = commit(merged)
  const added = isAdd ? clean.length - current.length : clean.length
  let after = null
  if (isCurrent && typeof api?.describeKeys === 'function') {
    try { after = api.describeKeys() } catch {}
  }
  return `${green}✓${reset} ${isAdd ? `新增 ${added} 个` : `整池替换为 ${clean.length} 个`}\n\n`
    + renderPoolStatus({ provId, prov, describe: after, isCurrent, C })
}

/** 非交互环境下的带参写法提示（三处分支复用，别各写一份免得漂移） */
export function keyPoolNonInteractiveHint(provId, isCurrent) {
  const p = isCurrent ? '' : provId + ' '
  return [
    '非交互环境无法运行 key 池向导。',
    '带参写法：',
    `  /key ${p}pool <k1> <k2> ...   设整池`,
    `  /key ${p}<sk-...>             设单 key`,
    `  /key ${p}clear                清空`,
    `  /key ${p}                     只看现状（这个能用）`,
  ].join('\n')
}

export { NonInteractiveError }
