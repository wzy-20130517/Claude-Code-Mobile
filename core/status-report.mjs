// /status：版本、模型、连通性、工具、会话一屏汇总（官方 src/commands/status/）。
// /statusline：自定义底部状态行 —— 官方是跑外部命令、喂 JSON 进 stdin、取 stdout
//              （src/utils/hooks.ts executeStatusLineCommand）。这里同样用子进程，
//              但超时更短，且失败一律静默回退到内置状态行（手机上不能让状态行拖住 UI）。

import { execFile } from 'node:child_process'
import { strWidth } from './width.mjs'

/** 官方 statusLine 超时 5s；我们缩到 2s —— 状态行每轮都要刷，卡住比不显示更糟 */
const STATUSLINE_TIMEOUT_MS = 2000

/**
 * 汇总状态。传进来的都是现成的取值函数/值，这个模块不直接摸全局，方便测试。
 */
export function buildStatusReport({
  version = '0.0.0',
  model = '(unknown)',
  providerId = '',
  providerUrl = '',
  protocol = 'openai',
  thinking = null,
  thinkingPolicy = '',
  keys = null,
  toolCount = 0,
  mcpServers = [],
  sessionId = '',
  messageCount = 0,
  promptTokens = 0,
  maxContext = 0,
  cwd = '',
  fullscreen = false,
  permissionMode = '',
  deepMode = false,
  planMode = false,
  incognito = false,
  autoDaemon = null,
  bgTasks = 0,
  node = process.version,
  platform = `${process.platform} ${process.arch}`,
} = {}) {
  const sections = []

  sections.push({
    title: '版本',
    rows: [
      ['Claude Code Mobile', `v${version}`],
      ['Node', node],
      ['平台', platform],
    ],
  })

  const modelRows = [
    ['模型', model],
    ['Provider', providerId ? `${providerId}${providerUrl ? `  ${maskUrl(providerUrl)}` : ''}` : '(未配置)'],
    ['协议', protocol],
  ]
  if (thinking) {
    modelRows.push(['思考', thinking.enabled ? `开启 · ${thinking.effort || 'high'}${thinking.show === false ? ' · 不显示' : ''}` : '关闭'])
  }
  if (thinkingPolicy) modelRows.push(['实际请求', thinkingPolicy])
  if (keys) modelRows.push(['API Key', keys])
  sections.push({ title: '模型', rows: modelRows })

  const pct = maxContext > 0 && promptTokens > 0
    ? Math.min(100, Math.round((promptTokens / maxContext) * 100))
    : null
  sections.push({
    title: '会话',
    rows: [
      ['会话 ID', sessionId || '(未保存)'],
      ['消息数', String(messageCount)],
      ['上下文', promptTokens > 0
        ? `${fmtK(promptTokens)} / ${fmtK(maxContext)}${pct !== null ? `  ${pct}%` : ''}`
        : `— / ${fmtK(maxContext)}（本轮还没有 API 数据）`],
      ['工作目录', cwd || process.cwd()],
    ],
  })

  const modeRows = [
    ['全屏模式', fullscreen ? '开' : '关'],
    ['权限模式', permissionMode || 'default'],
  ]
  if (deepMode) modeRows.push(['Deep 模式', '开'])
  if (planMode) modeRows.push(['计划模式', '开'])
  if (incognito) modeRows.push(['隐身会话', '开'])
  sections.push({ title: '模式', rows: modeRows })

  const toolRows = [['内置工具', `${toolCount} 个`]]
  if (mcpServers.length) {
    for (const s of mcpServers) {
      toolRows.push([`MCP ${s.name}`, `${s.status || '未知'}${s.toolCount ? ` · ${s.toolCount} 工具` : ''}`])
    }
  } else {
    toolRows.push(['MCP', '未连接'])
  }
  if (autoDaemon) toolRows.push(['自主任务守护', `运行中 #${autoDaemon.pid || '?'}`])
  if (bgTasks > 0) toolRows.push(['后台任务', `${bgTasks} 个运行中`])
  sections.push({ title: '工具', rows: toolRows })

  return { sections }
}

/** 渲染成终端文本 */
export function formatStatusReport(report, { dim = '', reset = '', bold = '' } = {}) {
  const { sections = [] } = report || {}
  if (!sections.length) return '没有可显示的状态'
  // 标签列对齐：取全局最长标签，避免各段左右不齐
  const labelWidth = Math.max(
    ...sections.flatMap(s => s.rows.map(([k]) => visibleWidth(k))),
  )
  const out = []
  for (const sec of sections) {
    if (out.length) out.push('')
    out.push(`${bold}${sec.title}${reset}`)
    for (const [k, v] of sec.rows) {
      const pad = ' '.repeat(Math.max(0, labelWidth - visibleWidth(k)))
      out.push(`  ${dim}${k}${pad}${reset}  ${v}`)
    }
  }
  return out.join('\n')
}

