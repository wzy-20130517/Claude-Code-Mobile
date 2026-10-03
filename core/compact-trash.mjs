// Claude Code Mobile - 压缩回收站
// 每次压缩前把完整会话（未压缩的原始消息）备份到 compact-trash/，
// 可用 /compact-trash restore 恢复到那个完整上下文。
import { readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { atomicWrite } from './atomic.mjs'

const TRASH_DIR = join(homedir(), '.claude-code-mobile', 'compact-trash')

function ensureDir() {
  if (!existsSync(TRASH_DIR)) mkdirSync(TRASH_DIR, { recursive: true })
}

/**
 * 压缩前备份完整会话。
 * @param {Array} messages 未压缩的完整消息数组
 * @param {object} opts { sessionId, reason, meta }
 * @returns {string} 备份文件名（不含目录）
 */
export function backupBeforeCompact(messages, opts = {}) {
  if (!Array.isArray(messages) || !messages.length) return null
  ensureDir()
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const safeReason = String(opts.reason || 'manual').replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 24)
  const name = `compact-${ts}-${safeReason}.json`
  const file = join(TRASH_DIR, name)
  const payload = {
    kind: 'compact-backup',
    createdAt: new Date().toISOString(),
    sessionId: opts.sessionId || null,
    reason: opts.reason || 'manual',
    messageCount: messages.length,
    meta: opts.meta || {},
    messages,
  }
  atomicWrite(file, JSON.stringify(payload))
  return name
}

/** 列出所有压缩备份（按时间倒序） */
export function listCompactTrash() {
  ensureDir()
  return readdirSync(TRASH_DIR)
    .filter(f => f.startsWith('compact-') && f.endsWith('.json'))
    .map(f => {
      const file = join(TRASH_DIR, f)
      const st = statSync(file)
      let info = null
      try {
        const head = JSON.parse(readFileSync(file, 'utf-8'))
        info = { messageCount: head.messageCount, reason: head.reason, createdAt: head.createdAt }
      } catch { info = null }
      return { name: f, size: st.size, mtime: st.mtimeMs, ...(info || {}) }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

/** 读取指定备份（按序号，1=最新） */
export function readCompactTrash(index) {
  const list = listCompactTrash()
  const item = list[index - 1]
  if (!item) return null
  const data = JSON.parse(readFileSync(join(TRASH_DIR, item.name), 'utf-8'))
  return { ...item, messages: data.messages }
}

/** 删除指定备份（按序号，1=最新）；all=true 清空 */
export function deleteCompactTrash(index, all = false) {
  const list = listCompactTrash()
  if (all) {
    for (const it of list) unlinkSync(join(TRASH_DIR, it.name))
    return list.length
  }
  const item = list[index - 1]
  if (!item) return 0
  unlinkSync(join(TRASH_DIR, item.name))
  return 1
}

/** 恢复指定备份的完整消息 */
export function restoreCompactTrash(index) {
  const data = readCompactTrash(index)
  if (!data) return null
  return data.messages
}

export { TRASH_DIR }
