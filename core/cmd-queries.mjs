// 只读查询类 slash 命令（从 index.mjs 的巨型 handleCommand 拆出来的第一批）
//
// 【为什么拆】handleCommand 一个函数 4868 行、83 个 case，占 index.mjs 的 68%。
// 一次全拆风险太高（几十个闭包变量互相引用，改错一处就是启动崩溃），
// 所以分批：先迁「纯查询、依赖最少」的这批验证模式，跑通再推其余。
//
// 【怎么解决闭包依赖】不再靠词法作用域，改成显式注入 ctx。
// ctx 里放 index.mjs 主流程持有的活对象/取值函数 —— 传引用或 getter，
// 不传快照：这些东西会被 /config、TodoWrite 之类原地改，
// 拿快照会读到旧值（这个坑在 SubAgentTool 的 tools 快照上踩过）。
//
// 【迁移纪律】必须逐字照抄原实现，不能凭印象重写。
// 第一版我把 recentErrors 当成函数、contextFiles.reset 写成 clear、
// formatContextFiles 漏了参数 —— 全是"看着差不多"造成的行为漂移。

/**
 * @param {object} ctx
 *   agent               Agent 实例（活对象）
 *   sessionStartTime    会话开始时间戳
 *   cmdStats            core/cmd-extensions.mjs 的 cmdStats
 *   recentErrors        错误数组（活引用，会被 push）
 *   todos               取值函数：() => 当前待办数组
 *   contextFiles        上下文文件记录对象（有 .reset()）
 *   formatContextFiles  格式化函数，要传 contextFiles
 *   incognito           取值函数：() => 是否隐身会话（会变，必须 getter）
 *   trace               { listTraces, readTrace, formatTraceList, formatTraceEvents,
 *                         formatTraceReplay, TRACE_DIR }
 *   config              配置对象（活引用）
 *   saveConfig          保存配置
 *   setAutoMemEnabled   自动记忆开关
 *   getAutoMemStatus    读自动记忆状态
 *   fsSession           取值函数：() => 全屏会话（可能为 null）
 *   cmdTemperature      core/cmd-extensions.mjs 的实现
 *   api                 API 实例（活对象，/config 会换）
 */
