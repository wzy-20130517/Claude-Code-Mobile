// 首次运行配置向导（2026-09-14 重写）
//
// ══════════════════════════════════════════════════════════════════
// 设计参考：openclaw 的 src/wizard/prompts.ts（本机 ~/cc-src/openclaw）
//
// 学到的四条原则：
//   1. **Prompter 抽象** —— 交互原语（text/select/confirm/note）与流程逻辑分离。
//      流程代码只调 prompter.xxx()，不直接碰 readline。好处：实现可换
//      （测试桩 / 未来全屏 UI / 无 TTY 降级），流程逻辑可单测。
//   2. **数据驱动步骤** —— 步骤是数据结构（{ key, title, run, skip }），
//      不是一坨 if (step === N)。加一步 = 数组里加一项，不动导航逻辑。
//   3. **先验证后落盘** —— openclaw 的注释原话：
//      "Guided onboarding verifies the selected AI connection before persisting its route."
//      测试连接失败时不静默保存，让用户明确决定。
//   4. **sensitive / validate / navigation 是一等公民** —— 不是事后补的开关。
//
// 但**不照搬**的部分（都写了理由，别觉得是偷懒）：
//   - openclaw 依赖 @clack/prompts。我们不用：Termux 上少一个运行时依赖少一分风险，
//     而且和项目其余部分（core/readline.mjs 自研）保持同一风格。
//   - openclaw 有完整 i18n 层。我们只有中文用户，直接写中文更省事、也更少出错。
//   - 手机上打字成本远高于桌面 → 能选就不打（预设列表排最前，URL 能省则省）。
//   - **不做掩码输入**：密钥最终明文存在 config.json 里，遮住输入并不增加真实安全性；
//     而手机上密钥基本靠粘贴，遮住反而没法确认粘全了。摘要里已经打了码。
// ══════════════════════════════════════════════════════════════════
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'
import { ensureParentDir } from './paths.mjs'
import { normalizeProviderUrl, providerEndpointPreview } from '../api/provider-url.mjs'
import { FONT_CHOICES, installFont } from '../ui/font-choice.mjs'
import { resolveConfigPath } from './paths.mjs'

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  // 2026-10-01：青蓝（36m）整体换 Claude 橙 #D77757（与 fullscreen accent 同色值）
  cyan: '\x1b[38;2;215;119;87m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', gray: '\x1b[90m',
}

/** 常见服务商预设。protocol 省略 = openai（最通用）。 */
const PRESETS = [
  { name: '自定义（手动输入 URL）', url: null },
  { name: 'OpenAI 官方', url: 'https://api.openai.com/v1' },
  { name: 'Anthropic 官方', url: 'https://api.anthropic.com', protocol: 'anthropic' },
  { name: 'DeepSeek 官方', url: 'https://api.deepseek.com/v1' },
  { name: '智谱 GLM', url: 'https://open.bigmodel.cn/api/paas/v4' },
  { name: 'Moonshot Kimi', url: 'https://api.moonshot.cn/v1' },
]

/** 分支导航哨兵。用 Symbol 不会被用户输入意外命中（'..' 会，所以那是另一个值）。 */
const BACK = Symbol('back')
const ABORT = Symbol('abort')

const line = (n = 46) => C.gray + '─'.repeat(n) + C.reset
const maskKey = (k) => {
  const s = String(k || '')
  if (!s) return '(未设置)'
  if (s.startsWith('${')) return s          // 环境变量占位符原样显示
  return s.length <= 12 ? s.slice(0, 3) + '···' + s.slice(-2) : s.slice(0, 7) + '···' + s.slice(-4)
}

function banner() {
  const star = [
    '            ░░░░░░                                        ',
    '    ░░░   ░░░░░░░░░░░░                                      ',
    '   ░░░░░░░░░░░░░░░░░░░░                                    ',
    '                           ░░░░                     ██    ',
    '                         ░░░░░░░░░░               ██▒▒██  ',
    '                                            ▒▒      ██   ▒',
    '       █████████                         ▒▒░░▒▒      ▒ ▒▒',
    '     █████████████                       ▒▒  ▒▒▒▒    ▒▒  ▒▒',
    '    ████  ████  ████                     ▒▒   ▒▒▒▒   ▒▒   ▒▒',
    '   ████   ████   ████                   ▒▒    ▒▒ ▒▒  ▒▒    ▒▒',
    '   ████   ████   ████                   ▒      ▒  ▒  ▒      ▒',
  ]
  return [
    '',
    C.cyan + C.bold + '  Welcome to Claude Code Mobile' + C.reset,
    '',
    ...star.map(l => C.cyan + '  ' + l + C.reset),
    '',
    C.gray + '  首次运行配置向导' + C.reset,
    '',
    line(),
    '',
  ].join('\n')
}


