// Claude Code Mobile - 智能工作流工具集（对标 Claude Code 原版扩展）
// ApplyPatch / Test / Diagnostics / RepoMap / Symbols / SafeRename
// 设计原则：全部本地执行（不消耗 API）、复用 undo/trash/LSP 链路、失败不写盘

import { Tool } from './tools.mjs'
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync, mkdirSync, unlinkSync } from 'node:fs'
import { resolve, join, dirname, basename, relative, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { backupBeforeOverwrite, backupToTrash } from './trash.mjs'
import { atomicWrite } from './atomic.mjs'
import { buildRepoMap, scanRepo, rankTags } from './repo-map.mjs'
import { lspManager } from './lsp.mjs'

// ─── 帮助函数 ───────────────────────────────────────────────

// 路径安全：目标必须在当前目录内（防路径穿越）
function safeResolve(base, target) {
  const root = resolve(base)
  const full = resolve(base, target)
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`路径越界: ${target}（只能操作 ${root} 内的文件）`)
  }
  return full
}

function runCmd(command, args, { cwd, timeout = 60000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(command, args, {
      cwd: cwd || process.cwd(),
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    }, (err, stdout, stderr) => {
      resolvePromise({
        ok: !err,
        code: err ? (err.code ?? 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err ? err.message : null,
      })
    })
    child.on('error', (e) => {
      reject(new Error(`无法启动命令 ${command}: ${e.message}`))
    })
  })
}

// ─── 1. ApplyPatch：应用 unified diff ────────────────────────
// 支持 git 风格 patch（diff --git / --- / +++ / @@ hunk），多文件原子应用
// 失败时不写任何文件；成功前对每个目标文件保存 undo 快照

export class ApplyPatchTool extends Tool {
  constructor(undoStore) {
    super({
      name: 'ApplyPatch',
      description: '应用 unified diff（git diff 格式）到多个文件。原子操作：任一文件解析/应用失败则全部不改。支持新增/删除/修改文件。比多个 Edit 更适合大改动，由模型一次性生成完整 patch。',
      input_schema: {
        type: 'object',
        properties: {
          patch: { type: 'string', description: 'unified diff 文本（git diff 输出格式，含 diff --git / --- / +++ / @@ hunk）' },
          base_path: { type: 'string', description: 'patch 内相对路径的基准目录（默认当前工作目录）' },
          backup_note: { type: 'string', description: '（可选）这次修改的目的，写进回收站备份名' },
        },
        required: ['patch'],
      },
      isDestructive: () => true,
      isConcurrencySafe: () => false,
      maxResultSizeChars: 5000,
      validateInput: (input) => {
        const errors = []
        if (!input.patch || typeof input.patch !== 'string') errors.push('patch is required (unified diff string)')
        return { valid: errors.length === 0, errors }
      },
    })
    this.undoStore = undoStore
  }

