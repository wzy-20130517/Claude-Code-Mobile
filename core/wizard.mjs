/**
 * 交互式向导：一条命令后分步收集输入，提示【原地替换】而不是往下追加。
 *
 * 为什么不用 askUser：那个是给 AI 提问用的（走 printAbove 往下堆），
 * 而向导是纯本地流程，不该经过模型，也不该把屏幕越堆越长。
 *
 * 显示方式：用全屏渲染器的实时块（updateLiveBlock）。它的语义就是
 * 「截回块起点再重写」，天然就是原地替换 —— 第 1 步问 URL，
 * 第 2 步的 key 提示直接把 URL 那块覆盖掉，不留残影。
 *
 * 用法：
 *   const answers = await runWizard({ rl, fsSession, C, steps: [
 *     { key: 'url',   label: 'API 地址', hint: 'https://api.example.com/v1', required: true },
 *     { key: 'apiKey', label: 'API Key', secret: true },
 *     { key: 'model', label: '模型名称', hint: 'gpt-4o' },
 *   ], title: '添加 Provider' })
 *   // 用户中途 Esc / Ctrl+C → 返回 null
 *
 * 步骤类型：
 *   普通      — 一问一答，空输入取 default
 *   options   — 枚举，输编号选
 *   multi     — 同一项逐个收（如 key 池），空行结束，答案是数组
 *   when(a)   — 条件步骤：返回 false 则整步跳过（用于分支流程）
 *
 * 参数：
 *   showStepCounter  false 时隐藏标题里的 (n/N)。带 when 分支时总步数会变，
 *                    显示固定分母会误导用户，这种流程建议关掉。
 *
 * 【为什么用历史栈而不是 idx--】对齐官方 WizardProvider 的 navigationHistory：
 * 有 when 分支时步骤序号不连续，`idx--` 会退到一个本该被跳过的步骤上；
 * 而且分支流程里"上一步"未必是 idx-1。压栈记录真实走过的路径才退得准。
 */

/** 单个步骤的校验：返回错误字符串表示不通过，返回 null 表示通过 */
function validateStep(step, value) {
  if (step.required && !value) return `${step.label} 不能为空`
  if (step.validate) {
    try {
      const r = step.validate(value)
      if (typeof r === 'string') return r
      if (r === false) return `${step.label} 格式不正确`
    } catch (e) {
      return String(e?.message || e)
    }
  }
  return null
}

/** 敏感值打码，避免 key 明文留在屏幕和历史里 */
function maskValue(v) {
  const s = String(v || '')
  if (s.length <= 8) return '*'.repeat(s.length)
  return s.slice(0, 4) + '*'.repeat(Math.min(s.length - 8, 20)) + s.slice(-4)
}

/**
 * 非交互模式开关。Agent 通过 CommandExec 调 slash 命令时置位。
 *
 * 【为什么必须有】向导的 Promise 只能由 rl.onEnter / rl._wizardCancel 兑现，
 * 而 Agent 场景下没有人按回车 → Promise 永不 resolve，整个 agent.run 卡到工具超时。
 * 更糟的是 runWizard 会把 rl.onEnter 换成自己的处理器，于是**真实用户之后每次回车
 * 都在喂这个看不见的向导**，而不是发消息。所以不能"静默等待"，必须直接失败。
 */
let nonInteractive = false

/**
 * 「交互被上层接管」模式 —— 用于 Web。
 *
 * 【与 withNonInteractive 的区别，别混用】
 *   withNonInteractive：**真的没有交互**（Agent 的 CommandExec、QQ 桥）。
 *     命令必须立刻失败并给出「改用带参写法」的提示，因为等不到任何人按键。
 *   withDelegatedInteraction：**有交互，只是不在终端里**（Web 前端弹窗）。
 *     命令可以正常走到 runSelect / runWizard，由 ctx 上的实现把
 *     「要选什么」序列化成 HTTP 响应发给浏览器，用户点完再回填。
 *
 * 【为什么需要这个】
 * `/model` 无参在 CLI 是「拉 {url}/models → ↑↓ 选 → Enter 切换」。
 * Web 端原先直接调 withNonInteractive，于是 model-list.mjs:228 的
 * `if (isNonInteractive())` 提前短路，返回一段「非交互环境用不了」的文本 ——
 * 用户看到的就是「打 /model 不弹列表，只给我一段说明」。
 *
 * 两者对 isNonInteractive() 的返回都是 true（命令内部做「不能阻塞等待」的判断
 * 时仍然安全），区别在于 runSelect / runWizard 会被 ctx 的实现接管而不是抛错。
 */
