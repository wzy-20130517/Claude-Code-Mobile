// Provider URL 统一规范化。
//
// 用户输入的是「站点地址」还是「完整 endpoint」不该决定请求能不能发：
//   https://x                 → OpenAI: https://x/v1
//   https://x/v1              → OpenAI: https://x/v1
//   https://x/v1/chat         → OpenAI: https://x/v1
//   https://x/v1/chat/completions → OpenAI: https://x/v1
//   https://x/v1/messages     → Anthropic: https://x
//   https://x/v1              → Anthropic: https://x
//   https://x/v1/responses    → Responses: https://x/v1
//
// ApiClient 内部始终从 canonical base 拼 endpoint：
//   OpenAI    `${base}/chat/completions`
//   Anthropic `${base}/v1/messages`
//   Responses `${base}/responses`
// 因此必须在所有入口统一调用这里，不能让 /url、/config provider add、
// 运行时 sync、构造器各自猜路径。

/**
 * 规范 Provider URL 为 ApiClient 所需的 base URL。
 * @param {string} raw 用户输入的 URL
 * @param {'openai'|'anthropic'|'responses'|string} protocol 协议
 * @returns {string} canonical base；空输入返回空字符串
 */
export function normalizeProviderUrl(raw, protocol = 'openai') {
  let url = String(raw || '').trim().replace(/\/+$/, '')
  if (!url) return ''

  // 【2026-10-03 修】清理重复的协议前缀。
  // 用户反馈「/url https://…… 回车，它竟然又拼了个 https:// 上去」——
  // 场景：粘贴时带了前缀，或输入法/剪贴板重复了，变成 https://https://xxx。
  // 原来的判断只检查「有没有协议」，有就跳过补全 —— 重复前缀原样存进配置，
  // 请求时必然失败。这里先把重复的剥干净再判断。
  // 匹配任意层数的 `https://` / `http://` 重复（`https://https://https://x` → `x`），
  // 但**保留用户明确写的协议**（`http://localhost` 不能变成 https）。
  // 做法：先记住第一个协议，剥掉全部，再用第一个补回去。
  const schemeMatch = url.match(/^(https?):\/\//i)
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase()
    url = url.replace(/^(?:(?:https?):\/\/)+/i, '')
    url = `${scheme}://${url}`
  } else {
    // 容忍用户漏写协议：/url example.com、provider add example.com 都能用。
    // localhost / 127.0.0.1 同样补 https（本地 HTTP 请用户明确写 http://）。
    url = `https://${url}`
  }

  // 完整 endpoint / 半截 endpoint 都先剥掉。只匹配结尾，不动站点自带路径前缀，
  // 例如 https://gateway.example/openai/v1 能保留 /openai。
  // responses 也要剥：用户可能直接贴 .../v1/responses
  url = url
    .replace(/\/(?:chat\/completions|chat|messages|responses|models)$/i, '')
    .replace(/\/+$/, '')

  const isAnthropic = String(protocol || '').toLowerCase() === 'anthropic'
  if (isAnthropic) {
    // Anthropic 请求层会追加 /v1/messages，所以 canonical base 不能带 /v1。
    return url.replace(/\/v1$/i, '').replace(/\/+$/, '')
  }

  // OpenAI / Responses 请求层追加 /chat/completions 或 /responses，
  // 所以 canonical base 必须以 /v1 结尾。
  return /\/v1$/i.test(url) ? url : `${url}/v1`
}

/** 给 UI 回显：用户输入经规范化后实际会用哪个 endpoint。 */
export function providerEndpointPreview(raw, protocol = 'openai') {
  const base = normalizeProviderUrl(raw, protocol)
  if (!base) return ''
  const p = String(protocol || '').toLowerCase()
  if (p === 'anthropic') return `${base}/v1/messages`
  if (p === 'responses') return `${base}/responses`
  return `${base}/chat/completions`
}
