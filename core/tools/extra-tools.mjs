// Claude Code Mobile - 额外工具
import { Tool } from './tools.mjs'

/**
 * TodoWrite —— 待办清单。
 *
 * 【2026-09-20 重写描述】用户反馈「agent 经常忘记更新待办，比如现在」。
 * 根因：我们的 description 只有「更新待办清单」5 个字，没有任何行为引导 ——
 * 模型不知道什么时候该用、什么时候不该用、更新频率要求。
 * 对比官方（~/cc-src/claude-code-main/tools/TodoWriteTool/prompt.ts）：
 * 官方有完整的 When to Use / When NOT to Use 清单 + 8 个带 reasoning 的例子，
 * 并在 DESCRIPTION 里明确「proactively and often」「at least one in_progress at all times」。
 *
 * 这里按官方骨架精简重写（中文、贴合本项目），关键是三条硬要求：
 *   1. 复杂任务（≥3 步）**开工前**就建清单
 *   2. 状态**实时**更新，完成一个立刻标一个，不攒批
 *   3. 任何时刻**有且仅有 1 个** in_progress
 */
const TODO_WRITE_DESCRIPTION = [
  '创建和管理当前会话的结构化任务清单。**主动且频繁地使用它**，让用户看到进度。',
  '',
  '## 什么时候用',
  '1. 复杂多步任务 —— 需要 3 个以上不同步骤时',
  '2. 需要仔细规划的任务 —— 多文件改动、反复调试、需要验证的改动',
  '3. 用户明确要求用待办清单时',
  '4. 用户一次给了多个任务（列表形式、逗号分隔、编号）',
  '5. 收到新指令后 —— 立刻把需求拆成待办',
  '6. 开始做某件事前 —— **先标成 in_progress 再动手**（任何时刻只能有一个 in_progress）',
  '7. 完成一件事后 —— **立刻**标 completed，并把过程中发现的新任务加进去',
  '',
  '## 什么时候不用',
  '1. 只有一个简单任务',
  '2. 任务琐碎、跟踪它没有组织价值',
  '3. 三步以内能做完',
  '4. 纯对话或纯信息查询（用户只是问个问题，不需要动手）',
  '',
  '## 状态管理（硬要求）',
  '- **实时更新**，不要攒到最后一起改',
  '- 完成一个**立刻**标一个 —— 别等整批做完才更新',
  '- **任何时刻有且仅有 1 个 in_progress**（不多不少）',
  '- 先完成当前任务，再开始新任务',
  '- 不再相关的任务**整个删掉**，不要留着',
  '- 所有任务都完成后，传空数组 `todos: []` 清空清单 —— 不要留一堆 completed 占着屏幕',
  '- 每个任务都要给两个描述：content（祈使句，如「修复登录 bug」）和 activeForm（进行时，如「正在修复登录 bug」）',
  '',
  '## 完成标准',
  '只有**真正做完**才能标 completed。以下情况**不许**标完成：',
  '- 测试还在失败',
  '- 只做了一部分',
  '- 遇到未解决的错误',
  '- 没找到必要的文件或依赖',
  '遇到阻塞时保持 in_progress，并新建一个任务描述「需要解决什么」。',
  '',
  '拿不准的时候就用它 —— 主动管理任务能让用户看清进度，也确保你不漏掉需求。',
].join('\n')

export class TodoWriteTool extends Tool {
  constructor() {
    super({
      name: 'TodoWrite',
      description: TODO_WRITE_DESCRIPTION,
      input_schema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '祈使句描述要做什么，如「修复登录 bug」' },
                activeForm: { type: 'string', description: '进行时描述，正在做时显示，如「正在修复登录 bug」' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'pending=未开始 · in_progress=进行中（同时只能有一个）· completed=已完成' },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
      isReadOnly: () => false,
      maxResultSizeChars: 2000,
      validateInput: (input) => {
        const errors = []
        if (!input.todos || !Array.isArray(input.todos)) { errors.push('todos is required and must be an array') }
        // 【2026-09-20】空数组是合法的 —— 表示「清空清单」（所有任务都完成了）。
        // 官方就是这么做的（TodoWriteTool.ts:69 `allDone ? [] : todos`）：
        // 全部完成时自动置空，而不是留一堆 completed 占着屏幕。
        // 我们原来写死「todos must not be empty」，导致干完活也清不掉，清单一直挂着。
        else {
          // 官方硬要求：任何时刻有且仅有 1 个 in_progress。
          // 不满足时**提示但不拒绝** —— 拒绝会让模型在"刚建清单还没开工"时卡住
          //（那时全是 pending，也是合法状态）。
          const inProgress = input.todos.filter(t => t.status === 'in_progress').length
          if (inProgress > 1) errors.push(`同时有 ${inProgress} 个 in_progress，最多只能有 1 个`)
        }
        return { valid: errors.length === 0, errors }
      },
    })
  }
  async execute(input) {
    const todos = input.todos || []
    // 全部完成 → 清空清单（对齐官方 TodoWriteTool.ts:69）。
    // 返回空字符串，UI 层据此收起看板。
    if (todos.length === 0 || todos.every(t => t.status === 'completed')) {
      return ''
    }
    return todos.map((t) => {
      const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '→' : '○'
      return `${icon} ${t.content}`
    }).join('\n')
  }
}

