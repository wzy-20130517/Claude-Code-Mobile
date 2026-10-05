// Claude Code Mobile - Git 检查点（Aider 式）
// 当工作目录是 git 仓库时：编辑后自动 commit（消息带 ccm: 前缀标记），
// /undo 只回滚本会话创建的提交（记录 commit hash 集合校验），比纯文件快照更安全。
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// 标记：本会话提交的消息前缀
const COMMIT_PREFIX = 'ccm:'

// 检测某目录（或其父目录）是否是 git 仓库
export function isGitRepo(dir) {
  try {
    const r = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    return r.trim() === 'true'
  } catch { return false }
}

// 获取当前 HEAD 的完整 hash（无仓库/无提交返回 null）
export function getHeadHash(dir) {
  try {
    const r = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    return r.trim() || null
  } catch { return null }
}

// 提交工作区所有改动（自动 add + commit），返回新 commit hash；无改动返回 null
export function autoCommit(dir, summary = '') {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: dir, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (!status.trim()) return null  // 无改动不提交
    execFileSync('git', ['add', '-A'], { cwd: dir, timeout: 5000, stdio: 'ignore' })
    const msg = `${COMMIT_PREFIX}${summary ? ' ' + summary : ' checkpoint'}`
    execFileSync('git', ['commit', '-m', msg], {
      cwd: dir, encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    return getHeadHash(dir)
  } catch { return null }
}

// 回滚到指定 commit（hard reset），返回是否成功
export function resetToCommit(dir, commitHash) {
  try {
    execFileSync('git', ['reset', '--hard', commitHash], {
      cwd: dir, encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    return true
  } catch { return false }
}

// 获取当前仓库的"本会话提交"列表：找出所有 ccm: 前缀的提交（从 HEAD 往前数）
// 返回 [{hash, message, time}]，最近在前
export function listSessionCommits(dir, limit = 50) {
  try {
    const r = execFileSync('git', ['log', `-${limit}`, '--format=%H|%s|%ct'], {
      cwd: dir, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    return r.trim().split('\n').filter(Boolean).map(line => {
      const [hash, message, time] = line.split('|')
      return { hash, message, time: Number(time) * 1000 }
    }).filter(c => c.message.startsWith(COMMIT_PREFIX))
  } catch { return [] }
}

export { COMMIT_PREFIX }
