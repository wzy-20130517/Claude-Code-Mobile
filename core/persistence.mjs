// Claude Code Mobile - 持久化
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { backupToTrash } from './trash.mjs'
import { atomicWrite } from './atomic.mjs'
import { DATA_DIR } from './paths.mjs'

export class ClaudeMdLoader {
  /**
   * 加载 CLAUDE.md（项目记忆）。
   *
   * 【搜索顺序 · 2026-10-03 用户要求】
   *   ① 用户数据目录的 CLAUDE.md（~/.claude-code-mobile/CLAUDE.md）—— **优先**
   *   ② 从 cwd 向上逐级找（原来的行为，支持多项目各自一份）
   *
   * 【为什么数据目录优先】用户原话：「CLAUDE.md，明晃晃的用户数据，被你完全忽略」。
   * 它 214KB 全是我和用户积累的项目记忆（踩过的坑、约定、教训），
   * 却被 git 跟踪着 —— 换台机器 clone 就丢，而且把版本库撑大。
   * 放数据目录后：跟着用户走、不进版本库、备份/清理时和别的用户数据一起处理。
   *
   * 【为什么还保留 cwd 向上搜索】CLAUDE.md 的原始语义是「项目级记忆」——
   * 用户可能在别的项目目录里也放一份（那个项目的约定）。
   * 数据目录那份是"全局记忆"，cwd 找到的是"本项目记忆"，两者都注入。
   */
  /**
   * 读一份 CLAUDE.md，超长时按「保留开头 + 后面列标题」压缩。
   *
   * 【2026-10-04 用户要求】原话：「md 会自动截断的，后面取 ## 标题行
   * 展示给 Agent 以便翻阅」。
   *
   * 【为什么不能只硬截断】原来是 `.slice(0, 35000)` —— 一刀切，后面全丢，
   * 而且是**静默的**：Agent 完全不知道文件里还有内容（用户 CLAUDE.md
   * 实测 142k 字符，只有 25% 进提示词，剩下 107k 无声消失）。
   * 超长时改成：
   *   ① 前 FULL_LIMIT 字符**完整保留**（最新的记录通常在后面……但标题
   *      能帮 Agent 知道有什么，需要时自己 Read 全文）
   *   ② 剩余部分只提取 `## ` 开头的标题行，拼成目录附在后面
   *   ③ 明确告诉 Agent「这是目录，要看正文用 Read 读原文件」
   * 这样 Agent 既知道文件里有什么，又能在需要时自己去翻，不再"不知道丢了什么"。
   *
   * 【为什么留的是开头而不是结尾】CLAUDE.md 的约定是"越靠后越新"，
   * 但开头放的是身份/规范类（工具铁律、思考语言要求），这些每轮都要用；
   * 后面的具体 bug 记录/教训是"查阅型"，标题目录足够指路。
   */
  static readWithToc(filePath, fullLimit = 35000) {
    const full = readFileSync(filePath, 'utf-8')
    if (full.length <= fullLimit) return { content: full, truncated: false, total: full.length }
    const head = full.slice(0, fullLimit)
    const tail = full.slice(fullLimit)
    // 提取尾部所有 ## 标题（# 一级标题少见，也收；### 太细不列）
    const titles = tail.match(/^#{1,2} .+$/gm) || []
    const toc = titles.length
      ? `\n\n---\n\n【以下内容因超长未完整注入，这里是标题目录（共 ${titles.length} 条）。` +
        `需要看某节正文时，用 Read 工具读原文件 ${filePath}】\n\n` + titles.join('\n')
      : `\n\n---\n\n【文件超长（${full.length} 字符），超出部分未注入且无标题可列】`
    return { content: head + toc, truncated: true, total: full.length, tocCount: titles.length }
  }

  static load(cwd, maxDepth = 5) {
    const contents = []
    // ① 用户数据目录的全局 CLAUDE.md（优先注入）
    try {
      const globalMd = join(DATA_DIR, 'CLAUDE.md')
      if (existsSync(globalMd)) {
        const r = ClaudeMdLoader.readWithToc(globalMd)
        contents.push({ path: globalMd, content: r.content, truncated: r.truncated, total: r.total })
      }
    } catch {}
    // ② 从 cwd 向上找（跳过与①相同的路径，避免重复注入）
    let dir = cwd
    for (let i = 0; i < maxDepth; i++) {
      const claudeMd = join(dir, 'CLAUDE.md')
      // 【上限 35000 字符】原来是 10000，导致 CLAUDE.md 只有 13% 被注入，
      // 而且是**静默截断**——标着「最高优先级」的工具调用铁律、用户偏好、
      // 最近的纠正记录全在截断线外读不到，于是同一个错反复犯（2026-08-30 实测发现）。
      // 35000 字符约 1.7 万 token，对 1M 上下文的模型可接受；精简后的 CLAUDE.md
      // （约 2 万字符）能完整进来。若以后再涨，优先精简文件而不是继续提上限。
      // 【2026-10-04】超长部分不再无声丢弃 —— 见 readWithToc 的标题目录机制。
      if (existsSync(claudeMd) && !contents.some(c => c.path === claudeMd)) {
        try {
          const r = ClaudeMdLoader.readWithToc(claudeMd)
          contents.push({ path: claudeMd, content: r.content, truncated: r.truncated, total: r.total })
        } catch {}
      }
      const parent = join(dir, '..'); if (parent === dir) break; dir = parent
    }
    return contents
  }
  static format(contents) { return contents.length === 0 ? '' : '\n\n# 项目上下文 (CLAUDE.md)\n\n' + contents.map(c => `## ${c.path}\n${c.content}\n`).join('\n') }
}

// 会话文件覆盖阈值：消息数差异超过此值先备份旧文件到回收站
const SESSION_BACKUP_DIFF_THRESHOLD = 5

// 会话文件数上限（仿 trash.mjs 的 MAX_TRASH_FILES）：
// SessionStore.save 原来只写不删，会话文件无限累积（实测 10 个 1.2MB，
// 长期挂着会更胖）。超出上限时删 mtime 最旧的，但永不删当前正在写的那个。
const MAX_SESSION_FILES = 30

export class SessionStore {
  /**
   * @param {string} [rootDir] 数据根目录。**默认是家目录下的 ~/.claude-code-mobile**
   *   （经 core/paths.mjs 解析），不再用相对路径 ——
   *   原来默认 `'.claude-code-mobile'` 是相对 cwd 的，而 CLI 启动时 cwd 就是项目目录，
   *   于是 584MB 用户数据被写进源码仓库里（2026-10-03 用户要求彻底分离）。
   *   显式传参的调用方（web/server.mjs 传 SESSION_ROOT）行为不变。
   */
  constructor(rootDir = null) {
    const root = rootDir || DATA_DIR
    this.rootDir = root; this.sessionsDir = join(root, 'sessions')
    if (!existsSync(this.sessionsDir)) mkdirSync(this.sessionsDir, { recursive: true })
  }
  save(sid, data) {
    const f = join(this.sessionsDir, `${sid}.json`)
    // 覆盖前防护：如果旧文件存在且 messages 数差异较大，先备份到回收站
    // 主要防 /clear 或 resume 后用同一个 sid 写入完全不同的对话内容
    if (existsSync(f)) {
      try {
        const old = JSON.parse(readFileSync(f, 'utf-8'))
        const oldN = Array.isArray(old?.messages) ? old.messages.length : 0
        const newN = Array.isArray(data?.messages) ? data.messages.length : 0
        if (Math.abs(oldN - newN) > SESSION_BACKUP_DIFF_THRESHOLD) {
          backupToTrash(f, `session-${sid}-before-overwrite`)
        }
      } catch { /* 旧文件解析失败不阻塞写入 */ }
    }
    atomicWrite(f, JSON.stringify(data, null, 2), 'utf-8')
    this.prune(sid)
  }

