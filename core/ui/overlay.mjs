// 通用弹层容器（对齐官方 HelpV2 / Dialog / Pane 模式）
//
// 官方 144 个组件里所有"面板类"UI 共用一套骨架：
//   Pane 圆角边框 + 内容滚动 + 关闭键 + (可选) 切页键
// 我们此前没有这个容器，所以 /help 只能一屏甩纯文本、命令面板做不了。
//
// 【键位必须迁就 Termux 键盘】官方那套用 Tab 切页、Esc 关闭，
// 但 Termux 上这两个键压根不存在，照搬等于弹层开了就关不掉。
// 所以：q / Ctrl+C 关闭，n·p·l·h·Ctrl+I 切页，全是软键盘上有的键。
//
// 设计：
//   - openOverlay() 接管 rl.onEnter/onArrow/按键，q 或 Ctrl+C 关闭
//   - 内容是 lines 数组，超可视高度时滚动（↑↓）；装得下时不吞键，交回外层滚正文
//   - tabs 传入时可切页（页名 -> lines 工厂）
//   - 全程 updateLiveBlock 原地刷新，结束后 endLiveBlock({keep:false})
//   - 非交互环境（Agent / QQ 私聊）直接抛 NonInteractiveError：
//     那些场景没人能按键，真开了弹层会把终端的回车全吃掉
//
// 用法：
//   const result = await openOverlay({ rl, fsSession, C, title, tabs: {...} })
//   // result: { closed: true } —— 目前仅关闭语义；选择类用 runSelect
import { isNonInteractive, NonInteractiveError } from '../commands/wizard.mjs'

const A = {
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  claude: '\x1b[38;2;215;119;87m',
  green: '\x1b[32m',
  cyan: '\x1b[38;5;110m',
}

/**
 * 打开一个弹层。tabs 为空时是单页滚动内容；有 tabs 时 Tab 键切页。
 * @param {object}   o.rl
 * @param {object}   o.fsSession     全屏适配器（无则退化为静态打印后立即返回）
 * @param {object}   o.C             颜色常量
 * @param {string}   o.title
 * @param {string[]|Function} o.lines  内容行数组，或 (pageName)=>lines 工厂（tabs 模式）
 * @param {Object<string,string[]>|Object<string,Function>} o.tabs  页名->内容
 * @param {string[]} o.tabOrder      页顺序（默认 Object.keys(tabs)）
 * @param {number}   o.visibleRows   内容可视行数（默认自适应 14）
 * @returns {Promise<{closed:true, page?:string}>}
 */