let delegatedInteraction = false

/** 在非交互模式下执行 fn（Agent 侧用）。保证异常/正常都会复位，支持嵌套。 */
export async function withNonInteractive(fn) {
  const prev = nonInteractive
  nonInteractive = true
  try { return await fn() } finally { nonInteractive = prev }
}

/**
 * 在「交互由上层接管」模式下执行 fn（Web 侧用）。
 * 命令可以走到选择/向导，由 ctx.runSelect / ctx.runWizard 序列化出去。
 */
export async function withDelegatedInteraction(fn) {
  const prevN = nonInteractive
  const prevD = delegatedInteraction
  nonInteractive = true
  delegatedInteraction = true
  try { return await fn() } finally {
    nonInteractive = prevN
    delegatedInteraction = prevD
  }
}

export function isNonInteractive() { return nonInteractive }

/** 当前是否处于「交互由上层接管」模式（Web）。命令可用它决定走哪条分支。 */
export function isDelegatedInteraction() { return delegatedInteraction }

/** 向导/选择器在非交互环境下应抛出的错误，调用方可据此给出带参写法提示 */
export class NonInteractiveError extends Error {
  constructor(what = '该命令') {
    super(`${what} 需要交互式向导，无法在非交互环境（如 Agent 调用）中运行。请改用带参数的写法一次性给全。`)
    this.name = 'NonInteractiveError'
    this.nonInteractive = true
  }
}

