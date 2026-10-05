// GitHub 工具集：把 core/github.mjs 的 REST 调用暴露给 Agent。
//
// 【工具边界怎么定的】
// 只封「用 fetch 三两行就能说清、但让模型自己拼容易出错」的操作。
// 不做的事：
//   · 不封文件内容的批量读写 —— 那是 Bash + git 的活，模型未必非要用工具
//   · 不封 GraphQL —— 复杂度上去了，收益不明（REST 够用）
//   · 不封 issue/PR 的复杂筛选 —— 让模型自己传 query 字符串更灵活
//
// 【为什么是这几个】
// 对齐官方 /issue、/pr-comments、/commit 那组命令的真实用途：
//   看仓库、看 issue、看 PR、发评论、建 issue。都是"读为主、写很少"。
// 刻意**没做**"合并 PR""删分支"这类破坏性操作 —— 手机上误触代价高，
// 真要做得让用户明确要求，走 Bash + gh 或直接调 API。

import { Tool } from './tools.mjs'
import { ghApi, resolveRepo, getGithubToken, loadGithubConfig } from '../integrations/github.mjs'

/** 统一的"没配 token 就早退"检查 */
function requireToken() {
  if (getGithubToken()) return null
  return '未配置 GitHub token。先运行 /github login，或设 GITHUB_TOKEN 环境变量。'
}

/** 统一的"仓库解析"检查 */
function requireRepo(inputRepo) {
  const r = resolveRepo(inputRepo)
  if (!r) {
    return { error: '没指定仓库，也没有配置过。用法：传 repo="owner/name"，或先 /github repo owner/name 配一个。' }
  }
  return { repo: r }
}

/** 把 GitHub API 失败转成人能读的一句话（工具结果里直接给模型看） */
function fail(prefix, res) {
  const hint = res.status === 404 ? '（仓库/资源不存在，或 token 无权访问私有仓库）'
    : res.status === 401 ? '（token 无效或已过期）'
    : res.status === 403 ? '（权限不足，或触发了 API 限流）'
    : ''
  return `${prefix}失败: HTTP ${res.status} ${res.error}${hint}`
}

export class GitHubRepoTool extends Tool {
  constructor() {
    super({
      name: 'GitHubRepo',
      description: '查看 GitHub 仓库概览（描述/星标/语言/默认分支/最近提交）。不传 repo 时用 /github repo 设置的仓库。',
      input_schema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/name 或完整 URL；省略则用仓库' },
        },
      },
      maxResultSizeChars: 4000,
    })
  }
  async execute(input) {
    const nt = requireToken(); if (nt) return nt
    const rr = requireRepo(input?.repo); if (rr.error) return rr.error
    const { owner, repo } = rr.repo
    const info = await ghApi(`/repos/${owner}/${repo}`)
    if (!info.ok) return fail('获取仓库', info)
    const d = info.data
    const commits = await ghApi(`/repos/${owner}/${repo}/commits?per_page=5`)
    const lines = [
      `# ${d.full_name}${d.private ? '（私有）' : ''}`,
      d.description || '(无描述)',
      '',
      `默认分支: ${d.default_branch}`,
      `语言: ${d.language || '—'} · 星标: ${d.stargazers_count} · Fork: ${d.forks_count}`,
      `大小: ${(d.size / 1024).toFixed(1)} MB · 更新: ${d.updated_at?.slice(0, 10)}`,
    ]
    if (d.topics?.length) lines.push(`标签: ${d.topics.join(', ')}`)
    if (commits.ok && Array.isArray(commits.data) && commits.data.length) {
      lines.push('', '最近提交:')
      for (const c of commits.data) {
        lines.push(`  ${String(c.sha).slice(0, 7)}  ${c.commit.message.split('\n')[0].slice(0, 70)}  (${c.commit.author?.name || '?'})`)
      }
    }
    return lines.join('\n')
  }
}