  // 解析单个文件的 patch 段：返回 { i, path, oldPath, newPath, hunks }
  // startIdx 指向 'diff --git ...' 行；从下一行开始解析，读到下一个 'diff --git' 为止
  _parseFilePatch(lines, startIdx) {
    let i = startIdx + 1
    let path = null
    let oldPath = null
    let newPath = null
    const hunks = []
    let curHunk = null
    let inHunk = false

    for (; i < lines.length; i++) {
      const line = lines[i]
      if (line.startsWith('diff --git ')) break
      if (line.startsWith('--- ')) { oldPath = line.slice(4).trim(); continue }
      if (line.startsWith('+++ ')) { newPath = line.slice(4).trim(); continue }
      if (line.startsWith('@@ ')) {
        if (curHunk) hunks.push(curHunk)
        const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
        curHunk = {
          oldStart: m ? parseInt(m[1]) : 1,
          oldCount: m && m[2] ? parseInt(m[2]) : 1,
          newStart: m ? parseInt(m[3]) : 1,
          newCount: m && m[4] ? parseInt(m[4]) : 1,
          oldLines: [],
          newLines: [],
        }
        inHunk = true
        continue
      }
      if (inHunk) {
        if (line.startsWith(' ')) { curHunk.oldLines.push(line.slice(1)); curHunk.newLines.push(line.slice(1)) }
        else if (line.startsWith('-')) curHunk.oldLines.push(line.slice(1))
        else if (line.startsWith('+')) curHunk.newLines.push(line.slice(1))
        else if (line.startsWith('\\ No newline')) { /* 忽略 */ }
        else { inHunk = false }
        continue
      }
      // 非 hunk 行：跳过（如 index / new file mode / --- 等元信息）
    }
    if (curHunk) hunks.push(curHunk)

    // 从 +++ 行解析路径（去掉 a/ b/ 前缀）
    path = newPath || oldPath || null
    if (path) path = path.replace(/^[ab]\//, '')

    return { i, path, oldPath, newPath, hunks }
  }

  // 对单个文件应用 hunks；返回新内容
  _applyHunks(oldContent, hunks) {
    let lines = oldContent === '' ? [] : (oldContent ?? '').split('\n')
    // 去掉末尾空行（文件以 \n 结尾时 split 多一个 ''）
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

    // 从后往前应用 hunk，避免行号偏移
    for (let h = hunks.length - 1; h >= 0; h--) {
      const hunk = hunks[h]
      const start = hunk.oldStart - 1  // 0-based
      const oldLen = hunk.oldLines.length
      // 验证旧内容匹配
      for (let k = 0; k < oldLen; k++) {
        const actual = lines[start + k]
        const expected = hunk.oldLines[k]
        if (actual !== expected) {
          throw new Error(`hunk @-${hunk.oldStart} 上下文不匹配：第 ${start + k + 1} 行期望 "${expected.slice(0, 60)}"，实际 "${String(actual).slice(0, 60)}"`)
        }
      }
      // 替换 oldLen 行为 newLines
      const newLines = [...hunk.newLines]
      lines.splice(start, oldLen, ...newLines)
    }

    return lines.join('\n') + '\n'
  }

  async execute(input, ctx = {}) {
    const base = resolve(ctx.cwd || process.cwd(), input.base_path || '.')
    const patchLines = input.patch.replace(/\r\n/g, '\n').split('\n')

    // 先解析所有文件 patch（parse 阶段不写盘）
    const files = []
    let i = 0
    while (i < patchLines.length) {
      if (patchLines[i].startsWith('diff --git ')) {
        const parsed = this._parseFilePatch(patchLines, i)
        if (!parsed.path) throw new Error(`无法解析 patch 文件路径（${patchLines[i]}）`)
        files.push(parsed)
        i = parsed.i
      } else i++
    }
    if (files.length === 0) throw new Error('patch 中未找到 diff --git 段，请提供完整 git diff 格式')

    // 应用阶段：全部在内存中计算，任一失败则整体不写
    const applied = []
    const writeList = []  // { abs, newContent }
    for (const fp of files) {
      const abs = safeResolve(base, fp.path)
      const existed = existsSync(abs)
      const oldContent = existed ? readFileSync(abs, 'utf-8') : null

      let newContent
      if (!existed && fp.hunks.length === 0) {
        // 新文件（diff --git a/x b/x 但没有 hunk？不正常）
        throw new Error(`新文件 ${fp.path} 没有可写入内容`)
      }
      if (existed) {
        newContent = this._applyHunks(oldContent, fp.hunks)
      } else {
        // 全新文件：hunks 全部是 + 行
        let lines = []
        for (const hunk of fp.hunks) lines.push(...hunk.newLines)
        newContent = lines.join('\n') + '\n'
      }
      writeList.push({ abs, newContent, existed, oldContent, path: fp.path })
      applied.push(`${existed ? '修改' : '新建'} ${fp.path}`)
    }

    // 写盘阶段：两阶段提交（prepare → commit）
    //
    // 【为什么不能直接循环 atomicWrite】atomicWrite 只保证「单个文件」原子，
    // 批次里第 N 个失败时前 N-1 个已经落盘且没有回滚，
    // 与工具描述承诺的「任一文件失败则全部不改」不符（多文件 patch 会写出半套改动）。
    //
    // 阶段一：所有文件都写成 .tmp（不碰目标路径）。任一失败 → 清理全部 tmp，原文件零改动。
    // 阶段二：全部 tmp 就位后再逐个 rename。rename 是同目录内的原子操作，
    //         走到这一步基本只会因权限/磁盘满失败；万一中途失败，用已保存的
    //         oldContent 把已 rename 的文件回滚，尽最大努力恢复。
    const staged = []   // { abs, tmp, existed, oldContent }
    try {
      for (const w of writeList) {
        const tmp = `${w.abs}.applypatch-${process.pid}-${Date.now().toString(36)}`
        writeFileSync(tmp, w.newContent, 'utf-8')
        staged.push({ abs: w.abs, tmp, existed: w.existed, oldContent: w.oldContent })
      }
    } catch (e) {
      for (const s of staged) { try { unlinkSync(s.tmp) } catch {} }
      throw new Error(`ApplyPatch 准备阶段失败，未改动任何文件：${e.message}`)
    }

    // 备份/快照放在 commit 之前、prepare 之后：此时已确认全部内容可写出，
    // 不会为一个注定失败的 patch 污染回收站和 undo 历史。
    for (const w of writeList) {
      if (!w.existed) continue
      backupBeforeOverwrite(w.abs, w.newContent, input.backup_note || '')
      if (this.undoStore) this.undoStore.saveSnapshot(w.abs, w.oldContent, input.backup_note || '')
    }

    const written = []
    const committed = []
    try {
      for (const s of staged) {
        renameSync(s.tmp, s.abs)
        committed.push(s)
        written.push(s.abs)
      }
    } catch (e) {
      // 回滚已 rename 的：原有文件恢复旧内容，新建的删掉
      for (const c of committed.reverse()) {
        try {
          if (c.existed) writeFileSync(c.abs, c.oldContent, 'utf-8')
          else unlinkSync(c.abs)
        } catch {}
      }
      for (const s of staged) { try { unlinkSync(s.tmp) } catch {} }
      throw new Error(`ApplyPatch 提交阶段失败，已回滚：${e.message}`)
    }

    return `ApplyPatch 完成：${applied.join('；')}\n已写 ${written.length} 个文件`
  }
}

// ─── 2. Test：运行测试/检查命令 ─────────────────────────────
// 优先读 package.json scripts；也可直接给命令

export class TestTool extends Tool {
  constructor() {
    super({
      name: 'Test',
      description: '运行测试或检查命令（npm test / node --check / 自定义命令）。默认运行 package.json 的 test 脚本；可指定 script 名或自定义命令字符串。返回结构化结果（退出码、stdout/stderr）。',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '自定义命令（如 "node tests/xxx.mjs"）；不传则用 script 参数' },
          script: { type: 'string', description: 'package.json scripts 里的名字（如 "test"、"check:web"）' },
          cwd: { type: 'string', description: '工作目录（默认当前）' },
          timeout: { type: 'number', description: '超时 ms（默认 60000）' },
        },
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      maxResultSizeChars: 8000,
    })
  }

  async execute(input, ctx = {}) {
    const cwd = resolve(ctx.cwd || process.cwd(), input.cwd || '.')
    const pkgPath = join(cwd, 'package.json')
    let pkg = null
    try { pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) } catch {}

    let command, args = []
    if (input.command) {
      const parts = input.command.split(/\s+/)
      command = parts[0]
      args = parts.slice(1)
    } else if (input.script && pkg?.scripts?.[input.script]) {
      const scriptCmd = pkg.scripts[input.script]
      const parts = scriptCmd.split(/\s+/)
      command = parts[0]
      args = parts.slice(1)
    } else if (input.script && pkg?.scripts?.[input.script] === undefined) {
      return `package.json 中没有 script "${input.script}"。可用: ${Object.keys(pkg?.scripts || {}).join(', ') || '(无)'}`
    } else if (pkg?.scripts?.test) {
      const scriptCmd = pkg.scripts.test
      const parts = scriptCmd.split(/\s+/)
      command = parts[0]
      args = parts.slice(1)
    } else {
      // 兜底：node --check 全部 mjs
      command = process.execPath
      args = ['--check']
      return `未找到 test script，尝试对项目 .mjs 逐个 node --check...（或显式传 command/script）`
    }

    const result = await runCmd(command, args, { cwd, timeout: input.timeout || 60000 })
    const summary = [
      `Test 结果: ${result.ok ? '✅ 通过' : `❌ 失败 (exit ${result.code})`}`,
      `命令: ${command} ${args.join(' ')}`,
      `目录: ${cwd}`,
    ]
    const output = (result.stdout || '').trim()
    const errOut = (result.stderr || '').trim()
    if (output) summary.push(`\n--- stdout ---\n${output.slice(-4000)}`)
    if (errOut) summary.push(`\n--- stderr ---\n${errOut.slice(-4000)}`)
    if (!result.ok && result.error) summary.push(`\n错误: ${result.error}`)
    return summary.join('\n')
  }
}

