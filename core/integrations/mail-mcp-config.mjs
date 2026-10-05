// 邮箱 MCP 账号管理（/mail 系列命令的实现）
//
// 【从单账号改成多账号】原来这里改的是 mcp.json 里 mail-qq 的 env
// （MAIL_USER/MAIL_PASS），只能配一个邮箱。现在账号表独立成
// ~/.claude-code-mobile/mail-accounts.json，支持任意多个邮箱 + 各自授权码。
//
// env 那份保留兼容：MCP server 仍会把它当隐式账号 'env'，所以旧配置不用改。
// 但 /mail 系列命令一律操作账号表 —— 两套并存但只有一处是可写的，
// 免得用户改了一处、生效的是另一处。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const ACCOUNTS_PATH = join(homedir(), '.claude-code-mobile', 'mail-accounts.json')

const mask = (v) => {
  const s = String(v || '')
  if (!s) return '(未设置)'
  return s.length > 6 ? `${s.slice(0, 3)}***${s.slice(-2)}` : '***'
}

function load() {
  if (!existsSync(ACCOUNTS_PATH)) return { default: null, accounts: {} }
  try {
    const raw = JSON.parse(readFileSync(ACCOUNTS_PATH, 'utf-8'))
    return { default: raw.default || null, accounts: raw.accounts || {}, _raw: raw }
  } catch (e) {
    return { default: null, accounts: {}, _error: e.message }
  }
}