export class GitHubIssuesTool extends Tool {
  constructor() {
    super({
      name: 'GitHubIssues',
      description: '列出 GitHub 仓库的 issue（默认 open）。可选按标签/关键词过滤。',
      input_schema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/name；省略用仓库' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: '默认 open' },
          labels: { type: 'string', description: '逗号分隔的标签，如 "bug,help wanted"' },
          search: { type: 'string', description: '按标题/正文搜索的关键词' },
          limit: { type: 'number', description: '返回条数，默认 15，最多 50' },
        },
      },
      maxResultSizeChars: 6000,
    })
  }
  async execute(input) {
    const nt = requireToken(); if (nt) return nt
    const rr = requireRepo(input?.repo); if (rr.error) return rr.error
    const { owner, repo } = rr.repo
    const limit = Math.min(50, Math.max(1, Number(input?.limit) || 15))
    const state = ['open', 'closed', 'all'].includes(input?.state) ? input.state : 'open'
    // 有 search 时走搜索端点（它是全站搜索，加 repo: 限定到本仓库）
    if (input?.search) {
      const q = `repo:${owner}/${repo} ${input.search} type:issue state:${state}`
      const r = await ghApi(`/search/issues?q=${encodeURIComponent(q)}&per_page=${limit}`)
      if (!r.ok) return fail('搜索 issue', r)
      if (!r.data.items?.length) return `没找到匹配「${input.search}」的 issue`
      return r.data.items.map(i =>
        `#${i.number} [${i.state}] ${i.title}\n  ${i.user?.login} · ${i.created_at?.slice(0, 10)} · ${i.comments} 评论`
      ).join('\n\n')
    }
    const params = new URLSearchParams({ state, per_page: String(limit) })
    if (input?.labels) params.set('labels', input.labels)
    const r = await ghApi(`/repos/${owner}/${repo}/issues?${params}`)
    if (!r.ok) return fail('列出 issue', r)
    // GitHub 的 issues 端点会把 PR 也混进来，按 pull_request 字段剔除
    const items = r.data.filter(i => !i.pull_request)
    if (!items.length) return `没有 ${state} 状态的 issue`
    return items.map(i =>
      `#${i.number} ${i.title}\n  ${i.user?.login} · ${i.created_at?.slice(0, 10)}`
      + (i.labels?.length ? ` · ${i.labels.map(l => l.name).join(',')}` : '')
      + (i.comments ? ` · ${i.comments} 评论` : '')
    ).join('\n')
  }
}

export class GitHubIssueViewTool extends Tool {
  constructor() {
    super({
      name: 'GitHubIssueView',
      description: '读单个 GitHub issue/PR 的正文与全部评论。',
      input_schema: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'issue 或 PR 编号' },
          repo: { type: 'string', description: 'owner/name；省略用仓库' },
          comments: { type: 'boolean', description: '是否附带评论，默认 true' },
        },
        required: ['number'],
      },
      maxResultSizeChars: 12000,
    })
  }
  async execute(input) {
    const nt = requireToken(); if (nt) return nt
    const rr = requireRepo(input?.repo); if (rr.error) return rr.error
    const num = Number(input?.number)
    if (!Number.isFinite(num)) return 'number 必须是数字'
    const { owner, repo } = rr.repo
    const r = await ghApi(`/repos/${owner}/${repo}/issues/${num}`)
    if (!r.ok) return fail(`读取 #${num}`, r)
    const d = r.data
    const kind = d.pull_request ? 'PR' : 'issue'
    const lines = [
      `# ${kind} #${d.number}: ${d.title}`,
      `${d.user?.login} · ${d.created_at?.slice(0, 10)} · ${d.state}`
      + (d.labels?.length ? ` · ${d.labels.map(l => l.name).join(',')}` : ''),
      '',
      (d.body || '(无正文)').slice(0, 6000),
    ]
    if (input?.comments !== false && d.comments > 0) {
      const c = await ghApi(`/repos/${owner}/${repo}/issues/${num}/comments?per_page=30`)
      if (c.ok && c.data?.length) {
        lines.push('', `── 评论（${c.data.length} 条）──`)
        for (const cm of c.data) {
          lines.push(`@${cm.user?.login} ${cm.created_at?.slice(0, 10)}:`)
          lines.push((cm.body || '').slice(0, 1500))
          lines.push('')
        }
      }
    }
    return lines.join('\n')
  }
}

