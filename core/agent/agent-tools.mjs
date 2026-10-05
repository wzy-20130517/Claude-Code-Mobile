// Claude Code Mobile - Agent 自执行工具
// 让 Claude 能：执行 slash 命令、查询用户输入历史、请求重启
import { Tool } from '../tools/tools.mjs'
import { markMainWroteMemory } from './auto-memory.mjs'
import { withNonInteractive } from '../commands/wizard.mjs'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { DATA_DIR } from '../infra/paths.mjs'
import { extractHeadingLines } from '../session/persistence.mjs'

// 持久化路径
const DEFAULT_HISTORY_FILE = join(homedir(), '.claude-code-mobile', 'input-history.json')

// 读 shell 历史文件（bash/zsh）
function readShellHistory(maxLines = 50) {
  const home = homedir()
  const candidates = [
    join(home, '.bash_history'),
    join(home, '.zsh_history'),
    join(home, '.history'),
  ]
  for (const f of candidates) {
    if (!existsSync(f)) continue
    try {
      const content = readFileSync(f, 'utf-8')
      const lines = content.split('\n').filter(l => l.trim()).slice(-maxLines)
      return lines.map(l => {
        const time = null   // bash history 默认无时间戳
        return { type: 'shell', content: l, timestamp: time }
      })
    } catch {}
  }
  return []
}

// 用户输入历史记录器（单例，由 index.mjs 注入数据）
// 持久化到 ~/.claude-code-mobile/input-history.json，跨重启保留
export class InputHistory {
  constructor(maxSize = 200, historyFile = null, sessionsDir = null) {
    this.entries = []   // {type: 'command'|'message'|'shell', content, timestamp}
    this.maxSize = maxSize
    this.historyFile = historyFile || DEFAULT_HISTORY_FILE
    this.sessionsDir = sessionsDir || null
    this._load()
  }

