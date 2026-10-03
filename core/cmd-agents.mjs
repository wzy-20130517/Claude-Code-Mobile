// /agents —— 子 Agent（subagent_type）控制命令
//
// 【为什么要有这个命令】
// 自定义角色卡 .claude/agents/*.md 只在启动时 load 一次。新建卡后不重启就 spawn，
// Agent 工具找不到该类型 → **静默退化成 general-purpose**：丢角色设定、共用记忆池，
// 而且没有任何提示。用户以为派出去的是 SRE，实际是个通用 agent。
// 这不是小瑕疵，是「用户以为做到了、其实没做到」的那类 bug，最贵。
//
// 【为什么不照搬官方】
// 官方 /agents 是多级交互 TUI（列表→详情→编辑→删除确认，还有 ↑↓ 导航页脚）。
// 手机端 40-60 列窄屏 + 触屏打字慢 + 无 Tab 键，多级菜单是负担而不是帮助：
// 每层都要看一屏、按一次方向键。这里砍成一层平铺的子命令，一屏看完，
// 常用路径（reload）只需敲 8 个字符。删除不做交互确认——手机上直接 rm 更快，
// 假确认对话框只是多一次点击。
//
// 官方保留下来的：命名（/agents）、按来源分组的概念、内置与自定义并列展示。
//
// 【为什么无参默认是「状态」而不是「角色卡清单」】
// 原来无参列的是"有哪些角色可用"，可这个问题一天问一次就够了；而"谁在跑、
// 跑了多久、卡住了吗"是每隔几分钟就要看一眼的。原本要三处拼凑才能回答：
// AgentStatus 只显示在跑的、TaskList 看任务归属、还得翻 .claude/agents/ 数卡片，
// 而"空闲的角色"和"建了卡但没 reload"这两个状态哪儿都看不到。
// 高频问题该占据零参数入口，低频的挪去 /agents cards。

import fs from 'fs'
import path from 'path'
import { runWizard, NonInteractiveError } from './wizard.mjs'

/** 内置 subagent_type：与 core/agent-tools.mjs 的 Agent 工具保持一致 */
const BUILTIN = [
  ['general-purpose', '全工具，独立完成复杂任务'],
  ['Explore', '只读，调研代码库'],
  ['Plan', '只读 + TodoWrite，制定执行计划'],
  ['Coordinator', '编排多个 worker 并行，自己做综合分析'],
]

/**
 * 生成角色卡。tools 空字符串 = 不写 tools 字段 = 继承全部工具
 * （loader 只在 meta.tools 存在时才限制工具集，见 custom-agents.mjs:42）。
 */
function buildCard({ name, description, tools = '', maxTurns = 30, body = '' }) {
  const fm = [`name: ${name}`,
              `description: ${description || `一句话说清这个角色什么时候该被派出去（Agent 工具靠这句话选人）`}`]
  if (tools) fm.push(`tools: ${tools}`)
  fm.push(`maxTurns: ${maxTurns}`)
  const content = body ? body.trim() + '\n' : `你是 ${name}。

## 你的职责
TODO：写清这个角色负责什么、不负责什么

## 你的视角
TODO：同一个现象，这个角色关注的和别人有什么不同

## 交付标准
TODO：什么算做完
`
  return `---\n${fm.join('\n')}\n---\n\n${content}`
}

/** 保留旧名，供仍按名字引用模板的地方使用 */
const TEMPLATE = (name) => buildCard({ name })

/** loader 的方法名做防御性适配，避免 loader 演进后这里静默失效 */
function listCards(loader) {
  if (!loader) return []
  try {
    const raw = typeof loader.list === 'function' ? loader.list()
      : Array.isArray(loader.agents) ? loader.agents
      : loader.agents instanceof Map ? [...loader.agents.values()] : []
    return (raw || []).filter(Boolean)
  } catch { return [] }
}

function cardName(a) { return a?.name || a?.type || '(未命名)' }