  // 超出 MAX_SESSION_FILES 时删最旧（mtime 排序）；永不删当前活跃会话。
  // 删除前照 SessionStore.delete 的惯例先备份一份进文件回收站，可 /trash restore 找回。
  prune(keepSid) {
    try {
      const entries = readdirSync(this.sessionsDir)
        .filter(x => x.endsWith('.json') && !x.endsWith('.bak'))
        .map(x => {
          try { return { name: x, sid: x.replace('.json', ''), mtime: statSync(join(this.sessionsDir, x)).mtimeMs } } catch { return null }
        })
        .filter(Boolean)
      if (entries.length <= MAX_SESSION_FILES) return
      entries.sort((a, b) => a.mtime - b.mtime) // 最旧在前
      const drop = entries.slice(0, entries.length - MAX_SESSION_FILES)
      for (const e of drop) {
        if (e.sid === keepSid) continue // 活跃会话永不删
        const full = join(this.sessionsDir, e.name)
        try { backupToTrash(full, `session-${e.sid}-auto-prune`) } catch {}
        try { unlinkSync(full) } catch {}
      }
    } catch { /* 清理失败不阻塞保存 */ }
  }
  load(sid) {
    const f = join(this.sessionsDir, `${sid}.json`)
    if (!existsSync(f)) return null
    // 损坏文件不能让启动路径（tryResume）崩溃，解析失败返回 null
    try { return JSON.parse(readFileSync(f,'utf-8')) } catch { return null }
  }
  list() { return existsSync(this.sessionsDir) ? readdirSync(this.sessionsDir).filter(f => f.endsWith('.json')).map(f => f.replace('.json','')) : [] }
  /**
   * 按标题找会话（重名保护用）：命中返回 sid，没有返回 null。
   *
   * 只读每个文件头部 4KB：会话 JSON 是 pretty-print，title 紧跟 sessionId
   * 在前几十字节；没必要把每个会话几百 KB 的全文都解析一遍。
   * 读不出/损坏的文件直接跳过（不阻塞命名）。
   */
  findByTitle(title, excludeSid = null) {
    const want = String(title || '').trim()
    if (!want) return null
    for (const sid of this.list()) {
      if (sid === excludeSid) continue
      let head = ''
      try {
        const fd = openSync(join(this.sessionsDir, `${sid}.json`), 'r')
        try {
          const buf = Buffer.alloc(4096)
          const n = readSync(fd, buf, 0, 4096, 0)
          head = buf.subarray(0, n).toString('utf-8')
        } finally { closeSync(fd) }
      } catch { continue }
      const m = head.match(/"title"\s*:\s*("(?:[^"\\]|\\.)*")/)
      if (!m) continue
      let t = null
      try { t = JSON.parse(m[1]) } catch { continue }
      if (t && String(t).trim() === want) return sid
    }
    return null
  }
  latest() {
    const list = this.list(); if (list.length === 0) return null
    // 单个文件被并发删除时 statSync 会抛，逐个 try 跳过失效项
    const s = list.map(id => {
      try { return { id, mtime: statSync(join(this.sessionsDir,`${id}.json`)).mtimeMs } } catch { return null }
    }).filter(Boolean).sort((a,b) => b.mtime - a.mtime)
    return s.length ? s[0].id : null
  }
  /**
   * 最近一次保存的会话，**排除指定 ID**（通常是当前会话）。
   *
   * 【为什么需要】/resume 无参的语义是「切到上一个会话」。
   * 但当前会话每轮对话都会落盘，`latest()` 返回的永远是它自己 ——
   * 无参 /resume 等于原地重载当前会话，用户看到的只是「已恢复 (N 条消息)」，
   * 没有任何切换发生。排除当前 ID 才能拿到真正「上一个」。
   */
  latestExcept(excludeId) {
    const list = this.list().filter(id => id !== excludeId)
    if (list.length === 0) return null
    const s = list.map(id => {
      try { return { id, mtime: statSync(join(this.sessionsDir,`${id}.json`)).mtimeMs } } catch { return null }
    }).filter(Boolean).sort((a,b) => b.mtime - a.mtime)
    return s.length ? s[0].id : null
  }
  delete(sid) {
    const f = join(this.sessionsDir, `${sid}.json`)
    if (!existsSync(f)) return false
    // 删除前也备份一份
    try { backupToTrash(f, `session-${sid}-before-delete`) } catch {}
    unlinkSync(f); return true
  }
}