export function makeQueryCommands(ctx) {
  return {
    /** /cost — token 用量 */
    cost() {
      const u = ctx.agent.getTokenUsage()
      const lastP = ctx.agent.getLastPromptTokens()
      return `Token 统计:\n  当前上下文: ${lastP}\n  累计输出: ${u.output}\n  缓存读: ${u.cacheRead || 0}`
    },

    /** /stats — 会话统计 */
    stats() {
      return ctx.cmdStats(ctx.agent, ctx.sessionStartTime)
    },

    /** /errors — 本进程记录的错误（recentErrors 是数组，不是函数） */
    errors() {
      const arr = ctx.recentErrors
      return arr.length ? arr.join('\n') : '(当前进程暂无未注入错误)'
    },

    /** /todos — 当前待办清单 */
    todos() {
      const todos = ctx.todos()
      if (todos.length === 0) return '(无)'
      return todos
        .map((t) => `${t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[*]' : '[ ]'} ${t.content}`)
        .join('\n')
    },

    /** /files — 上下文里的文件（reset/clear 清空记录） */
    files(args) {
      const sub = String(args[0] || '').toLowerCase()
      if (sub === 'reset' || sub === 'clear') {
        ctx.contextFiles.reset()
        return '已清空上下文文件记录'
      }
      return ctx.formatContextFiles(ctx.contextFiles)
    },

    /** /trace — 运行轨迹（incognito 下禁用，避免把隐身会话写进磁盘轨迹） */
    trace(args) {
      if (ctx.incognito()) return 'Incognito 会话禁用 /trace'
      const T = ctx.trace
      const sub = String(args[0] || 'list').toLowerCase()
      if (sub === 'list') return T.formatTraceList(T.listTraces({ limit: args[1] || 20 }))
      if (sub === 'show' || sub === 'view' || sub === 'replay') {
        const id = args[1] || ctx.agent.getLastTraceId()
        if (!id) return `暂无当前 trace。目录: ${T.TRACE_DIR}`
        const events = T.readTrace(id, { limit: args[2] || 200 })
        return sub === 'replay' ? T.formatTraceReplay(events) : `Trace ${id}:\n${T.formatTraceEvents(events)}`
      }
      if (sub === 'path') return T.TRACE_DIR
      if (sub === 'status') {
        const id = ctx.agent.getLastTraceId()
        return id ? `当前 run trace: ${id}\n目录: ${T.TRACE_DIR}` : `当前没有已完成 run。目录: ${T.TRACE_DIR}`
      }
      return '用法: /trace [list [N]|show/replay [run_id] [N]|status|path]'
    },

    /** /greeting — 开场白开关（写 config.json，永久生效） */
    greeting(args) {
      if (!args[0]) return `开场白: ${ctx.config.greeting === false ? '关闭' : '开启'}\n用法: /greeting on|off`
      if (args[0] === 'off') { ctx.config.greeting = false; ctx.saveConfig(ctx.config); return '开场白已关闭（永久生效，写入 config.json）' }
      if (args[0] === 'on') { ctx.config.greeting = true; ctx.saveConfig(ctx.config); return '开场白已开启' }
      return '用法: /greeting on|off'
    },

    /** /automem — 自动记忆开关与状态 */
    automem(args) {
      const sub = String(args[0] || '').toLowerCase()
      if (sub === 'on') { ctx.setAutoMemEnabled(true); return '自动记忆已开启：每轮结束后自动提炼值得记的内容到 CLAUDE.md' }
      if (sub === 'off') { ctx.setAutoMemEnabled(false); return '自动记忆已关闭' }
      const st = ctx.getAutoMemStatus()
      return `自动记忆: ${st.enabled ? '开启' : '关闭'}\n  已提取 ${st.runs} 次\n  当前游标: 消息 #${st.cursor}\n  用法: /automem on|off`
    },

    /** /temperature — 生成温度（透传给 cmd-extensions 的实现） */
    temperature(args) {
      return ctx.cmdTemperature(args, ctx.config, ctx.api, ctx.saveConfig)
    },

    /** /keys — 静态键位说明。只列实现里真的认的键 */
    keys() {
      // 【2026-09-20 用户反馈「web 中部分帮助文本是 CLI 的，比如 ↑↓ 这样的快捷键」】
      // 终端键位表（Ctrl+P/N、Ctrl+J、滑屏翻正文…）在浏览器里**一个都不成立**：
      // 浏览器不会把 Ctrl 组合键交给页面，也没有 readline。照着显示只会误导。
      // ctx.platform 由 buildWebCtx / buildCommandTable 传入（'web' | 'cli'）。
      if (ctx.platform === 'web') {
        return `快捷键（Web）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Enter         发送（可在设置页改为 Shift+Enter / Ctrl+Enter
                等，或「仅按钮」）
  Shift+Enter   换行（若发送键设为 Enter）
  ↑ / ↓         在命令与候选列表里移动（输入框获焦时）
  Tab           补全当前命令/子命令
  Esc           关闭命令面板 / 弹窗
  点发送按钮    与 Enter 等效（设置成「仅按钮」时就靠它）`
      }
      return `快捷键
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Ctrl+I    补全命令/路径；无 / 时刷新全屏界面
  Ctrl+C    有字清空 · 空行退出 · 运行中打断
  Ctrl+X    重启（保存会话）
  Ctrl+P/N  上一条 / 下一条输入；处理中且有排队消息时改为翻排队队列
  Ctrl+J    换行（不发送）
  Ctrl+S    把排队消息【立即注入当前任务】（模型下一轮就能看到）
            普通消息 → 作为「执行中补充指令」注入，不打断当前工具批次
            slash 命令 → 白名单内的立即插队执行；其余也退回注入
  Ctrl+G    删除当前排队消息
  Ctrl+L    清屏（不清对话历史）
  Ctrl+A/E  行首 / 行尾
  Ctrl+T/Y/O  待办 / 活动 / 全部看板
  Ctrl+H      收起/展开顶部欢迎页（小屏多出几行正文，状态会记住）
  滑屏      翻正文`
    },

    /** /board — 看板折叠（快捷键 ^T/^Y/^O 的 slash 兜底） */
    board(args) {
      const fs = ctx.fsSession()
      if (!fs) return '看板不可用'
      const sub = (args[0] || '').toLowerCase()
      const map = {
        todo: 'todo', t: 'todo',
        activity: 'activity', act: 'activity', a: 'activity',
        all: 'all', '': 'all',
      }
      const which = map[sub]
      if (!which) {
        return '用法: /board [todo|activity|all]\n'
          + '  快捷键: ^T 待办 · ^Y 活动 · ^O 全部\n'
          + `  当前: 待办 ${fs.collapsed.todo ? '收起' : '展开'}`
          + ` · 活动 ${fs.collapsed.activity ? '收起' : '展开'}`
      }
      return fs.toggleBoard(which)
    },
  }
}