export async function runWizard({ rl, fsSession, C, steps, title = '设置向导', showStepCounter = true }) {
  if (!Array.isArray(steps) || !steps.length) return {}
  // 非交互环境立刻失败，不要挂起等一个永远不会来的回车
  if (nonInteractive) throw new NonInteractiveError(title)
  const answers = {}
  let idx = 0
  let errorMsg = null
  // 走过的步骤序号（官方 navigationHistory）。回退 = 弹栈，而不是 idx--
  const history = []

  /** 该步是否启用：when(answers) 返回 false 就整步跳过 */
  const enabled = (st) => {
    if (typeof st?.when !== 'function') return true
    try { return st.when(answers) !== false } catch { return true }
  }

  /** 从 from 起找下一个启用的步骤，没有则返回 steps.length（收尾） */
  const nextEnabled = (from) => {
    let i = from
    while (i < steps.length && !enabled(steps[i])) i++
    return i
  }

  const dim = C?.dim || '\x1b[2m'
  const reset = C?.reset || '\x1b[0m'
  const claude = C?.claude || '\x1b[38;2;215;119;87m'
  const green = C?.green || '\x1b[32m'
  const red = '\x1b[38;5;203m'

  // 画当前这一屏：标题 + 已完成项 + 当前提问 + 剩余项
  const paint = () => {
    const lines = []
    // 计数只算启用的步骤：带 when 分支时把被跳过的也算进分母会让用户等一个永远不来的步骤
    let counter = ''
    if (showStepCounter) {
      const total = steps.filter(enabled).length
      const pos = steps.slice(0, idx + 1).filter(enabled).length
      counter = ` ${dim}(${pos}/${total})${reset}`
    }
    // 官方 Pane 风格：圆角边框（╭╰）+ 单线内容区
    lines.push(`${claude}╭ ${title}${reset}${counter}`)
    steps.forEach((st, i) => {
      // 被 when 跳过的步骤根本不展示（否则用户以为还要填）
      if (!enabled(st)) return
      // 已完成 = 真的走过（在 history 里），不能用 i < idx ——
      // 有分支时被跳过的步骤也满足 i < idx，会被误打上 ✓
      const done = history.includes(i)
      const cur = i === idx
      if (done) {
        // multi 的答案是数组，直接拼字符串会变逗号串，改报个数
        let shown
        if (st.multi) {
          const got = Array.isArray(answers[st.key]) ? answers[st.key] : []
          shown = got.length ? `${got.length} 个` : `${dim}(跳过)${reset}`
        } else {
          shown = st.secret ? maskValue(answers[st.key]) : (answers[st.key] || `${dim}(跳过)${reset}`)
        }
        lines.push(`${dim}│${reset} ${green}✓${reset} ${dim}${st.label}${reset} ${shown}`)
      } else if (cur) {
        // 官方 ListItem：焦点步骤用 ❯ 指针
        lines.push(`${dim}│${reset} ${claude}❯ ${st.label}${reset}${st.required ? red + ' *' + reset : ''}`)
        if (st.hint) lines.push(`${dim}│   例: ${st.hint}${reset}`)
        if (st.desc) lines.push(`${dim}│   ${st.desc}${reset}`)
        // 枚举型步骤：列出选项，输入编号即可（不用记名字）
        if (Array.isArray(st.options) && st.options.length) {
          st.options.forEach((op, oi) => {
            const val = typeof op === 'string' ? op : op.value
            const lb = typeof op === 'string' ? op : (op.label || op.value)
            const mark = String(answers[st.key] ?? st.default) === String(val) ? `${green}·${reset}` : ' '
            lines.push(`${dim}│   ${mark}${oi + 1}) ${lb}${reset}`)
          })
        }
        // multi：把已收到的列出来，否则用户不知道输到第几个了
        if (st.multi) {
          const got = Array.isArray(answers[st.key]) ? answers[st.key] : []
          got.forEach((v, gi) => {
            lines.push(`${dim}│   ${green}${gi + 1}.${reset} ${st.secret ? maskValue(v) : v}`)
          })
          // 明说「可一次粘贴多个」——不写用户就会以为必须逐个手打（触屏上等于放弃）
          const multiTip = st.multiSplit === false
            ? (got.length ? '继续输下一个，直接回车结束' : '逐个输入，直接回车结束')
            : (got.length ? '还可继续贴，直接回车结束' : '可一次贴多个（空格/换行分隔），回车结束')
          lines.push(`${dim}│   ${multiTip}${reset}`)
        }
        if (errorMsg) lines.push(`${dim}│   ${red}${errorMsg}${reset}`)
      } else {
        lines.push(`${dim}│   ${st.label}${reset}`)
      }
    })
    const nav = history.length ? '输入 - 返回上一步 · Ctrl+C 取消' : 'Ctrl+C 取消'
    lines.push(`${dim}╰ ${nav}${reset}`)
    // 实时块 = 截回起点重写，所以这里是整屏原地替换
    if (fsSession) {
      try { fsSession.updateLiveBlock(lines) } catch {}
    } else {
      // 非全屏模式退化：只打当前一步，避免刷屏
      const st = steps[idx]
      if (!st) return   // idx 越界（已收尾）时别崩
      process.stdout.write(`${claude}${st.label}${reset}${st.hint ? dim + ' (例: ' + st.hint + ')' + reset : ''}\n`)
    }
  }

  return new Promise((resolve) => {
    const prevOnEnter = rl.onEnter
    const prevPrompt = rl.prompt

    const finish = (result) => {
      rl.onEnter = prevOnEnter
      // ★ 2026-09-29 修「打断要按两次」：向导正常完成后必须清掉 _wizardCancel。
      //   原来只有 select.mjs 的 finish 清了 _selectCancel，wizard 这里漏了 →
      //   跑过一次向导（如 /config provider add）后钩子残留，之后 AI 跑任务
      //   按 Ctrl+C 先命中「if (rl._wizardCancel)」分支，弹 [已取消] 吃掉这次
      //   按键（调的是已完成向导的陈旧 finish，无害但白费一次），第二次 Ctrl+C
      //   才到 processing 分支真打断。清掉它，第一次 Ctrl+C 就直达打断。
      rl._wizardCancel = null
      if (fsSession) {
        // keep:false —— 向导过程是过渡态，结果由调用方给出一行总结
        try { fsSession.endLiveBlock({ keep: false }) } catch {}
      }
      rl.setPrompt(prevPrompt)
      resolve(result)
    }

    // 暴露取消入口，供 Ctrl+C 处理器调用
    rl._wizardCancel = () => finish(null)

    /**
     * 前进一步：把当前步压入 history（供回退弹栈），跳到下一个启用的步骤。
     * 所有"答完进下一步"的分支都必须走这里，别再自己 idx++ ——
     * 漏压栈会让回退退错位置，漏 nextEnabled 会停在本该跳过的步骤上。
     */
    const advance = () => {
      history.push(idx)
      idx = nextEnabled(idx + 1)
      if (idx >= steps.length) return finish(answers)
      paint()
      rl.render()
    }

    rl.onEnter = (line) => {
      const raw = String(line || '').trim()
      const st = steps[idx]

      // 【回退】对齐官方 WizardProvider.goBack：弹 navigationHistory，而不是 idx--。
      // 官方用 Esc/左键，这里用输入 `-` 或 `..`（终端里更好敲）。
      if ((raw === '-' || raw === '..') && history.length) {
        idx = history.pop()
        // 清掉要重填那一步的旧答案：留着的话用户空输入会取 default 而不是原值，
        // 但已完成行又显示着旧值，两边不一致
        delete answers[steps[idx]?.key]
        errorMsg = null
        paint()
        rl.render()
        return
      }

      // 【multi】同一步反复收：非空就 push 并留在当前步，空行才进下一步
      //
      // 【为什么要拆分】原来一行只收一个值，可手机上的真实行为是**粘贴一批**
      // ——从别处复制三四个 sk- 长串过来，中间是空格或换行。原实现会把整串
      // 当成单个 key 存进池子，而且不报错，等到发请求才 401，极难归因。
      // 逐个手打 sk- 在触屏上根本不现实，所以「一次粘贴一批」才是主路径。
      // 分隔符认空格 / 逗号 / 换行（终端粘贴多行时换行也可能一次到达）。
      // st.multiSplit === false 可关掉（值本身含空格的场景，如多个描述）。
      if (st.multi) {
        const got = Array.isArray(answers[st.key]) ? answers[st.key] : (answers[st.key] = [])
        if (raw) {
          const chunks = st.multiSplit === false ? [raw] : raw.split(/[\s,]+/).filter(Boolean)
          let added = 0, dup = 0, firstErr = null
          for (const c of chunks) {
            const err = validateStep(st, c)
            if (err) { if (!firstErr) firstErr = err; continue }
            if (got.includes(c)) { dup++; continue }
            got.push(c)
            added++
          }
          // 批量粘贴时逐条报错会刷屏，汇总成一句：加了几个、重复几个、错在哪
          if (firstErr) errorMsg = chunks.length > 1 ? `已加 ${added} 个，有项不合格：${firstErr}` : firstErr
          else if (dup && !added) errorMsg = dup > 1 ? `${dup} 项都已在列表里，已忽略` : '该项已在列表里，已忽略'
          else if (dup) errorMsg = `已加 ${added} 个，跳过 ${dup} 个重复`
          else errorMsg = null
          paint()
          rl.render()
          return
        }
        if (st.required && !got.length) {
          errorMsg = `${st.label} 至少需要 1 项`
          paint()
          rl.render()
          return
        }
        errorMsg = null
        return advance()
      }

      // 空输入：必填项报错留在原地，选填项跳过
      let value = raw || (st.default ?? '')
      // 枚举型步骤：输入编号 → 映射成真实值
      if (Array.isArray(st.options) && /^\d+$/.test(raw)) {
        const pick = st.options[parseInt(raw, 10) - 1]
        if (pick !== undefined) value = typeof pick === 'string' ? pick : pick.value
      }
      const err = validateStep(st, value)
      if (err) {
        errorMsg = err
        paint()
        rl.render()
        return
      }

      answers[st.key] = value
      errorMsg = null
      advance()
    }

    if (fsSession) {
      try { fsSession.beginLiveBlock() } catch {}
    }
    // 首步也可能带 when（条件不满足就该从第二步开始）
    idx = nextEnabled(0)
    if (idx >= steps.length) return finish(answers)
    paint()
    rl.setPrompt('  ❯ ')
    rl.render()
  })
}
