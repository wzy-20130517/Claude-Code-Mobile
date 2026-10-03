// Claude Code Mobile - 回收站
// 大修改或删除时备份旧文件到 ~/.claude-code-mobile/trash/
// 备份文件名: ♻原名.时间戳.hash前6位
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, copyFileSync, statSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { DATA_DIR } from './paths.mjs'

// 【2026-10-03】原来是相对路径 '.claude-code-mobile/trash' ——
// 相对 **cwd**，而 CLI 启动时 cwd 是项目目录，回收站就落在源码里（448MB）。
// 改成家目录下的绝对路径，与源码彻底分离。
const TRASH_DIR = join(DATA_DIR, 'trash')
// 回收站 manifest：备份名 → 原始绝对路径。恢复时优先用它还原到原位，
// 而不是盲目恢复到 process.cwd()（原来恢复错位置，从别处删的文件全堆到项目根）。
const TRASH_MANIFEST = join(DATA_DIR, 'trash-manifest.json')

function loadTrashManifest() {
  try { return JSON.parse(readFileSync(TRASH_MANIFEST, 'utf-8')) || {} } catch { return {} }
}
function saveTrashManifest(manifest) {
  try { writeFileSync(TRASH_MANIFEST, JSON.stringify(manifest), 'utf-8') } catch {}
}
const MIN_DIFF_TO_BACKUP = 200  // 修改量超过 200 字符才备份

function ensureTrashDir() {
  if (!existsSync(TRASH_DIR)) mkdirSync(TRASH_DIR, { recursive: true })
}

function shortHash(content) {
  return createHash('md5').update(content).digest('hex').slice(0, 6)
}

function timestampStr() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

// 备份文件名: ♻原名.时间戳.hash前6位.描述（可选）
function sanitizeDesc(s) {
  if (!s) return ''
  // 去掉 Windows/Linux 都不友好的字符，限制长度
  let r = String(s).trim().replace(/[\/\\\:*?"<>|\n\r\t]/g, '_').replace(/\s+/g, '_').slice(0, 40)
  // 前缀加 . 分隔，方便后续解析
  return r ? '.' + r : ''
}

function makeTrashName(filePath, content, desc = '') {
  const base = basename(filePath)
  return `♻${base}.${timestampStr()}.${shortHash(content)}${sanitizeDesc(desc)}`
}

// 计算两段文本的差异字符数（简化版：取最长公共子序列的余集）
function diffSize(oldStr, newStr) {
  if (oldStr === newStr) return 0
  // 简化：直接取绝对差 + 交集外的字符
  // 更精确的算法太慢，用行级 diff 近似
  const oldLines = oldStr.split('\n')
  const newLines = newStr.split('\n')
  // 做个简单的行级比较
  const oldSet = new Set(oldLines)
  const newSet = new Set(newLines)
  let diff = 0
  let i = 0, j = 0
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) { i++; j++ }
    else {
      // 找 newLines[j] 在 oldLines 里最近的匹配
      let found = false
      for (let k = i; k < Math.min(i + 5, oldLines.length); k++) {
        if (oldLines[k] === newLines[j]) { diff += oldLines.slice(i, k).join('\n').length; i = k + 1; found = true; break }
      }
      if (!found) { diff += newLines[j].length; j++ }
    }
  }
  // 剩余的
  if (i < oldLines.length) diff += oldLines.slice(i).join('\n').length
  if (j < newLines.length) diff += newLines.slice(j).join('\n').length
  return diff
}

// 备份被删除的文件（rm 用，整文件删除总是备份）
// 回收站文件数上限：超出时删最旧的（含 manifest 条目）
export const MAX_TRASH_FILES = 200

// 从 ♻原名.时间戳.hash.描述 里取时间戳（20260827-114141 这段）。
// 拿不到就返回 0（当最旧处理，优先被清）。
function trashTimeKey(name) {
  const m = String(name).match(/\.(\d{8}-\d{6})\./)
  return m ? Number(m[1].replace('-', '')) : 0
}

function pruneTrash() {
  try {
    // 【为什么不能直接 .sort()】
    // 文件名是 ♻原名.时间戳.hash，原名在时间戳【前面】，所以字母序排出来
    // ♻edge-tts.mjs.20260827 会排在 ♻world.js.20260812 前面 ——
    // slice(0,...) 取到的"最旧"实际是字母序靠前的，可能删掉刚备份的新文件。
    // 必须按时间戳段排。
    const files = readdirSync(TRASH_DIR)
      .filter(f => f.startsWith('♻'))
      .sort((a, b) => trashTimeKey(a) - trashTimeKey(b))
    if (files.length <= MAX_TRASH_FILES) return
    const drop = files.slice(0, files.length - MAX_TRASH_FILES)
    const manifest = loadTrashManifest()
    for (const f of drop) {
      try { unlinkSync(join(TRASH_DIR, f)) } catch {}
      delete manifest[f]
    }
    saveTrashManifest(manifest)
  } catch { /* 清理失败不阻塞主流程 */ }
}

export function backupToTrash(filePath, desc = '') {
  if (!existsSync(filePath)) return null
  const content = readFileSync(filePath, 'utf-8')
  ensureTrashDir()
  const trashName = makeTrashName(filePath, content, desc)
  const trashPath = join(TRASH_DIR, trashName)
  writeFileSync(trashPath, content, 'utf-8')
  // 记录原始路径，恢复时回到原位
  const manifest = loadTrashManifest()
  manifest[trashName] = resolve(filePath)
  saveTrashManifest(manifest)
  pruneTrash()
  return trashPath
}