// ──────────────────────────────────────────────────────────────────
// 虚拟屏幕 Prompter（2026-10-01 用户要求）
//
// 老实现（rl.question）validate 失败后 continue → 重新 question →
// 终端在**下面重新弹一个输入框**，输入越改错误越堆，打的字也丢了。
//
// 新实现「类似全屏模式的虚拟屏幕」布局（底部固定两行 + 上方滚动态）：
//   …步骤内容（body：hint / 选项 / note，自然向上滚）…
//   × 最新错误（单行，原地替换；无错时空行占位 → 输入行位置永远稳定）
//     label › 正在输入的内容▌（原地编辑：打字/退格只重绘这一行）
//
// 关键约定：
//   · 错误**只**更新错误行，不重画输入框、不清用户已打的字
//   · 输入行锚定屏底（每次从屏底数行，不依赖绝对行号 → 滚屏后仍正确）
//   · 直读 raw stdin（不用 readline，避免双消费与回显打架）
//   · 粘贴（bracketed paste / Termux 大段粘贴）剥掉标记后逐字符入缓冲
// ──────────────────────────────────────────────────────────────────

/**
 * 建虚拟屏会话（全帧按行差分渲染版）。
 *
 * 渲染模型：一帧 = [页头行…, body…, 错误行, 输入行]，与上帧**逐行 diff**，
 * 只重写变化行（\x1b[row;1H + \x1b[2K + 内容）。比「滚屏+屏底锚点」稳：
 * 不依赖绝对行号、清行不留垃圾、滚屏错位问题不存在。
 * 每次击键只更新输入行；validate 失败只更新错误行 —— 打的字不丢。
 *
 * 返回 { ui, p, dispose }：
 *   ui      流程层原语（write/hint/ok/warn/error/page，语义与老版一致）
 *   p       Prompter（text/select/confirm/note —— BACK/ABORT 语义与老版一致）
 *   dispose finally 调：关 raw、清监听、显示光标
 */