export async function openOverlay({
  rl, fsSession, C = A, title, lines, tabs = null, tabOrder = null,
  visibleRows = 14,
}) {
  if (isNonInteractive()) throw new NonInteractiveError(title || 'overlay')
  if (!fsSession) {
    // 无全屏：静态打印后立即返回（不接管按键）
    const body = typeof lines === 'function' ? lines() : (lines || [])
    process.stdout.write(body.join('\n') + '\n')
    return { closed: true }
  }

  const pages = tabs ? (tabOrder || Object.keys(tabs)) : null
  let pageIdx = 0
  let scroll = 0

  const bodyLines = () => {
    if (!tabs) return typeof lines === 'function' ? lines() : (lines || [])
    const key = pages[pageIdx]
    const t = tabs[key]
    return typeof t === 'function' ? t(key) : (t || [])
  }

  const paint = () => {
    const body = bodyLines()
    const maxScroll = Math.max(0, body.length - visibleRows)
    scroll = Math.min(scroll, maxScroll)
    const L = []
    const tabRow = pages
      ? '  ' + pages.map((p, i) => (i === pageIdx ? `${A.bold}[${p}]${A.reset}` : `${A.dim}${p}${A.reset}`)).join(' ')
      : ''
    L.push(`${A.claude}╭ ${title}${A.reset}${tabRow}`)
    if (scroll > 0) L.push(`${A.dim}│  ↑ 还有 ${scroll} 行${A.reset}`)
    const end = Math.min(body.length, scroll + visibleRows)
    for (let i = scroll; i < end; i++) L.push(`${A.dim}│${A.reset} ${body[i]}`)
    if (end < body.length) L.push(`${A.dim}│  ↓ 还有 ${body.length - end} 行${A.reset}`)
    // 键位提示只写**真的接了线**的键。
    //
    // 【历史教训】这里先后写错过两版：
    //   v1「Tab 切页 · Esc 关闭」→ Termux 键盘没有这两个键
    //   v2「n/p 或 ^I 切页 · q 关闭」→ q/n/p 是裸字母，readline 里
    //      压根没往 _overlayTab 派发，提示写了但按下去毫无反应；
    //      而且裸字母跟正常打字冲突（想输入 q 就把弹层关了）、
    //      p/n 又和 Ctrl+P/N 翻历史撞。
    // 现在只用 Ctrl 组合键：^I 下一页、^H 上一页、^C 关闭。
    // 这三个都在 readline 的 Ctrl 分派表里真实接线，且不占用普通输入。
    const nav = pages
      ? '←→ 切页 · ↑↓ 滚动 · ^C 关闭'
      : '↑↓ 滚动 · ^C 关闭'
    L.push(`${A.dim}╰ ${nav}${A.reset}`)
    try { fsSession.updateLiveBlock(L) } catch {}
  }

  return new Promise((resolve) => {
    const prevOnEnter = rl.onEnter
    const prevOnArrow = rl.onArrow

    const close = () => {
      rl.onEnter = prevOnEnter
      rl.onArrow = prevOnArrow
      rl._overlayTab = null
      rl._selectCancel = null
      try { fsSession.endLiveBlock({ keep: false }) } catch {}
      resolve({ closed: true, page: pages ? pages[pageIdx] : undefined })
    }

    rl._selectCancel = close   // Ctrl+C 处理器走的取消通道
    // Ctrl+I / Ctrl+H 也保留切页（^I 本来就是 Tab 的编码，习惯了的人还能用）
    rl._overlayTab = (key) => {
      if (!pages) return
      if (key === '\t') { pageIdx = (pageIdx + 1) % pages.length; scroll = 0; paint(); rl.render(); return }
      if (key === 'h') { pageIdx = (pageIdx - 1 + pages.length) % pages.length; scroll = 0; paint(); rl.render(); return }
    }
    rl.onArrow = (dir) => {
      // ←→ 切页。
      // 弹层里左右键本来没用（不在编辑输入行），拿来切页最直观，
      // 也避开了裸字母键（跟打字冲突）和 Ctrl+P/N（跟翻历史冲突）。
      if (pages && (dir === 'left' || dir === 'right')) {
        pageIdx = dir === 'right'
          ? (pageIdx + 1) % pages.length
          : (pageIdx - 1 + pages.length) % pages.length
        scroll = 0
        paint()
        rl.render()
        return true
      }
      // 【弹层开着时上下键一律归弹层，不放给正文】
      //
      // 之前为了"避免吞键"写成「内容装得下就 return false」，方向错了：
      // 那一刻上下键会漏给外层去滚背景正文 —— 弹层还盖在屏幕上，
      // 背后的正文却在动，用户完全不知道自己在操作什么。
      // 模态弹层的正确语义是**独占方向键**：内容能滚就滚，滚不动就什么都不做，
      // 但绝不把键交出去。要看正文先 ^C 关掉弹层。
      const body = bodyLines()
      const maxScroll = Math.max(0, body.length - visibleRows)
      if (dir === 'up') { scroll = Math.min(maxScroll, scroll + 3); paint(); return true }
      if (dir === 'down') { scroll = Math.max(0, scroll - 3); paint(); return true }
      return true   // 其余方向也吞掉，保持模态
    }
    rl.onEnter = () => {}   // Enter 在弹层里无操作，防误提交
    paint()
    rl.render()
  })
}
