// 网络错误的**可读化**（2026-10-16 加）
//
// ══════════════════════════════════════════════════════════════
//  为什么需要它
// ══════════════════════════════════════════════════════════════
//
// Node 的 fetch 在传输层失败时，抛出的 `Error` 消息**恒为 `fetch failed`**
// ——真实原因藏在 `err.cause` 里（undici 的 `TypeError` / `Error`），
// 而 `cause.message` 往往还是空字符串，真正有信息的是 `cause.code`
// （ECONNREFUSED / ENOTFOUND / UND_ERR_CONNECT_TIMEOUT …）。
//
// 后果（2026-10-16 实测踩到）：生图工具报 `fetch failed`，我据此反复误判 ——
// 先猜「URL 拼错了」，又猜「域名不通」，最后用 curl 才看到真实响应是
// `HTTP 503 model_not_found`。**光看 `fetch failed` 什么都推不出来**，
// 而 curl 能通、Node 不通这类情况又恰恰需要 cause 才能区分。
//
// 所以：凡是 catch 到 fetch 异常要展示给用户/写进日志的地方，都过这个函数，
// 把 cause 链摊平成人能读的一行。

/**
 * 把 fetch 抛出的异常描述成可读文本（含 cause 链的真实原因）。
 *
 * 输出形如：
 *   `fetch failed ← ECONNREFUSED (connect ECONNREFUSED 127.0.0.1:8788)`
 *   `fetch failed ← UND_ERR_CONNECT_TIMEOUT (Connect Timeout Error)`
 *   `HTTP 503: model_not_found`            ← 若 e 是普通 Error 则原样返回
 *
 * @param {unknown} e 捕获到的异常
 * @param {object} [opts]
 * @param {number} [opts.maxDepth=3] cause 链最多追几层（防循环引用）
 * @returns {string}
 */
export function describeFetchError(e, opts = {}) {
  const maxDepth = opts.maxDepth ?? 3
  if (e === null || e === undefined) return '(无错误信息)'
  if (typeof e === 'string') return e

  const parts = []
  const seen = new Set()
  let cur = e
  for (let i = 0; i < maxDepth && cur && !seen.has(cur); i++) {
    seen.add(cur)
    // 优先 code（最有信息量：ECONNREFUSED / ENOTFOUND / UND_ERR_*）
    const code = cur.code || cur.errno || ''
    // message 有时为空（undici 的 cause 常见），空就不占位
    const msg = String(cur.message || '').trim()
    const name = String(cur.name || '').trim()

    let seg = ''
    if (code) seg = String(code)
    if (msg && msg !== code) {
      // 避免 "fetch failed ← fetch failed" 这种重复
      seg = seg ? `${seg} (${msg})` : msg
    } else if (!seg && name) {
      seg = name
    }
    if (seg && !parts.includes(seg)) parts.push(seg)

    cur = cur.cause
  }

  if (!parts.length) return String(e)
  // 用 ← 表示「因为」：`fetch failed ← ECONNREFUSED (...)`
  return parts.join(' ← ')
}

/**
 * 判断这个异常是不是「传输层失败」（即 fetch 只给了 `fetch failed`）。
 *
 * 用途：决定要不要重试、要不要给出「检查网络/域名」这类建议。
 * 判据同时看 message 与 cause.code —— 只看 message 会漏掉 cause 才有信息的情况。
 *
 * @param {unknown} e
 * @returns {boolean}
 */
export function isTransportError(e) {
  if (!e || typeof e !== 'object') return false
  const text = describeFetchError(e).toLowerCase()
  if (text.includes('fetch failed')) return true
  return /econnrefused|econnreset|enotfound|eai_again|etimedout|epipe|socket hang up|und_err|network is unreachable|network is down|no route to host|software caused connection abort|certificate|tls/i.test(text)
}

/**
 * 从异常里取出最具体的错误码（用于 trace / 分类）。
 * 找不到返回 ''。
 */
export function fetchErrorCode(e) {
  let cur = e
  const seen = new Set()
  for (let i = 0; i < 5 && cur && !seen.has(cur); i++) {
    seen.add(cur)
    if (cur.code) return String(cur.code)
    if (cur.errno) return String(cur.errno)
    cur = cur.cause
  }
  return ''
}