// 备份即将被覆盖的文件（Write/Edit 前调用）
// 只在修改量超过阈值时备份
export function backupBeforeOverwrite(filePath, newContent, desc = '') {
  if (!existsSync(filePath)) return null
  const oldContent = readFileSync(filePath, 'utf-8')
  if (oldContent === newContent) return null
  // 算修改量，超过阈值才备份
  const changes = diffSize(oldContent, newContent)
  if (changes < MIN_DIFF_TO_BACKUP) return null

  ensureTrashDir()
  const trashName = makeTrashName(filePath, oldContent, desc)
  const trashPath = join(TRASH_DIR, trashName)
  writeFileSync(trashPath, oldContent, 'utf-8')
  // 【原来漏了这两步】
  // pruneTrash 只在 backupToTrash（rm 路径）末尾调，而日常绝大多数备份来自
  // Write/Edit 走的就是这个函数 —— 于是清理从不触发，实测攒到 83 个（上限 50）。
  // manifest 也没记，导致 /trash restore 找不到原始路径。
  const manifest = loadTrashManifest()
  manifest[trashName] = resolve(filePath)
  saveTrashManifest(manifest)
  pruneTrash()
  return trashPath
}

// Bash rm 拦截：备份要删的文件
export function maybeBackupRm(command, cwd) {
  if (!/\brm\b/.test(command)) return { command, backed: [] }
  const parts = command.split(/\s+/)
  const rmIdx = parts.findIndex(p => p === 'rm')
  if (rmIdx === -1) return { command, backed: [] }

  const backed = []
  for (let i = rmIdx + 1; i < parts.length; i++) {
    const arg = parts[i]
    if (arg.startsWith('-')) continue  // flag
    const filePath = arg.startsWith('/') ? arg : join(cwd || process.cwd(), arg)
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      const backedPath = backupToTrash(filePath)
      if (backedPath) backed.push(`${arg} → ${backedPath}`)
    }
  }
  return { command, backed }
}

// 正则匹配备份文件名: ♻原名.时间戳.hash.描述（描述可空）
const TRASH_NAME_RE = /^♻(.+)\.(\d{8}-\d{6})\.([a-f0-9]{6})(?:\.(.*))?$/

// 列出回收站
export function listTrash() {
  ensureTrashDir()
  const files = readdirSync(TRASH_DIR).filter(f => f.startsWith('♻')).sort().reverse()
  if (files.length === 0) return '(回收站为空)'
  const lines = ['回收站内容:']
  files.forEach((f, i) => {
    const m = f.match(TRASH_NAME_RE)
    let origName = f, timeStr = '?', hash = '?', desc = ''
    if (m) {
      origName = m[1]
      const ts = m[2]
      timeStr = `${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)} ${ts.slice(9,11)}:${ts.slice(11,13)}:${ts.slice(13,15)||'00'}`
      hash = m[3]
      desc = m[4] || ''
    }
    const size = existsSync(join(TRASH_DIR, f)) ? statSync(join(TRASH_DIR, f)).size : 0
    const descStr = desc ? `  「${desc}」` : ''
    lines.push(`  ${i + 1}. ${origName}  ${timeStr}  ${size}B  #${hash}${descStr}`)
  })
  lines.push('')
  lines.push('恢复: /trash restore <序号>')
  return lines.join('\n')
}

// 恢复文件
export function restoreTrash(index) {
  ensureTrashDir()
  const files = readdirSync(TRASH_DIR).filter(f => f.startsWith('♻')).sort().reverse()
  const idx = parseInt(index) - 1
  if (isNaN(idx) || idx < 0 || idx >= files.length) return `序号无效，用 /trash 查看列表`
  const trashFile = files[idx]
  const trashPath = join(TRASH_DIR, trashFile)
  const m = trashFile.match(TRASH_NAME_RE)
  const origName = m ? m[1] : trashFile.replace(/^♻/, '')
  // 优先按 manifest 里的原始路径恢复（修：从别处删的文件堆到项目根）
  const manifest = loadTrashManifest()
  const origPath = manifest[trashFile]
  const destPath = origPath || join(process.cwd(), origName)
  // 如果目标已存在，先备份当前的。
  // 提示不能直写 stdout：全屏模式下正文在虚拟缓冲里，
  // 直写会插进固定区（header/footer）造成「提示乱飘」。并进返回值交上层渲染。
  let note = ''
  if (existsSync(destPath)) {
    backupToTrash(destPath)
    note = `\n  注意: ${origName} 已存在，已备份当前版本`
  }
  copyFileSync(trashPath, destPath)
  return `已恢复 ${origName} (${statSync(destPath).size}B)${note}`
}

// 清空回收站
export function clearTrash() {
  ensureTrashDir()
  const files = readdirSync(TRASH_DIR).filter(f => f.startsWith('♻'))
  if (files.length === 0) return '回收站已是空的'
  let count = 0
  for (const f of files) {
    try { unlinkSync(join(TRASH_DIR, f)); count++ } catch {}
  }
  return `已清空回收站 (${count} 个文件)`
}