// ─── 3. Diagnostics：代码诊断 ────────────────────────────────
// 走 LSP（js/ts/py），非支持类型用 node --check

export class DiagnosticsTool extends Tool {
  constructor() {
    super({
      name: 'Diagnostics',
      description: '获取文件的代码诊断（语法/类型错误）。支持 .js/.ts/.jsx/.mjs/.cjs/.py 走 LSP；其他文件可用 check_only 选项跑 node --check。适合修改代码后自证无错。',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '要诊断的文件' },
          check_only: { type: 'boolean', description: 'true 时跳过 LSP 直接 node --check（更快，只查语法）' },
        },
        required: ['file_path'],
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => false,  // LSP 内部有状态，避免并发
      maxResultSizeChars: 10000,
      validateInput: (input) => {
        const errors = []
        if (!input.file_path) errors.push('file_path is required')
        return { valid: errors.length === 0, errors }
      },
    })
  }

  async execute(input, ctx = {}) {
    const abs = resolve(ctx.cwd || process.cwd(), input.file_path)
    if (!existsSync(abs)) return `文件不存在: ${abs}`

    // 纯语法检查（node --check）
    if (input.check_only && abs.endsWith('.mjs') || input.check_only && abs.endsWith('.js')) {
      const result = await runCmd(process.execPath, ['--check', abs], { timeout: 30000 })
      return result.ok
        ? `✅ ${input.file_path} 语法通过`
        : `❌ ${input.file_path} 语法错误:\n${(result.stderr || '').slice(-2000)}`
    }

    // LSP 诊断
    const result = await lspManager.run(abs, 'diagnostic', {}, ctx.cwd || process.cwd())
    if (result?.error) return `LSP 失败: ${result.error}`
    if (!Array.isArray(result) || result.length === 0) return `✅ ${input.file_path} 无诊断错误`
    return result.map(d => {
      const sev = { 1: 'ERROR', 2: 'WARN', 3: 'INFO', 4: 'HINT' }[d.severity] || 'MSG'
      const start = d.range?.start || { line: 0, character: 0 }
      return `[${sev}] ${start.line + 1}:${start.character + 1} ${d.message}${d.source ? ` (${d.source})` : ''}`
    }).join('\n')
  }
}