/** 人类可读耗时：2m14s 而不是 134000ms。手机上一眼要能读出量级 */
function humanMs(ms) {
  const n = Number(ms) || 0
  if (n < 1000) return `${n}ms`
  const s = Math.floor(n / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60}s`
  return `${Math.floor(m / 60)}h${m % 60}m`
}

// 空转判据：5 分钟没有任何新产出。这不是"一定卡死"——有的工具（长 Bash、
// 大文件 Read）本身就要跑几分钟——所以文案用"疑似"，把判断权留给用户。
const IDLE_SUSPECT_MS = 5 * 60 * 1000

/** 轮次接近上限时要显眼：这是"要不要 AgentStop 干预"的关键信号 */
function turnsLabel(turns, maxTurns) {
  if (!maxTurns) return turns > 0 ? `${turns} 轮` : '未完成首轮'
  const near = turns >= maxTurns * 0.8
  return `${turns}/${maxTurns} 轮${near ? ' ⚠快到上限' : ''}`
}

/**
 * 三段式实时状态。
 *
 * 为什么分三段而不是一张表：三段回答的是三个不同的问题——
 * "现在要不要干预"（在跑）、"我能派谁"（空闲）、"为什么派不动"（未加载）。
 * 混在一张表里，每次都得自己筛一遍。
 */
function renderStatus(ctx) {
  const { customAgents: loader, agentsDirs = [], bgTasks = [], keptAgents = [],
          running = 0, limit = 0, C = {} } = ctx
  const dim = C.dim || ''
  const reset = C.reset || ''
  const green = C.green || ''
  const yellow = C.yellow || C.claude || ''
  const bold = C.bold || ''

  const cards = listCards(loader)
  const loadedNames = new Set(cards.map(cardName))
  const builtinNames = new Set(BUILTIN.map(([n]) => n))

  const out = []

  // ── 段 1：在跑的 ────────────────────────────────────
  // 只取 local_agent：local_bash 是后台命令，不是子 Agent，混进来会误导
  const live = bgTasks.filter(t => t.status === 'running' || t.status === 'pending')
  out.push(`${bold}在跑的子 Agent${reset}` +
    (limit ? ` ${dim}(${running}/${limit} 并发)${reset}` : ''))
  if (!live.length) {
    out.push(`  ${dim}(无)${reset}`)
  } else {
    for (const t of live) {
      const nm = t.agentName || t.description || t.id
      const ty = t.agentType ? ` ${dim}${t.agentType}${reset}` : ''
      const icon = t.status === 'pending' ? '○' : `${green}→${reset}`
      out.push(`  ${icon} ${nm}${ty}`)
      const bits = [humanMs(t.duration_ms), turnsLabel(t.turns, t.maxTurns)]
      out.push(`    ${dim}${bits.join(' · ')}${reset}`)
      // 空转信号：正常干活的和卡死的在别处长得一模一样，这行是唯一区别
      if (t.status === 'running' && t.lastOutputAt) {
        const idle = Date.now() - t.lastOutputAt
        if (idle > IDLE_SUSPECT_MS) {
          out.push(`    ${yellow}疑似空转：${humanMs(idle)} 无新产出${reset}`)
          out.push(`    ${dim}要停就 AgentStop 或 /bg-status ${t.id}${reset}`)
        }
      }
      out.push(`    ${dim}id ${t.id}${reset}`)
    }
  }

  // ── 段 2：可派的角色（空闲）──────────────────────────
  // 在跑实例按类型归组，用来标注"这个角色有几个实例在跑"
  const busyByType = new Map()
  for (const t of live) {
    if (!t.agentType) continue
    busyByType.set(t.agentType, (busyByType.get(t.agentType) || 0) + 1)
  }
  out.push('', `${bold}可派的角色${reset} ${dim}(已加载 ${builtinNames.size + cards.length})${reset}`)
  const renderRole = (name, desc, isBuiltin) => {
    const n = busyByType.get(name) || 0
    const tag = n ? `${green} ●${n} 在跑${reset}` : `${dim} 空闲${reset}`
    out.push(`  ${name}${tag}${isBuiltin ? ` ${dim}内置${reset}` : ''}`)
    if (desc) out.push(`    ${dim}${String(desc).replace(/\s+/g, ' ').slice(0, 42)}${reset}`)
  }
  for (const [n, d] of BUILTIN) renderRole(n, d, true)
  for (const a of cards) renderRole(cardName(a), a.description, false)

  // ── 段 3：未加载（建了卡但没 reload）────────────────
  // 这个状态原来完全不可见，而后果很贵：spawn 静默退化成 general-purpose
  const unloaded = []
  for (const dir of (agentsDirs.length ? agentsDirs : [])) {
    let files = []
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')) } catch { continue }
    for (const f of files) {
      const nm = path.basename(f, '.md')
      // 卡里的 name: 字段可能和文件名不同，两边都不命中才算未加载
      if (loadedNames.has(nm)) continue
      let inner = ''
      try {
        const m = fs.readFileSync(path.join(dir, f), 'utf8').match(/^name:\s*(.+)$/m)
        inner = m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
      } catch {}
      if (inner && loadedNames.has(inner)) continue
      unloaded.push(inner || nm)
    }
  }
  if (unloaded.length) {
    out.push('', `${yellow}未加载（需 /agents reload）${reset}`)
    for (const n of unloaded) out.push(`  ! ${n}`)
    out.push(`  ${dim}没 reload 就 spawn = 静默退化成 general-purpose，角色设定全丢${reset}`)
  }

  // ── 可唤醒的（跑完但上下文还留着）─────────────────
  // 让 worker 返工该 wake 而不是重新 spawn（重开等于丢全部上下文），
  // 但"哪些还能 wake"没有任何地方能查，只能凭记忆猜
  if (keptAgents.length) {
    out.push('', `${bold}可唤醒${reset} ${dim}(跑完但上下文留着，wake 可续跑)${reset}`)
    for (const k of keptAgents) {
      const ago = k.lastRunAt ? humanMs(Date.now() - k.lastRunAt) + '前' : ''
      out.push(`  ${k.name} ${dim}${[k.type, k.messages ? `${k.messages} 条上下文` : '', ago].filter(Boolean).join(' · ')}${reset}`)
    }
  }

  out.push('', `${dim}/agents cards   看角色卡清单与详情${reset}`,
               `${dim}/agents reload  改完卡立刻生效（不用重启）${reset}`,
               `${dim}/agents new     向导建新卡${reset}`)
  return out.join('\n')
}

/**
 * 建卡向导。原来 `/agents new <名字>` 只落一个空壳模板，用户还得自己去
 * .claude/agents/*.md 手写 frontmatter（name/description/tools/maxTurns）——
 * 手机上这活基本干不了：字段名记不住、工具名一个个敲、写错了还不报错，
 * 只在 spawn 时静默退化。所以把"必须填对的部分"全改成选，正文可跳过。
 */
const TOOL_PRESETS = [
  { value: 'readonly', label: '只读调研', hint: '读代码、搜索、看图，不改文件',
    tools: 'Read, Glob, Grep, HashlineRead, HashlineGrep, RepoMap, Symbols, WebSearch, WebFetch' },
  { value: 'coder', label: '可写代码', hint: '读写改 + 跑命令 + 诊断',
    tools: 'Read, Write, Edit, MultiEdit, Glob, Grep, Bash, Test, Diagnostics, RepoMap, Symbols' },
  { value: 'full', label: '全工具', hint: '继承全部（含派子 Agent、团队协作）', tools: '' },
  { value: 'custom', label: '自定义', hint: '手填工具名，逗号分隔', tools: null },
]

async function runNewWizard(ctx, presetName = '') {
  const { agentsDirs = [], rl, fsSession, C = {} } = ctx
  const dir = agentsDirs[0] || path.join(process.cwd(), '.claude', 'agents')
  const cards = listCards(ctx.customAgents)
  const taken = new Set([...cards.map(cardName), ...BUILTIN.map(([n]) => n)])

  const answers = await runWizard({
    rl, fsSession, C,
    title: '新建子 Agent 角色卡',
    showStepCounter: false,
    steps: [
      { key: 'name', label: '角色名', required: true, hint: 'sre',
        default: presetName || '',
        desc: '就是 subagent_type，短、无空格',
        validate: v => {
          if (!/^[\w.-]+$/.test(v)) return '只能用字母数字 . _ -'
          if (taken.has(v)) return `「${v}」已存在（内置或已加载）`
          if (fs.existsSync(path.join(dir, `${v}.md`))) return `${v}.md 已存在，直接编辑它`
          return null
        } },
      { key: 'description', label: '一句话职责', required: true,
        hint: '守质量门禁，管测试基线与回归防护',
        desc: 'Agent 工具靠这句话选人，写清「什么时候该派它」' },
      { key: 'preset', label: '工具集', options: TOOL_PRESETS,
        default: 'coder', desc: '输编号选' },
      { key: 'tools', label: '工具名（逗号分隔）',
        when: a => a.preset === 'custom', required: true,
        hint: 'Read, Grep, Bash' },
      { key: 'maxTurns', label: '最大轮数', default: '30', hint: '30',
        desc: '回车用 30；复杂角色给 60-100',
        validate: v => /^\d+$/.test(v) && +v > 0 ? null : '要一个正整数' },
      { key: 'body', label: '职责正文', desc: '可留空：留空生成带 TODO 的骨架，之后再写' },
    ],
  })
  if (!answers) return '已取消'

  const preset = TOOL_PRESETS.find(p => p.value === answers.preset) || TOOL_PRESETS[1]
  const tools = answers.preset === 'custom'
    ? String(answers.tools || '').split(',').map(s => s.trim()).filter(Boolean).join(', ')
    : preset.tools
  const file = path.join(dir, `${answers.name}.md`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, buildCard({
      name: answers.name, description: answers.description,
      tools, maxTurns: answers.maxTurns, body: answers.body,
    }), 'utf8')
  } catch (e) { return `创建失败：${e.message}` }

  // reload 直接在这里做完：向导刚建的卡如果还要用户再敲一次 reload，
  // 忘了就是静默退化 —— 这正是本命令存在的理由，不该留个坑给用户踩
  let reloaded = false
  try {
    if (typeof ctx.customAgents?.reload === 'function') ctx.customAgents.reload()
    else if (typeof ctx.customAgents?.load === 'function') ctx.customAgents.load()
    reloaded = !!(ctx.onReload && ctx.onReload())
  } catch {}

  const dimC = C.dim || '', resetC = C.reset || '', greenC = C.green || ''
  return [
    `${greenC}✓${resetC} 已创建 ${answers.name}`,
    `  ${dimC}${file}${resetC}`,
    `  工具：${tools || '（继承全部）'}`,
    `  轮数：${answers.maxTurns}`,
    reloaded ? `${greenC}✓${resetC} 已重载，现在可以直接 spawn`
             : `${dimC}下一步：/agents reload 让它生效${resetC}`,
    answers.body ? '' : `${dimC}正文留空：编辑上面的文件填 TODO 处，再 /agents reload${resetC}`,
  ].filter(Boolean).join('\n')
}

/**
 * @param {string} argStr  /agents 后面的原始参数
 * @param {object} ctx {
 *   customAgents, agentsDirs, onReload,          // 角色卡
 *   bgTasks, keptAgents, running, limit,         // 实时状态（数据源同 AgentStatus 工具）
 *   rl, fsSession, C,                           // 建卡向导要占用终端
 * }
 * async：/agents new 无参会进向导，Promise 由 rl.onEnter 兑现。
 */
export async function cmdAgents(argStr = '', ctx = {}) {
  const { customAgents: loader, agentsDirs = [], onReload } = ctx
  const parts = String(argStr || '').trim().split(/\s+/).filter(Boolean)
  const sub = (parts[0] || '').toLowerCase()
  const rest = parts.slice(1).join(' ').trim()

  // ── reload：本命令存在的主要理由 ──────────────────────────
  if (sub === 'reload' || sub === 'r') {
    const before = listCards(loader).map(cardName).sort()
    try {
      if (typeof loader?.load === 'function') loader.load()
      else if (typeof loader?.reload === 'function') loader.reload()
      else return '当前版本的角色卡加载器不支持热重载，请 Ctrl+X 重启。'
    } catch (e) {
      return `重载失败：${e.message}\n卡片仍是重载前的状态，可 Ctrl+X 重启兜底。`
    }
    const after = listCards(loader).map(cardName).sort()
    const added = after.filter(n => !before.includes(n))
    const gone = before.filter(n => !after.includes(n))
    let applied = ''
    try { applied = onReload ? (onReload() || '') : '' } catch {}

    const lines = [`已重载角色卡：${after.length} 张`]
    if (added.length) lines.push(`  + 新增 ${added.join('  ')}`)
    if (gone.length) lines.push(`  - 移除 ${gone.join('  ')}`)
    if (!added.length && !gone.length) lines.push('  内容已刷新（无增减）')
    lines.push(applied ? `系统提示词已同步，现在可以直接 spawn。`
                       : `注意：本轮系统提示词未重建，AI 可能还不知道新卡；下一条消息后生效。`)
    return lines.join('\n')
  }

  // ── new：无参进向导，带名字仍走一步到位的模板 ───────────
  // 为什么保留带参路径：知道自己要什么的老用户敲 `/agents new sre` 一步就完，
  // 向导反而是负担。向导服务的是"记不住 frontmatter 有哪些字段"的场景。
  if (sub === 'new' || sub === 'add') {
    if (!rest) {
      try {
        return await runNewWizard(ctx)
      } catch (e) {
        // 非交互（Agent 走 CommandExec）：不能静默等回车，必须失败并给带参写法
        if (e instanceof NonInteractiveError || e?.nonInteractive) {
          return '非交互环境无法运行建卡向导。\n带参写法：/agents new <名字>\n（生成模板后编辑 .claude/agents/<名字>.md，再 /agents reload）'
        }
        throw e
      }
    }
    if (!/^[\w.-]+$/.test(rest)) return `名字只能用字母数字 . _ -（收到「${rest}」）`
    const dir = agentsDirs[0] || path.join(process.cwd(), '.claude', 'agents')
    const file = path.join(dir, `${rest}.md`)
    if (fs.existsSync(file)) return `已存在：${file}\n直接编辑它，然后 /agents reload。`
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, TEMPLATE(rest), 'utf8')
    } catch (e) { return `创建失败：${e.message}` }
    return `已创建 ${file}\n\n下一步：\n  /editor 或编辑器写内容\n  /agents reload   让它立刻可用（不用重启）`
  }

  const cards = listCards(loader)

  // ── 无参 / status：实时状态（高频问题占据零参数入口）────
  if (!sub || sub === 'status' || sub === 's') return renderStatus(ctx)

  // ── <名字>：看某张卡；cards/list 看清单 ────────────────
  if (sub && sub !== 'cards' && sub !== 'list' && sub !== 'ls') {
    const hit = cards.find(a => cardName(a).toLowerCase() === sub)
    if (!hit) {
      const near = cards.map(cardName).filter(n => n.toLowerCase().includes(sub))
      return `没有已加载的角色卡「${parts[0]}」。`
        + (near.length ? `\n是不是：${near.join('  ')}` : '')
        + `\n\n刚建好文件？先 /agents reload——否则 spawn 会静默退化成 general-purpose。`
    }
    const tools = Array.isArray(hit.tools) ? hit.tools.join(', ') : (hit.tools || '（继承全部）')
    const body = String(hit.prompt || hit.content || hit.systemPrompt || '').trim()
    const head = body.split('\n').slice(0, 6).join('\n')
    return [
      `${cardName(hit)}`,
      hit.description ? `\n${hit.description}` : '',
      `\n工具：${tools}`,
      hit.source || hit.file ? `来源：${hit.source || hit.file}` : '',
      head ? `\n正文开头\n${head}${body.split('\n').length > 6 ? '\n…' : ''}` : '',
    ].filter(Boolean).join('\n')
  }

  // ── 无参 / list：一屏看完，窄屏单列 ───────────────────
  const out = ['可用的 subagent_type', '━━━━━━━━━━━━━━━━━━━━━━━━', '内置']
  for (const [n, d] of BUILTIN) out.push(`  ${n}\n    ${d}`)
  out.push('', `自定义（.claude/agents，已加载 ${cards.length} 张）`)
  if (!cards.length) {
    out.push('  还没有。/agents new <名字> 建一张')
  } else {
    for (const a of cards) {
      const d = String(a.description || '').replace(/\s+/g, ' ').slice(0, 44)
      out.push(`  ${cardName(a)}${d ? `\n    ${d}` : ''}`)
    }
  }
  out.push('', '/agents reload      改完角色卡立刻生效（不用重启）',
               '/agents <名字>      看某张卡',
               '/agents new <名字>  建新卡',
               '',
               '没 reload 就 spawn 新卡 = 静默退化成 general-purpose，角色设定全丢。')
  return out.join('\n')
}

export default cmdAgents
