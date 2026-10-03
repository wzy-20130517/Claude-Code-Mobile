// Team + Mailbox：多 Agent 协作的组织与通信层
//
// 设计抄自官方 claude-code（utils/teammateMailbox.ts + TeamCreateTool）：
//   1) Team 与 TaskList 1:1 对应 —— teamName 直接当 tasks.mjs 的 listId 用，
//      不再单独维护「团队有哪些任务」，天然同步。
//   2) 每个成员一个独立 inbox 文件，不是共享队列 —— 避免并发写同一文件，
//      也让「谁还没读消息」可查。
//   3) 消息带 read 标记而不是读完删除 —— 保留会话痕迹，便于事后复盘。
//
// 与官方的差异（移动端简化）：
//   官方有 Unix socket / remote bridge 做跨进程实时投递，我们只做文件队列。
//   Termux 单机场景下子 Agent 是同进程调度的，文件队列足够，不引入额外依赖。

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { atomicWrite } from './atomic.mjs'
import { listTasks, resetTaskList } from './tasks.mjs'

const ROOT = join(homedir(), '.claude-code-mobile', 'teams')
// 单个 inbox 保留的消息上限。超过就丢最旧的：inbox 是通信缓冲不是归档，
// 无上限会让长任务的 JSON 涨到几 MB，每次读写都变慢。
const MAX_INBOX_MESSAGES = 200

function safeName(s) {
  return String(s || '').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')
}

function teamDir(team) { return join(ROOT, safeName(team)) }
function configPath(team) { return join(teamDir(team), 'config.json') }
function inboxDir(team) { return join(teamDir(team), 'inboxes') }
function inboxPath(team, agent) { return join(inboxDir(team), `${safeName(agent)}.json`) }

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf-8')) } catch { return fallback }
}

export function teamExists(team) {
  return existsSync(configPath(team))
}

export function createTeam(team, { description = '' } = {}) {
  if (!team || !String(team).trim()) throw new Error('team 名称必填')
  const name = safeName(team)
  if (teamExists(name)) return { ok: false, reason: 'exists', team: getTeam(name) }
  mkdirSync(inboxDir(name), { recursive: true })
  const cfg = {
    name,
    description: String(description || ''),
    members: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  atomicWrite(configPath(name), JSON.stringify(cfg, null, 2))
  return { ok: true, team: cfg }
}

export function getTeam(team) {
  return readJson(configPath(team), null)
}

export function listTeams() {
  if (!existsSync(ROOT)) return []
  return readdirSync(ROOT)
    .filter(d => existsSync(configPath(d)))
    .map(d => getTeam(d))
    .filter(Boolean)
}

/** 加入团队。重复加入不报错，幂等——子 Agent 可能被重启后重新 join。 */
export function joinTeam(team, agent, { role = '' } = {}) {
  const cfg = getTeam(team)
  if (!cfg) return { ok: false, reason: 'no_team' }
  const name = safeName(agent)
  const existing = cfg.members.find(m => m.name === name)
  if (existing) {
    if (role) existing.role = role
    existing.status = 'active'
  } else {
    cfg.members.push({ name, role: String(role || ''), status: 'active', joinedAt: new Date().toISOString() })
  }
  cfg.updatedAt = new Date().toISOString()
  atomicWrite(configPath(team), JSON.stringify(cfg, null, 2))
  // 建空 inbox，让 sendMessage 不必先判目录是否存在
  if (!existsSync(inboxPath(team, name))) {
    mkdirSync(inboxDir(team), { recursive: true })
    atomicWrite(inboxPath(team, name), JSON.stringify([], null, 2))
  }
  return { ok: true, team: cfg }
}

export function setMemberStatus(team, agent, status) {
  const cfg = getTeam(team)
  if (!cfg) return false
  const m = cfg.members.find(x => x.name === safeName(agent))
  if (!m) return false
  m.status = status
  cfg.updatedAt = new Date().toISOString()
  atomicWrite(configPath(team), JSON.stringify(cfg, null, 2))
  return true
}

/**
 * 投递消息到对方 inbox。
 * summary 是给人看的一行预览（官方用于 UI 折叠显示），text 是完整内容。
 */
export function sendMessage(team, { from, to, text, summary = '', type = 'text' }) {
  const cfg = getTeam(team)
  if (!cfg) return { ok: false, reason: 'no_team' }

  // 【to:"*" = 广播给所有队友】对齐官方 SendMessageTool。
  // 没有广播时，想让全场都听见只能对每个人发一遍 —— 图灵测试那局里
  // 4 个 Agent 各自把同一段话发 3 遍，纯浪费轮次。
  // 官方原文标注 "expensive (linear in team size)"，所以只在真的人人都需要时用。
  if (String(to).trim() === '*') {
    const me = safeName(from)
    const targets = cfg.members.filter(m => m.name !== me && m.status !== 'inactive')
    if (!targets.length) return { ok: false, reason: 'no_peers' }
    let n = 0
    for (const m of targets) {
      const r = sendMessage(team, { from, to: m.name, text, summary, type })
      if (r.ok) n++
    }
    return { ok: true, broadcast: true, delivered: n, targets: targets.map(m => m.name) }
  }

  const target = safeName(to)
  if (!cfg.members.find(m => m.name === target)) {
    return { ok: false, reason: 'no_member', members: cfg.members.map(m => m.name) }
  }
  mkdirSync(inboxDir(team), { recursive: true })
  const box = readJson(inboxPath(team, target), [])
  box.push({
    from: safeName(from),
    to: target,
    type,
    text: String(text || ''),
    summary: String(summary || '').slice(0, 80),
    timestamp: new Date().toISOString(),
    read: false,
  })
  // 超限丢最旧
  const trimmed = box.length > MAX_INBOX_MESSAGES ? box.slice(-MAX_INBOX_MESSAGES) : box
  atomicWrite(inboxPath(team, target), JSON.stringify(trimmed, null, 2))
  return { ok: true, queued: trimmed.length }
}

/**
 * 读取 inbox。默认只返回未读并标记已读（drain 语义），
 * peek=true 则不改 read 状态，用于旁观者查看。
 */
export function readInbox(team, agent, { unreadOnly = true, peek = false } = {}) {
  const path = inboxPath(team, agent)
  const box = readJson(path, [])
  const picked = unreadOnly ? box.filter(m => !m.read) : box
  if (!peek && picked.length) {
    for (const m of box) m.read = true
    atomicWrite(path, JSON.stringify(box, null, 2))
  }
  return picked
}

export function inboxCounts(team) {
  const dir = inboxDir(team)
  if (!existsSync(dir)) return {}
  const out = {}
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    const agent = f.replace(/\.json$/, '')
    const box = readJson(join(dir, f), [])
    out[agent] = { total: box.length, unread: box.filter(m => !m.read).length }
  }
  return out
}