export class GitHubPRsTool extends Tool {
  constructor() {
    super({
      name: 'GitHubPRs',
      description: '列出 GitHub 仓库的 Pull Request。',
      input_schema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/name；省略用仓库' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: '默认 open' },
          limit: { type: 'number', description: '返回条数，默认 15，最多 50' },
        },
      },
      maxResultSizeChars: 6000,
    })
  }
  async execute(input) {
    const nt = requireToken(); if (nt) return nt
    const rr = requireRepo(input?.repo); if (rr.error) return rr.error
    const { owner, repo } = rr.repo
    const state = ['open', 'closed', 'all'].includes(input?.state) ? input.state : 'open'
    const limit = Math.min(50, Math.max(1, Number(input?.limit) || 15))
    const r = await ghApi(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=${limit}`)
    if (!r.ok) return fail('列出 PR', r)
    if (!r.data.length) return `没有 ${state} 状态的 PR`
    return r.data.map(p =>
      `#${p.number} ${p.title}\n  ${p.user?.login} · ${p.head?.ref} → ${p.base?.ref}`
      + ` · ${p.draft ? '草稿 · ' : ''}${p.created_at?.slice(0, 10)}`
    ).join('\n')
  }
}

export class GitHubPRCommentsTool extends Tool {
  constructor() {
    super({
      name: 'GitHubPRComments',
      description: '读某个 PR 的评审意见（含代码行级评论与 diff 上下文）。对齐官方 /pr-comments。',
      input_schema: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'PR 编号' },
          repo: { type: 'string', description: 'owner/name；省略用仓库' },
        },
        required: ['number'],
      },
      maxResultSizeChars: 16000,
    })
  }
  async execute(input) {
    const nt = requireToken(); if (nt) return nt
    const rr = requireRepo(input?.repo); if (rr.error) return rr.error
    const num = Number(input?.number)
    if (!Number.isFinite(num)) return 'number 必须是数字'
    const { owner, repo } = rr.repo
    const [issueC, reviewC] = await Promise.all([
      ghApi(`/repos/${owner}/${repo}/issues/${num}/comments?per_page=30`),
      ghApi(`/repos/${owner}/${repo}/pulls/${num}/comments?per_page=30`),
    ])
    const out = []
    // PR 级评论
    if (issueC.ok && issueC.data?.length) {
      out.push(`── PR 级评论（${issueC.data.length}）──`)
      for (const c of issueC.data) out.push(`@${c.user?.login}:\n${(c.body || '').slice(0, 1200)}\n`)
    }
    // 代码行级评论：带 path / line / diff_hunk
    if (reviewC.ok && reviewC.data?.length) {
      out.push(`── 代码评审（${reviewC.data.length}）──`)
      for (const c of reviewC.data) {
        out.push(`@${c.user?.login} ${c.path}:${c.line ?? c.original_line ?? '?'}`)
        if (c.diff_hunk) out.push('```diff\n' + c.diff_hunk.slice(0, 800) + '\n```')
        out.push(`> ${(c.body || '').slice(0, 1000)}\n`)
      }
    }
    return out.length ? out.join('\n') : '这个 PR 还没有评论'
  }
}

export class GitHubCommentTool extends Tool {
  constructor() {
    super({
      name: 'GitHubComment',
      description: '在 GitHub issue 或 PR 下发表评论。会让仓库成员看到，发之前确认内容无误。',
      input_schema: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'issue 或 PR 编号' },
          body: { type: 'string', description: '评论正文（Markdown）' },
          repo: { type: 'string', description: 'owner/name；省略用仓库' },
        },
        required: ['number', 'body'],
      },
      maxResultSizeChars: 2000,
      validateInput(input) {
        const e = []
        if (!Number.isFinite(Number(input?.number))) e.push('number 必须是数字')
        if (!input?.body || !String(input.body).trim()) e.push('body 不能为空')
        return { valid: e.length === 0, errors: e }
      },
    })
  }
  async execute(input) {
    const nt = requireToken(); if (nt) return nt
    const rr = requireRepo(input?.repo); if (rr.error) return rr.error
    const { owner, repo } = rr.repo
    const num = Number(input.number)
    const r = await ghApi(`/repos/${owner}/${repo}/issues/${num}/comments`, {
      method: 'POST', body: { body: String(input.body) },
    })
    if (!r.ok) return fail('发表评论', r)
    return `已在 #${num} 发表评论\n${r.data.html_url}`
  }
}

