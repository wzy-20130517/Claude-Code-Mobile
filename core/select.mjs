/**
 * 交互式选择列表，对齐官方 components/select.js 与 SelectMulti.js。
 *
 * 官方 101 个命令里 56 个是 local-jsx（交互式面板），其中 select 用量第二高
 * （20 处），我们原来完全没有 —— /config、/model、/font 这些都得手打编号。
 *
 * 设计要点：
 * - 上下键移动，Enter 确认，Ctrl+C 取消（返回 null）
 * - 数字键 1-9 直接跳选（移动端敲方向键累，这是我们比官方多的一条）
 * - 超过 visibleRows 时窗口滚动，并显示 ↑/↓ 提示还有多少项
 * - 画面用实时块整块重写 = 原地替换，不往下堆
 * - multi:true 时空格切换勾选，Enter 提交全部
 */

import { isNonInteractive, isDelegatedInteraction, NonInteractiveError } from './wizard.mjs'

/**
 * 「选择器委托器」—— Web 端在启动命令前注册进来，runSelect 遇到委托模式时调它。
 *
 * 【为什么用注册而不是让调用方传 ctx】
 * runSelect 有 6 个调用点，其中 model-list.mjs 是**直接 import** 的
 *（`import { runSelect } from './select.mjs'`），签名里根本没有 ctx ——
 * 那是 CLI 的调用方式，为 Web 去改所有调用点的签名会污染 CLI 侧。
 *
 * 注册器的语义：「如果你能把这次选择序列化给浏览器，就你来；
 * 不能（比如 CLI 环境）就返回 null，我继续按终端流程走」。
 *
 * @type {null | ((o: object) => Promise<never> | null)}
 */
let selectDelegate = null

/** Web 端在跑命令前注册；传 null 注销。返回上一个（便于嵌套时恢复）。 */
export function setSelectDelegate(fn) {
  const prev = selectDelegate
  selectDelegate = fn
  return prev
}

const A = {
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  claude: '\x1b[38;2;215;119;87m',
  green: '\x1b[32m',
  cyan: '\x1b[38;5;110m',
}

/**
 * @param {object}   o
 * @param {object}   o.rl          readline 实例
 * @param {object}   o.fsSession   全屏适配器（没有则退化为纯文本列出）
 * @param {string}   o.title       标题
 * @param {Array}    o.items       [{ value, label, hint?, disabled? }] 或字符串数组
 * @param {number}   [o.initial]   初始高亮下标
 * @param {boolean}  [o.multi]     多选模式
 * @param {number}   [o.visibleRows] 可见行数，默认 8
 * @returns {Promise<any|any[]|null>} 单选返回 value，多选返回 value[]，取消返回 null
 */