function createVscreenSession() {
  const stdout = process.stdout
  let headLines = []     // 页头（page 重画）
  let bodyLines = []     // 本页定格内容
  let errText = ''       // 最新校验错误（'' = 空行占位，输入行位置稳定）
  let buf = ''           // 输入缓冲
  let promptText = ''    // 输入行静态前缀
  let acceptKeys = false // 只有 Prompter 在等键时才消费按键
  let resolveKey = null

  let prevFrame = []     // 上一帧的行数组（diff 用）

  const frame = () => {
    const rows = []
    for (const h of headLines) rows.push(h)
    for (const b of bodyLines) rows.push(b)
    rows.push(errText ? `  \x1b[31m× ${errText}\x1b[0m` : '')
    if (acceptKeys || promptText) {
      rows.push(`${promptText}\x1b[38;2;215;119;87m${buf}\x1b[0m\x1b[38;2;215;119;87m▌\x1b[0m`)
    }
    return rows
  }

  const render = () => {
    const next = frame()
    const cols = stdout.columns || 80
    let out = ''
    const max = Math.max(prevFrame.length, next.length)
    for (let i = 0; i < max; i++) {
      const a = prevFrame[i] ?? null
      const b = next[i] ?? null
      if (a === b) continue
      // 行号 i+1（帧顶 = 屏顶）；清行后写新内容（空行只清）
      out += `\x1b[${i + 1};1H\x1b[2K`
      if (b) out += truncateAnsi(b, cols - 1)
    }
    // 从渲染区收回：新帧更短时清掉多出的旧行（已在上面 a!==b && b===null 覆盖）
    // 光标送回输入行末尾（接受输入时）
    if (acceptKeys) {
      const row = next.length
      const visLen = visibleLen(promptText) + [...buf].length
      out += `\x1b[${row};1H\x1b[2K${promptText}\x1b[38;2;215;119;87m${buf}\x1b[0m\x1b[38;2;215;119;87m▌\x1b[0m`
      out += `\x1b[${row};${Math.min(visLen + 2, cols)}H`
    } else {
      out += `\x1b[${next.length};1H`
    }
    stdout.write(out)
    prevFrame = next
  }

  // ── ANSI 感知的截断/长度（颜色序列不占宽）──
  function visibleLen(s) {
    return [...String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')].length
  }
  function truncateAnsi(s, max) {
    // 超宽截断（简化：按可见字符计数，遇到 ANSI 序列原样保留）
    let vis = 0, out = ''
    const re = /(\x1b\[[0-9;]*[A-Za-z])|([\s\S])/g
    let m
    while ((m = re.exec(s))) {
      if (m[1]) { out += m[1]; continue }
      if (vis >= max) break
      out += m[2]; vis++
    }
    return out + '\x1b[0m'
  }

  // ── stdin raw 模式 ──
  const hadRaw = process.stdin.isRaw === true
  try { process.stdin.setRawMode(true) } catch {}
  try { process.stdin.resume() } catch {}
  try { stdout.write('\x1b[?25l') } catch {}

  const onRawData = (chunk) => {
    if (!acceptKeys || !resolveKey) return
    const r = resolveKey; resolveKey = null
    r(String(chunk))
  }
  process.stdin.on('data', onRawData)
  const waitKey = () => new Promise((res) => { resolveKey = res })

  // ── ui ──
  const pushBody = (text) => {
    // 含换行的多行文本拆成行
    const ls = String(text).split('\n')
    for (const l of ls) bodyLines.push(l)
    render()
  }

  const ui = {
    write: (s) => { String(s).split('\n').forEach((l) => bodyLines.push(l)); render() },
    hint: (s) => { if (s) pushBody(`\x1b[2m  ${s}\x1b[0m`) },
    ok: (s) => pushBody(`\x1b[32m  ${s}\x1b[0m`),
    warn: (s) => pushBody(`\x1b[33m  ${s}\x1b[0m`),
    error: (s) => pushBody(`\x1b[31m  ${s}\x1b[0m`),
    page: (n, total, title) => {
      bodyLines = []
      errText = ''
      buf = ''
      // ★ 2026-10-01 修「遗留」：完成页（n=✓）不该带「输 .. 返回上一步」——
      //   流程已结束没有上一步；进度也显示「完成」而不是 ✓/✓。
      const isDone = n === '✓'
      const progress = isDone ? '✓ 完成' : `${n}/${total} · ${title}`
      const hint = isDone
        ? `\x1b[90m  （直接关掉或 Ctrl+C 退出）${'─'.repeat(30)}\x1b[0m`
        : `\x1b[90m  （输 .. 返回上一步；Ctrl+C 退出）${'─'.repeat(30)}\x1b[0m`
      headLines = [
        `\x1b[38;2;215;119;87m\x1b[1mClaude Code Mobile 配置向导\x1b[0m  \x1b[90m${progress}\x1b[0m`,
        hint,
      ]
      // 清屏重建
      prevFrame = []
      stdout.write('\x1b[2J\x1b[H')
      render()
    },
    _begin: (ph) => { promptText = ph; buf = ''; errText = ''; acceptKeys = true; render() },
    _setError: (msg) => { errText = msg; render() },
    _end: () => {
      // 提交定格：输入行 → 静态记录行（去 ▌），停收键
      acceptKeys = false
      const frozen = `${promptText}\x1b[90m${buf}\x1b[0m`
      bodyLines.push(frozen)
      promptText = ''; buf = ''; errText = ''
      render()
    },
    _waitKey: waitKey,
    _push: pushBody,
  }

  const isBack = (t) => { const x = t.trim(); return x === '..' || x.toLowerCase() === 'b' }

  /** 键解析 → 编辑。返回 'submit' | 'abort' | 'wait'。 */
  const handleKey = (raw) => {
    let s = raw.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '')
    if (s.includes('\x03') || s.includes('\x04')) return 'abort'   // Ctrl+C / Ctrl+D
    // ★ 2026-10-01 修：原来「有 \\r 就直接 submit」——批量注入的 chunk（如 `1\\r`
    //   同包）里字符没入缓冲就提交了，buf 是空的。正确顺序：
    //   先处理退格与可打印字符入 buf，最后才看「包里有没有换行」决定提交。
    const submitted = /\r|\n/.test(s)
    // 退格可能一次到多个（快速长按）：按个数删
    const bs = (s.match(/\x7f|\x08/g) || []).length
    if (bs > 0) {
      const chars = [...buf]
      for (let i = 0; i < bs && chars.length; i++) chars.pop()
      buf = chars.join('')
      s = s.replace(/\x7f|\x08/g, '')
    }
    // 剥掉方向键等 ESC 序列，剩可打印字符入缓冲（多字符 chunk = 粘贴）
    s = s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b./g, '')
    s = s.replace(/[\r\n]/g, '')
    if (s) buf += s
    return submitted ? 'submit' : 'wait'
  }

  /** 底部循环：按键→编辑→重绘，直到 submit/abort。 */
  const readUntilSubmit = async () => {
    for (;;) {
      const key = await waitKey()
      acceptKeys = true
      const act = handleKey(key)
      if (act === 'abort') return 'abort'
      if (act === 'submit') return 'submit'
      render()
    }
  }

  const p = {
    async text({ label, hint = '', def = '', required = true, validate = null }) {
      if (hint) ui.hint(hint)
      const defNote = def ? `\x1b[90m (默认: ${def})\x1b[0m` : ''
      // ★ _begin 只在首次调 —— 放循环里会把校验失败后的缓冲清空，
      //   违反「报错后打字原地继续、已输入的字不丢」。
      ui._begin(`  ${label}${defNote} › `)
      for (;;) {
        const act = await readUntilSubmit()
        if (act === 'abort') return ABORT
        const s = buf.trim()
        const val = s === '' ? def : s
        if (required && (val === '' || val == null)) { ui._setError('必填，请输入'); continue }
        if (val !== '' && val != null && validate) {
          const err = validate(val)
          // ★ 校验失败：只更新错误行，输入框原地、buf 不清、不重弹
          if (err) { ui._setError(err); continue }
        }
        ui._end()
        return val
      }
    },

    async select({ label, options, def = 1 }) {
      ui.hint(label)
      options.forEach((it, i) => {
        ui._push(`  \x1b[38;2;215;119;87m${String(i + 1).padStart(2)}.\x1b[0m ${it}`)
      })
      ui._begin(`  选择 (1-${options.length}, 默认 ${def}) › `)
      for (;;) {
        const act = await readUntilSubmit()
        if (act === 'abort') return ABORT
        const s = buf.trim()
        if (isBack(s)) return BACK
        const n = s === '' ? def : parseInt(s, 10)
        if (!Number.isInteger(n) || n < 1 || n > options.length) {
          ui._setError(`请输入 1-${options.length}`)   // 只占错误行，选项不重画
          continue
        }
        ui._end()
        return n - 1
      }
    },

    async confirm({ label, defYes = true }) {
      const hintTxt = defYes ? '(Y/n)' : '(y/N)'
      ui._begin(`  ${label} ${hintTxt} › `)
      for (;;) {
        const act = await readUntilSubmit()
        if (act === 'abort') return ABORT
        const s = buf.trim()
        if (isBack(s)) return BACK
        if (!s) { ui._end(); return defYes }
        const yes = /^y(es)?$/i.test(s)
        const no = /^n(o)?$/i.test(s)
        if (!yes && !no) { ui._setError('输入 y 或 n'); continue }
        ui._end()
        return yes
      }
    },

    async note(msg) { ui._push(msg) },
  }

  const dispose = () => {
    try { process.stdin.removeListener('data', onRawData) } catch {}
    try { if (!hadRaw) process.stdin.setRawMode(false) } catch {}
    try { stdout.write('\x1b[?25h') } catch {}
    try { stdout.write('\x1b[0m\n') } catch {}
  }

  return { ui, p, dispose }
}

