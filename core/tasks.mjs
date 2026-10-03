// 持久化 Task 系统（多 Agent 协作用）
//
// 设计抄自官方 claude-code utils/tasks.ts，保留三个核心机制：
//   1) 双向依赖图：blocks / blockedBy 成对维护，加边时两侧同时更新
//   2) owner 归属：任务可被某个 agent 占用，防止两个 agent 抢同一件事
//   3) claim 四道检查：存在 → 未被他人占用 → 未完成 → 无未解决阻塞项
//
// 与 TodoWrite 的区别：
//   TodoWrite 是当轮会话的临时清单，进程结束就没了，只给用户看进度。
//   Task 落盘到 ~/.claude-code-mobile/tasks/<listId>/，跨轮、跨重启存活，
//   可以被子 Agent 领取、更新、交还，是多 Agent 协作的共享状态。
//
// 与 bg-tasks.mjs 的区别：
//   bg-tasks 管的是「正在跑的进程」（pid、stdout、kill），内存态。
//   这里管的是「要做的事」（依赖、归属、状态），持久态。两者不重叠。

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { atomicWrite } from './atomic.mjs'

const ROOT = join(homedir(), '.claude-code-mobile', 'tasks')
const DEFAULT_LIST = 'default'
const VALID_STATUS = ['pending', 'in_progress', 'completed']

function listDir(listId = DEFAULT_LIST) {
  return join(ROOT, String(listId).replace(/[^\w.-]/g, '_'))
}

function taskPath(listId, id) {
  return join(listDir(listId), `${id}.json`)
}