export async function runSelect({
  rl, fsSession, title = '请选择', items = [],
  initial = 0, multi = false, visibleRows = 8, footer = null,
  // 【Web 用】选中后干什么。CLI 忽略这两个字段（它直接 return 值给调用方继续跑）；
  // Web 跨请求，必须把意图带给服务端，见 web/command-adapter.mjs 的 SelectRequired。
  action = null, meta = null,
}) {
  const list = items.map((it) => (
    typeof it === 'string' ? { value: it, label: it } : it
  )).filter(Boolean)
  if (!list.length) return null
  // 【2026-09-20】委托模式（Web）：把列表交给上层序列化给前端，而不是抛错。
  // 顺序很重要 —— 必须在下面的 isNonInteractive() 检查**之前**，
  // 因为委托模式下 isNonInteractive() 也是 true（命令内部做「不能阻塞等待」
  // 判断时仍要安全），先判它就会把 Web 也当成"没人能按键"。
  if (isDelegatedInteraction() && selectDelegate) {
    return selectDelegate({ title, items: list, initial, multi, footer, visibleRows, action, meta })
  }
  // 与 runWizard 同理：非交互环境下等不到按键，直接失败而不是挂死
  if (isNonInteractive()) throw new NonInteractiveError(title)

  let cursor = Math.min(Math.max(0, initial), list.length - 1)
  const checked = new Set(
    multi ? list.map((it, i) => (it.checked ? i : -1)).filter(i => i >= 0) : []
  )
  // 滚动窗口的起点
  let top = 0

  const clampTop = () => {
    if (cursor < top) top = cursor
    else if (cursor >= top + visibleRows) top = cursor - visibleRows + 1
    top = Math.max(0, Math.min(top, Math.max(0, list.length - visibleRows)))
  }

  const paint = () => {
    clampTop()
    const lines = []
    const counter = list.length > visibleRows
      ? ` ${A.dim}(${cursor + 1}/${list.length})${A.reset}`
      : ''
    lines.push(`${A.claude}╭ ${title}${A.reset}${counter}`)

    if (top > 0) lines.push(`${A.dim}│  ↑ 还有 ${top} 项${A.reset}`)

    const end = Math.min(list.length, top + visibleRows)
    for (let i = top; i < end; i++) {
      const it = list[i]
      const on = i === cursor
      // 数字键直选前缀：前 9 项单数字，10 起用两位数字。
      //
      // ⚠ 原来只给 i<9 显示编号，第 10 项起前缀是空白 —— 用户看到的就是
      // 「1..9 之后没法继续」：parseInt 明明支持 10+，但界面上没有编号可敲。
      // 10 起不缩位，保持编号始终可见、可直选。
      const num = `${A.dim}${i + 1}${A.reset} `
      const box = multi
        ? (checked.has(i) ? `${A.green}✓ ${A.reset}` : `${A.dim}  ${A.reset}`)
        : ''
      // 官方 ListItem：焦点行用 ❯ 指针（suggestion 色），非焦点行空格占位
      const arrow = on ? `${A.claude}❯${A.reset}` : ' '
      const label = it.disabled
        ? `${A.dim}${it.label}${A.reset}`
        : on ? `${A.bold}${it.label}${A.reset}` : it.label
      const hint = it.hint ? ` ${A.dim}${it.hint}${A.reset}` : ''
      lines.push(`${A.dim}│${A.reset}${arrow}${num}${box}${label}${hint}`)
      // 官方 SelectOption：description 显示在 label 下方，缩进 2，inactive 色
      if (it.description && on) {
        lines.push(`${A.dim}│    ${it.description}${A.reset}`)
      }
    }

    const rest = list.length - end
    if (rest > 0) lines.push(`${A.dim}│  ↓ 还有 ${rest} 项${A.reset}`)

    const keys = multi
      ? '空格 勾选 · Enter 提交 · Ctrl+C 取消'
      : '↑↓ 移动 · 数字键直选 · Enter 确认 · Ctrl+C 取消'
    lines.push(`${A.dim}╰ ${footer || keys}${A.reset}`)

    if (fsSession) {
      try { fsSession.updateLiveBlock(lines) } catch {}
    } else {
      process.stdout.write(lines.join('\n') + '\n')
    }
  }

  return new Promise((resolve) => {
    const prevOnEnter = rl.onEnter
    const prevOnArrow = rl.onArrow

    const finish = (result) => {
      rl.onEnter = prevOnEnter
      rl.onArrow = prevOnArrow
      rl._selectCancel = null
      if (fsSession) {
        // keep:false —— 选择过程是过渡态，结果由调用方给出一行总结
        try { fsSession.endLiveBlock({ keep: false }) } catch {}
      }
      resolve(result)
    }

    rl._selectCancel = () => finish(null)

    // 返回 true = 拦截该按键，不让 readline 走历史翻页
    rl.onArrow = (dir) => {
      if (dir === 'up') { cursor = (cursor - 1 + list.length) % list.length; paint(); return true }
      if (dir === 'down') { cursor = (cursor + 1) % list.length; paint(); return true }
      return true
    }

    rl.onEnter = (line) => {
      const raw = String(line || '').trim()

      // 数字键直选：移动端敲方向键累，这条比官方多
      if (/^\d+$/.test(raw)) {
        const n = parseInt(raw, 10) - 1
        if (n >= 0 && n < list.length) {
          if (multi) {
            if (checked.has(n)) checked.delete(n); else checked.add(n)
            cursor = n
            paint(); rl.render(); return
          }
          if (list[n].disabled) { paint(); rl.render(); return }
          return finish(list[n].value)
        }
        paint(); rl.render(); return
      }

      // 多选：空格切换当前项
      if (multi && raw === '') {
        // 空 Enter = 提交
        return finish([...checked].sort((a, b) => a - b).map(i => list[i].value))
      }
      if (multi && (raw === ' ' || raw === 'x')) {
        if (checked.has(cursor)) checked.delete(cursor); else checked.add(cursor)
        paint(); rl.render(); return
      }

      if (list[cursor]?.disabled) { paint(); rl.render(); return }
      return finish(list[cursor].value)
    }

    if (fsSession) {
      try { fsSession.beginLiveBlock() } catch {}
    }
    paint()
    rl.render()
  })
}