export class GitHubCreateIssueTool extends Tool {
  constructor() {
    super({
      name: 'GitHubCreateIssue',
      description: '在 GitHub 仓库新建 issue。提交前确认标题和正文；会真实创建，仓库成员可见。',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'issue 标题' },
          body: { type: 'string', description: '正文（Markdown）' },
          labels: { type: 'array', items: { type: 'string' }, description: '可选标签名' },
          repo: { type: 'string', description: 'owner/name；省略用仓库' },
        },
        required: ['title'],
      },
      maxResultSizeChars: 2000,
      validateInput(input) {
        const e = []
        if (!input?.title || !String(input.title).trim()) e.push('title 不能为空')
        return { valid: e.length === 0, errors: e }
      },
    })
  }
  async execute(input) {
    const nt = requireToken(); if (nt) return nt
    const rr = requireRepo(input?.repo); if (rr.error) return rr.error
    const { owner, repo } = rr.repo
    const payload = { title: String(input.title) }
    if (input.body) payload.body = String(input.body)
    if (Array.isArray(input.labels) && input.labels.length) payload.labels = input.labels.map(String)
    const r = await ghApi(`/repos/${owner}/${repo}/issues`, { method: 'POST', body: payload })
    if (!r.ok) return fail('创建 issue', r)
    return `已创建 issue #${r.data.number}: ${r.data.title}\n${r.data.html_url}`
  }
}

export class GitHubFileTool extends Tool {
  constructor() {
    super({
      name: 'GitHubFile',
      description: '读取 GitHub 仓库里的文件（不需要本地 clone）。用于看远端代码、README、配置。',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '仓库内路径，如 src/index.ts' },
          repo: { type: 'string', description: 'owner/name；省略用仓库' },
          ref: { type: 'string', description: '分支/标签/commit SHA；省略用默认分支' },
          list: { type: 'boolean', description: 'true = 列目录而不是读文件' },
        },
        required: ['path'],
      },
      maxResultSizeChars: 30000,
    })
  }
  async execute(input) {
    const nt = requireToken(); if (nt) return nt
    const rr = requireRepo(input?.repo); if (rr.error) return rr.error
    const { owner, repo } = rr.repo
    const p = String(input?.path || '').replace(/^\/+/, '')
    const q = input?.ref ? `?ref=${encodeURIComponent(input.ref)}` : ''
    const r = await ghApi(`/repos/${owner}/${repo}/contents/${encodeURIComponent(p).replace(/%2F/g, '/')}${q}`)
    if (!r.ok) return fail(`读取 ${p}`, r)
    const d = r.data
    // 目录：返回条目清单
    if (Array.isArray(d)) {
      return `目录 ${p}/（${d.length} 项）:\n` + d.map(x =>
        `  ${x.type === 'dir' ? '[D]' : '   '} ${x.name}${x.size ? `  (${x.size}B)` : ''}`
      ).join('\n')
    }
    if (input?.list) return `${p} 是文件，不是目录（${d.size} 字节）`
    // 文件：内容按 base64 编码返回，且大文件可能没有 content 字段
    if (!d.content) {
      return `文件较大（${d.size} 字节），API 未内联返回内容。\n下载地址: ${d.download_url}\n（可用 Bash curl 取，或改用 ViewImage/Read 处理本地副本）`
    }
    try {
      const text = Buffer.from(d.content, 'base64').toString('utf-8')
      return `# ${owner}/${repo}:${p}${input?.ref ? `@${input.ref}` : ''}\n\n${text}`
    } catch {
      return `文件解码失败（可能是二进制，${d.size} 字节）\n${d.download_url}`
    }
  }
}

// ── 配置命令（非工具） ──────────────────────────────────

export const GITHUB_TOOLS = [
  GitHubRepoTool, GitHubIssuesTool, GitHubIssueViewTool, GitHubPRsTool,
  GitHubPRCommentsTool, GitHubCommentTool, GitHubCreateIssueTool, GitHubFileTool,
]
