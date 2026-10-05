// 定时任务（仿官方 ScheduleCronTool：CronCreate/Delete/List + 进程内轮询）
// 存储 ~/.claude-code-mobile/scheduled_tasks.json；session 任务只活内存。
// 到点把 prompt 直接注入对话（走 onFire 回调，由 index.mjs 接到 pendingInputs）。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

const DIR = join(homedir(), '.claude-code-mobile')
const FILE = join(DIR, 'scheduled_tasks.json')
const MAX_JOBS = 50

// ---------- cron 解析（5字段：分 时 日 月 周，本地时间） ----------
function parseField(s, min, max, names = null) {
  const out = new Set()
  const norm = (v) => {
    v = String(v).trim().toLowerCase()
    if (names && names[v] !== undefined) return names[v]
    const n = parseInt(v, 10)
    if (Number.isNaN(n) || n < min || n > max) return null
    return n
  }
  for (const part of String(s).split(',')) {
    const p = part.trim()
    if (p === '*') { for (let i = min; i <= max; i++) out.add(i); continue }
    let m = p.match(/^\*\/(\d+)$/)
    if (m) {
      const step = parseInt(m[1], 10)
      if (step < 1) return null
      for (let i = min; i <= max; i += step) out.add(i)
      continue
    }
    m = p.match(/^(.+)-(.+?)(?:\/(\d+))?$/)
    if (m) {
      const a = norm(m[1]), b = norm(m[2])
      const step = m[3] ? parseInt(m[3], 10) : 1
      if (a === null || b === null || step < 1 || a > b) return null
      for (let i = a; i <= b; i += step) out.add(i)
      continue
    }
    const n = norm(p)
    if (n === null) return null
    out.add(n)
  }
  return out
}

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

export function parseCronExpression(expr) {
  const f = String(expr || '').trim().split(/\s+/)
  if (f.length !== 5) return null
  const min = parseField(f[0], 0, 59)
  const hour = parseField(f[1], 0, 23)
  const dom = parseField(f[2], 1, 31)
  const mon = parseField(f[3], 1, 12, MON)
  const dow = parseField(f[4], 0, 7, DOW)
  if (!min || !hour || !dom || !mon || !dow) return null
  if (dow.has(7)) { dow.delete(7); dow.add(0) }
  return { min, hour, dom, mon, dow, domStar: f[2] === '*', dowStar: f[4] === '*' }
}

function matchDate(d, c) {
  if (!c.mon.has(d.getMonth() + 1)) return false
  if (!c.hour.has(d.getHours())) return false
  if (!c.min.has(d.getMinutes())) return false
  // 日/周：官方 cron 语义，任一匹配即可（都不是*时取并集）
  const domOk = c.dom.has(d.getDate())
  const dowOk = c.dow.has(d.getDay())
  if (!c.domStar && !c.dowStar) return domOk || dowOk
  if (!c.domStar) return domOk
  if (!c.dowStar) return dowOk
  return true
}

// 下次触发（从 from 之后下一分钟开始找，最多扫 366 天）
export function computeNextCronRun(cron, fromMs = Date.now()) {
  const c = typeof cron === 'string' ? parseCronExpression(cron) : cron
  if (!c) return null
  const t = new Date(fromMs)
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + 1)
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matchDate(t, c)) return t.getTime()
    t.setMinutes(t.getMinutes() + 1)
  }
  return null
}

export function cronToHuman(rawCron) {
  const raw = String(rawCron).trim().split(/\s+/)
  const c = parseCronExpression(rawCron)
  if (!c) return rawCron
  const pad = (n) => String(n).padStart(2, '0')
  const hours = [...c.hour].sort((a, b) => a - b)
  const mins = [...c.min].sort((a, b) => a - b)
  if (c.domStar && c.dowStar && c.mon.size === 12) {
    if (c.min.size === 60 && c.hour.size === 24) return '每分钟'
    // */n 步进格式直接描述，不展开
    if (/^\*\/\d+$/.test(raw[0]) && raw[1] === '*') return `每 ${raw[0].slice(2)} 分钟`
    if (/^\*\/\d+$/.test(raw[1]) && raw[0] === '0') return `每 ${raw[1].slice(2)} 小时`
    if (mins.length === 1 && hours.length === 24) return `每小时 ${pad(mins[0])} 分`
    if (mins.length === 1 && hours.length === 1) return `每天 ${pad(hours[0])}:${pad(mins[0])}`
    if (c.min.size === 1) return `每天 ${hours.map(pad).join(',')} 点的 ${pad(mins[0])} 分`
    return `每天 ${hours.map(pad).join(',')} 点`
  }
  if (!c.dowStar && c.domStar) {
    const names = ['日', '一', '二', '三', '四', '五', '六']
    const days = [...c.dow].sort((a, b) => a - b).map(i => '周' + names[i]).join('、')
    return `${days} ${pad(hours[0] ?? 0)}:${pad(mins[0] ?? 0)}`
  }
  return cron
}

// ---------- 存储 ----------
function readFile() {
  try {
    if (!existsSync(FILE)) return { tasks: [] }
    const d = JSON.parse(readFileSync(FILE, 'utf-8'))
    if (!d || !Array.isArray(d.tasks)) return { tasks: [] }
    return { tasks: d.tasks.filter(t => t && typeof t.id === 'string' && typeof t.cron === 'string' && typeof t.prompt === 'string' && typeof t.createdAt === 'number' && parseCronExpression(t.cron)) }
  } catch { return { tasks: [] } }
}

