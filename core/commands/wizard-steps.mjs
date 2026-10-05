// 向导定义（steps + 落盘逻辑）—— CLI 与 Web 共用
//
// 【为什么抽出来】
// 2026-09-19 用户要求「有向导的也复用，在 web 也建向导」。
//
// 向导在本项目里分成两半：
//   · 交互层：core/wizard.mjs 的 runWizard —— 画 ANSI 边框、读 readline。**终端专属**
//   · 内容层：steps 数组 + 拿到 answers 后怎么落盘。**跨端通用**
//
// 原来这两半混在一起（写在 index.mjs 的 handleCommand 里），Web 想复用就只能重抄一遍。
// 现在把内容层抽到这里：
//   · CLI：runWizard({ steps: providerAddSteps(ctx) }) → 拿到 answers → applyProviderAdd()
//   · Web：HTTP 把 steps 发给前端渲染表单 → 提交回 answers → applyProviderAdd()
//
// **落盘逻辑只有一份**，所以「CLI 加 Provider」和「Web 加 Provider」写出来的
// 配置结构必然一致（包括 apiKeys 池、protocol 落盘规则、URL 规范化）。

import { normalizeProviderUrl } from '../api/provider-url.mjs'

/**
 * 「添加 Provider」的步骤定义。
 *
 * @param {object} ctx
 * @param {object} ctx.config 当前配置（用于算下一个可用 ID、校验重名）
 * @returns {Array} steps
 */
export function providerAddSteps(ctx) {
  const existing = Object.keys(ctx.config?.providers || {})
  const nextId = String(Math.max(0, ...existing.map(n => parseInt(n, 10) || 0)) + 1)
  return [
    {
      key: 'id',
      label: '编号 (ID)',
      default: nextId,
      hint: nextId,
      desc: `留空用 ${nextId}`,
      validate: v => (existing.includes(v) ? `编号 ${v} 已存在` : null),
    },
    { key: 'name', label: '显示名称', required: true, hint: 'my-provider' },
    {
      key: 'url',
      label: 'API 地址 (URL)',
      required: true,
      hint: 'https://api.example.com/v1',
      validate: v => (/^https?:\/\//.test(v) ? null : '必须以 http:// 或 https:// 开头'),
    },
    // multi：一次能收多个 key。白嫖来的免费站点几乎都是「一批 key 轮换」，
    // 原来只能填一个，配池子得先 add 再 /key <id> pool k1 k2 —— 两步，
    // 而第二步要在一行里手打好几个 sk- 长串，手机上等于放弃。
    {
      key: 'apiKeys',
      label: 'API Key',
      multi: true,
      secret: true,
      hint: 'sk-...',
      desc: '可一次贴多个（空格/换行分隔）轮换用；留空则之后用 /key 设置',
    },
    { key: 'model', label: '模型名称', required: true, hint: 'gpt-4o' },
    // 协议：决定请求打到哪个端点。默认 openai（覆盖 90% 中转站），
    // 选错的表现是 404 —— 所以向导里直接给选项，别让用户去猜字段。
    {
      key: 'protocol',
      label: '协议',
      options: [
        { label: 'openai', value: 'openai', desc: '/chat/completions · 最通用，中转站基本都是它' },
        { label: 'anthropic', value: 'anthropic', desc: '/v1/messages · Claude 原生' },
        { label: 'responses', value: 'responses', desc: '/responses · OpenAI 新协议（o 系/GPT-5）' },
      ],
      default: 'openai',
    },
  ]
}

/**
 * 把 providerAddSteps 收到的 answers 落盘。
 *
 * @param {object} answers runWizard / Web 表单的原始答案
 * @param {object} ctx
 * @param {object} ctx.config
 * @param {Function} ctx.saveConfig
 * @param {object} [ctx.C] 颜色（CLI 用，Web 传空对象）
 * @returns {string} 给用户看的回执
 */
export function applyProviderAdd(answers, ctx) {
  const { config, saveConfig } = ctx
  const C = ctx.C || new Proxy({}, { get: () => '' })
  if (!answers) return '已取消'

  // multi 步骤答案是数组。数据结构不改：apiKeys 是轮换池，apiKey 取第一个
  // （core/api.mjs setKeys(keys, fallback) 就是这个约定）。单个 key 时不写
  // apiKeys，避免出现「长度 1 的池」这种既不是单 key 也不是池的中间态。
  const keys = (Array.isArray(answers.apiKeys) ? answers.apiKeys : [answers.apiKeys])
    .map(s => String(s || '').trim())
    .filter(Boolean)

  config.providers = config.providers || {}
  const prov = {
    name: answers.name,
    url: answers.url,
    model: answers.model,
    apiKey: keys[0] || '',
  }
  if (keys.length > 1) prov.apiKeys = keys
  // 协议：openai 是默认值不落盘（保持配置干净）；其它必须显式存
  if (answers.protocol && answers.protocol !== 'openai') prov.protocol = answers.protocol
  // URL 按协议规范化（三种协议的 canonical base 规则不同）
  prov.url = normalizeProviderUrl(prov.url, prov.protocol || 'openai')
  config.providers[answers.id] = prov
  saveConfig(config)

  const keyNote = keys.length > 1
    ? `${keys.length} 个（轮换池）`
    : keys.length === 1
      ? '已设置 1 个'
      : `${C.dim}未设置（用 /key ${answers.id} <sk-...> 补）${C.reset}`

  return [
    `${C.green}✓${C.reset} 已添加 Provider ${C.bold}${answers.id}${C.reset} (${answers.name})`,
    `  URL:   ${answers.url}`,
    `  Model: ${answers.model}`,
    `  Key:   ${keyNote}`,
    `${C.dim}  切换过去: /config ${answers.id}${C.reset}`,
  ].join('\n')
}

/**
 * 所有可用的向导定义。
 *
 * 键是 URL 安全的 id（Web 端 `/api/wizard/<id>` 用它）。
 * 每个条目：{ title, steps(ctx), apply(answers, ctx) }
 *
 * 【只登记两端都实现的】登记了但 Web 侧没接，用户点进去会得到空白弹窗 ——
 * 比不登记更糟。CLI 独有的向导（如 GitHub Token）暂时不在这里。
 */
export const WIZARDS = {
  'provider-add': {
    title: '添加 Provider',
    steps: providerAddSteps,
    apply: applyProviderAdd,
  },
}

/** 取向导定义，不存在返回 null。 */
export function getWizard(id) {
  return WIZARDS[id] || null
}

/** 列出所有向导 id（供调试 / 文档）。 */
export function wizardIds() {
  return Object.keys(WIZARDS)
}
