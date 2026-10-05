// 命令面板（对齐官方 QuickOpenDialog / GlobalSearchDialog 思路）
//
// 移动端打字累：Ctrl+I 补全要求记住命令前缀，命令面板只要打关键词。
// 模糊匹配：子串命中即可，按「前缀命中 > 越早命中 > 名字短」排序。
// Enter 执行高亮命令，^C 关闭，↑↓ 换选中项。
// （不是 Esc —— Termux 键盘没有 Esc 键，关闭实际走 rl._selectCancel = Ctrl+C）
//
// 依赖 overlay 不依赖 overlay：自带 paint 循环（要实时跟随输入，和
// openOverlay 的纯滚动弹层不同构，复用会互相扭曲）。
import { isNonInteractive, NonInteractiveError } from './wizard.mjs'

const A = {
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  claude: '\x1b[38;2;215;119;87m',
}

/**
 * 模糊匹配打分：返回 null=不匹配，越大越靠前
 */
export function fuzzyScore(query, name) {
  if (!query) return 1
  const q = query.toLowerCase()
  const n = name.toLowerCase()
  const idx = n.indexOf(q)
  if (idx === -1) {
    // 子序列匹配（打 ccd 也能命中 claude-code-desktop 这类）
    let qi = 0
    for (let i = 0; i < n.length && qi < q.length; i++) {
      if (n[i] === q[qi]) qi++
    }
    if (qi === q.length) return 10 - n.length * 0.01
    return null
  }
  // 前缀命中最高，其次越早命中
  let score = 100 - idx * 5 - name.length * 0.1
  if (idx === 0) score += 50
  return score
}

/**
 * 打开命令面板。
 * @param {object}  o.rl / o.fsSession / o.C
 * @param {Array}   o.commands  [{name, desc}] 或 ['name', ...]
 * @param {Function} o.onRun    (name) => void —— 用户 Enter 时回调（由调用方执行命令）
 * @returns {Promise<{ran: string|null, closed: boolean}>}
 */
export async function openCommandPalette({ rl, fsSession, C = A, commands = [], onRun }) {
  if (isNonInteractive()) throw new NonInteractiveError('命令面板')
  // kind 决定分层：'builtin'（原生 slash）排在 'skill' 之前。
  // 用户要求：面板里 skill 往下排，原生 slash 放上面 —— 832 个 skill 混在
  // 内置命令里会把常用命令挤没，模糊匹配分数又常常让 skill 反超。
  const items = commands.map(c => typeof c === 'string'
    ? { name: c, desc: '', kind: 'builtin' }
    : { name: c.name || '', desc: c.desc || c.hint || '', kind: c.kind || 'builtin' })
    .filter(it => it.name)

  let query = ''
  let cursor = 0
  let matches = items.slice(0, 20)
  let ran = null
  const visibleRows = 12

  const refilter = () => {
    // 分层排序：先按 kind（builtin < skill），同层内才比模糊匹配分数。
    // 不能只把 skill 的分数减一个常数 —— skill 数量太多（832 个），
    // 任何固定罚分都可能被「前缀命中 +50」抵消掉，导致 skill 又插到前面。
    const KIND_ORDER = { builtin: 0, skill: 1 }
    matches = items
      .map(it => ({ it, s: fuzzyScore(query, it.name) + (it.desc && fuzzyScore(query, it.desc) ? 5 : 0) }))
      .filter(x => x.s !== null)
      .sort((a, b) => {
        const ka = KIND_ORDER[a.it.kind] ?? 0
        const kb = KIND_ORDER[b.it.kind] ?? 0
        if (ka !== kb) return ka - kb          // 原生命令永远在前
        return b.s - a.s                       // 同层按匹配度
      })
      .slice(0, 20)
      .map(x => x.it)
    if (cursor >= matches.length) cursor = Math.max(0, matches.length - 1)
  }

  const paint = () => {
    const L = []
    // 键位提示只写真能按的：关闭走 _selectCancel（Ctrl+C），Termux 没有 Esc 键
    L.push(`${A.claude}╭ 命令面板${A.reset} ${A.dim}输入过滤 · ↑↓ 选择 · Enter 执行 · ^C 关闭${A.reset}`)
    L.push(`${A.dim}│${A.reset} ❯ ${query}${A.claude}▏${A.reset}`)
    const end = Math.min(matches.length, visibleRows)
    for (let i = 0; i < end; i++) {
      const it = matches[i]
      const on = i === cursor
      const arrow = on ? `${A.claude}❯${A.reset}` : ' '
      const label = on ? `${A.bold}/${it.name}${A.reset}` : `/${it.name}`
      // skill 标一下来源：面板里原生命令和 skill 混排时，不标用户分不清
      // 哪个是内置功能、哪个是提示词模板
      const tag = it.kind === 'skill' ? ` ${A.dim}[skill]${A.reset}` : ''
      const desc = it.desc ? ` ${A.dim}${it.desc.slice(0, 40)}${A.reset}` : ''
      L.push(`${A.dim}│${A.reset}${arrow} ${label}${tag}${desc}`)
    }
    if (!matches.length) L.push(`${A.dim}│  （无匹配命令）${A.reset}`)
    if (matches.length > visibleRows) L.push(`${A.dim}│  ↓ 还有 ${matches.length - visibleRows} 个${A.reset}`)
    L.push(`${A.dim}╰ ${matches.length} 个匹配${A.reset}`)
    try { fsSession.updateLiveBlock(L) } catch {}
  }

  return new Promise((resolve) => {
    const prevOnEnter = rl.onEnter
    const prevPrompt = rl.prompt

    const close = (ranName) => {
      rl.onEnter = prevOnEnter
      rl.setPrompt(prevPrompt)
      rl._paletteInput = null
      rl._paletteMove = null
      rl._selectCancel = null
      try { fsSession.endLiveBlock({ keep: false }) } catch {}
      resolve({ ran: ranName || null, closed: !ranName })
    }

    if (isNonInteractive()) return close(null)
    rl._selectCancel = () => close(null)

    // 输入实时进面板（不走 readline.line，避免和主输入行互相污染）
    rl._paletteInput = (text) => {
      if (text === '\b' || text === '\x7f') {
        query = query.slice(0, -1)
      } else {
        query += text
      }
      cursor = 0
      refilter()
      paint()
      rl.render()
    }
    rl._paletteMove = (dir) => {
      if (dir === 'up') cursor = Math.max(0, cursor - 1)
      else cursor = Math.min(matches.length - 1, cursor + 1)
      paint()
      rl.render()
    }

    rl.onArrow = (dir) => {
      if (dir === 'up') { rl._paletteMove?.('up'); return true }
      if (dir === 'down') { rl._paletteMove?.('down'); return true }
      return true
    }
    rl.onEnter = (line) => {
      const raw = String(line || '').trim()
      // 数字直选（移动端友好）
      if (/^\d+$/.test(raw)) {
        const n = parseInt(raw, 10) - 1
        if (n >= 0 && n < matches.length) {
          ran = matches[n].name
          return close(ran)
        }
      }
      if (matches[cursor]) {
        ran = matches[cursor].name
        return close(ran)
      }
      close(null)
    }

    refilter()
    paint()
    rl.setPrompt('')   // 面板内输入行就是查询框
    rl.render()
  })
}
