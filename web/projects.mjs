/**
 * 项目（Projects）—— Web 端的持久化知识容器。
 *
 * 【为什么有这个文件】
 * 用户反馈「web 中有"项目"这个概念，但实际没做」——核实属实：
 * UI（ProjectsPage.tsx，858 行）是从官方照抄的完整界面，
 * 但 `web/src/api.ts` 里项目相关的 9 个函数**全是 stub**（`return []` / `return {}`），
 * 服务端也没有任何 /api/projects 端点。整个功能是空壳。
 *
 * 【设计依据】用户给的资料（/sdcard/Download/claude-workspace/project.txt）：
 * 官方 Projects 的核心是三层：
 *   1. **知识库**：项目内上传的文档，对话时作为背景参考
 *   2. **项目指令**：每个项目单独定制的回应方式
 *   3. **检索增强**：内容接近上下文上限时自动启用 RAG（官方仅付费）
 *
 * 我们实现 1+2（第 3 层需要向量检索，手机端不值得，用「文件内容按需注入 +
 * 超出预算时截断并提示」代替），并额外做：
 *   · 项目对话（conversation 归属项目，列表里能看 chat_count）
 *   · 归档（is_archived，列表可过滤）
 *
 * 【为什么不复用官方云端结构】官方 Projects 跑在它的服务端（有账号/共享/权限）。
 * 我们是本地单机：一个 JSON 文件就是全部真相，随会话数据一起放 ~/.claude-code-mobile/。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, unlinkSync, copyFileSync, renameSync } from 'node:fs'
import { join, basename, extname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

/** 项目数据文件：与 sessions 同级，便于一起备份。 */
const PROJECTS_FILE = 'projects.json'
/** 项目上传文件的落盘目录（每个项目一个子目录）。 */
const PROJECT_FILES_DIR = 'project-files'

/**
 * 单次注入 systemPrompt 的知识库上限（字符）。
 * 超出部分不注入，改为在提示里说明「还有 N 个文件未展开」——
 * 比静默截断好：模型知道自己看到的不全，会主动 Read 剩下的。
 * （官方在这一层用的是 RAG；手机端做向量检索性价比太低。）
 */
const KNOWLEDGE_CHAR_BUDGET = 24000

export class ProjectStore {
  /**
   * @param {string} root 数据根目录（通常 ~/.claude-code-mobile）
   */
  constructor(root) {
    this.root = root
    this.file = join(root, PROJECTS_FILE)
    this.filesDir = join(root, PROJECT_FILES_DIR)
    this.data = this._load()
  }

