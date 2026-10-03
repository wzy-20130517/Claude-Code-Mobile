// Claude Code Mobile - Skills 系统
// 支持多目录：项目 skills/ 优先，用户全局 ~/.claude/skills 兜底
import { Tool } from './tools.mjs'
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

// 全局 active skill 清单在 system prompt 里的字符预算。
// 背景：实测 820 个全局 skill 全量注入 = 108KB ≈ 31K tokens，每轮都发，直接把上下文顶满。
// 6000 字符大约能列 200+ 个名字，够模型知道有哪些技能；其余靠 Skill 工具按名检索。
const ACTIVE_SKILL_LIST_BUDGET = 6000

export function globalSkillsDir() {
  return join(homedir(), '.claude', 'skills')
}

export function ensureGlobalSkillsDir() {
  const dir = globalSkillsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function ensureProjectSkillsDir(cwd = process.cwd()) {
  const dir = join(cwd, 'skills')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function unquote(s) {
  const v = String(s ?? '').trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  return v
}

// frontmatter 解析。原来只认 `key: 单行字符串`，但官方字段里 paths/allowedTools/tags
// 都是数组，两种写法都得吃：
//   inline:  paths: ["**/*.tsx", "src/**"]
//   列表:    paths:
//              - "**/*.tsx"
//              - src/**
function parseFrontmatter(content) {
  const m = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { meta: {}, body: String(content || ''), raw: String(content || '') }
  const meta = {}
  const lines = m[1].split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const km = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:(.*)$/)
    if (!km) { i++; continue }
    const key = km[1].trim().toLowerCase()
    const rest = km[2].trim()

    // 内联数组 [a, b, c]
    if (rest.startsWith('[') && rest.endsWith(']')) {
      meta[key] = rest.slice(1, -1).split(',').map(unquote).filter(Boolean)
      i++
      continue
    }
    // 值为空 → 看下面是不是 YAML 列表
    if (rest === '') {
      const items = []
      let j = i + 1
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        items.push(unquote(lines[j].replace(/^\s*-\s+/, '')))
        j++
      }
      meta[key] = items.length ? items : ''
      i = items.length ? j : i + 1
      continue
    }
    meta[key] = unquote(rest)
    i++
  }
  return { meta, body: String(content).slice(m[0].length), raw: String(content) }
}

// 参数替换：{{args}} / {{query}} 两种占位符。
// inline、fork、用户显式调用三条路径共用，避免各写一份漂移。
function applySkillArgs(body, args) {
  const a = args != null ? String(args) : ''
  if (!a) return body
  return String(body || '')
    .replace(/\{\{\s*args\s*\}\}/g, a)
    .replace(/\{\{\s*query\s*\}\}/g, a)
}

/**
 * 在 skill 正文前拼一段资源说明，让模型知道附属文件在哪、有哪些。
 *
 * 对齐官方做法：官方 bundledSkills 解包 files 后，会在 prompt 前面加一句
 * "Base directory: <dir>" 再列出文件；模型自己决定要不要 Read。
 * 我们不预读文件内容——skill 可能带几百 KB 资源，全塞进上下文是浪费，
 * 让模型按需 Read 才对。
 */
function withSkillFiles(body, entry) {
  const files = entry?.files || []
  if (!entry?.baseDir || !files.length) return body
  const kb = (n) => n >= 1024 ? `${(n / 1024).toFixed(0)}KB` : `${n}B`
  const lines = files.map(f => `  ${f.rel}${f.size ? `  (${kb(f.size)})` : ''}`)
  return [
    `本 skill 附带资源文件，目录：${entry.baseDir}`,
    ...lines,
    '需要时用 Read 读取（路径 = 上面目录 + 文件名）。不要凭猜测编造这些文件的内容。',
    '',
    body,
  ].join('\n')
}

/**
 * 解析 skill frontmatter 里的 hooks 字段。
 * 写坏了就当没有——skill 是用户自己放的文件，一个语法错不该让整个 skill 加载失败，
 * 更不该让 CLI 起不来。官方在 loadSkillsDir 里也是 fail-open 处理。
 */
/**
 * 若 skill 声明了 hooks 就注册进 HookManager。
 * 两条入口（Skill 工具、用户 /skill-name）都调这个，保证行为一致。
 * fail-open：注册失败只是没有钩子，不该让 skill 展开本身失败。
 */