/**
 * 跑用户自定义状态行命令。
 * 官方把一个 JSON 从 stdin 喂进去（含 model / cwd / session 等），取 stdout 当状态行。
 * 失败/超时/空输出 → 返回 null，调用方回退内置状态行。
 */
export function runStatusLineCommand(command, payload = {}, { timeoutMs = STATUSLINE_TIMEOUT_MS, shell = null } = {}) {
  return new Promise((resolve) => {
    const cmd = String(command || '').trim()
    if (!cmd) { resolve(null); return }
    const sh = shell || process.env.SHELL || '/bin/sh'
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    let child
    try {
      child = execFile(sh, ['-c', cmd], { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (err, stdout) => {
        if (err) { finish(null); return }
        // 官方：trim、按行 trim、丢空行、再用 \n 拼回去
        const text = String(stdout || '')
          .trim()
          .split('\n')
          .map(l => l.trim())
          .filter(Boolean)
          .join('\n')
        finish(text || null)
      })
    } catch {
      finish(null)
      return
    }
    // 把上下文 JSON 喂给 stdin（官方同样是 stdin 传参）。
    // 命令不读 stdin 时会 EPIPE，必须挂 error 处理器 —— 否则未捕获的流错误会崩进程。
    try {
      const sin = child.stdin
      if (sin) {
        sin.on('error', () => {})
        sin.end(JSON.stringify(payload))
      }
    } catch { /* ignore */ }
    child.on?.('error', () => finish(null))
  })
}

/** statusLine 命令能拿到的上下文（对齐官方 StatusLineCommandInput 的常用字段） */
export function buildStatusLinePayload({
  model = '', providerId = '', sessionId = '', cwd = process.cwd(),
  messageCount = 0, promptTokens = 0, maxContext = 0, version = '',
} = {}) {
  return {
    hook_event_name: 'StatusLine',
    model: { id: model, display_name: model },
    workspace: { current_dir: cwd },
    session_id: sessionId,
    version,
    provider: providerId,
    context: { used_tokens: promptTokens, max_tokens: maxContext },
    message_count: messageCount,
  }
}

/**
 * 状态条第二行：运行时指标 + 位置信息（2026-09-15）。
 *
 * 为什么单独抽出来：这段原来嵌在 index.mjs 的 updateFsStatus 里（那个函数几百行），
 * 既没法单测，也没法在改动后快速验证「窄屏降级对不对」——而它恰好是宽度敏感的逻辑
 *（手机上 40~60 列是常态）。抽出来后可测、可复用。
 *
 * 布局：`首字 X · 轮 N · LLM Y · 工具 Z(M) │ P:项目 W:工作区`
 * 左侧是「这次任务花在哪了」，右侧是「在哪个项目/工作区做事」，用 │ 分组。
 *
 * 降级顺序（宽度不够时依次放弃，保证不溢出）：
 *   完整 → 只留左侧 → 只留 P: → 空（宁可不显示，也不溢出被终端截成半截字）
 *
 * @param {object} o
 * @param {object|null} o.metrics agent.getMetrics() 的返回值
 * @param {string} o.cwd 当前工作目录（仅在没设 workspace 时兜底显示）
 * @param {string} o.workspace 工作区路径（/workspace 设置）
 * @param {string} o.sessionName 会话名（/rename 设置）
 * @param {string} o.sessionId 会话 ID（没起名时显示它 —— /resume 要敲的就是这个）
 * @param {number} o.cols 终端列数
 * @param {(s:string)=>number} o.width 显示宽度函数（外部注入，便于测试）
 */
export function buildMetricsLine({
  metrics = null, cwd = '', workspace = '', sessionName = '', sessionId = '',
  cachePct = null, cacheRead = null, cols = 80, width = strWidth,
} = {}) {
  // 耗时格式：<1s 用 ms，其余一律用秒（保留一位小数）。
  // 为什么超过 60 秒也不转成 "1m27s"：状态条是**实时跳动**的读数，
  // 统一单位才能一眼看出涨了多少；混用单位时「1m27s → 1m31s」要心算，
  // 而「86.9s → 91.2s」是直接的。且用户给的示例就是 86.9s 这种写法。
  const fmtMs = (ms) => {
    const v = Math.max(0, Number(ms) || 0)
    if (v < 1000) return `${Math.round(v)}ms`
    return `${(v / 1000).toFixed(1)}s`
  }
  // 取路径最后一段，过长截断（手机上路经常 40+ 字符，全显示会把整行挤爆）
  const shortName = (p, keep) => {
    const s = String(p || '').replace(/\/+$/, '')
    const base = s.split('/').filter(Boolean).pop() || s || '—'
    return base.length > keep ? base.slice(0, keep - 1) + '…' : base
  }

  // ── 第二行：运行时指标（2026-09-16 拆成独立行）──
  //
  // 布局：`首token平均 21.7s · 44tok/s 轮 3 · LLM 86.9s · 工具 886ms(2)`
  //   · 首 token 平均 = 端点响应特征（跨 run 保留，换 provider 作废）
  //   · tok/s        = 生成速度（输出 token ÷ 生成耗时，不含首字等待）
  //   · 轮 N         = 本次任务已跑轮数
  //   · LLM / 工具   = 本次任务的耗时构成（含进行中的那一段，实时走秒）
  const line2Parts = []
  if (metrics) {
    // 首字无样本显示 —（不能显示 0ms，会被读成"瞬间到达"）
    line2Parts.push(metrics.avgFirstTokenMs == null
      ? '首token平均 —'
      : `首token平均 ${fmtMs(metrics.avgFirstTokenMs)}`)
    // tps 只在有足够生成量时显示（样本太少算出来是噪音）
    if (metrics.tps != null) line2Parts.push(`${metrics.tps}tok/s`)
    if (metrics.turns > 0) line2Parts.push(`轮 ${metrics.turns}`)
    if (metrics.llmMs > 0) line2Parts.push(`LLM ${fmtMs(metrics.llmMs)}`)
    // 工具时间只在真调过工具时显示；没调过还显示「工具 0ms」是噪音
    if (metrics.toolCalls > 0) line2Parts.push(`工具 ${fmtMs(metrics.toolMs)}(${metrics.toolCalls})`)
  }
  const line2 = line2Parts.join(' · ')

  // ── 第三行：位置与状态 ──
  //
  // 布局：`工作目录:claude-worksp… session:9348d031 · cache 100%`
  //   · 工作目录 = /workspace 设的路径（用户干活的地方；不是 CLI 安装目录）
  //   · session  = 会话 id（/resume /delete /branch 要敲的就是它）
  //   · cache    = prompt cache 命中率（省钱的直观指标）
  const line3Parts = []
  const wsPath = workspace || cwd
  if (wsPath) line3Parts.push(`工作目录:${shortName(wsPath, 14)}`)
  const sess = sessionName ? shortName(sessionName, 12) : String(sessionId || '')
  if (sess) line3Parts.push(`session:${sess}`)
  // cache：只有真实数据且不为 0 时显示（新会话首次请求本来就没缓存）
  if (cacheRead != null && cacheRead > 0) {
    line3Parts.push(`cache ${cachePct ?? 0}%/${cacheRead}tok`)
  }
  const line3 = line3Parts.join(' · ')

  // ── 降级（宽度不够时逐级放弃，保证每行都不溢出）──
  //
  // 两行分别独立降级：第二行是"这次跑得怎么样"，第三行是"我在哪"。
  // 不能因为第三行放不下就把第二行也砍掉 —— 它们的信息价值互不依赖。
  const fit = (parts, sep = ' · ') => {
    // 从完整开始，逐个丢弃**尾部**字段，直到放得下
    for (let n = parts.length; n > 0; n--) {
      const s = parts.slice(0, n).join(sep)
      if (width(s) <= cols) return s
    }
    return ''
  }
  // 【空指标时不要第二行】—— 刚启动、还没跑过任何一轮时，line2Parts 里
  // 只有 `首token平均 —` 这一项，单独占一行显得很空（用户 2026-09-16 反馈
  // "刚启动时状态条太空"）。宁可整行不显示，把版面留给第三行。
  //
  // 判据用"有没有真数据"而不是"字符串是否为空"：`首token平均 —` 非空，
  // 但它表达的是"还没数据"，跟没有是一样的 —— 不该为它保留一整行。
  const hasRealMetrics = !!(metrics && (
    metrics.avgFirstTokenMs != null || metrics.turns > 0 ||
    metrics.llmMs > 0 || metrics.toolCalls > 0 || metrics.tps != null
  ))
  const l2 = hasRealMetrics ? fit(line2Parts) : ''
  const l3 = fit(line3Parts)

  // 兜底：如果第二行真放不下（极窄屏），至少留 tps（它是"快不快"的唯一指标）
  if (!l2 && metrics?.tps != null && width(`${metrics.tps}tok/s`) <= cols) {
    return `${metrics.tps}tok/s\n${l3}`.trim()
  }
  return [l2, l3].filter(Boolean).join('\n')
}

function fmtK(n) {
  const v = Number(n) || 0
  if (v <= 0) return '0'
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`
  return String(v)
}

/** URL 打码：保留协议和主机，隐藏路径细节 */
function maskUrl(url) {
  const s = String(url || '')
  try {
    const u = new URL(s)
    return `${u.protocol}//${u.host}`
  } catch {
    return s.length > 40 ? `${s.slice(0, 40)}…` : s
  }
}

// 委托给 core/width.mjs（宽度计算的单一权威）。
// 原实现注释写着「够用，只用于标签对齐」，但它：
//   · 不剥 ANSI —— 带色标签的转义序列被当可见字符，宽度算多 6~10
//   · emoji / 代理对按单字符算 1 列，实际占 2
// 状态行本来就是带色的，所以这里不是「够用」而是真会错位。
function visibleWidth(s) {
  return strWidth(s)
}
