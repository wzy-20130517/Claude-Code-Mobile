// 输出风格（对齐官方 constants/outputStyles.ts + outputStyles/loadOutputStylesDir.ts）
//
// 官方的语义：
//   1. 内置风格：default（无提示词）、Explanatory（讲解实现选择）、Learning（让用户动手写）
//   2. 用户自定义：`.claude/output-styles/*.md`（项目级）与 `~/.claude/output-styles/*.md`（用户级）
//      文件名即风格名；frontmatter 提供 name / description / keep-coding-instructions；
//      正文即风格提示词。
//   3. 注入形式：`# Output Style: <name>\n<prompt>`（官方 getOutputStyleSection）
//   4. keep-coding-instructions: false → **不注入**「执行任务」那段通用指令，
//      让风格完全接管行为（Explanatory / Learning 都设了 true，即保留）
//   5. 项目级覆盖用户级（同名时）
//
// 【为什么不照搬官方全部】
//   官方的 outputStyle 与 settings.json / 插件系统耦合（插件可强制指定风格、
//   有 SettingSource 优先级链）。我们没有插件体系，且风格来源只有两处目录，
//   照搬那套优先级只会增加没人走的分支。这里保留：内置 + 两级目录 + 覆盖规则。
//
// 【为什么不用 /output-style 命令】
//   官方自己已经把它标成 Deprecated + isHidden（见 commands/output-style/index.ts），
//   改为在 /config 里选。我们同样放进 /config 的交互列表，不单独开命令。
import { readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const DEFAULT_OUTPUT_STYLE_NAME = 'default'

/** 官方内置的两个非默认风格（提示词照官方 constants/outputStyles.ts 翻译/精简） */
export const BUILTIN_STYLES = {
  Explanatory: {
    name: 'Explanatory',
    description: '解释实现选择与代码库模式（教学向）',
    keepCodingInstructions: true,
    source: 'built-in',
    prompt: `在完成软件工程任务之外，额外提供关于代码库的教学性说明。

保持清晰、有教育意义，在聚焦任务的同时给出有用的解释。平衡讲解与完成度。

## Insights
为了促进学习，在写代码前后，用下面这种块补充简短的教学要点：

\`★ Insight ─────────────────────────────────────\`
[2-3 条与本次改动相关的要点]
\`─────────────────────────────────────────────────\`

要点放在对话里，不要写进代码库。优先讲**这个代码库/这段代码特有**的洞见，
而不是通用编程常识。`,
  },
  Learning: {
    name: 'Learning',
    description: '让用户动手写小段代码（协作学习）',
    keepCodingInstructions: true,
    source: 'built-in',
    prompt: `在完成软件工程任务之外，帮助用户通过动手实践和讲解来学习代码库。

保持协作和鼓励的态度。在有意义的设计决策上请用户参与，例行实现自己做。

## Requesting Human Contributions
在生成 20+ 行代码时，请用户贡献 2-10 行，场景包括：
- 设计决策（错误处理、数据结构）
- 有多种合理写法的业务逻辑
- 关键算法或接口定义

请求格式：

\`★ Learn by Doing\`
**Context:** [已搭好什么、这个决策为什么重要]
**Your Task:** [具体到文件与函数；提 TODO(human) 但不要给行号]
**Guidance:** [要考虑的取舍与约束]

请求前必须先用编辑工具在代码里留下 TODO(human) 标记，且全代码库只留一处。
发出请求后不要再做任何事，等用户实现完再继续。`,
  },
}

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

/** 从正文里取第一个非空行当描述（官方 extractDescriptionFromMarkdown 的简化） */
function descriptionFromBody(body, fallback) {
  for (const line of String(body || '').split('\n')) {
    const t = line.replace(/^#+\s*/, '').trim()
    if (t && !t.startsWith('---')) return t.length > 60 ? t.slice(0, 60) + '…' : t
  }
  return fallback
}

/** 确保目录存在（与 ensureCommandsDir 同风格） */
export function ensureOutputStylesDir(cwd) {
  const dir = join(cwd, '.claude', 'output-styles')
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}

/**
 * 扫描一个目录下的 *.md，转成风格对象。
 * 文件名即风格名（官方一致），frontmatter.name 可覆盖显示名。
 */
function loadDir(dir, source) {
  const out = []
  try {
    if (!existsSync(dir)) return out
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      const full = join(dir, f)
      let raw
      try { raw = readFileSync(full, 'utf-8') } catch { continue }
      const { meta, body } = parseFrontmatter(raw)
      const styleName = f.replace(/\.md$/, '')
      if (!body.trim()) continue
      // keep-coding-instructions 支持布尔与字符串两种写法（官方两种都认）
      const kci = meta['keep-coding-instructions']
      const keepCodingInstructions = kci === undefined ? undefined
        : (kci === true || kci === 'true')
      out.push({
        name: meta.name || styleName,
        id: styleName,
        description: meta.description || descriptionFromBody(body, `自定义风格 ${styleName}`),
        prompt: body.trim(),
        keepCodingInstructions,
        source,
        path: full,
      })
    }
  } catch {}
  return out
}

/**
 * 列出全部可用风格：内置 + 用户级 + 项目级（后者覆盖同名前者）。
 * 返回 Map<id, style>，顺序：default 在最前，其余按来源（内置→用户→项目）。
 */
export function listOutputStyles(cwd = process.cwd()) {
  const map = new Map()
  map.set(DEFAULT_OUTPUT_STYLE_NAME, {
    name: DEFAULT_OUTPUT_STYLE_NAME, id: DEFAULT_OUTPUT_STYLE_NAME,
    description: '默认（无额外风格提示词）', prompt: null, source: 'built-in',
  })
  for (const [id, s] of Object.entries(BUILTIN_STYLES)) map.set(id, { ...s, id })
  // 用户级先加载，项目级后加载 → 同名时项目级覆盖（官方语义）
  for (const s of loadDir(join(homedir(), '.claude', 'output-styles'), 'user')) map.set(s.id, s)
  for (const s of loadDir(join(cwd, '.claude', 'output-styles'), 'project')) map.set(s.id, s)
  return map
}

/** 取单个风格；不存在返回 null（调用方据此回退到 default） */
export function getOutputStyle(name, cwd = process.cwd()) {
  if (!name || name === DEFAULT_OUTPUT_STYLE_NAME) return null
  return listOutputStyles(cwd).get(name) || null
}

/**
 * 生成要注入系统提示词的段落（官方 getOutputStyleSection 的同构实现）。
 * 返回 null 表示无需注入（default 风格）。
 */
export function getOutputStyleSection(style) {
  if (!style || !style.prompt) return null
  return `# Output Style: ${style.name}\n${style.prompt}`
}