function registerSkillHooksIfAny(hookManager, entry) {
  if (!hookManager?.registerSkillHooks || !entry?.hooks) return 0
  try {
    return hookManager.registerSkillHooks(entry.name, entry.hooks, entry.baseDir)
  } catch {
    return 0
  }
}

function parseSkillHooks(raw) {
  if (!raw) return null
  if (typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(String(raw))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function asArray(v) {
  if (Array.isArray(v)) return v.filter(Boolean)
  const s = String(v ?? '').trim()
  if (!s) return []
  return s.split(/[,\s]+/).filter(Boolean)
}

// glob → 正则。支持 ** / * / ? ，够覆盖 paths 的实际写法
function globToRe(glob) {
  let out = ''
  const g = String(glob || '')
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') { out += '.*'; i++; if (g[i + 1] === '/') i++ }
      else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else if ('.+^${}()|[]\\'.includes(c)) out += '\\' + c
    else out += c
  }
  return new RegExp('^' + out + '$')
}

function isTruthyMeta(v) {
  if (v === true) return true
  const s = String(v ?? '').trim().toLowerCase()
  return s === 'true' || s === 'yes' || s === '1' || s === 'on' || s === 'passive'
}

/**
 * 显式的「假」值判定。
 *
 * 不能用 !isTruthyMeta()：那样字段缺失（undefined）也会判成 false，
 * 而 userInvocable 这类开关必须「默认 true，只有明确写 false 才关」。
 */
function isFalsyMeta(v) {
  if (v === false) return true
  const s = String(v ?? '').trim().toLowerCase()
  return s === 'false' || s === 'no' || s === '0' || s === 'off'
}

function isPassiveMeta(meta = {}) {
  if (isTruthyMeta(meta.passive)) return true
  if (isTruthyMeta(meta.always) || isTruthyMeta(meta.inject) || isTruthyMeta(meta.auto)) return true
  const mode = String(meta.mode || meta.type || '').trim().toLowerCase()
  return mode === 'passive' || mode === 'always' || mode === 'inject' || mode === 'auto'
}

export class SkillLoader {
  constructor(rootDirs = './skills') {
    const list = (Array.isArray(rootDirs) ? rootDirs : [rootDirs]).filter(Boolean).map(d => String(d))
    this.rootDirs = list.length ? list : ['./skills']
    const primary = this.rootDirs[0]
    if (primary && !existsSync(primary)) {
      try { mkdirSync(primary, { recursive: true }) } catch {}
    }
    // list() 结果缓存。启动路径改走 listNames()（只 readdir+stat，不读正文），
    // 名单/时间戳没变时 list() 也直接命中，不再把 823 个文件全部读一遍
    //（实测：冷盘读全文 3s、热盘 0.5s；只扫目录名 12~25ms）。
    this._listCache = null
  }

  _resolveFile(safeName) {
    for (const dir of this.rootDirs) {
      if (!dir || !existsSync(dir)) continue
      // 1) 扁平结构: skills/foo.md
      const f = join(dir, safeName)
      if (existsSync(f)) return { path: f, dir, scope: this._scopeOf(dir) }
      // 2) 仓库目录结构: skills/foo/SKILL.md
      const nameDir = safeName.replace(/\.md$/i, '')
      const f2 = join(dir, nameDir, 'SKILL.md')
      if (existsSync(f2)) return { path: f2, dir, scope: this._scopeOf(dir) }
    }
    return null
  }

  _scopeOf(dir) {
    try {
      const g = globalSkillsDir()
      if (dir === g || dir.startsWith(g + '/') || dir.startsWith(g + '\\')) return 'global'
    } catch {}
    return 'project'
  }

  _safeName(name) {
    if (typeof name !== 'string' || !name) return null
    if (name.includes('/') || name.includes('\\') || name.includes('..') || name.includes('\0')) return null
    return name.endsWith('.md') ? name : `${name}.md`
  }

  _entryFromFile(name, full, dir) {
    let content = ''
    try { content = readFileSync(full, 'utf-8') } catch { return null }
    const { meta, body } = parseFrontmatter(content)
    const passive = isPassiveMeta(meta)

    // 官方执行语义字段（Claude Code 对齐）。缺失即默认值，所以只有
    // name/description 的老 skill 行为完全不变。
    const paths = asArray(meta.paths)
    const context = String(meta.context || '').trim().toLowerCase() === 'fork' ? 'fork' : 'inline'

    return {
      name,
      description: String(meta.description || '').trim(),
      scope: this._scopeOf(dir),
      path: full,
      passive,
      mode: passive ? 'passive' : 'active',

      // ── 执行语义：决定这个 skill 以什么身份运行 ─────────────
      context,                                     // inline=当前对话展开；fork=派子 agent 隔离执行
      agent: String(meta.agent || '').trim() || null,        // 指定 subagent_type
      model: String(meta.model || '').trim() || null,        // 强制模型
      effort: String(meta.effort || '').trim() || null,      // 强制思考强度
      allowedTools: asArray(meta.allowedtools || meta['allowed-tools']),  // 工具白名单
      // hooks: skill 自带生命周期钩子（对齐官方 BundledSkillDefinition.hooks）。
      // frontmatter 里写 JSON，例：
      //   hooks: {"PreToolUse":[{"matcher":"Write","hooks":[{"command":"./guard.sh"}]}]}
      // 只在该 skill 激活期间生效，命令以 skill 目录为 cwd。
      hooks: parseSkillHooks(meta.hooks),
      whenToUse: String(meta.when || meta.when_to_use || meta['when-to-use'] || '').trim(),
      // ── 双通道调用开关（对齐官方 loadSkillsDir.ts）─────────────
      // 官方把每个 skill 直接做成 type:'prompt' 的 Command，同时是
      // 「用户可敲的 slash 命令」和「模型可调的能力」，两个开关独立：
      //   disableModelInvocation: true  → 模型不准自己调，只能用户 /名字 触发
      //   userInvocable: false          → 不出现在命令列表里，只给模型用
      // 官方还有 isHidden = !userInvocable，我们用 userInvocable 直接过滤。
      disableModelInvocation: isTruthyMeta(meta.disablemodelinvocation ?? meta['disable-model-invocation']),
      // 默认可用户调用；显式写 userInvocable: false / user-invocable: false 才关闭
      userInvocable: !isFalsyMeta(meta.userinvocable ?? meta['user-invocable']),

      // ── 条件激活：paths 命中才进上下文 ────────────────────
      paths,
      conditional: paths.length > 0,
      _pathRes: paths.map(globToRe),

      // ── 分组维度（现有 136 个 skill 都带 domain/tags，用来做按需加载）──
      domain: String(meta.domain || '').trim() || null,
      subdomain: String(meta.subdomain || '').trim() || null,
      tags: asArray(meta.tags),

      version: String(meta.version || '').trim() || null,

      // ── 附属资源文件（对齐官方 BundledSkillDefinition.files）───────
      // 官方把资源内联在 TS 定义里，首次调用时解包到磁盘；我们的 skill 本来
      // 就是目录形式（skills/foo/SKILL.md），资源直接放同目录即可，无需解包。
      // baseDir 会写进展开后的正文，模型据此 Read 资源。
      baseDir: this._skillBaseDir(full),
      files: this._scanSkillFiles(full),

      meta,
      body,
      raw: content,
    }
  }

  /**
   * skill 的资源根目录。
   * 目录型（skills/foo/SKILL.md）→ skills/foo，可以放附属资源；
   * 扁平型（skills/foo.md）→ null，单文件没有自己的目录。
   */
  _skillBaseDir(fullPath) {
    return /(?:^|[\\/])SKILL\.md$/i.test(fullPath) ? dirname(fullPath) : null
  }

  /**
   * 扫描 skill 目录下的附属资源（不含 SKILL.md 本身）。
   *
   * 【为什么要限制】
   * 这些文件名会拼进提示词，且模型会照着去 Read。所以：
   *   - 只扫一层子目录，避免 node_modules 之类深树炸上下文
   *   - 数量上限 40，超出只报总数
   *   - 跳过隐藏文件和常见垃圾目录
   * 官方在 resolveSkillFilePath() 里也做了 `..` 和绝对路径校验防逃逸，
   * 我们这里是「扫描已存在的文件」而不是「按外部输入写文件」，
   * 逃逸风险本身不存在，但仍不跟随符号链接，避免指向仓库外。
   */
  _scanSkillFiles(fullPath) {
    const base = this._skillBaseDir(fullPath)
    if (!base) return []
    const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv'])
    const MAX_FILES = 40
    const out = []
    const walk = (dir, depth, prefix) => {
      if (out.length >= MAX_FILES || depth > 1) return
      let ents
      try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const ent of ents) {
        if (out.length >= MAX_FILES) return
        if (ent.name.startsWith('.')) continue
        const rel = prefix ? `${prefix}/${ent.name}` : ent.name
        if (ent.isSymbolicLink()) continue
        if (ent.isDirectory()) {
          if (SKIP_DIRS.has(ent.name)) continue
          walk(join(dir, ent.name), depth + 1, rel)
        } else if (ent.isFile()) {
          if (/^SKILL\.md$/i.test(ent.name) && !prefix) continue
          let size = 0
          try { size = statSync(join(dir, ent.name)).size } catch {}
          out.push({ rel, size })
        }
      }
    }
    walk(base, 0, '')
    return out.sort((a, b) => a.rel.localeCompare(b.rel))
  }

  /** 某个 skill 的 paths 是否匹配给定文件列表 */
  matchesPaths(entry, files = []) {
    if (!entry?.conditional) return false
    for (const f of files) {
      const norm = String(f || '').replace(/^\.\//, '')
      for (const re of entry._pathRes) {
        if (re.test(norm)) return true
      }
    }
    return false
  }

  /**
   * 条件激活：给定本轮涉及的文件，返回该被激活的 conditional skill。
   * 对应 Claude Code 的 activateConditionalSkillsForPaths()。
   */
  activateForPaths(files = []) {
    return this.list().filter(e => this.matchesPaths(e, files))
  }

  /** 按 domain 分组索引：用于「先给目录，再按需展开」省上下文 */
  domainIndex() {
    const idx = new Map()
    for (const e of this.list()) {
      const d = e.domain || '(未分类)'
      if (!idx.has(d)) idx.set(d, [])
      idx.get(d).push(e.name)
    }
    return idx
  }

  /** 估算一个 skill 注入清单时的 token 成本（对齐官方 estimateSkillFrontmatterTokens） */
  estimateTokens(entry) {
    const text = `${entry.name}${entry.description}${entry.whenToUse || ''}`
    return Math.ceil(text.length / 3)
  }

  /**
   * 目录扫描：列出所有候选 skill 文件（**不读正文**），保留 readdir 顺序与
   * rootDirs 优先级（项目在前）。同名候选全部保留，去重交给调用方 ——
   * 与旧 list() 行为一致：解析失败的名字不占用，可以下沉到后一个目录的同名文件。
   *
   * 每项带 (mtimeMs, size)，供缓存键比对；stat 失败记为 null（强制重建，不缓存）。
   */
  _scanCandidates() {
    const out = []
    for (const dir of this.rootDirs) {
      if (!dir || !existsSync(dir)) continue
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const ent of entries) {
        let name = null
        let full = null
        if (ent.isFile() && ent.name.endsWith('.md')) {
          // 扁平结构: skills/foo.md
          name = ent.name.replace(/\.md$/i, '')
          full = join(dir, ent.name)
        } else if (ent.isDirectory()) {
          // 仓库结构: skills/foo/SKILL.md
          const sk = join(dir, ent.name, 'SKILL.md')
          if (!existsSync(sk)) continue
          name = ent.name
          full = sk
        } else {
          continue
        }
        let mtimeMs = null
        let size = null
        try { const st = statSync(full); mtimeMs = st.mtimeMs; size = st.size } catch {}
        out.push({ name, full, dir, mtimeMs, size })
      }
    }
    return out
  }

  /** 缓存键：路径 + mtime + size 拼串。任何一项 stat 失败 → 唯一 nonce，永不复用。 */
  _scanIdentity(cands) {
    let id = ''
    for (const c of cands) {
      if (c.mtimeMs == null) return `BROKEN:${Date.now()}:${Math.random()}`
      id += `${c.full}\u0000${c.mtimeMs}\u0000${c.size}\n`
    }
    return id
  }

  list() {
    const cands = this._scanCandidates()
    const id = this._scanIdentity(cands)
    if (this._listCache && this._listCache.id === id) return this._listCache.entries.slice()
    const map = new Map()
    for (const c of cands) {
      if (map.has(c.name)) continue
      const e = this._entryFromFile(c.name, c.full, c.dir)
      if (e) map.set(c.name, e)
    }
    const entries = [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
    this._listCache = { id, entries }
    return entries.slice()
  }

  /**
   * 只列名字（不读正文）。启动路径专用：
   *   - format() 里全局 skill 只需要一个数量
   *   - 命令补全（slashCommands）只需要名字
   * 本地 skill 数量少（个位数），顺手解析拿 userInvocable，保证补全过滤语义不变；
   * 全局 skill 不读正文（823 个里 0 个使用该开关），默认视为可用户调用。
   *
   * 与 list() 的细微差别：读不出内容（解析失败）的文件在 list() 里不占名
   *（可下沉到全局同名），这里以「文件存在」为准。影响仅限病态场景（文件在但读不出）。
   */
  listNames() {
    const cands = this._scanCandidates()
    const seen = new Set()
    const out = []
    for (const c of cands) {
      if (seen.has(c.name)) continue
      seen.add(c.name)
      const scope = this._scopeOf(c.dir)
      const item = { name: c.name, scope, path: c.full, dir: c.dir }
      if (scope !== 'global') {
        try {
          const e = this._entryFromFile(c.name, c.full, c.dir)
          if (e) item.userInvocable = e.userInvocable
        } catch {}
      }
      out.push(item)
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }

  /** 名单缓存作废（write() 自动调用；文件系统外部改动靠 mtime 校验兜底）。 */
  invalidate() {
    this._listCache = null
  }

  get(name) {
    const safe = this._safeName(name)
    if (!safe) return null
    const hit = this._resolveFile(safe)
    if (!hit) return null
    return this._entryFromFile(safe.replace(/\.md$/i, ''), hit.path, hit.dir)
  }

  read(name) {
    const entry = this.get(name)
    return entry?.raw || ''
  }

  write(name, content, opts = {}) {
    const safe = this._safeName(name)
    if (!safe) throw new Error(`非法 skill 名: ${name}`)
    let dir
    if (opts.scope === 'global') {
      dir = ensureGlobalSkillsDir()
    } else {
      dir = this.rootDirs[0] || ensureProjectSkillsDir()
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    }
    const f = join(dir, safe)
    writeFileSync(f, content, 'utf-8')
    // 内容变了，名单缓存作废（mtime 校验其实也能发现，这里省一次全量比对）
    this._listCache = null
    return f
    return f
  }

  format() {
    // 【性能】以前用 list()：把 823 个全局 skill 全文读一遍（冷盘 3s），
    // 但全局 skill 在这里只用到一个「数量」，正文白读。改用 listNames() 只扫
    // 目录名；本地 skill 只有个位数，按需解析拿 description（实测 ~5ms）。
    //
    // 【为什么不再注入 passive 正文】
    // 原来 passive skill 的正文每轮硬塞进 system prompt。多个 passive 同时生效时，
    // 各自都在给模型设定身份（「你是资深 IDE 工程师」「你是教书十年的老师」），
    // 直接互相打架 —— 模型只能二选一或者串味，这是实测出现幻觉的根因。
    //
    // 官方 SKILL.md 规范里没有 passive，原因就在这：skill 是【能力】不是【人格】。
    // 身份始终由 system prompt 唯一掌握，skill 只在被调用时提供领域知识。
    // 触发时机写进 description（官方做法：「Use when building gesture-driven UI...」），
    // 由模型自己判断何时调用。
    //
    // 兼容：仍解析 passive 字段，但只用于在清单里打标提示，不再注入正文。
    const all = this.listNames()
    let out = ''

    if (all.length) {
      // 预算控制：全局 skill 库可能有上千个（实测 820 个 = 108KB ≈ 31K tokens），
      // 无条件全量注入会把 system prompt 撑爆，导致每轮都逼近上下文上限。
      // 策略：项目 skill 全列（带描述），全局 skill 只列个数；
      // 具体技能让模型用 Skill 工具按名字检索（SkillTool 会做模糊匹配）。
      const local = all.filter(x => x.scope !== 'global')
      const globalCount = all.length - local.length

      out += '\n\n# 可用 Skills（主动）\n'

      if (local.length) {
        out += '\n## 项目 skills\n'
        for (const x of local) {
          let desc = ''
          try { desc = this._entryFromFile(x.name, x.path, x.dir)?.description || '' } catch {}
          out += `- \`/${x.name}\`: ${desc || '无描述'}\n`
        }
      }

      if (globalCount) {
        // 全局 skill 名单不再每轮注入提示词：822 个名字 = ~1767 tokens，
        // 每轮模型都要重新 prefill 这部分，但名字本身帮不了模型找到对的那个 skill
        //（它不知道哪个 skill 能解决当前问题）。改为让模型主动用 Skill 工具搜索。
        // 项目 skills 仍会列出（7 个，19 字符，几乎免费）。
        out += `\n## 全局 skills（共 ${globalCount} 个）\n`
        out += '按名字用 Skill 工具调用即可（支持模糊匹配），或用 Grep 搜 ~/.claude/skills/ 找具体技能。\n'
      }

      out += '\n（skill 正文不每轮注入；用 /名字 或 Skill 工具展开。同名时项目覆盖全局。）\n'
    } else {
      return ''
    }
    return out
  }
}

export class SkillTool extends Tool {
  constructor(loader, opts = {}) {
    super({
      name: 'Skill',
      description: '调用一个 skill：读取它的正文并展开到当前上下文，获得该领域的专门知识/方法。何时该调用写在每个 skill 的 description 里。支持项目 skills/ 与 ~/.claude/skills/，同名时项目优先，名字支持模糊匹配。',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'skill 名（不含 .md），支持模糊匹配' },
          args: { type: 'string', description: '可选参数，替换 {{args}} / {{query}}' },
        },
        required: ['name'],
      },
    })
    this.loader = loader
    // fork 执行器由 index.mjs 注入（需要 Agent 能力，skills.mjs 不该直接依赖 agent）
    this.forkRunner = opts.forkRunner || null
    // hookManager 同理由 index.mjs 注入，用于注册 skill 自带的 hooks
    this.hookManager = opts.hookManager || null
  }

  async execute(input) {
    const entry = this.loader.get(input.name)
    if (!entry) throw new Error(`Skill "${input.name}" not found（项目 skills/ 与 ~/.claude/skills/）`)

    // disable-model-invocation：官方唯一的行为开关。声明后只能用户显式 /名字 触发，
    // 模型不许自己调（防止把「需要人拍板」的 skill 自动跑掉）。
    // 用户路径走 expandActiveSkill()，不经过这里，所以这条只拦模型。
    if (entry.disableModelInvocation) {
      throw new Error(
        `Skill "/${entry.name}" 声明了 disable-model-invocation，只能由用户显式调用 /${entry.name}，模型不能自行触发。`
      )
    }

    // skill 声明的 hooks 在展开时生效（session 级）。
    // 放在 body 组装之前：万一 registerSkillHooks 抛了也不影响正文返回。
    registerSkillHooksIfAny(this.hookManager, entry)

    const body = withSkillFiles(applySkillArgs(entry.body || '', input.args), entry)

    // context: fork —— 不在当前对话展开，而是派一个子 agent 在隔离上下文里跑完再回报。
    // 这是 skill 从「模板」升级成「架构组件」的关键：它自带独立 token 预算、
    // 可指定模型/思考强度/工具白名单，不污染主对话。
    if (entry.context === 'fork') {
      if (!this.forkRunner) {
        return `Skill /${entry.name} 声明了 context: fork，但当前环境未提供 fork 执行器，已降级为内联展开:\n\n${body}`
      }
      const out = await this.forkRunner({
        name: entry.name,
        prompt: body,
        agent: entry.agent,
        model: entry.model,
        effort: entry.effort,
        allowedTools: entry.allowedTools,
      })
      return `Skill /${entry.name}（fork 隔离执行${entry.agent ? ` · agent=${entry.agent}` : ''}${entry.model ? ` · model=${entry.model}` : ''}）结果:\n\n${out}`
    }

    // inline：展开到当前上下文。若声明了 model/effort/allowedTools，附带提示让调用方生效。
    const scope = entry.scope === 'global' ? '全局' : '项目'
    const hints = []
    if (entry.model) hints.push(`建议模型 ${entry.model}`)
    if (entry.effort) hints.push(`思考强度 ${entry.effort}`)
    if (entry.allowedTools.length) hints.push(`仅用工具 ${entry.allowedTools.join('/')}`)
    const hintLine = hints.length ? `\n（本 skill 声明：${hints.join(' · ')}）` : ''
    return `Skill /${entry.name}（${scope}）展开:${hintLine}\n\n${body}`
  }
}

/** slash/Web 展开主动 skill 前调用；被动则返回错误文案 */
export function expandActiveSkill(loader, name, argText = '', hookManager = null) {
  const entry = loader.get(name)
  if (!entry) return null
  // 用户手动展开时同样注册 skill hooks，与 Skill 工具路径保持一致
  registerSkillHooksIfAny(hookManager, entry)
  // 不再拦 passive：passive 正文已不注入系统，用户手动 /名字 展开是唯一入口。
  // disableModelInvocation 也不拦这里 —— 那个字段的语义正是「只许用户调」。
  // 资源清单对用户路径同样要加：否则 /skill-name 展开后模型看不到附属文件，
  // 而 Skill 工具路径能看到，两条入口行为不一致会很难排查。
  return { error: false, content: withSkillFiles(applySkillArgs(entry.body || '', argText), entry), entry }
}