// ─── 4. RepoMap：仓库结构地图 ────────────────────────────────
// 复用 core/repo-map.mjs 的 Aider PageRank 简化版

export class RepoMapTool extends Tool {
  constructor() {
    super({
      name: 'RepoMap',
      description: '生成代码库结构地图（函数/类/常量定义，按引用频次排序）。用于快速了解项目，比全量 Glob+Read 更省 token。',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '仓库目录（默认当前）' },
          max_tags: { type: 'number', description: '最多显示多少标签（默认 60）' },
          max_chars: { type: 'number', description: '输出字符上限（默认 4000）' },
        },
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      maxResultSizeChars: 8000,
    })
  }
  async execute(input, ctx = {}) {
    const dir = resolve(ctx.cwd || process.cwd(), input.path || '.')
    if (!existsSync(dir)) return `目录不存在: ${dir}`
    return buildRepoMap(dir, {
      maxTags: input.max_tags || 60,
      maxChars: input.max_chars || 4000,
      signal: ctx.signal,
    })
  }
}

// ─── 5. Symbols：符号索引（支持类型过滤 + 定位） ──────────────
// 比 RepoMap 更全：给出符号名、类型、文件、行号

export class SymbolsTool extends Tool {
  constructor() {
    super({
      name: 'Symbols',
      description: '列出代码库中的符号（类/函数/常量/接口/类型），可按名称关键词过滤。返回 文件:行号 符号名 (类型) — 可直接用 Read 定位。',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录（默认当前）' },
          keyword: { type: 'string', description: '按符号名关键词过滤（如 "api"、"tool"）' },
          limit: { type: 'number', description: '最多返回多少（默认 80）' },
        },
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      maxResultSizeChars: 10000,
    })
  }
  async execute(input, ctx = {}) {
    const dir = resolve(ctx.cwd || process.cwd(), input.path || '.')
    if (!existsSync(dir)) return `目录不存在: ${dir}`
    const { tags, files, contents, truncated } = await scanRepo(dir, { signal: ctx.signal })
    const keyword = (input.keyword || '').toLowerCase()
    const ranked = (await rankTags(tags, files, contents, { signal: ctx.signal }))
      .filter(t => !keyword || t.name.toLowerCase().includes(keyword))
    const limit = Math.min(input.limit || 80, 300)
    if (ranked.length === 0) return keyword ? `没有匹配 "${input.keyword}" 的符号` : '没有找到符号'
    const out = ranked.slice(0, limit).map(t => {
      const rel = relative(dir, t.file)
      return `${rel}:${t.line} ${t.name} (refs:${t.refs})`
    })
    const tail = ranked.length > limit ? `\n... 其余 ${ranked.length - limit} 个省略` : ''
    const capped = truncated ? '\n... 扫描因文件数或总大小上限提前结束' : ''
    return out.join('\n') + tail + capped
  }
}

