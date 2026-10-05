// Claude Code Mobile - Git 工具
import { Tool } from '../tools/tools.mjs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

function git(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd: cwd,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    }).trim()
  } catch (e) {
    return `Error: ${e.message}`
  }
}

export class GitStatusTool extends Tool {
  constructor() {
    super({
      name: 'GitStatus', description: 'git status', input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    })
  }
  async execute(input, ctx = {}) { return git(input.path ? resolve(ctx.cwd || process.cwd(), input.path) : (ctx.cwd || process.cwd()), ['status']) }
}

export class GitDiffTool extends Tool {
  constructor() {
    super({
      name: 'GitDiff', description: 'git diff', input_schema: { type: 'object', properties: { path: { type: 'string' }, staged: { type: 'boolean' } } },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    })
  }
  async execute(input, ctx = {}) {
    const a = ['diff']
    if (input.staged) a.push('--staged')
    return git(input.path ? resolve(ctx.cwd || process.cwd(), input.path) : (ctx.cwd || process.cwd()), a)
  }
}

export class GitLogTool extends Tool {
  constructor() {
    super({
      name: 'GitLog', description: 'git log', input_schema: { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'number' } } },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    })
  }
  async execute(input, ctx = {}) { return git(input.path ? resolve(ctx.cwd || process.cwd(), input.path) : (ctx.cwd || process.cwd()), ['log', '--oneline', `-n${input.limit || 20}`]) }
}

export class GitCommitTool extends Tool {
  constructor() {
    super({
      name: 'GitCommit', description: 'git commit', input_schema: { type: 'object', properties: { path: { type: 'string' }, message: { type: 'string' } }, required: ['message'] },
      isDestructive: () => true,
      maxResultSizeChars: 1000,
      validateInput: (input) => {
        const errors = []
        if (!input.message) errors.push('message is required')
        return { valid: errors.length === 0, errors }
      },
    })
  }
  async execute(input, ctx = {}) { return git(input.path ? resolve(ctx.cwd || process.cwd(), input.path) : (ctx.cwd || process.cwd()), ['commit', '-m', input.message]) }
}

export class GitAddTool extends Tool {
  constructor() {
    super({
      name: 'GitAdd', description: 'git add', input_schema: { type: 'object', properties: { path: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } }, required: ['files'] },
      isDestructive: () => true,
      maxResultSizeChars: 1000,
      validateInput: (input) => {
        const errors = []
        if (!input.files || !Array.isArray(input.files) || input.files.length === 0) errors.push('files is required and must be a non-empty array')
        return { valid: errors.length === 0, errors }
      },
    })
  }
  async execute(input, ctx = {}) { return git(input.path ? resolve(ctx.cwd || process.cwd(), input.path) : (ctx.cwd || process.cwd()), ['add', ...input.files]) }
}
