// .claude/agents/*.md 自定义 subagent 定义（对标原版）
// frontmatter: name, description, tools (comma-separated), model (ignored)
import { readdirSync, readFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { DATA_DIR } from './paths.mjs'

function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return { meta: {}, body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return { meta: {}, body: raw }
  const head = raw.slice(3, end).trim()
  const body = raw.slice(end + 4).replace(/^\n/, '')
  const meta = {}
  for (const line of head.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
  return { meta, body }
}

export class CustomAgentLoader {
  constructor(roots = []) {
    this.roots = roots
    this.agents = new Map()
    this.reload()
  }

  reload() {
    this.agents.clear()
    for (const root of this.roots) {
      if (!existsSync(root)) continue
      let files = []
      try { files = readdirSync(root).filter(f => f.endsWith('.md')) } catch { continue }
      for (const f of files) {
        try {
          const full = join(root, f)
          if (!statSync(full).isFile()) continue
          const raw = readFileSync(full, 'utf-8')
          const { meta, body } = parseFrontmatter(raw)
          const name = (meta.name || basename(f, '.md')).replace(/^\//, '')
          if (!name || name.includes('/') || name.includes('..')) continue
          let toolNames = null
          if (meta.tools) {
            const parts = meta.tools.split(',').map(s => s.trim()).filter(Boolean)
            if (parts.length) toolNames = parts
          }
          this.agents.set(name, {
            description: meta.description || `自定义 agent: ${name}`,
            toolNames,
            maxTurns: Number(meta.maxTurns) || 30,
            promptAddition: `\n# 你的角色：自定义子 Agent (${name})\n${body}\n**重要**：你运行在后台，永远不要调用 AskUserQuestion。\n`,
            source: full,
          })
        } catch {}
      }
    }
  }

  /** 合并到内置 SUBAGENT_TYPES */
  mergeInto(baseTypes) {
    const out = { ...baseTypes }
    for (const [name, cfg] of this.agents) {
      out[name] = {
        description: cfg.description,
        toolNames: cfg.toolNames,
        maxTurns: cfg.maxTurns,
        promptAddition: cfg.promptAddition,
      }
    }
    return out
  }

  list() {
    return [...this.agents.entries()].map(([name, a]) => ({
      name, description: a.description, source: a.source,
    }))
  }

  formatForPrompt() {
    const list = this.list()
    if (!list.length) return ''
    return '\n\n# 用户自定义 subagent（.claude/agents）\n' +
      list.map(a => `- \`${a.name}\`: ${a.description}`).join('\n') +
      '\nAgent 工具的 subagent_type 可填以上名称。\n'
  }
}

export function ensureAgentsDir(cwd) {
  const dir = join(cwd, '.claude', 'agents')
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}

/**
 * 用户级 agents 目录（数据目录下）—— **优先级最高**。
 *
 * 【2026-10-03】用户定义的 agent 角色（cpo/cto/qa…）是**用户数据**：
 * 换台机器应该跟着走，不该被 git 跟踪。放 ~/.claude-code-mobile/agents/。
 * 项目级 .claude/agents/ 仍然支持（那是"这个项目专属的角色"）。
 * 加载顺序：数据目录 → 项目目录 → ~/.claude/agents/（官方约定位置）。
 */
export function userAgentsDir() {
  const dir = join(DATA_DIR, 'agents')
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}