  _load() {
    let supplemented = false
    try {
      if (existsSync(this.historyFile)) {
        const data = JSON.parse(readFileSync(this.historyFile, 'utf-8'))
        if (Array.isArray(data.entries)) this.entries = data.entries.slice(-this.maxSize)
      }
    } catch {}
    // 从 sessions 目录补充 slash 命令历史
    try {
      const sessionsDir = this.sessionsDir
        ? resolve(this.sessionsDir)
        : (process.env.CCM_SESSIONS_DIR
          ? resolve(process.env.CCM_SESSIONS_DIR)
          // 【2026-10-03】原来拼 process.cwd() —— 指向源码内的老位置。
          // 统一走用户数据目录（core/paths.mjs），源码与数据分离。
          : join(DATA_DIR, 'sessions'))
      if (existsSync(sessionsDir)) {
        const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'))
          .map(f => ({ f, t: statSync(join(sessionsDir, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t)
          .slice(0, 10)
        const known = new Set(this.entries.map(e => e.content + '@' + e.timestamp))
        for (const { f } of files) {
          try {
            const sess = JSON.parse(readFileSync(join(sessionsDir, f), 'utf-8'))
            const msgs = sess.messages || sess.history || []
            for (const m of msgs) {
              if (m.role !== 'user' || typeof m.content !== 'string') continue
              const text = m.content
              // 只保留首行是 slash 命令的（忽略注入的标记）
              const firstLine = text.split('\n')[0].trim()
              if (!firstLine.startsWith('/') || firstLine.length > 200) continue
              // /image 例外：它设计上是普通用户消息（见 index.mjs「/image 拦截」段），
              // 会话里存的就是原文，不能被当成命令补录进历史（2026-10-04 修复）。
              if (/^\/image(\s|$)/.test(firstLine)) continue
              const key = firstLine + '@' + (sess.savedAt || 0)
              if (!known.has(key)) {
                this.entries.push({ type: 'command', content: firstLine, timestamp: sess.savedAt || Date.now() })
                known.add(key)
                supplemented = true
              }
            }
          } catch {}
        }
        this.entries.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
        if (this.entries.length > this.maxSize) this.entries = this.entries.slice(-this.maxSize)
      }
    } catch {}
    // 如果有补充内容，保存一次（让下次启动直接从文件加载）
    if (supplemented) this._save()
  }

  _save() {
    try {
      const dir = dirname(this.historyFile)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.historyFile, JSON.stringify({ entries: this.entries.slice(-this.maxSize) }, null, 2), 'utf-8')
    } catch {}
  }

  add(type, content) {
    this.entries.push({ type, content, timestamp: Date.now() })
    // QQ 注入的消息（带前缀）里若包含 slash 命令，额外记为 command，让 recentCommands 能看到
    // 例：QQ 发 "/help" → 整条 "【QQ消息｜来自...】\n/help" 记 message，同时抽 "/help" 记 command
    if (type === 'message' && typeof content === 'string') {
      const stripped = content
        .replace(/^【QQ消息｜来自[^\n]*】\n?/, '')
        .replace(/^【QQ收件箱提醒】[\s\S]*?。\n?/, '')
        .replace(/^【🎁 福利捕获】[\s\S]*?接住。\n?/, '')
      const firstLine = stripped.split('\n')[0].trim()
      // /image 例外：它已被设计为「普通用户消息」（见 index.mjs 的「/image 拦截」段），
      // 不该再被补记成 command —— 否则 /slash recent 会把用户发的图片消息
      // 当成"最近敲过的命令"注入给模型（2026-10-04 用户报「还是进了 slash 捕获」）。
      const isImageMsg = /^\/image(\s|$)/.test(firstLine)
      if (!isImageMsg && firstLine.startsWith('/') && firstLine.length <= 200) {
        this.entries.push({ type: 'command', content: firstLine, timestamp: Date.now() })
      }
    }
    if (this.entries.length > this.maxSize) this.entries.shift()
    this._save()
  }

  recent(n = 20) {
    // 合并：程序内历史 + shell 历史按时间戳排序 merge
    const shell = readShellHistory(n)
    const local = this.entries.slice(-n)
    if (shell.length > 0) {
      return local.concat([
        { type: 'shell-divider', content: '--- shell 历史 ---', timestamp: Date.now() },
        ...shell.slice(-n),
      ])
    }
    return local
  }

  recentCommands(n = 10) {
    return this.entries.filter(e => e.type === 'command').slice(-n)
  }

  recentMessages(n = 10) {
    return this.entries.filter(e => e.type === 'message').slice(-n)
  }

  recentShell(n = 20) {
    return readShellHistory(n)
  }

  clear() { this.entries = [] }
}

/**
 * 这些命令在缺参数时会开交互式向导/弹层，没有键盘的场景必须带全参数。
 * 键 = 命令名，值 = 等价的非交互写法。
 *
 * 两类场景共用这张表：
 *   - Agent 通过 CommandExec 调命令
 *   - 用户从 QQ 私聊发 slash 命令（手机那侧没法按键关弹层）
 * 所以必须 export —— 各处自己抄一份必然漂移。
 */
export const NON_INTERACTIVE_HINTS = {
  qq: '/qq owner <QQ号> · /qq port <端口> · /qq api <URL>（别用 /qq setup）',
  imagegen: '/imagegen url <URL> · key <KEY> · model <名> · size <尺寸> · dir <路径>（别用 /imagegen setup）',
  key: '/key [providerID] <密钥>；多 key 池必须一行给全：/key [id] pool <k1> <k2> ...',
  config: '/config <ID> 直接切换；改配置用 /model /url /name /key（别用无参 /config 选单）',
  mail: '/mail set <邮箱> <授权码> [imap主机] [端口]，或 /mail user|pass|imap|port <值>',
  effort: '/effort none|minimal|low|medium|high|xhigh|max，或 off|show|hide（别用无参 /effort）',
  permissions: '/permissions mode default|acceptEdits|plan|bypassPermissions · allow <工具名>',
  agents: '/agents（无参=列表，只读）· /agents new <名字> 生成模板（别指望向导）',
  model: '/model <名称> 改当前 Provider 模型 · /model <id> <名称> 改指定（无参会开选单）',
  // /help 不在这里：它在非交互环境直接返回纯文本清单，不抛 NonInteractiveError。
}

// 工具1：执行 slash 命令
export class CommandExecTool extends Tool {
  constructor(handleCommand) {
    super({
      name: 'CommandExec',
      description: '执行程序内 slash 命令（如 /model, /compact, /cost, /clear 等）。不要用这个执行 shell 命令——用 Bash 工具。',
      input_schema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的命令，如 "model" 或 "compact 10" 或 "cost"（不要带 / 前缀）',
          },
        },
        required: ['command'],
      },
      maxResultSizeChars: 10000,
      validateInput: (input) => {
        const errors = []
        if (!input.command) errors.push('command is required')
        return { valid: errors.length === 0, errors }
      },
    })
    this.handleCommand = handleCommand
  }