// ──────────────────────────────────────────────────────────────────
// 交互原语层（Prompter）
//
// 所有方法遵守同一约定：
//   正常 → 返回用户给的值
//   输 .. 或 b → 返回 BACK（交给流程层决定回退到哪一步）
//   Ctrl+C → 返回 ABORT（流程层立刻收尾，不留半截配置）
//
// 流程代码只依赖这四个方法，不 import readline —— 这是可测性的全部秘密。
// ──────────────────────────────────────────────────────────────────
function createPrompter(rl, ui) {
  /** 底层一问一答。返回 ABORT 表示 rl 已关闭（Ctrl+C）。 */
  const askRaw = (q) => new Promise((resolve) => {
    const onClose = () => resolve(ABORT)
    rl.once('close', onClose)
    rl.question(q, (raw) => {
      rl.removeListener('close', onClose)
      resolve(String(raw ?? ''))
    })
  })

  const isBack = (s) => {
    const t = s.trim()
    return t === '..' || t.toLowerCase() === 'b'
  }

  return {
    /** 单行文本。validate 返回错误字符串 = 不通过，原地重问。 */
    async text({ label, hint = '', def = '', required = true, validate = null }) {
      for (;;) {
        ui.hint(hint)
        const suffix = def !== '' && def != null ? C.gray + ' (' + def + ')' + C.reset : ''
        const raw = await askRaw(C.bold + label + C.reset + suffix + C.gray + ' › ' + C.reset)
        if (raw === ABORT) return ABORT
        if (isBack(raw)) return BACK
        const s = raw.trim()
        const val = s === '' ? def : s
        if (required && (val === '' || val == null)) { ui.error('必填，请输入'); continue }
        if (val !== '' && val != null && validate) {
          const err = validate(val)
          if (err) { ui.error(err); continue }
        }
        return val
      }
    },

    /** 列表选择。返回所选项的索引；def 是 1-based 默认序号。 */
    async select({ label, options, def = 1 }) {
      ui.hint(label)
      options.forEach((it, i) => {
        const num = C.cyan + String(i + 1).padStart(2) + '.' + C.reset
        ui.write('  ' + num + ' ' + it + '\n')
      })
      for (;;) {
        const raw = await askRaw(C.gray + `  选择 (1-${options.length}, 默认 ${def}) › ` + C.reset)
        if (raw === ABORT) return ABORT
        const s = raw.trim()
        if (isBack(s)) return BACK
        const n = s === '' ? def : parseInt(s, 10)
        if (!Number.isInteger(n) || n < 1 || n > options.length) {
          ui.error(`请输入 1-${options.length}`)
          continue
        }
        return n - 1
      }
    },

    /** 是/否。默认值由 defYes 决定。 */
    async confirm({ label, defYes = true }) {
      const hint = defYes ? '(Y/n)' : '(y/N)'
      const raw = await askRaw(C.bold + label + C.reset + C.gray + ' ' + hint + ' › ' + C.reset)
      if (raw === ABORT) return ABORT
      const s = raw.trim()
      if (isBack(s)) return BACK
      if (!s) return defYes
      return s.toLowerCase() === 'y' || s.toLowerCase() === 'yes'
    },

    /** 一段不需要回应的说明文字（openclaw 的 note 语义）。 */
    async note(msg) { ui.write(msg + '\n') },
  }
}