// ─────────────────────────────────────────────────────────────
// 会话类命令（第四批）
//
// 【状态依赖的坑】sessionId / sessionTitle 都是 index.mjs 里的 let，
// /new /resume /rename 会改它们。所以：
//   - 读：必须用 getter（sessionId() / sessionTitle()）
//   - 写：必须回调（setSessionTitle()），模块内改不了外层的 let
// 这是拆分里最容易出错的一类 —— 传值会读到旧会话 ID，
// 直接赋值则改不动外层变量（静默失败，命令看着执行了其实没生效）。

/**
 * @param {object} ctx
 *   sessionId        () => 当前会话 ID
 *   sessionTitle     () => 当前标题
 *   setSessionTitle  (t) => void  写回 index.mjs 的 let
 *   sessionStore     会话存储（list/load/save/delete）
 *   saveSession      保存当前会话
 *   agent            Agent 实例
 *   todos            () => 待办数组
 */
export function makeSessionCommands(ctx) {
  return {
    /** /save — 保存当前会话 */
    save() {
      ctx.saveSession()
      return '会话已保存'
    },

    /** /rename — 给当前会话命名（立即写盘，不等自动保存） */
    rename(args) {
      const title = args.join(' ').trim()
      if (!title) return `用法: /rename <名称>\n当前会话标题: ${ctx.sessionTitle() || '(未命名)'}`
      // 重名保护：/resume 支持按名字找会话，两个同名会话会分不清（还得靠 ID）。
      // 拦掉并告诉用户哪个占用了这个名字。
      const dup = ctx.sessionStore.findByTitle?.(title, ctx.sessionId()) || null
      if (dup) return `已有同名会话「${title}」（ID: ${dup}）。换个名字，或先 /delete ${dup} 再命名。`
      ctx.setSessionTitle(title)
      const sid = ctx.sessionId()
      ctx.sessionStore.save(sid, {
        sessionId: sid,
        title,
        savedAt: new Date().toISOString(),
        messages: ctx.agent.getHistory(),
        todos: ctx.todos(),
        tokenUsage: ctx.agent.getTokenUsage(),
        lastPromptTokens: ctx.agent.getLastPromptTokens?.() || 0,
      })
      return `已命名当前会话: ${title}`
    },

    /** /delete <id> | /delete all —— 当前活动会话永不删 */
    delete(args) {
      if (!args[0]) return '用法: /delete <会话ID>  或  /delete all  删除所有'
      const sid = ctx.sessionId()
      if (args[0] === 'all') {
        const ids = ctx.sessionStore.list()
        if (ids.length === 0) return '(无保存的会话)'
        let n = 0
        for (const id of ids) {
          if (id === sid) continue  // 跳过当前活动会话
          if (ctx.sessionStore.delete(id)) n++
        }
        return `已删除 ${n} 个会话（当前活动会话保留）`
      }
      const targetId = args[0]
      if (targetId === sid) return '不能删除当前正在使用的会话，先 /new 或 /resume 切到别的会话'
      if (!ctx.sessionStore.load(targetId)) return `未找到会话: ${targetId}`
      if (ctx.sessionStore.delete(targetId)) return `已删除会话: ${targetId}`
      return `删除失败: ${targetId}`
    },

    /** /load — 列出已保存会话，当前那条标 ← */
    load() {
      const ids = ctx.sessionStore.list()
      if (ids.length === 0) return '(无)'
      const sid = ctx.sessionId()
      const lines = []
      for (const id of ids) {
        const data = ctx.sessionStore.load(id)
        const title = data?.title || '(未命名)'
        const savedAt = data?.savedAt
          ? new Date(data.savedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
          : '??'
        const msgCount = data?.messages?.length || 0
        const marker = id === sid ? ' ←' : ''
        lines.push(`  ${id}  ${savedAt}  ${msgCount}条  ${title}${marker}`)
      }
      return '已保存的会话:\n' + lines.join('\n')
    },

    /**
     * /clear — 清空当前对话的聊天记录（会话 ID 不变）。
     * 想开一个全新对话用 /new。
     *
     * 【为什么要先存回收站】清空不可逆，用户手滑敲了就没了。
     * 存 JSON 到 .claude-code-mobile/cleared/，/clear-restore 可捞回来。
     * 目录两端共用（CLI 和 Web 都往同一处写），换端也能恢复。
     * 只保留最近 50 份，防止无限膨胀。
     *
     * 依赖 ctx 上的 fs 方法（existsSync/mkdirSync/writeFileSync/readdirSync/rmSync）
     * 和 join —— 两端 ctx 都提供了这些，模块本身不 import node:fs。
     */
    clear() {
      const sid = ctx.sessionId()
      const before = ctx.agent.getHistory().length
      try {
        const dir = ctx.dataPath ? ctx.dataPath('cleared') : '.claude-code-mobile/cleared'
        if (!ctx.existsSync(dir)) ctx.mkdirSync(dir, { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const file = `${dir}/${sid}-${stamp}.json`
        ctx.writeFileSync(file, JSON.stringify({
          kind: 'cleared-session',
          clearedAt: new Date().toISOString(),
          sessionId: sid,
          title: ctx.sessionTitle(),
          messages: ctx.agent.getHistory(),
          todos: ctx.todos(),
          tokenUsage: ctx.agent.getTokenUsage?.(),
        }, null, 2), 'utf-8')
        // 只保留最近 50 份
        const files = ctx.readdirSync(dir).filter(f => f.endsWith('.json')).sort()
        while (files.length > 50) {
          try { ctx.rmSync(ctx.join(dir, files.shift())) } catch { /* 删不掉就留着 */ }
        }
      } catch (e) { ctx.recordError?.('clear-backup', e) }
      // 常规保存也照旧（/resume 兜底：即使回收站丢了，会话文件还在）
      try { ctx.saveSession() } catch { /* 存不下不拦清空 */ }
      ctx.agent.clear()
      ctx.agent.systemPrompt = ctx.getCurrentSystemPrompt?.() || ctx.agent.systemPrompt
      ctx.setTodos([])
      // 同时清掉屏上累积的正文（CLI 全屏）；Web 的 fsSession 是 null，会跳过
      const fs = ctx.fsSession?.()
      if (fs) { try { fs.clearBody(); fs.flushRender() } catch { /* 渲染器状态异常不该拦住命令 */ } }
      try { ctx.saveSession() } catch {}
      return `已清空当前对话（${before} 条），会话 ID 仍是 ${sid}。\n清掉的内容已存入对话回收站：/clear-restore 查看 · /clear-restore <序号> 恢复。开新对话用 /new。`
    },

    /**
     * /clear-restore [序号] — 查看/恢复被 /clear 清掉的对话。
     * 不带参数 = 列出最近 20 份；带序号 = 恢复那份到当前会话。
     */
    'clear-restore'(args) {
      const dir = ctx.dataPath ? ctx.dataPath('cleared') : '.claude-code-mobile/cleared'
      if (!ctx.existsSync(dir)) return '对话回收站为空（还没有 /clear 过）。'
      const files = ctx.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse()
      if (!files.length) return '对话回收站为空。'
      if (!args[0]) {
        const lines = ['对话回收站（最近 20 份）：']
        files.slice(0, 20).forEach((f, i) => {
          try {
            const d = JSON.parse(ctx.readFileSync(`${dir}/${f}`, 'utf-8'))
            const n = Array.isArray(d.messages) ? d.messages.length : 0
            lines.push(`  ${i + 1}. [${d.clearedAt?.slice(0, 16).replace('T', ' ')}] 会话 ${d.sessionId} · ${n} 条${d.title ? ` · ${d.title}` : ''}`)
          } catch { lines.push(`  ${i + 1}. ${f}（损坏）`) }
        })
        lines.push('', '恢复：/clear-restore <序号>')
        return lines.join('\n')
      }
      const idx = Number(args[0]) - 1
      if (!Number.isInteger(idx) || idx < 0 || idx >= files.length) return `序号超出范围（1~${files.length}）`
      try {
        const d = JSON.parse(ctx.readFileSync(`${dir}/${files[idx]}`, 'utf-8'))
        const messages = Array.isArray(d.messages) ? d.messages : []
        ctx.agent.setHistory(messages)
        return `已恢复 ${messages.length} 条消息（来自 ${d.clearedAt?.slice(0, 16).replace('T', ' ')}）。`
      } catch (e) { return `恢复失败：${e?.message || e}` }
    },

    /**
     * /new — 保存当前对话并开一个新会话（原 /clear 的行为，2026 改名）。
     * 与 /clear 的区别：/clear 留在原会话里清空，/new 换一个新 sessionId。
     */
    new() {
      const oldId = ctx.sessionId()
      try { ctx.saveSession() } catch { /* 旧会话存不下也别拦住开新会话 */ }
      const newId = ctx.newSessionId()
      ctx.setSessionId(newId)
      ctx.setSessionTitle(null)
      ctx.setTodos([])
      ctx.setIncognito(false)
      ctx.agent.clear()
      ctx.agent.systemPrompt = ctx.getCurrentSystemPrompt?.() || ctx.agent.systemPrompt
      const fs = ctx.fsSession?.()
      try {
        fs?.clearBody?.()
        // 新会话的视觉起点（对齐启动路径的 New Session Start 线）。
        // 只 clearBody 会留一片空白，用户看不出"新对话从这开始"。
        if (fs?.writeLine && ctx.sessionDividerLines) {
          for (const line of ctx.sessionDividerLines()) fs.writeLine(line)
        }
        fs?.flushRender?.()
      } catch {}
      return `当前对话已保存 (ID: ${oldId})，已开始新对话 (ID: ${newId})。用 /resume ${oldId} 可恢复旧对话。`
    },

    /**
     * /resume [ID|名称] — 切到指定会话；不带参数 = 切到「上一个」会话（排除当前）。
     *
     * 【无参为什么要排除当前】见下方实现处的注释：当前会话每轮都落盘，
     * latest() 永远返回它自己，不排除的话无参调用等于原地重载、命令形同虚设。
     *
     * 【名称匹配规则】精确 → 忽略大小写 → 唯一前缀。
     * 故意**不做模糊包含匹配**：「修表」和「修表格」都含"修"，包含匹配会挑错会话，
     * 而恢复错会话会把当前上下文冲掉（代价高）。宁可要求用户多敲几个字。
     *
     * 【先按名称找还是先按 ID】ID 是 8 位十六进制（9348d031），名称是用户起的（"修表格"），
     * 两者不会撞（ID 只含 [0-9a-f]，中文名一定不是合法 ID），所以顺序无所谓正确性。
     * 这里先查 ID——它是权威标识，且查表比遍历 load 全部会话快。
     */
    resume(args) {
      if (args[0]) {
        const query = args.join(' ').trim()
        const ids = ctx.sessionStore.list()
        let targetId = null
        let matchKind = ''

        if (ids.includes(query)) { targetId = query; matchKind = 'id' }
        if (!targetId) {
          const byTitle = []
          for (const id of ids) {
            const d = ctx.sessionStore.load(id)
            if (d?.title) byTitle.push({ id, title: String(d.title) })
          }
          const q = query.toLowerCase()
          const exact = byTitle.find(x => x.title === query)
          const ci = byTitle.find(x => x.title.toLowerCase() === q)
          const prefix = byTitle.filter(x => x.title.toLowerCase().startsWith(q))
          if (exact) { targetId = exact.id; matchKind = 'name' }
          else if (ci) { targetId = ci.id; matchKind = 'name' }
          else if (prefix.length === 1) { targetId = prefix[0].id; matchKind = 'prefix' }
          else if (prefix.length > 1) {
            return `有 ${prefix.length} 个会话名以「${query}」开头，请说得更具体：\n`
              + prefix.map(x => `  ${x.id}  ${x.title}`).join('\n')
          }
        }
        if (!targetId) return `未找到会话: ${query}\n（/load 看全部；可用 ID 或 /rename 起过的名字）`
        const data = ctx.sessionStore.load(targetId)
        if (!data || !data.messages || data.messages.length === 0) return `未找到会话: ${targetId}`

        // 切走之前先把当前会话存了，否则未保存的内容会丢
        if (ctx.agent.getHistory().length > 0) {
          try { ctx.saveSession() } catch { /* 存不下也允许切 */ }
        }
        ctx.agent.setHistory(data.messages)
        ctx.setSessionId(targetId)
        ctx.setSessionTitle(data.title || null)
        ctx.setTodos(data.todos || [])
        ctx.setIncognito(data.incognito === true)
        ctx.agent.systemPrompt = ctx.getCurrentSystemPrompt?.() || ctx.agent.systemPrompt
        if (data.tokenUsage) {
          const tu = ctx.agent.getTokenUsage?.()
          if (tu) Object.assign(tu, data.tokenUsage)
        }
        return `已恢复会话${data.title ? `: ${data.title}` : ''} (${data.messages.length} 条消息)`
          + (matchKind === 'prefix' ? `\n（按名称前缀「${query}」匹配到 ${targetId}）` : '')
          // 历史回放（对齐官方：恢复的上下文直接渲染上屏）。
          // ctx.replayHistory 由 CLI 注入；Web 端不注入则跳过（它有自己的消息列表）。
          // 返回值可能是空串（用户 /replay off 时）—— 这时不要多打一个空行。
          + (() => { const h = ctx.replayHistory ? ctx.replayHistory(data.messages) : ''; return h ? '\n' + h : '' })()
      }

      // 不带参数 → 切到「上一个」会话（排除当前）。
      //
      // 【为什么排除当前】当前会话每轮对话都会落盘，latest() 永远返回它自己 ——
      // 无参 /resume 等于原地重载，用户看不到任何切换，命令形同虚设。
      // 用 latestExcept 排除当前 ID 才能拿到真正的「上一个」。
      const curId = ctx.sessionId()
      // 先存当前会话：一是防止未落盘内容丢失，二是让它保持最新 mtime
      // （不影响结果，因为下面已排除它）。
      if (ctx.agent.getHistory().length > 0) {
        try { ctx.saveSession() } catch { /* 存不下也允许切 */ }
      }
      const targetId = ctx.sessionStore.latestExcept
        ? ctx.sessionStore.latestExcept(curId)
        : null
      if (!targetId) return '没有其他已保存的会话（/load 看全部）'
      const data = ctx.sessionStore.load(targetId)
      if (!data) return `未找到会话: ${targetId}`
      ctx.agent.setHistory(Array.isArray(data.messages) ? data.messages : [])
      ctx.setSessionId(targetId)
      ctx.setSessionTitle(data.title || null)
      ctx.setTodos(data.todos || [])
      ctx.setIncognito(data.incognito === true)
      ctx.agent.systemPrompt = ctx.getCurrentSystemPrompt?.() || ctx.agent.systemPrompt
      if (data.tokenUsage) {
        const tu = ctx.agent.getTokenUsage?.()
        if (tu) Object.assign(tu, data.tokenUsage)
      }
      const n = Array.isArray(data.messages) ? data.messages.length : 0
      if (n === 0) return `已切回会话 ${targetId}（记录为空，可能被 /clear 过；找回内容用 /clear-restore）`
      return `已恢复${data.incognito ? ' Incognito 隔离' : ''}会话${data.title ? `: ${data.title}` : ''} (${n} 条消息)`
        + `\n（从 ${curId} 切走；切回用 /resume ${curId}）`
        + (() => { const h = ctx.replayHistory ? ctx.replayHistory(data.messages) : ''; return h ? '\n' + h : '' })()
    },
  }
}