/** 解散团队。同时清掉对应的任务列表（Team = TaskList，不能只删一半）。 */
export function deleteTeam(team, { keepTasks = false } = {}) {
  if (!teamExists(team)) return { ok: false, reason: 'no_team' }
  const taskCount = listTasks(team).length
  try { rmSync(teamDir(team), { recursive: true, force: true }) } catch {}
  if (!keepTasks) resetTaskList(team)
  return { ok: true, removedTasks: keepTasks ? 0 : taskCount }
}

/** 团队全景：成员、状态、任务进度、未读数。给 /team 命令和 TeamStatus 工具共用。 */
export function teamOverview(team) {
  const cfg = getTeam(team)
  if (!cfg) return null
  const tasks = listTasks(team)
  const counts = inboxCounts(team)
  return {
    name: cfg.name,
    description: cfg.description,
    members: cfg.members.map(m => ({
      ...m,
      owned: tasks.filter(t => t.owner === m.name).length,
      unread: counts[m.name]?.unread || 0,
    })),
    tasks: {
      total: tasks.length,
      pending: tasks.filter(t => t.status === 'pending').length,
      inProgress: tasks.filter(t => t.status === 'in_progress').length,
      completed: tasks.filter(t => t.status === 'completed').length,
    },
  }
}

export function formatTeamOverview(ov) {
  if (!ov) return '(团队不存在)'
  const lines = [`团队 [${ov.name}]${ov.description ? ' — ' + ov.description : ''}`]
  lines.push(`任务: 共 ${ov.tasks.total} · 待办 ${ov.tasks.pending} · 进行中 ${ov.tasks.inProgress} · 完成 ${ov.tasks.completed}`)
  if (!ov.members.length) {
    lines.push('成员: (还没有成员加入)')
  } else {
    lines.push('成员:')
    for (const m of ov.members) {
      const badge = m.status === 'active' ? '●' : '○'
      const unread = m.unread ? ` ✉${m.unread}` : ''
      lines.push(`  ${badge} ${m.name}${m.role ? `（${m.role}）` : ''} 持有 ${m.owned} 个任务${unread}`)
    }
  }
  return lines.join('\n')
}