  async execute(input) {
    const cmd = (input.command || '').trim().replace(/^\/+/, '')
    if (!cmd) return '错误: 请提供命令名称'
    const [name, ...args] = cmd.split(/\s+/)
    try {
      // 【必须包在 withNonInteractive 里】否则命中向导分支（/qq setup、/config、
      // /key pool、/backup config…）会永久挂起：向导的 Promise 只能由用户回车兑现，
      // 而这里没有用户。更糟的是向导会接管 rl.onEnter，导致真实用户之后每次回车
      // 都在喂这个看不见的向导。所以让它快速失败，并告诉模型改用带参写法。
      const result = await withNonInteractive(
        () => this.handleCommand(`/${cmd}`, cmd, name, args)
      )
      // String() 同时覆盖字符串和 new String(...) 包装对象（后者 typeof 是 'object'）
      return String(result)
    } catch (e) {
      if (e?.nonInteractive) {
        return `${e.message}\n提示：${NON_INTERACTIVE_HINTS[name] || '用 /help ' + name + ' 查带参数的用法。'}`
      }
      return `命令执行错误: ${e.message}`
    }
  }
}

// 工具2：查询用户输入历史
export class UserInputHistoryTool extends Tool {
  constructor(inputHistory) {
    super({
      name: 'UserInputHistory',
      description: '查询用户最近的输入历史（包括 slash 命令和普通消息）。当用户问"我刚才输入了什么"或需要回顾上下文时使用。',
      input_schema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['all', 'commands', 'messages', 'shell'],
            description: '筛选类型：all=全部（含 shell 历史）, commands=仅 slash 命令, messages=仅普通消息, shell=仅 shell 命令历史',
          },
          count: {
            type: 'number',
            description: '返回最近多少条（默认 20）',
          },
        },
      },
    })
    this.inputHistory = inputHistory
  }

  async execute(input) {
    const count = input.count || 20
    const type = input.type || 'all'
    let entries
    if (type === 'commands') entries = this.inputHistory.recentCommands(count)
    else if (type === 'messages') entries = this.inputHistory.recentMessages(count)
    else if (type === 'shell') entries = this.inputHistory.recentShell(count)
    else entries = this.inputHistory.recent(count)

    if (entries.length === 0) return '(无输入历史)'
    const lines = entries.map(e => {
      const time = e.timestamp ? new Date(e.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--:--'
      const prefix = e.type === 'command' ? '[命令]' : e.type === 'message' ? '[消息]' : e.type === 'shell' ? '[shell]' : e.type === 'shell-divider' ? '' : '[?]'
      if (e.type === 'shell-divider') return e.content
      return `${time} ${prefix} ${e.content}`
    })
    return lines.join('\n')
  }
}