// ──────────────────────────────────────────────────────────────────
// 连接测试：真实发一个最小请求
// ──────────────────────────────────────────────────────────────────
async function testConnection({ url, apiKey, model, protocol }) {
  // 端点规则必须跟 ApiClient 完全一致，否则向导「测试连接」永远失败，
  // 用户会以为 key 错了（而实际是路径拼错）。三种协议各不相同：
  //   openai    base 带 /v1 → {base}/chat/completions
  //   anthropic base 不带 /v1 → {base}/v1/messages
  //   responses base 带 /v1 → {base}/responses
  const isAnthropic = protocol === 'anthropic'
  const isResponses = protocol === 'responses'
  const endpoint = isAnthropic
    ? url.replace(/\/$/, '') + '/v1/messages'
    : isResponses
      ? url.replace(/\/$/, '') + '/responses'
      : url.replace(/\/$/, '') + '/chat/completions'
  const headers = { 'Content-Type': 'application/json' }
  if (isAnthropic) {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers['Authorization'] = 'Bearer ' + apiKey
  }
  const body = isAnthropic
    ? { model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }
    : isResponses
      ? { model, max_output_tokens: 16, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }
      : { model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal })
    const text = await res.text()
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ': ' + text.slice(0, 160) }
    try {
      const j = JSON.parse(text)
      if (j.error) return { ok: false, error: String(j.error.message || j.error).slice(0, 160) }
    } catch {}
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '请求超时（15s）' : (e.message || String(e)) }
  } finally {
    clearTimeout(timer)
  }
}

/** 从 URL + 模型名推一个默认配置名（用户懒得取名时用）。 */
function defaultNameFor(url, model) {
  try {
    return new URL(url).hostname.replace(/^(www|api)\./, '').split('.')[0] + '-' + model.split(/[-/]/)[0]
  } catch {
    return 'provider-1'
  }
}

/** 把 ${ENV} 占位符换成真实值（测试连接用；存盘保留占位符）。 */
function resolveKey(apiKey) {
  const s = String(apiKey || '')
  return s.startsWith('${') && s.endsWith('}') ? (process.env[s.slice(2, -1)] || '') : s
}

// ──────────────────────────────────────────────────────────────────
// 无 TTY 时的降级：不启动向导，把「怎么配」讲清楚
//
// 原来没有这层：管道/重定向环境（CI、其他程序调用）下向导会卡在
// rl.question 上永远等不到输入 —— 进程看起来"死"了，用户不知道为什么。
// ──────────────────────────────────────────────────────────────────
function nonTtyHelp(configPath) {
  const w = (s) => process.stdout.write(s + '\n')
  w('')
  w(C.yellow + '当前环境没有交互终端，无法运行配置向导。' + C.reset)
  w('')
  w(C.bold + '两种方式配置：' + C.reset)
  w('')
  w(C.bold + '1) 用环境变量（推荐，一条命令搞定）' + C.reset)
  w('  ' + C.cyan + 'CCM_ONBOARD_URL=https://中转站/v1 \\' + C.reset)
  w('  ' + C.cyan + 'CCM_ONBOARD_MODEL=deepseek-chat \\' + C.reset)
  w('  ' + C.cyan + 'CCM_ONBOARD_KEY=sk-xxx \\' + C.reset)
  w('  ' + C.cyan + 'node index.mjs' + C.reset + C.gray + '   # 自动写 ' + configPath + C.reset)
  w('')
  w(C.bold + '2) 手写 ' + configPath + C.reset)
  w(C.gray + '  格式参考：' + C.reset)
  w(C.gray + JSON.stringify({
    providers: { '1': { name: 'my', url: 'https://中转站/v1', model: 'deepseek-chat', apiKey: 'sk-xxx' } },
    current: '1',
  }, null, 2).split('\n').map(l => '  ' + l).join('\n') + C.reset)
  w('')
}

/** 环境变量齐全时直接落盘，不进向导（脚本化部署 / CI 用）。 */
function tryEnvOnboarding(configPath) {
  const url = process.env.CCM_ONBOARD_URL
  const model = process.env.CCM_ONBOARD_MODEL
  const key = process.env.CCM_ONBOARD_KEY
  if (!url || !model || !key) return null
  const protocol = (process.env.CCM_ONBOARD_PROTOCOL || 'openai').toLowerCase()
  const norm = normalizeProviderUrl(url, protocol)
  const config = buildConfig({
    url: norm, model, apiKey: key, protocol,
    name: process.env.CCM_ONBOARD_NAME || defaultNameFor(norm, model),
    workspace: process.env.CCM_ONBOARD_WORKSPACE || null,
  })
  ensureParentDir(configPath)   // 全新用户数据目录还不存在，写前必须建
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  process.stdout.write(C.green + '✓ 已按环境变量写入 ' + configPath + C.reset + '\n')
  process.stdout.write(C.gray + '  ' + providerEndpointPreview(norm, protocol) + C.reset + '\n')
  return true
}