function save(cfg) {
  try { mkdirSync(dirname(ACCOUNTS_PATH), { recursive: true }) } catch {}
  const out = {
    _说明: '邮箱账号表。MCP 工具的 account 参数填别名或邮箱地址；search_code 传 "*" 搜所有账号。改完需 Ctrl+X 重启 MCP。',
    default: cfg.default,
    accounts: cfg.accounts,
  }
  // 授权码是敏感信息，权限收到 600
  writeFileSync(ACCOUNTS_PATH, JSON.stringify(out, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
}

/** SMTP 主机推导规则要跟 server.mjs 保持一致（imap.x → smtp.x） */
const smtpOf = (a) => a.smtpHost || String(a.host || 'imap.qq.com').replace(/^imap\./i, 'smtp.')

export function mailStatus() {
  const cfg = load()
  if (cfg._error) return `账号表解析失败: ${cfg._error}\n文件: ${ACCOUNTS_PATH}`
  const names = Object.keys(cfg.accounts)
  if (names.length === 0) {
    return `邮箱账号: 未配置\n`
      + `文件: ${ACCOUNTS_PATH}\n\n`
      + `添加: /mail add（向导）或 /mail add <别名> <邮箱> <授权码> [imap主机] [端口]\n`
      + `QQ 邮箱授权码在「设置 → 账户 → 生成授权码」，不是登录密码。`
  }
  const lines = [`邮箱账号（${names.length} 个）:`]
  for (const [k, a] of Object.entries(cfg.accounts)) {
    const isDef = k === cfg.default
    lines.push(`  ${isDef ? '●' : '○'} ${k}${isDef ? '  ← 默认' : ''}`)
    lines.push(`      ${a.user}`)
    lines.push(`      IMAP ${a.host || 'imap.qq.com'}:${a.port || 993} · SMTP ${smtpOf(a)}:${a.smtpPort || 465}`)
    lines.push(`      授权码 ${mask(a.pass)}${a.note ? ' · ' + a.note : ''}`)
  }
  lines.push('')
  lines.push(`文件: ${ACCOUNTS_PATH}`)
  lines.push(`改动需 Ctrl+X 重启，MCP 才会重新读取。`)
  return lines.join('\n')
}

/** 添加/覆盖账号。alias 省略时用邮箱地址的 @ 前部分 */
export function mailAdd({ alias, user, pass, host, port, smtpHost, smtpPort, note }) {
  const u = String(user || '').trim()
  const p = String(pass || '').trim()
  if (!u || !p) return '需要邮箱地址和授权码'
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(u)) return `邮箱地址格式不对: ${u}`
  const name = String(alias || '').trim() || u.split('@')[0]
  const cfg = load()
  const exists = !!cfg.accounts[name]
  cfg.accounts[name] = {
    user: u,
    pass: p,
    host: String(host || '').trim() || 'imap.qq.com',
    port: parseInt(port) || 993,
    ...(smtpHost ? { smtpHost: String(smtpHost).trim() } : {}),
    ...(smtpPort ? { smtpPort: parseInt(smtpPort) } : {}),
    ...(note ? { note: String(note).trim() } : {}),
  }
  // 第一个账号自动设为默认，否则用户配完发现「没有默认账号」很困惑
  if (!cfg.default) cfg.default = name
  save(cfg)
  return `${exists ? '已更新' : '已添加'}账号 "${name}": ${u}\n`
    + `  IMAP ${cfg.accounts[name].host}:${cfg.accounts[name].port} · SMTP ${smtpOf(cfg.accounts[name])}:${cfg.accounts[name].smtpPort || 465}\n`
    + (cfg.default === name ? '  已设为默认账号\n' : '')
    + `按 Ctrl+X 重启后 MCP 生效。`
}

export function mailRemove(name) {
  const n = String(name || '').trim()
  if (!n) return '用法: /mail rm <别名>'
  const cfg = load()
  if (!cfg.accounts[n]) {
    return `没有账号 "${n}"。可用: ${Object.keys(cfg.accounts).join(', ') || '(无)'}`
  }
  const wasDefault = cfg.default === n
  delete cfg.accounts[n]
  // 删掉默认账号后要重新指定，否则所有工具调用都会报「没有默认账号」
  if (wasDefault) cfg.default = Object.keys(cfg.accounts)[0] || null
  save(cfg)
  return `已删除账号 "${n}"`
    + (wasDefault ? `\n默认账号改为: ${cfg.default || '(无账号了)'}` : '')
    + `\n按 Ctrl+X 重启后生效。`
}

export function mailSetDefault(name) {
  const n = String(name || '').trim()
  const cfg = load()
  if (!n) return `当前默认账号: ${cfg.default || '(未设置)'}\n可用: ${Object.keys(cfg.accounts).join(', ') || '(无)'}\n用法: /mail default <别名>`
  if (!cfg.accounts[n]) return `没有账号 "${n}"。可用: ${Object.keys(cfg.accounts).join(', ') || '(无)'}`
  const old = cfg.default
  cfg.default = n
  save(cfg)
  return `默认账号: ${old || '(无)'} → ${n}（${cfg.accounts[n].user}）\n按 Ctrl+X 重启后生效。`
}

/** 改单个字段：/mail pass <别名> <新授权码> 这类 */
export function mailUpdate(field, name, value) {
  const cfg = load()
  const names = Object.keys(cfg.accounts)
  if (names.length === 0) return '还没有配置任何账号，先 /mail add'
  // 只有一个账号时别名可省略
  const target = String(name || '').trim() || (names.length === 1 ? names[0] : cfg.default)
  if (!cfg.accounts[target]) return `没有账号 "${target}"。可用: ${names.join(', ')}`
  const v = String(value || '').trim()
  const FIELDS = {
    pass: '授权码', user: '邮箱地址', host: 'IMAP 主机',
    port: '端口', smtpHost: 'SMTP 主机', smtpPort: 'SMTP 端口', note: '备注',
  }
  if (!FIELDS[field]) return `不支持的字段: ${field}（可用: ${Object.keys(FIELDS).join('/')}）`
  if (!v) {
    const cur = cfg.accounts[target][field]
    const shown = field === 'pass' ? mask(cur) : (cur ?? '(未设置)')
    return `${target} 的${FIELDS[field]}: ${shown}\n用法: /mail ${field} [别名] <新值>`
  }
  if (field === 'port' || field === 'smtpPort') {
    if (!/^\d+$/.test(v)) return '端口必须是数字'
    cfg.accounts[target][field] = parseInt(v)
  } else {
    cfg.accounts[target][field] = v
  }
  save(cfg)
  const shown = field === 'pass' ? mask(v) : v
  return `${target} 的${FIELDS[field]} 已改为 ${shown}\n按 Ctrl+X 重启后生效。`
}