  _load() {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      return { projects: Array.isArray(raw?.projects) ? raw.projects : [] }
    } catch {
      return { projects: [] }
    }
  }

  _save() {
    mkdirSync(this.root, { recursive: true })
    // 原子写：先写临时文件再 rename，避免断电/被杀时留下半截 JSON。
    // （会话数据用的是同一套做法，保持一致。）
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }

  list({ includeArchived = true } = {}) {
    const all = this.data.projects
    const filtered = includeArchived ? all : all.filter(p => !p.is_archived)
    // 最近更新的排前面（与官方列表一致）
    return filtered
      .slice()
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
      .map(p => this._summary(p))
  }

  /** 列表用的精简形态（带计数，不带文件内容 —— 内容可能很大）。 */
  _summary(p) {
    return {
      id: p.id,
      name: p.name,
      description: p.description || '',
      instructions: p.instructions || '',
      file_count: Array.isArray(p.files) ? p.files.length : 0,
      chat_count: Array.isArray(p.conversations) ? p.conversations.length : 0,
      is_archived: !!p.is_archived,
      created_at: p.created_at,
      updated_at: p.updated_at,
      // 列表页要显示前几个文件名，给个轻量摘要就够（不含正文）
      files: (p.files || []).map(f => ({ id: f.id, file_name: f.file_name, file_size: f.file_size })),
    }
  }

  get(id) {
    const p = this.data.projects.find(x => x.id === id)
    return p || null
  }

  create({ name, description = '', instructions = '' }) {
    const now = new Date().toISOString()
    const project = {
      id: randomBytes(8).toString('hex'),
      name: String(name || '').trim() || '未命名项目',
      description: String(description || ''),
      instructions: String(instructions || ''),
      files: [],          // [{ id, file_name, file_size, mime_type, path, uploaded_at }]
      conversations: [],  // [{ id, title, created_at }]
      is_archived: false,
      created_at: now,
      updated_at: now,
    }
    this.data.projects.push(project)
    this._save()
    return this._summary(project)
  }

  update(id, patch = {}) {
    const p = this.get(id)
    if (!p) return null
    // 只允许改这几个字段 —— 白名单比黑名单安全（不会让调用方顺手改 files/conversations）
    for (const k of ['name', 'description', 'instructions', 'is_archived']) {
      if (patch[k] !== undefined) p[k] = patch[k]
    }
    p.updated_at = new Date().toISOString()
    this._save()
    return this._summary(p)
  }

  remove(id) {
    const i = this.data.projects.findIndex(x => x.id === id)
    if (i < 0) return false
    const [removed] = this.data.projects.splice(i, 1)
    // 删掉它的上传文件（不留孤儿占空间）
    for (const f of removed.files || []) {
      try { if (f.path && existsSync(f.path)) unlinkSync(f.path) } catch {}
    }
    try { /* 目录空了也不强删，留给后续上传复用 */ } catch {}
    this._save()
    return true
  }

  /**
   * 把一个已上传的文件挂到项目下。
   * @param {string} id 项目 id
   * @param {{ sourcePath: string, fileName: string, mimeType?: string, size?: number }} file
   */
  addFile(id, { sourcePath, fileName, mimeType = '', size = 0 }) {
    const p = this.get(id)
    if (!p) return null
    const dir = join(this.filesDir, id)
    mkdirSync(dir, { recursive: true })
    const fileId = randomBytes(8).toString('hex')
    // 保留扩展名（有些场景要靠它判断类型），前缀用 fileId 防重名覆盖
    const ext = extname(fileName || '')
    const dest = join(dir, `${fileId}${ext}`)
    copyFileSync(sourcePath, dest)
    const entry = {
      id: fileId,
      file_name: fileName || basename(dest),
      file_size: size || (() => { try { return statSync(dest).size } catch { return 0 } })(),
      mime_type: mimeType,
      path: dest,
      uploaded_at: new Date().toISOString(),
    }
    p.files = [...(p.files || []), entry]
    p.updated_at = new Date().toISOString()
    this._save()
    return entry
  }

  removeFile(id, fileId) {
    const p = this.get(id)
    if (!p) return false
    const i = (p.files || []).findIndex(f => f.id === fileId)
    if (i < 0) return false
    const [f] = p.files.splice(i, 1)
    try { if (f.path && existsSync(f.path)) unlinkSync(f.path) } catch {}
    p.updated_at = new Date().toISOString()
    this._save()
    return true
  }

  /** 把会话挂到项目下（建项目对话时调）。 */
  attachConversation(id, { conversationId, title = '' }) {
    const p = this.get(id)
    if (!p) return null
    if (!Array.isArray(p.conversations)) p.conversations = []
    if (!p.conversations.some(c => c.id === conversationId)) {
      p.conversations.push({ id: conversationId, title, created_at: new Date().toISOString() })
      p.updated_at = new Date().toISOString()
      this._save()
    }
    return p.conversations
  }

  detachConversation(id, conversationId) {
    const p = this.get(id)
    if (!p) return false
    const before = (p.conversations || []).length
    p.conversations = (p.conversations || []).filter(c => c.id !== conversationId)
    if (p.conversations.length !== before) {
      p.updated_at = new Date().toISOString()
      this._save()
      return true
    }
    return false
  }

  /** 找出某个会话属于哪个项目（会话侧栏/加载时要用）。 */
  projectOfConversation(conversationId) {
    return this.data.projects.find(p => (p.conversations || []).some(c => c.id === conversationId)) || null
  }

  /**
   * 构造注入 systemPrompt 的「项目背景」段。
   *
   * 对应官方 Projects 的第 1+2 层：知识库（文件内容）+ 项目指令。
   * 第 3 层（检索增强）用「按预算截断 + 明确告知还剩多少」代替：
   * 手机端跑向量检索不现实，但模型知道"还有文件没展开"时会主动 Read。
   *
   * @returns {string} 空串表示不注入（会话不属于任何项目）
   */
  buildPromptSection(conversationId) {
    const p = this.projectOfConversation(conversationId)
    if (!p) return ''

    const lines = ['\n# 当前项目（Projects）']
    lines.push(`项目名：${p.name}`)
    if (p.description) lines.push(`描述：${p.description}`)

    if (p.instructions && String(p.instructions).trim()) {
      lines.push('')
      lines.push('## 项目指令（必须遵守）')
      lines.push(String(p.instructions).trim())
    }

    const files = Array.isArray(p.files) ? p.files : []
    if (files.length) {
      lines.push('')
      lines.push('## 项目知识库')
      lines.push(`本项目有 ${files.length} 个文件。以下是可直接阅读的文本内容：`)
      let used = 0
      const skipped = []
      for (const f of files) {
        // 只展开文本类文件；二进制（图片/PDF/zip）给出路径让模型按需用工具读
        const isText = /\.(md|txt|json|js|mjs|cjs|ts|tsx|jsx|py|sh|css|html|xml|yaml|yml|csv|log|ini|toml)$/i.test(f.file_name || '')
        if (!isText) { skipped.push(f); continue }
        let body = ''
        try { body = readFileSync(f.path, 'utf8') } catch { skipped.push(f); continue }
        if (used + body.length > KNOWLEDGE_CHAR_BUDGET) {
          // 预算不够就不再展开，但**记下来**并在末尾说明（不静默截断）
          skipped.push(f)
          continue
        }
        used += body.length
        lines.push('')
        lines.push(`### ${f.file_name}`)
        lines.push('```')
        lines.push(body.replace(/\n$/, ''))
        lines.push('```')
      }
      if (skipped.length) {
        lines.push('')
        lines.push(`（以上未展开的文件共 ${skipped.length} 个，需要时用 Read 工具按路径读取：）`)
        for (const f of skipped) lines.push(`- ${f.file_name} → ${f.path}`)
      }
    }

    lines.push('')
    lines.push('注意：这是用户为该会话所属项目准备的背景资料；回答时优先遵循项目指令。')
    return lines.join('\n') + '\n'
  }
}