// 工具3：主动记忆写入
// 让助手能在对话中主动把重要事项写入 CLAUDE.md，跨会话保留
export class MemoryTool extends Tool {
  constructor(memoryPath = null, memoryLabel = 'CLAUDE.md') {
    super({
      name: 'Memory',
      description: `把重要信息写入 ${memoryLabel} 项目记忆文件（跨会话保留）。`
        + '适用场景：用户说「记一下」「记住这个」「加到 CLAUDE.md」、'
        + '重要的代码风格约定、构建命令、用户偏好、错误教训。'
        + '不要记琐碎对话内容，只记对未来对话有用的项目级元信息。'
        + '\n文件很大时（系统提示词里只给了标题目录），用 action="toc" 列目录、'
        + 'action="section" + title 取某一节完整正文（比 Read 整个文件省上下文）。',
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['append', 'show', 'init', 'toc', 'section'],
            description: 'append=追加内容，show=看全文，init=创建，toc=列标题目录，section=按标题取一节',
          },
          text: {
            type: 'string',
            description: '要追加的文本（action=append 时必填）。会被原样写入文件末尾。',
          },
          title: {
            type: 'string',
            description: 'action=section 时必填：标题关键词（模糊匹配，取第一个命中的 ## 小节）',
          },
        },
        required: ['action'],
      },
    })
    this.memoryPath = memoryPath || null
    this.memoryLabel = memoryLabel
  }

  async execute(input, ctx = {}) {
    // 【2026-10-03】默认写到数据目录（CLAUDE.md 是用户数据，不进源码/版本库）
    const path = this.memoryPath || join(DATA_DIR, 'CLAUDE.md')
    const action = input.action || 'append'

    if (action === 'show') {
      if (!existsSync(path)) return `${this.memoryLabel} 不存在`
      return readFileSync(path, 'utf-8')
    }

    if (action === 'init') {
      if (existsSync(path)) return `${this.memoryLabel} 已存在，用 action=append 追加内容`
      writeFileSync(path, `# ${this.memoryLabel}\n\n本项目的工作约定和笔记。\n`, 'utf-8')
      return `已创建 ${this.memoryLabel}`
    }

    if (action === 'toc') {
      if (!existsSync(path)) return `${this.memoryLabel} 不存在`
      const full = readFileSync(path, 'utf-8')
      // 【排除代码块】2026-10-04：CLAUDE.md 里的 ``` shell 片段中的注释
      // （# 1) 换 token、# 常用操作）会被当成标题——实测混进 7 条假标题。
      // 统一走 extractHeadingLines（跟踪围栏开闭状态）。
      const heads = extractHeadingLines(full)
      if (!heads.length) return `${this.memoryLabel} 没有 ## 标题（共 ${full.length} 字符）`
      const out = heads.map((h, i) => `${i + 1}. ${h}`)
      return `${this.memoryLabel} 标题目录（共 ${out.length} 节，文件 ${full.length} 字符）：\n\n`
        + out.join('\n')
        + `\n\n用 action="section" + title 取某一节完整正文。`
    }

    if (action === 'section') {
      if (!existsSync(path)) return `${this.memoryLabel} 不存在`
      const kw = String(input.title || '').trim()
      if (!kw) return '错误: action=section 需要 title 参数（标题关键词）'
      const full = readFileSync(path, 'utf-8')
      const lines = full.split('\n')
      // 找出所有标题行的位置（# / ## 级，**跳过代码块内的假标题**）
      const headTexts = new Set(extractHeadingLines(full))
      const heads = []
      let inFence = false, fenceChar = ''
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim()
        const fm = /^(`{3,}|~{3,})/.exec(t)
        if (fm) {
          const ch = fm[1][0]
          if (!inFence) { inFence = true; fenceChar = ch }
          else if (ch === fenceChar) { inFence = false; fenceChar = '' }
          continue
        }
        if (inFence) continue
        if (headTexts.has(t)) heads.push({ line: i, text: t })
      }
      // 模糊匹配：优先完整包含，其次去 # 后包含，最后不区分大小写
      const kwLower = kw.toLowerCase()
      let hit = heads.find(h => h.text.includes(kw))
      if (!hit) hit = heads.find(h => h.text.replace(/^#+\s*/, '').toLowerCase().includes(kwLower))
      if (!hit) {
        // 没命中 → 给出相近的候选（帮助模型修正关键词）
        const near = heads.filter(h => h.text.toLowerCase().includes(kwLower.slice(0, 4))).slice(0, 5)
        return `未找到含「${kw}」的小节。`
          + (near.length ? `\n相近的：\n` + near.map(h => `  ${h.text}`).join('\n') : '')
          + `\n用 action="toc" 看完整目录。`
      }
      // 取该标题到下一个同级/更高级标题之间的内容
      const startLine = hit.line
      const startLevel = (hit.text.match(/^#+/) || ['#'])[0].length
      let endLine = lines.length
      for (const h of heads) {
        if (h.line <= startLine) continue
        const lvl = (h.text.match(/^#+/) || ['#'])[0].length
        if (lvl <= startLevel) { endLine = h.line; break }
      }
      const body = lines.slice(startLine, endLine).join('\n').trimEnd()
      const more = endLine < lines.length ? `\n\n（下一节：${lines[endLine]}）` : ''
      return body + more
    }

    if (action === 'append') {
      const text = (input.text || '').trim()
      if (!text) return '错误: text 不能为空'
      const cur = existsSync(path) ? readFileSync(path, 'utf-8') : `# ${this.memoryLabel}\n\n`
      // 确保文件以换行结尾，追加的 text 也以换行结尾
      const separator = cur.endsWith('\n') ? '' : '\n'
      writeFileSync(path, cur + separator + text + '\n', 'utf-8')
      // 互斥：主 agent 刚写过记忆，本周期不再自动提取（防重复）
      try { markMainWroteMemory() } catch {}
      return `已写入 ${this.memoryLabel}（追加 ${text.length} 字符）`
    }

    return `未知 action: ${action}`
  }
}