function ensureDir(listId) {
  const dir = listDir(listId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function readTask(listId, id) {
  try {
    const raw = readFileSync(taskPath(listId, id), 'utf-8')
    const t = JSON.parse(raw)
    // 兼容旧数据：缺字段时补默认值，避免下游到处判空
    t.blocks = Array.isArray(t.blocks) ? t.blocks : []
    t.blockedBy = Array.isArray(t.blockedBy) ? t.blockedBy : []
    t.comments = Array.isArray(t.comments) ? t.comments : []
    return t
  } catch {
    return null
  }
}

function writeTask(listId, task) {
  ensureDir(listId)
  atomicWrite(taskPath(listId, task.id), JSON.stringify(task, null, 2))
  return task
}

/** 分配下一个数字 id。扫目录取最大值 +1，不依赖单独的计数器文件。 */
function nextId(listId) {
  const dir = listDir(listId)
  if (!existsSync(dir)) return 1
  let max = 0
  for (const f of readdirSync(dir)) {
    const m = /^(\d+)\.json$/.exec(f)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

export function listTasks(listId = DEFAULT_LIST) {
  const dir = listDir(listId)
  if (!existsSync(dir)) return []
  const out = []
  for (const f of readdirSync(dir)) {
    if (!/^\d+\.json$/.test(f)) continue
    const t = readTask(listId, f.replace('.json', ''))
    if (t) out.push(t)
  }
  return out.sort((a, b) => Number(a.id) - Number(b.id))
}

export function getTask(listId, id) {
  return readTask(listId, id)
}

export function createTask(listId, { subject, description = '', activeForm = '', blockedBy = [] } = {}) {
  if (!subject || !String(subject).trim()) throw new Error('subject 必填')
  const id = String(nextId(listId))
  const task = {
    id,
    subject: String(subject).trim(),
    description: String(description || ''),
    // activeForm 对齐官方 spinner 用法：进行时描述，如「修复 parser 崩溃」
    activeForm: String(activeForm || '') || String(subject).trim(),
    status: 'pending',
    owner: null,
    blocks: [],
    blockedBy: [],
    // 进展留痕（对齐官方 TaskGet 的 comments）：多 Agent 协作时
    // 交接人需要知道"前面那个人做到哪、卡在什么地方"，光看 status 不够
    comments: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  writeTask(listId, task)
  // 建依赖边：blockedBy 里每个 id 的 blocks 也要加上自己（双向维护）
  for (const dep of blockedBy) {
    addDependency(listId, String(dep), id)
  }
  return readTask(listId, id)
}

/**
 * blockerId 阻塞 blockedId。双向写：blocker.blocks += blocked，blocked.blockedBy += blocker。
 * 官方的关键设计——只写单边会导致 claim 检查漏判。
 */
export function addDependency(listId, blockerId, blockedId) {
  if (String(blockerId) === String(blockedId)) return false
  const blocker = readTask(listId, blockerId)
  const blocked = readTask(listId, blockedId)
  if (!blocker || !blocked) return false
  if (!blocker.blocks.includes(String(blockedId))) {
    blocker.blocks.push(String(blockedId))
    blocker.updatedAt = new Date().toISOString()
    writeTask(listId, blocker)
  }
  if (!blocked.blockedBy.includes(String(blockerId))) {
    blocked.blockedBy.push(String(blockerId))
    blocked.updatedAt = new Date().toISOString()
    writeTask(listId, blocked)
  }
  return true
}

/**
 * 追加一条进展留痕。
 * 多 Agent 交接时最需要的东西：接手的人光看 status=in_progress 不知道
 * 前面那个人做到哪、试过什么、卡在哪。comments 是时间序的，只追加不改写。
 */
export function addComment(listId, id, { by = 'unknown', text = '' } = {}) {
  const task = readTask(listId, id)
  if (!task) return null
  const t = String(text || '').trim()
  if (!t) return task
  task.comments.push({
    by: String(by || 'unknown'),
    text: t,
    at: new Date().toISOString(),
  })
  task.updatedAt = new Date().toISOString()
  writeTask(listId, task)
  return task
}

export function updateTask(listId, id, patch = {}) {
  const task = readTask(listId, id)
  if (!task) return null
  if (patch.status && !VALID_STATUS.includes(patch.status)) {
    throw new Error(`status 只能是 ${VALID_STATUS.join(' / ')}`)
  }
  for (const k of ['subject', 'description', 'activeForm', 'status', 'owner']) {
    if (k in patch) task[k] = patch[k]
  }
  task.updatedAt = new Date().toISOString()
  return writeTask(listId, task)
}

/**
 * 尝试领取任务。抄官方 claimTask 的四道检查，任一不过就拒绝并说明原因。
 * 没用文件锁：Termux 单机场景下子 Agent 是同进程内串行调度的，
 * 真出现并发再引入 lockfile，先不加依赖。
 */
export function claimTask(listId, id, agentId) {
  const task = readTask(listId, id)
  if (!task) return { ok: false, reason: 'not_found' }
  if (task.owner && task.owner !== agentId) {
    return { ok: false, reason: 'already_claimed', owner: task.owner }
  }
  if (task.status === 'completed') {
    return { ok: false, reason: 'already_completed' }
  }
  // 未完成的前置任务会阻塞领取（pending 和 in_progress 都算未解决）
  const unresolved = new Set(listTasks(listId).filter(t => t.status !== 'completed').map(t => String(t.id)))
  const blocking = task.blockedBy.filter(b => unresolved.has(String(b)))
  if (blocking.length) {
    return { ok: false, reason: 'blocked', blockedBy: blocking }
  }
  const updated = updateTask(listId, id, { owner: agentId, status: 'in_progress' })
  return { ok: true, task: updated }
}

export function deleteTask(listId, id) {
  const task = readTask(listId, id)
  if (!task) return false
  // 清理反向边，避免留下指向已删任务的悬空依赖
  for (const other of listTasks(listId)) {
    let dirty = false
    if (other.blocks.includes(String(id))) {
      other.blocks = other.blocks.filter(x => String(x) !== String(id)); dirty = true
    }
    if (other.blockedBy.includes(String(id))) {
      other.blockedBy = other.blockedBy.filter(x => String(x) !== String(id)); dirty = true
    }
    if (dirty) { other.updatedAt = new Date().toISOString(); writeTask(listId, other) }
  }
  try { unlinkSync(taskPath(listId, id)) } catch { return false }
  return true
}

export function resetTaskList(listId = DEFAULT_LIST) {
  const dir = listDir(listId)
  if (!existsSync(dir)) return 0
  const n = listTasks(listId).length
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
  return n
}

export function listTaskLists() {
  if (!existsSync(ROOT)) return []
  return readdirSync(ROOT).filter(d => {
    try { return existsSync(join(ROOT, d)) } catch { return false }
  })
}

/** 渲染成人看的清单，供 /tasks 命令和工具结果复用。 */
export function formatTasks(tasks, { showBlocked = true } = {}) {
  if (!tasks.length) return '（没有任务）'
  return tasks.map(t => {
    const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '→' : '○'
    const own = t.owner ? ` @${t.owner}` : ''
    const dep = showBlocked && t.blockedBy.length ? ` ⟵${t.blockedBy.join(',')}` : ''
    return `${icon} #${t.id} ${t.subject}${own}${dep}`
  }).join('\n')
}

export const TASK_DEFAULT_LIST = DEFAULT_LIST