// ─── 6. SafeRename：安全重命名（先找引用 + 预览） ─────────────
// 只做文本级引用替换（同一目录下简单标识符重命名），不跨文件黑魔法；
// 提供 dry_run 预览，确认后才写盘。

export class SafeRenameTool extends Tool {
  constructor(undoStore) {
    super({
      name: 'SafeRename',
      description: '安全重命名文件/目录内的标识符。先扫描引用并给出预览（dry_run=true 只预览不改），确认后原子替换所有出现。',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '扫描目录（默认当前）' },
          from: { type: 'string', description: '旧名称（标识符/文件名片段）' },
          to: { type: 'string', description: '新名称' },
          include: { type: 'string', description: '文件名过滤正则（如 \\.mjs$）' },
          dry_run: { type: 'boolean', description: 'true=只预览不修改' },
          backup_note: { type: 'string', description: '（可选）修改说明，写进回收站' },
        },
        required: ['from', 'to'],
      },
      isDestructive: () => true,
      isConcurrencySafe: () => false,
      maxResultSizeChars: 8000,
      validateInput: (input) => {
        const errors = []
        if (!input.from) errors.push('from is required')
        if (!input.to) errors.push('to is required')
        if (input.from === input.to) errors.push('from 与 to 相同')
        return { valid: errors.length === 0, errors }
      },
    })
    this.undoStore = undoStore
  }

  async execute(input, ctx = {}) {
    const dir = resolve(ctx.cwd || process.cwd(), input.path || '.')
    if (!existsSync(dir)) return `目录不存在: ${dir}`
    const from = input.from
    const to = input.to
    const includeRe = input.include ? new RegExp(input.include) : null

    // 收集候选文件（源码文件）
    const candidates = []
    const walk = (d) => {
      let entries; try { entries = readdirSync(d) } catch { return }
      for (const e of entries) {
        if (e.startsWith('.') || e === 'node_modules' || e === '.git') continue
        const full = join(d, e)
        let s; try { s = statSync(full) } catch { continue }
        if (s.isDirectory()) { walk(full); continue }
        if (!/\.(mjs|js|ts|jsx|tsx|py|json|md|html|css)$/i.test(e)) continue
        if (includeRe && !includeRe.test(e)) continue
        candidates.push(full)
      }
    }
    walk(dir)

    // 扫描引用
    const refs = []
    for (const f of candidates) {
      let content; try { content = readFileSync(f, 'utf-8') } catch { continue }
      if (!content.includes(from)) continue
      const count = content.split(from).length - 1
      refs.push({ file: f, count, rel: relative(dir, f) })
    }
    if (refs.length === 0) return `未找到 "${from}" 的引用（目录: ${dir}）`

    const preview = refs.map(r => `  ${r.rel} · ${r.count} 处`).join('\n')
    if (input.dry_run) {
      return `SafeRename 预览（${refs.length} 个文件，${refs.reduce((a, r) => a + r.count, 0)} 处引用）:\n${preview}\n\n确认后去掉 dry_run 执行`
    }

    // 执行替换
    const changed = []
    for (const r of refs) {
      const oldContent = readFileSync(r.file, 'utf-8')
      const newContent = oldContent.split(from).join(to)
      backupBeforeOverwrite(r.file, newContent, input.backup_note || '')
      if (this.undoStore) this.undoStore.saveSnapshot(r.file, oldContent, input.backup_note || '')
      atomicWrite(r.file, newContent)
      changed.push(r.rel)
    }
    return `SafeRename 完成：${from} → ${to}\n${changed.map(c => `  ✓ ${c}`).join('\n')}`
  }
}