export class WebFetchTool extends Tool {
  constructor() {
    super({
      name: 'WebFetch', description: '抓取网页内容',
      input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      isReadOnly: () => true,
      maxResultSizeChars: 15000,
      validateInput: (input) => {
        const errors = []
        if (!input.url) { errors.push('url is required') }
        else {
          try { new URL(input.url) } catch { errors.push('url is not a valid URL') }
        }
        return { valid: errors.length === 0, errors }
      },
    })
  }
  async execute(input) {
    // 1. 协议 + SSRF 校验：只允许 http/https，阻断内网/环回/元数据地址
    let u
    try { u = new URL(input.url) } catch { throw new Error('无效 URL') }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`不支持的协议 ${u.protocol}（只允许 http/https）`)
    }
    if (isBlockedHost(u.hostname)) {
      throw new Error(`拒绝访问内网/环回地址: ${u.hostname}（防 SSRF）`)
    }
    // 2. 超时 15s（不依赖外层工具超时）
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const resp = await fetch(input.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android) Claude-Code-Mobile/1.0' },
        signal: controller.signal,
        redirect: 'follow',
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      // 3. Content-Length 预检 + 流式读取上限（防超大响应先 OOM 再截断）
      const MAX_BYTES = 5 * 1024 * 1024  // 5MB 上限
      const cl = parseInt(resp.headers.get('content-length') || '0', 10)
      if (cl && cl > MAX_BYTES) throw new Error(`响应过大 ${Math.round(cl/1024/1024)}MB，上限 5MB`)
      let raw = ''
      if (resp.body && resp.body.getReader) {
        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let total = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            total += value.length
            if (total > MAX_BYTES) { try { await reader.cancel() } catch {}; break }
            raw += decoder.decode(value, { stream: true })
          }
        } finally { try { reader.releaseLock() } catch {} }
      } else {
        raw = (await resp.text()).slice(0, MAX_BYTES)
      }
      const text = raw.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,15000)
      return `URL: ${input.url}\n\n${text}`
    } catch(e) {
      if (e.name === 'AbortError') throw new Error('Fetch failed: 请求超时 (15s)')
      throw new Error(`Fetch failed: ${e.message}`)
    } finally {
      clearTimeout(timer)
    }
  }
}

// SSRF 防护：判断 hostname 是否是内网/环回/链路本地/元数据地址
function isBlockedHost(hostname) {
  if (!hostname) return true
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')  // 去 IPv6 方括号
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '0.0.0.0') return true
  // IPv6 唯一本地地址 fc00::/7、链路本地 fe80::
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true
  // IPv4 私有 / 环回 / 链路本地 / 元数据
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const a = +m[1], b = +m[2]
    if (a === 127) return true               // 环回
    if (a === 10) return true                // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true  // 172.16.0.0/12
    if (a === 192 && b === 168) return true  // 192.168.0.0/16
    if (a === 169 && b === 254) return true  // 链路本地 + 云元数据 169.254.169.254
    if (a === 0) return true
  }
  return false
}

export class AskUserSimpleTool extends Tool {
  constructor(onAsk) {
    super({
      name: 'AskUserQuestion',
      description: '向用户提问获取信息。\n' +
        '可以给选项（options，最多 4 个）—— 用户按编号选，也能自己打字（选项外补充说明）。\n' +
        '不给 options 就是纯文本提问。\n' +
        '⚠️ 子 Agent 不要调用 —— 无法与用户交互，会一直阻塞。',
      input_schema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要问的问题' },
          // 【2026-10-06 加】与 APK 端对齐：CLI 原来只有纯文本提问，
          // 用户必须打字；APK 有选项按钮但没有输入框。两端各缺一半，
          // 现在 CLI 也支持选项（复用 slash 向导的选项 UI 渲染）。
          options: {
            type: 'array',
            items: { type: 'string' },
            description: '可选：预设选项（最多 4 个）。给了就按编号列出，用户输编号选，也可自由输入。',
          },
        },
        required: ['question'],
      },
      maxResultSizeChars: 5000,
      validateInput: (input) => {
        const errors = []
        if (!input.question) errors.push('question is required')
        return { valid: errors.length === 0, errors }
      },
    })
    this.onAsk = onAsk
  }
  async execute(input) {
    const opts = Array.isArray(input.options)
      ? input.options.map(String).filter(Boolean).slice(0, 4)
      : []
    // onAsk 第二个参数是选项（旧实现只传 question —— 保持向后兼容，
    // 老的 askUser 忽略第二个参数即可）
    const a = await this.onAsk(input.question, opts)
    return a || '(no answer)'
  }
}
