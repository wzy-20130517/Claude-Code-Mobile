// Agent 长期记忆 —— 让同一类子 Agent 跨会话累积经验。
//
// 对齐官方 tools/AgentTool/agentMemory.ts 的三作用域设计：
//   user     ~/.claude-code-mobile/agent-memory/<type>/        跨项目，个人经验
//   project  <cwd>/.claude/agent-memory/<type>/                跟着仓库走，可提交
//   local    <cwd>/.claude/agent-memory-local/<type>/          本机私有，不进版本控制
//
// 为什么需要：原来每个子 Agent 都是白纸，同一个 code-reviewer 第十次跑
// 仍然不记得前九次踩过什么坑。有了记忆，「一人公司」里的每个角色才算真的员工。
//
// 设计取舍：
//   · 存 markdown 而不是 JSON —— 记忆是给模型读的，md 直接进 prompt
//   · 按 agent 类型分目录而不是按实例 —— 同类 agent 共享经验才有复利
//   · 只追加不覆盖（append 语义）—— 避免后一次把前面的经验抹掉
//   · 读取时有大小上限 —— 记忆无限长会挤爆上下文
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SCOPES = ['user', 'project', 'local']
/** 单个记忆文件注入 prompt 时的上限，超出取最近部分 */
const MAX_INJECT_CHARS = 6000

/** 目录名白名单：防路径穿越 */
function safeType(t) {
  const s = String(t || 'general').trim()
  if (!s || /[\/\\]|\.\./.test(s) || s.includes('\0')) return null
  return s.slice(0, 64)
}

function scopeRoot(scope, cwd) {
  const base = cwd || process.cwd()
  if (scope === 'user') return join(homedir(), '.claude-code-mobile', 'agent-memory')
  if (scope === 'project') return join(base, '.claude', 'agent-memory')
  if (scope === 'local') return join(base, '.claude', 'agent-memory-local')
  return null
}

function memFile(scope, type, cwd) {
  const t = safeType(type)
  const root = scopeRoot(scope, cwd)
  if (!t || !root) return null
  return join(root, t, 'MEMORY.md')
}

/**
 * 写入一条记忆（追加）。
 * 默认 scope=project：经验大多是项目相关的，跟着仓库走最合理。
 */
export function writeMemory({ type, text, scope = 'project', cwd = null, by = null } = {}) {
  const p = memFile(scope, type, cwd)
  if (!p) return { ok: false, reason: 'bad_type_or_scope' }
  const t = String(text || '').trim()
  if (!t) return { ok: false, reason: 'empty' }
  try {
    mkdirSync(join(p, '..'), { recursive: true })
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
    const head = existsSync(p) ? '' : `# ${safeType(type)} 的长期记忆\n\n（同类 Agent 跨会话共享。只追加，不要删改前人的记录。）\n`
    appendFileSync(p, `${head}\n## ${stamp}${by ? ` · ${by}` : ''}\n${t}\n`, 'utf-8')
    return { ok: true, path: p, scope }
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) }
  }
}

/**
 * 读取某类 agent 的全部记忆（三个作用域合并）。
 * 顺序 user → project → local：越靠后越具体，后面的内容更贴近当前环境。
 */
export function readMemory({ type, cwd = null, maxChars = MAX_INJECT_CHARS } = {}) {
  const parts = []
  for (const scope of SCOPES) {
    const p = memFile(scope, type, cwd)
    if (!p || !existsSync(p)) continue
    try {
      let body = readFileSync(p, 'utf-8').trim()
      if (!body) continue
      parts.push({ scope, body })
    } catch {}
  }
  if (!parts.length) return null

  let out = parts.map(x => `<!-- scope: ${x.scope} -->\n${x.body}`).join('\n\n---\n\n')
  // 超长时保留**尾部**：记忆是追加的，最近的经验更相关
  if (out.length > maxChars) {
    out = `（记忆较长，已省略较早部分）\n…\n` + out.slice(-maxChars)
  }
  return out
}

/** 列出所有有记忆的 agent 类型，供 /memory-agent 查看 */
export function listMemories({ cwd = null } = {}) {
  const found = []
  for (const scope of SCOPES) {
    const root = scopeRoot(scope, cwd)
    if (!root || !existsSync(root)) continue
    let dirs = []
    try { dirs = readdirSync(root) } catch { continue }
    for (const d of dirs) {
      const p = join(root, d, 'MEMORY.md')
      if (!existsSync(p)) continue
      let size = 0, mtime = 0
      try { const st = statSync(p); size = st.size; mtime = st.mtimeMs } catch {}
      found.push({ type: d, scope, path: p, size, mtime })
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime)
}

/** 清空某类 agent 在某作用域的记忆（需要显式指定，避免误删） */
export function clearMemory({ type, scope, cwd = null } = {}) {
  const p = memFile(scope, type, cwd)
  if (!p || !existsSync(p)) return { ok: false, reason: 'not_found' }
  try {
    writeFileSync(p, '', 'utf-8')
    return { ok: true, path: p }
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) }
  }
}