/** 落盘用的 config 对象（单点构造，向导和 env 路径共用，避免两处漂移）。 */
function buildConfig({ url, model, apiKey, protocol, name, workspace }) {
  return {
    providers: {
      '1': {
        name, url, model, apiKey,
        // openai 是默认值、不必写盘；其它协议必须显式存 ——
        // 否则重启后按 openai 发请求，端点错、用户看到莫名的 404。
        ...(protocol && protocol !== 'openai' ? { protocol } : {}),
      },
    },
    current: '1',
    ...(workspace ? { workspacePath: workspace } : {}),
    thinking: { enabled: false, effort: 'medium', show: true },
    stream: true,
    temperature: 1,
    maxContextTokens: 200000,
    permissionMode: 'bypassPermissions',
    fullscreen: true,
    greeting: false,
    // 自动保活默认开（2026-10-03 用户拍板：「耗不了几个电，但非常有用」）。
    // 静音音频防系统冻结 Termux，息屏挂机必需。
    keepaliveAuto: true,
    // 会话历史显示默认关（2026-10-03 用户拍板：「replayHistory 默认关吧」）。
    // 进入会话时不铺历史正文，想看用 /replay on。
    replayHistory: false,
  }
}

// ──────────────────────────────────────────────────────────────────
// 主流程
// ──────────────────────────────────────────────────────────────────
export async function runOnboarding(configPath = resolveConfigPath('config.json')) {
  // 非交互环境：给说明而不是卡死
  if (!process.stdin.isTTY) {
    const done = tryEnvOnboarding(configPath)
    if (done) return true
    nonTtyHelp(configPath)
    return false
  }

  // ★ 2026-10-01 换虚拟屏幕会话（见 createVscreenSession 注释）：
  //   不再用 readline —— rl.question 校验失败会「在下面重新弹输入框」，
  //   打的字也丢。新路径：底部固定「错误行+输入行」，错误原地替换、
  //   打字原地编辑；Ctrl+C 由 raw 键解析成 ABORT（不走 SIGINT 通道）。
  //   老的 createPrompter 保留在下方（回滚保险，当前无调用）。
  let aborted = false
  const vs = createVscreenSession()
  const ui = vs.ui
  const p = vs.p

  // ── 步骤定义（数据驱动）─────────────────────────────────
  //
  // 每步：{ key, title, run(st) → BACK|ABORT|undefined, skip?(st) → bool }
  // run 里直接改 st；返回 BACK 由导航层回退，返回 ABORT 立刻收尾。
  // 加步骤 = 加一项，导航逻辑一行不用动。
  const st = { presetIdx: 0, url: null, protocol: 'openai', model: null, apiKey: null, name: null, workspace: null, tested: false }

  const steps = [
    // ── 终端字体（2026-10-01）：放第一步 —— 选完立刻 termux-reload-settings 生效，
    //    向导剩余界面直接用新字体显示。start.sh 的「没字体自动装 JBM」已删，
    //    字体外观从「替用户决定」改成「问用户」。skip 不做：首启一律问。
    {
      key: 'font', title: '终端字体',
      run: async () => {
        const idx = await p.select({
          label: '选择终端字体（字体已内置在项目里，选完直接装、无需联网；之后可用 /font 切换）：',
          options: FONT_CHOICES.map((f) => f.name),
          def: 2,   // JetBrains Mono（推荐）= 第 2 项
        })
        if (idx === ABORT) return ABORT
        if (idx === BACK) return undefined   // 第一步无上一步：原地重来
        const r = installFont(FONT_CHOICES[idx].id)
        if (r.ok) ui.ok(r.msg)
        else ui.warn(r.msg)
        return undefined
      },
    },
    {
      key: 'preset', title: '服务商',
      run: async (st) => {
        const idx = await p.select({
          label: '选择服务商：',
          options: PRESETS.map(x => x.url ? x.name + C.gray + '  ' + x.url + C.reset : x.name),
          def: (typeof st.presetIdx === 'number' ? st.presetIdx : 0) + 1,
        })
        if (idx === ABORT) return ABORT
        if (idx === BACK) return undefined       // 第一步无上一步：原地重来
        st.presetIdx = idx
        const preset = PRESETS[idx]
        if (preset.url) { st.url = preset.url; st.protocol = preset.protocol || 'openai' }
        return undefined
      },
    },
    {
      key: 'url', title: 'API 地址',
      skip: (st) => !!PRESETS[st.presetIdx]?.url,   // 预设自带 URL 就跳过这步
      run: async (st) => {
        const url = await p.text({
          label: '  API 地址',
          hint: '中转站/自建服务的 base URL，通常以 /v1 结尾',
          def: st.url || '',
          validate: v => /^https?:\/\/.+/i.test(v) ? null : '必须以 http:// 或 https:// 开头',
        })
        if (url === ABORT) return ABORT
        if (url === BACK) return BACK
        st.url = normalizeProviderUrl(url, st.protocol || 'openai')
        return undefined
      },
    },
    {
      key: 'model', title: '模型名',
      run: async (st) => {
        ui.hint('地址: ' + st.url)
        const model = await p.text({
          label: '  模型',
          hint: '例：gpt-4o / claude-sonnet-4 / deepseek-chat',
          def: st.model || '',
          validate: null,   // 2026-10-01：不校验长度（同 key —— 有的就是短）
        })
        if (model === ABORT) return ABORT
        if (model === BACK) return BACK
        st.model = model
        return undefined
      },
    },
    {
      key: 'key', title: 'API 密钥',
      run: async (st) => {
        const apiKey = await p.text({
          label: '  Key',
          hint: '粘贴密钥；也可填 ${ENV_NAME} 引用环境变量（如 ${DEEPSEEK_KEY}）',
          def: st.apiKey || '',
          validate: null,   // 2026-10-01：不校验长度 —— 有的 key 就是短（原 >=8 总误伤）
        })
        if (apiKey === ABORT) return ABORT
        if (apiKey === BACK) return BACK
        st.apiKey = apiKey
        return undefined
      },
    },
    {
      // 【新步骤】协议选择。
      //
      // 旧版靠 URL 里有没有 "anthropic" 字样猜协议 —— 猜错的表现是 404，
      // 而且用户完全不知道哪里错了（他明明填对了 URL）。responses 更是猜不出来。
      // 明确问一次，成本一次回车，省掉整类错误。
      key: 'protocol', title: '协议',
      run: async (st) => {
        const cur = st.protocol || 'openai'
        const opts = [
          { v: 'openai', label: 'openai' + C.gray + '      /chat/completions · 最通用，中转站基本都认' + C.reset },
          { v: 'anthropic', label: 'anthropic' + C.gray + '   /v1/messages · Claude 原生' + C.reset },
          { v: 'responses', label: 'responses' + C.gray + '   /responses · OpenAI 新协议（需网关支持）' + C.reset },
        ]
        const idx = await p.select({
          label: '请求协议：',
          options: opts.map(o => (o.v === cur ? C.green + '· ' + C.reset : '  ') + o.label),
          def: Math.max(1, opts.findIndex(o => o.v === cur) + 1),
        })
        if (idx === ABORT) return ABORT
        if (idx === BACK) return BACK
        const next = opts[idx].v
        // 换协议要重新规范化 URL：三种协议的 canonical base 规则不同
        //（anthropic 不带 /v1，另两个要带），原样留着会拼错端点。
        if (next !== cur && st.url) st.url = normalizeProviderUrl(st.url, next)
        st.protocol = next
        return undefined
      },
    },
    {
      key: 'confirm', title: '确认',
      run: async (st) => {
        const defNm = defaultNameFor(st.url, st.model)
        ui.write('  ' + C.gray + '名称' + C.reset + '  ' + (st.name || defNm) + '\n')
        ui.write('  ' + C.gray + '地址' + C.reset + '  ' + st.url + '\n')
        ui.write('  ' + C.gray + '端点' + C.reset + '  ' + providerEndpointPreview(st.url, st.protocol) + '\n')
        ui.write('  ' + C.gray + '模型' + C.reset + '  ' + st.model + '\n')
        ui.write('  ' + C.gray + '协议' + C.reset + '  ' + st.protocol + '\n')
        ui.write('  ' + C.gray + '密钥' + C.reset + '  ' + maskKey(st.apiKey) + '\n\n')

        const name = await p.text({
          label: '  配置名', hint: '起个短名（回车用默认）',
          def: st.name || defNm, required: false,
        })
        if (name === ABORT) return ABORT
        if (name === BACK) return BACK
        st.name = (typeof name === 'string' && name.trim()) ? name.trim() : defNm

        const wantTest = await p.confirm({ label: '  现在测试一下连接？', defYes: true })
        if (wantTest === ABORT) return ABORT
        if (wantTest === BACK) return BACK
        if (!wantTest) { st.tested = false; return undefined }

        const keyForTest = resolveKey(st.apiKey)
        if (!keyForTest) {
          ui.write(C.yellow + '  ⚠ ' + st.apiKey + ' 当前为空，跳过测试\n' + C.reset)
          return undefined
        }
        ui.write(C.gray + '\n  发一个最小请求…\n' + C.reset)
        const r = await testConnection({ url: st.url, apiKey: keyForTest, model: st.model, protocol: st.protocol })
        if (r.ok) { ui.ok('✓ 连接正常'); st.tested = true; return undefined }
        ui.error('✗ ' + r.error)
        // 【先验证后落盘】失败不静默保存 —— 让用户明确选（openclaw 同款行为）
        const goOn = await p.confirm({ label: '  仍然保存这份配置？', defYes: true })
        if (goOn === ABORT) return ABORT
        if (goOn === BACK) return BACK
        if (!goOn) {
          ui.write(C.gray + '\n  已放弃，未写入。\n' + C.reset)
          return ABORT
        }
        return undefined
      },
    },
    {
      key: 'workspace', title: '工作区',
      run: async (st) => {
        const wp = await p.text({
          label: '  工作区路径',
          hint: '项目文件/生成代码存放的主目录（回车跳过用默认）',
          def: st.workspace || '/sdcard/Download/claude-workspace',
          required: false,
          validate: v => v === '' ? null : (/^\//.test(v) ? null : '必须是绝对路径（以 / 开头）'),
        })
        if (wp === ABORT) return ABORT
        if (wp === BACK) return BACK
        st.workspace = wp || null
        return undefined
      },
    },
  ]

  // ── 导航层：前进/后退/跳过 ──────────────────────────────
  //
  // 数据驱动的好处在这里：加/删/跳过步骤不需要动导航。
  // skip 也参与回退（回退时要跳过那些本来就不会执行到的步骤）。
  const visibleSteps = () => steps.filter(s => !(s.skip && s.skip(st)))

  try {
    // ★ 2026-10-01：新运行先清屏 + 清回滚（3J），否则上一次的完成页
    //   还留在可视区/回滚缓冲里，和本次 banner 糊成一段（「有遗留在里面」）。
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H')
    process.stdout.write(banner())
    let i = -1
    while (i < steps.length - 1) {
      if (aborted) return false
      // 找下一个该执行的步骤（跳过 skip 命中的）
      let next = i + 1
      while (next < steps.length && steps[next].skip && steps[next].skip(st)) next++
      if (next >= steps.length) break

      const step = steps[next]
      const vis = visibleSteps()
      ui.page(vis.indexOf(step) + 1, vis.length, step.title)

      const ret = await step.run(st)
      if (aborted || ret === ABORT) { aborted = true; break }

      if (ret === BACK) {
        // 回退到上一个可见步骤
        let prev = next - 1
        while (prev >= 0 && steps[prev].skip && steps[prev].skip(st)) prev--
        i = prev - 1        // 循环头 i+1 之后正好落在 prev 上；prev=-1 时重跑第一步
        continue
      }
      i = next
    }

    if (aborted) return false

    // ── 落盘 ──
    ensureParentDir(configPath)   // 同上：数据目录可能还不存在
    writeFileSync(configPath, JSON.stringify(buildConfig(st), null, 2), 'utf-8')

    ui.page('✓', '✓', '配置完成')
    ui.ok('已写入 ' + configPath)
    ui.write('\n')
    ui.write('  ' + C.gray + '名称' + C.reset + '  ' + st.name + '\n')
    ui.write('  ' + C.gray + '地址' + C.reset + '  ' + st.url + '\n')
    ui.write('  ' + C.gray + '端点' + C.reset + '  ' + providerEndpointPreview(st.url, st.protocol) + '\n')
    ui.write('  ' + C.gray + '模型' + C.reset + '  ' + st.model + '\n')
    ui.write('  ' + C.gray + '协议' + C.reset + '  ' + st.protocol + '\n')
    ui.write('  ' + C.gray + '密钥' + C.reset + '  ' + maskKey(st.apiKey) + '\n')
    if (!st.tested) ui.write(C.gray + '  （未测连接；用 /config test 随时验证）' + C.reset + '\n')
    ui.write('\n' + C.gray + '  之后可用 /config 查看、/config provider add 加更多配置。' + C.reset + '\n')
    ui.write('\n' + C.bold + '  常用操作' + C.reset + '\n')
    ui.write('  ' + C.cyan + '/config' + C.reset + C.gray + '      切换 Provider / 模型 / Key / 协议' + C.reset + '\n')
    ui.write('  ' + C.cyan + '/protocol' + C.reset + C.gray + '    改协议：openai | anthropic | responses' + C.reset + '\n')
    ui.write('  ' + C.cyan + 'Ctrl+I' + C.reset + C.gray + '   补全命令名或文件路径' + C.reset + '\n')
    ui.write('  ' + C.cyan + 'Ctrl+P/N' + C.reset + C.gray + ' 上一条 / 下一条输入历史' + C.reset + '\n')
    ui.write('  ' + C.cyan + 'Ctrl+X' + C.reset + C.gray + '   保存会话并重启' + C.reset + '\n\n')
    return true
  } catch (e) {
    if (aborted) return false
    process.stdout.write('\n' + C.red + '配置向导出错: ' + (e?.message || String(e)) + C.reset + '\n')
    return false
  } finally {
    // 恢复终端：关 raw、清 data 监听、显示光标
    vs.dispose()
  }
}