// ─── 7. Sleep：主动等待 ────────────────────────────────────
// 为什么需要专门的工具而不是 `Bash sleep 5`：
//   1. Bash 是风险最高的工具，为了等几秒去开一个 shell 不合理
//   2. `Bash sleep` 期间 Ctrl+C 只能杀子进程，工具本身仍在等待返回
//   3. Bash 有 600s 超时上限且输出会进结果，纯等待场景全是噪音
// 典型用途：等构建产物落盘、等服务端口就绪、等异步任务、给上游限流留冷却间隔。
export class SleepTool extends Tool {
  constructor() {
    super({
      name: 'Sleep',
      description: '暂停执行指定秒数后继续。用于等构建完成、等服务启动、等异步任务、'
        + '给限流留冷却间隔。\n'
        + '【别用它做轮询】要等子 Agent 用 AgentOutput({block:true})，'
        + '要等界面用 phone_wait，要等后台命令用 BashOutput —— 那些会在条件满足时'
        + '立刻返回，比盲等固定秒数快得多。\n'
        + '【上限 300 秒】需要更久说明该换成后台任务 + 事件回调。',
      input_schema: {
        type: 'object',
        properties: {
          seconds: { type: 'number', description: '等待秒数，0.1 到 300' },
          reason: { type: 'string', description: '可选：为什么要等（写进结果，方便回溯）' },
        },
        required: ['seconds'],
      },
      // 纯等待，不碰文件系统也不改状态
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      validateInput: (input) => {
        const s = Number(input?.seconds)
        if (!Number.isFinite(s)) return 'seconds 必须是数字'
        if (s < 0.1) return 'seconds 不能小于 0.1'
        if (s > 300) return 'seconds 不能超过 300（更久请改用后台任务）'
        return null
      },
    })
  }

  async execute(input, ctx = {}) {
    const seconds = Number(input.seconds)
    const ms = Math.round(seconds * 1000)
    const startedAt = Date.now()
    // 【必须响应 ctx.signal】否则 Ctrl+C 之后这个工具还在挂着，
    // 用户按了中断却要等它睡完 —— 这正是不用 `Bash sleep` 的理由之一。
    const interrupted = await new Promise((resolve) => {
      let timer = null
      let ticker = null
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        if (ticker) clearInterval(ticker)
      }
      const onAbort = () => { cleanup(); resolve(true) }
      // 【倒计时要在等待期间可见 · 2026-09-04】
      // 只在结束后的结果行写「已等待 100s」是没用的：那时候等待早结束了，
      // 而「还要等多久」恰恰是等待期间才需要的信息（原来那几秒屏幕上只有 spinner，
      // 看不出是在等待还是卡死）。用 ctx.onProgress 每秒推一次剩余时间。
      // 只有 ≥3 秒才开 ticker：短等待推进度纯闪屏。
      //
      // ⚠ 必须带 { replace: true }（2026-09-06 修）：
      //   onProgress 默认是**追加**语义（Bash 的输出本来就要一行行累积），
      //   而倒计时每秒推的是「同一行的新版本」，走追加就变成
      //     剩 88/100s
      //     剩 87/100s
      //     剩 86/100s   ← 一直往下堆，屏幕被刷满
      //   replace 让 UI 侧把这次内容**整体替换**掉上次的，实现原地刷新。
      if (typeof ctx.onProgress === 'function' && seconds >= 3) {
        // 文案用分数「剩 3/4」：分子=剩余秒、分母=总秒数，一眼看出还要等多久。
        // 用 ceil 避免结束前显示「剩 0」。
        ticker = setInterval(() => {
          const left = Math.ceil(Math.max(0, seconds - (Date.now() - startedAt) / 1000))
          try { ctx.onProgress(`剩 ${left}/${seconds}s`, { replace: true }) } catch {}
        }, 1000)
        if (ticker.unref) ticker.unref()
      }
      timer = setTimeout(() => {
        cleanup()
        if (ctx.signal) ctx.signal.removeEventListener?.('abort', onAbort)
        resolve(false)
      }, ms)
      if (ctx.signal) {
        if (ctx.signal.aborted) { onAbort(); return }
        ctx.signal.addEventListener('abort', onAbort, { once: true })
      }
    })
    const actual = ((Date.now() - startedAt) / 1000).toFixed(1)
    const why = input.reason ? `（${String(input.reason).slice(0, 80)}）` : ''
    // 结果行保持简洁：等待过程中的进度由上面的 onProgress 倒计时负责，
    // 这里再写一遍目标值属于事后重复（等待已经结束，那个数字没有决策价值）。
    // 只有「被中断」值得说清还差多少 —— 那说明目标没达成。
    if (interrupted) return `等待被中断：实际 ${actual}s / 目标 ${seconds}s${why}`
    return `已等待 ${actual}s${why}`
  }
}
