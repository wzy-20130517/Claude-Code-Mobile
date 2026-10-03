// Claude Code Mobile - 跨文件 Undo（持久化索引）
// 索引: undo-index.json；快照内容: 同目录独立文件
// 根目录固定在包安装目录下（不依赖 process.cwd()），避免工作区切换丢索引
import { existsSync, writeFileSync, readFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { atomicWrite } from './atomic.mjs'
import { isGitRepo, autoCommit, resetToCommit, listSessionCommits } from './git-checkpoint.mjs'
import { DATA_DIR } from './paths.mjs'

// 50 太少：一轮多文件改动（MultiEdit + 几次 Write）就能吃掉十几条，
// 密集开发时几分钟满一轮，想回退到半小时前的状态就已经被清掉了。
// 快照都是文本文件，300 条量级的磁盘占用可以忽略。
const MAX_SNAPSHOTS = 300
const TTL_MS = 7 * 24 * 60 * 60 * 1000  // 7 天

function defaultUndoRoot() {
  // 【2026-10-03】原来指向源码内的 .claude-code-mobile/undo ——
  // 用户要求源码与数据分离，改到家目录（core/paths.mjs 统一解析）。
  return join(DATA_DIR, 'undo')
}

export class MultiUndoStore {
  constructor(rootDir = defaultUndoRoot()) {
    this.rootDir = resolve(rootDir)
    this.indexFile = join(this.rootDir, 'undo-index.json')
    if (!existsSync(this.rootDir)) mkdirSync(this.rootDir, { recursive: true })
    this.snapshots = []
    this.gitRoot = null  // 检测到的 git 仓库根目录（缓存）；null=非 git 环境
    this._loadIndex()
  }

  // 检测工作区是否是 git 仓库（懒检测 + 缓存）
  _detectGit() {
    if (this.gitRoot !== null) return this.gitRoot
    try {
      // 包目录的上一级（claude-code-mobile 项目根）作为工作目录
      const candidate = resolve(this.rootDir, '..', '..')
      this.gitRoot = isGitRepo(candidate) ? candidate : false
    } catch { this.gitRoot = false }
    return this.gitRoot
  }

  init() {
    this._maybeCleanup(true)
  }

  _resolveSnapshotFile(entryPath) {
    if (!entryPath) return null
    if (existsSync(entryPath)) return entryPath
    const abs1 = resolve(entryPath)
    if (existsSync(abs1)) return abs1
    const abs2 = join(this.rootDir, basename(entryPath))
    if (existsSync(abs2)) return abs2
    return null
  }

  _loadIndex() {
    try {
      if (!existsSync(this.indexFile)) {
        this.snapshots = []
        return
      }
      const data = JSON.parse(readFileSync(this.indexFile, 'utf-8'))
      if (!Array.isArray(data.snapshots)) {
        this.snapshots = []
        return
      }
      let changed = false
      this.snapshots = data.snapshots.map(s => {
        if (s.type !== 'file') return s
        const fixed = this._resolveSnapshotFile(s.file)
        if (!fixed) {
          changed = true
          return null
        }
        if (fixed !== s.file) changed = true
        return {
          ...s,
          file: fixed,
          path: s.path ? resolve(s.path) : s.path,
        }
      }).filter(Boolean)
      if (changed) this._flushIndex()
    } catch {
      this.snapshots = []
    }
  }

  _flushIndex() {
    try {
      // 原子写：索引文件半写损坏会丢失所有回滚点，必须 tmp+rename
      atomicWrite(
        this.indexFile,
        JSON.stringify({ snapshots: this.snapshots, savedAt: Date.now() }),
        'utf-8'
      )
    } catch {}
  }

  _deleteSnapshotFile(snapshotPath) {
    try { if (snapshotPath && existsSync(snapshotPath)) unlinkSync(snapshotPath) } catch {}
  }

  _maybeCleanup(aggressive = false) {
    if (!aggressive) return
    const now = Date.now()
    const fileSnaps = this.snapshots.filter(s => s.type === 'file')
    const expired = new Set()
    for (const s of fileSnaps) {
      if (now - (s.timestamp || 0) > TTL_MS) {
        expired.add(s.file)
        this._deleteSnapshotFile(s.file)
      }
    }
    let keepFiles = fileSnaps.filter(s => !expired.has(s.file))
    if (keepFiles.length > MAX_SNAPSHOTS) {
      const drop = keepFiles.slice(0, keepFiles.length - MAX_SNAPSHOTS)
      for (const s of drop) {
        expired.add(s.file)
        this._deleteSnapshotFile(s.file)
      }
    }
    if (expired.size === 0) return
    this.snapshots = this.snapshots.filter(s => s.type !== 'file' || !expired.has(s.file))
    this._pruneEmptyGroups()
    this._flushIndex()
  }

  _pruneEmptyGroups() {
    const result = []
    for (let i = 0; i < this.snapshots.length; i++) {
      const s = this.snapshots[i]
      if (s.type !== 'group_start') {
        if (s.type === 'group_end' || s.type === 'file') result.push(s)
        continue
      }
      let hasFile = false
      let endIdx = -1
      for (let j = i + 1; j < this.snapshots.length; j++) {
        if (this.snapshots[j].type === 'group_end') { endIdx = j; break }
        if (this.snapshots[j].type === 'file') hasFile = true
      }
      if (hasFile) result.push(s)
      else i = endIdx >= 0 ? endIdx : i
    }
    const cleaned = []
    let depth = 0
    for (const s of result) {
      if (s.type === 'group_start') { depth++; cleaned.push(s) }
      else if (s.type === 'group_end') {
        if (depth > 0) { depth--; cleaned.push(s) }
      } else cleaned.push(s)
    }
    this.snapshots = cleaned
  }

  beginGroup() {
    this.snapshots.push({ type: 'group_start', timestamp: Date.now() })
    this._flushIndex()
  }

  /**
   * @param {string} filePath 被修改的文件
   * @param {string} content  修改前的内容（用于回滚）
   * @param {string} [note]   本次改动的说明（来自工具的 backup_note），写进 git 提交信息
   */
  saveSnapshot(filePath, content, note = '') {
    const absPath = resolve(filePath)
    const safeName = absPath.replace(/[\/\\]/g, '_')
    const snapFile = join(this.rootDir, `${Date.now()}_${safeName}`)
    writeFileSync(snapFile, content, 'utf-8')
    // git 检查点：仓库内编辑后自动提交，快照记录 commit hash 供 undo 精确回滚
    let gitCommit = null
    const gitRoot = this._detectGit()
    if (gitRoot) {
      // 提交信息优先用改动说明（相对路径 + note），回退到原来的 edit 文件名。
      // 原来清一色 "edit _path_to_file"，git log 里完全看不出每次改了什么。
      const relName = absPath.startsWith(gitRoot) ? absPath.slice(gitRoot.length).replace(/^[\/\\]/, '') : safeName.slice(-40)
      const cleanNote = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 100)
      const summary = cleanNote ? `${relName} — ${cleanNote}` : `edit ${relName}`
      try { gitCommit = autoCommit(gitRoot, summary) } catch {}
    }
    this.snapshots.push({
      type: 'file',
      path: absPath,
      file: snapFile,
      timestamp: Date.now(),
      gitCommit,  // 该快照对应的 git 提交 hash（无 git 时为 null）
    })
    const fileCount = this.snapshots.filter(s => s.type === 'file').length
    if (fileCount > MAX_SNAPSHOTS) this._maybeCleanup(true)
    else this._flushIndex()
  }

  endGroup() {
    let startIdx = -1
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i].type === 'group_end') break
      if (this.snapshots[i].type === 'group_start') { startIdx = i; break }
    }
    if (startIdx < 0) return
    const hasFile = this.snapshots.slice(startIdx + 1).some(s => s.type === 'file')
    if (!hasFile) this.snapshots.splice(startIdx, 1)
    else this.snapshots.push({ type: 'group_end', timestamp: Date.now() })
    this._flushIndex()
  }

  _findGroupStart(groupEndIdx) {
    for (let i = groupEndIdx - 1; i >= 0; i--) {
      if (this.snapshots[i].type === 'group_start') return i
    }
    return 0
  }

  undo() {
    let groupEndIdx = -1
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i].type === 'group_end') { groupEndIdx = i; break }
    }
    if (groupEndIdx >= 0) {
      const startIdx = this._findGroupStart(groupEndIdx)
      const files = this.snapshots.slice(startIdx + 1, groupEndIdx).filter(s => s.type === 'file')
      const results = []
      for (const f of files.slice().reverse()) {
        const snap = this._resolveSnapshotFile(f.file)
        if (snap) {
          atomicWrite(f.path, readFileSync(snap, 'utf-8'), 'utf-8')
          results.push(`回滚: ${f.path}`)
          this._deleteSnapshotFile(snap)
        }
      }
      this.snapshots.splice(startIdx, groupEndIdx - startIdx + 1)
      this._flushIndex()
      return results
    }

    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      const s = this.snapshots[i]
      if (s.type !== 'file') continue
      // git 模式：有 commit hash 且是 git 仓库 → 回滚到该 commit 的上一提交
      if (s.gitCommit && this.gitRoot) {
        const ok = resetToCommit(this.gitRoot, `${s.gitCommit}~1`)
        this.snapshots.splice(i, 1)
        this._flushIndex()
        return ok ? [`已回滚 git 提交: ${s.path}`] : [`git 回滚失败，快照已移除: ${s.path}`]
      }
      // 文件快照模式
      const snap = this._resolveSnapshotFile(s.file)
      if (snap) {
        atomicWrite(s.path, readFileSync(snap, 'utf-8'), 'utf-8')
        this._deleteSnapshotFile(snap)
        this.snapshots.splice(i, 1)
        this._flushIndex()
        return [`回滚: ${s.path}`]
      }
      this.snapshots.splice(i, 1)
      this._flushIndex()
    }
    return []
  }

  // 默认值跟着 MAX_SNAPSHOTS 走：留 50 的话存了 300 条也只能列出最近 50 条，
  // 等于上限提了但看不到。
  listSnapshots(maxCount = MAX_SNAPSHOTS) {
    const files = this.snapshots.filter(s => s.type === 'file')
    return files.slice(-maxCount).map(s => ({
      file: s.path,
      snapshotPath: s.file,
      timestamp: new Date(s.timestamp).toLocaleString(),
    }))
  }

  getSnapshotCount() {
    return this.snapshots.filter(s => s.type === 'file').length
  }

  getRootDir() {
    return this.rootDir
  }
}