function writeFile(tasks) {
  try {
    mkdirSync(DIR, { recursive: true })
    const clean = tasks.map(t => ({ id: t.id, cron: t.cron, prompt: t.prompt, createdAt: t.createdAt, ...(t.lastFiredAt ? { lastFiredAt: t.lastFiredAt } : {}), ...(t.recurring ? { recurring: true } : {}) }))
    writeFileSync(FILE, JSON.stringify({ tasks: clean }, null, 2))
  } catch {}
}

// session 任务（内存，不落盘）
const sessionTasks = new Map()

export function listCronTasks() {
  const file = readFile().tasks.map(t => ({ ...t, durable: true }))
  const sess = [...sessionTasks.values()].map(t => ({ ...t, durable: false }))
  return [...file, ...sess]
}

export function addCronTask({ cron, prompt, recurring = false, durable = false }) {
  if (!parseCronExpression(cron)) throw new Error(`cron 表达式非法: ${cron}`)
  if (!prompt || !String(prompt).trim()) throw new Error('prompt 不能为空')
  if (listCronTasks().length >= MAX_JOBS) throw new Error(`任务已满（${MAX_JOBS} 个），先删再建`)
  if (computeNextCronRun(cron) === null) throw new Error(`cron 一年内无匹配: ${cron}`)
  const t = { id: randomUUID().slice(0, 8), cron: String(cron).trim(), prompt: String(prompt), createdAt: Date.now(), recurring: !!recurring }
  if (durable) {
    const file = readFile()
    file.tasks.push(t)
    writeFile(file.tasks)
  } else {
    sessionTasks.set(t.id, t)
  }
  return { ...t, durable, nextRun: computeNextCronRun(t.cron), human: cronToHuman(t.cron) }
}

export function deleteCronTask(id) {
  if (sessionTasks.delete(id)) return true
  const file = readFile()
  const n = file.tasks.filter(t => t.id !== id)
  if (n.length === file.tasks.length) return false
  writeFile(n)
  return true
}

// ---------- 调度器（30秒一 tick，到点调 onFire(prompt, task)） ----------
const nextFireAt = new Map() // id -> ms
const inFlight = new Set()

export function cronCheck(now = Date.now(), onFire) {
  const fired = []
  for (const t of listCronTasks()) {
    const isSession = !t.durable
    let next = nextFireAt.get(t.id)
    if (next === undefined) {
      if (t.recurring) {
        // ⚠ 补跑防护（2026-09-13 修正）：防的是「错过多次一拥而上」，不是「错过一次也扔掉」。
        //
        //   原实现只要触发点在停机窗口内就一律跳过 —— 每日 8:00 的签到任务，
        //   用户 8:09 重启 CLI，只错过 9 分钟就被扔掉，得等到明天。
        //   用户报「今天的 cron 签到任务怎么没触发」就是这条。
        //
        //   现在的语义：算出停机窗口内错过了几个触发点（从 last 往后逐个数），
        //   只错过 1 个 → 立即补跑（晚到总比丢了好）；
        //   错过 ≥2 个 → 仍跳过（防堵队列，那是防护的本意）。
        const last = t.lastFiredAt ?? t.createdAt
        const first = computeNextCronRun(t.cron, last) ?? Infinity
        if (first <= now) {
          // 数停机窗口内错过了几个触发点（最多数 60 个，够覆盖每分钟的频率）
          let missed = 0
          let cursor = first
          while (cursor <= now && missed < 60) {
            missed++
            cursor = computeNextCronRun(t.cron, cursor) ?? Infinity
          }
          // 只错过 1 个：补跑；多个：跳过，从 now 重算
          next = missed <= 1 ? first : (computeNextCronRun(t.cron, now) ?? Infinity)
        } else {
          next = first
        }
      } else {
        next = computeNextCronRun(t.cron, t.createdAt) ?? Infinity
      }
      nextFireAt.set(t.id, next)
    }
    if (now < next || inFlight.has(t.id)) continue
    inFlight.add(t.id)
    try { onFire(t.prompt, t) } catch {}
    fired.push(t)
    if (t.recurring) {
      // 循环：从 now 重算下次
      nextFireAt.set(t.id, computeNextCronRun(t.cron, now) ?? Infinity)
      if (!isSession) {
        const file = readFile()
        const f = file.tasks.find(x => x.id === t.id)
        if (f) { f.lastFiredAt = now; writeFile(file.tasks) }
      }
    } else {
      // 一次性：触发后删
      nextFireAt.delete(t.id)
      deleteCronTask(t.id)
    }
    inFlight.delete(t.id)
  }
  return fired
}

// 启动时：错过的一次性任务拼通知（官方行为），循环任务不补跑
export function missedOneShots(now = Date.now()) {
  const out = []
  for (const t of listCronTasks()) {
    if (t.recurring) continue
    const next = computeNextCronRun(t.cron, t.createdAt)
    if (next !== null && next <= now) out.push(t)
  }
  return out
}

export function startCronScheduler(onFire, intervalMs = 30000) {
  if (process.env.CLAUDE_CODE_DISABLE_CRON) return null
  const timer = setInterval(() => cronCheck(Date.now(), onFire), intervalMs)
  if (timer.unref) timer.unref()
  return timer
}
