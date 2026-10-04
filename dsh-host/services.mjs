/**
 * services.mjs —— 宿主服务注册表（数据驱动 + 容错）。
 *
 * 【为什么抽出来】
 * 原来 plugin-loader.mjs 里硬编码 18 个 `new XxxService(ctx)`：
 *   1. 任何一个构造失败 → 整个宿主起不来（一个坏服务拖垮全部）
 *   2. 顺序靠注释和记忆维持（SystemPrompt 必须在 ToolRuntime 前…）
 *   3. 加服务要改三处（import / 代码 / 文档）
 *
 * 现在改成表驱动：
 *   - `deps` 声明依赖的服务名，注册器按拓扑序注册（不满足则跳过并告警）
 *   - 单个服务失败只记录错误，不影响其他服务
 *   - 加服务 = 表里加一行
 *
 * 【依赖顺序从哪来】
 * 都是实测踩出来的（构造时报 `Cannot read properties of undefined`）：
 *   - SystemPrompt → ToolRuntime（后者构造读 ctx.systemPrompt.tools()）
 *   - SessionProjections → GoalService（后者构造读 ctx.sessionProjections.register()）
 */

import LlmRuntime from '@deepseek-ai/dsh-llm'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import CredentialProvider from '@deepseek-ai/dsh-credentials'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import GoalService from '@deepseek-ai/dsh-goal'
import WebRuntime from '@deepseek-ai/dsh-web'
import SandboxProvider from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import Storage from '@deepseek-ai/dsh-storage'
import { ShellEnvRegistry } from '@deepseek-ai/dsh-shell-env'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import DeepSeekLlmApiExtensionRegistry from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import PtcWorkflowEngine from '@deepseek-ai/dsh-workflow-ptc'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import path from 'node:path'

/**
 * 服务定义表。
 *
 * 字段：
 *   name   —— ctx 上的服务名（用于依赖检查和日志）
 *   Klass  —— 官方服务类（都是 `extends Service`，构造即注册）
 *   config —— 构造参数（函数形式，拿 ctx 上下文）
 *   deps   —— 依赖的服务名列表（注册器保证先注册它们）
 *   desc   —— 一句话说明（日志/文档用）
 */
export const SERVICE_TABLE = [
  { name: 'llm', Klass: LlmRuntime, desc: 'LLM 路由注册' },
  { name: 'settings', Klass: SettingsProvider, desc: '插件配置' },
  { name: 'timer', Klass: TimerService, desc: '定时器' },
  { name: 'credentials', Klass: CredentialProvider, desc: '凭据存取' },
  {
    // 必须用 LocalSubprocessRuntime（实现类）：抽象 SubprocessRuntime 只有 constructor，
    // 而 bash-local 需要 spawn（报 this.ctx.subprocess.spawn is not a function）。
    // 注意：装它要 --ignore-scripts（node-pty 原生编译在 Termux 会失败，但不用 pty 功能时无影响）。
    name: 'subprocess', Klass: LocalSubprocessRuntime, desc: '子进程',
  },
  { name: 'typert', Klass: TypertRegistry, desc: '类型化 RPC 注册' },

  {
    name: 'systemPrompt', Klass: SystemPrompt, desc: '提示词组装',
    config: () => ({ toolOrder: ['<unlisted-tools>'], includeHarnessIdentity: false }),
  },
  {
    name: 'tools', Klass: ToolRuntime, desc: '工具注册',
    deps: ['systemPrompt'],   // 构造时读 ctx.systemPrompt.tools()
  },
  { name: 'skills', Klass: SkillRegistry, desc: '技能注册', config: () => ({}) },

  {
    name: 'fs', Klass: LocalFileSystem, desc: '文件系统',
    // 必须用 Local 实现类：抽象 FileSystem 会先占名导致冲突
    config: (ctx) => ({ cwd: ctx.dataDir ?? process.cwd(), diffBasisMaxBytes: 1024 * 1024 }),
  },
  {
    // 必须用 LocalBashExecutor（实现类）：抽象 ShellExecutor 只有 sandboxMode 一个方法，
    // 而 tool-bash 需要 resolve/run/start（报 ctx.shell.resolve is not a function）。
    // 注意：npm 的 latest tag（0.0.1-rc.1）依赖未发布的 dsh-bash 会装不上，必须显式指定 0.1.6-alpha.2。
    name: 'shell', Klass: LocalBashExecutor, desc: 'Shell 执行',
    // 直接 new 不走 schemastery 默认值，手填全部字段
    config: (ctx) => ({
      cwd: ctx.dataDir ?? process.cwd(),
      timeoutMs: 120000,
      maxTimeoutMs: 600000,
      maxOutputBytes: 64000,
      maxSpillBytes: 67108864,
      graceMs: 3000,
    }),
  },
  { name: 'agents', Klass: AgentRegistry, desc: 'Agent 注册' },
  {
    name: 'jobs', Klass: LocalJobRegistry, desc: '后台作业',
    // 必须用 Local 实现类：JobRegistry 是抽象 seam，构造直接抛错
    config: () => ({ maxConcurrentJobsPerOwner: 8 }),
  },
  { name: 'sessions', Klass: SessionStore, desc: '会话存储' },
  { name: 'sessionProjections', Klass: SessionProjectionRegistry, desc: '会话投影' },
  { name: 'workspaceRegistry', Klass: WorkspaceRegistry, desc: '工作区注册' },
  {
    name: 'goals', Klass: GoalService, desc: '目标服务',
    deps: ['sessionProjections'],   // 构造时读 ctx.sessionProjections.register()
    config: () => ({}),
  },
  { name: 'web', Klass: WebRuntime, desc: '搜索/抓取', config: () => ({}) },
  { name: 'sandbox', Klass: SandboxProvider, desc: '沙箱提供者' },
  {
    name: 'sandboxPolicy', Klass: SandboxPolicyService, desc: '沙箱策略',
    config: (ctx) => ({ mode: 'workspace-write', workspaceRoot: ctx.dataDir ?? process.cwd() }),
  },
  { name: 'storage', Klass: Storage, desc: '存储中心' },
  { name: 'shellEnv', Klass: ShellEnvRegistry, desc: 'Shell 环境变量', config: () => ({}) },
  {
    name: 'sessionPersistence', Klass: JsonlSessionPersistence, desc: '会话持久化',
    config: (ctx) => ({ root: path.join(ctx.dataDir ?? process.cwd(), 'sessions') }),
  },
  { name: 'commands', Klass: CommandRuntime, desc: '命令注册' },
  { name: 'deepseekLlmApiExtensions', Klass: DeepSeekLlmApiExtensionRegistry, desc: 'DeepSeek API 扩展' },
  {
    name: 'ptcRuntime', Klass: NodePtcRuntime, desc: 'PTC 运行时',
    // static inject: [fs, subprocess, sandbox, sandboxPolicy] —— 都已在上方
    // 注意：直接 new 不会走 schemastery 默认值填充，必须手填全部字段
    config: () => ({
      timeoutMs: 120000,
      maxTimeoutMs: 600000,
      maxOutputBytes: 67108864,
      maxOldGenerationSizeMb: 512,
      maxMessageBytes: 134217728,
      maxPendingCalls: 128,
      graceMs: 3000,
      nodeExecutable: process.execPath,
    }),
  },
  {
    // 服务名是 'workflowEngine'（0.1.6-alpha.2 版父类注册的）
    // 踩坑：0.0.1-rc.1 老版叫 'workflows'，与插件期望不符 → 必须用新版
    name: 'workflowEngine', Klass: PtcWorkflowEngine, desc: '工作流引擎',
    deps: ['ptcRuntime'],   // 构造时读 ctx.ptcRuntime.language
    config: () => ({}),
  },
  {
    name: 'subagents', Klass: SubagentRuntime, desc: '子 agent 运行时',
    config: () => ({ maxDepth: 2, maxActiveSubagents: 8 }),
  },
]

/**
 * 按依赖顺序注册服务（拓扑 + 容错）。
 *
 * @param {Context} ctx
 * @param {object} [options]
 * @param {(msg: string, level?: string) => void} [options.log] 日志回调
 * @returns {{ ok: string[], failed: Array<{name: string, error: string}>, skipped: Array<{name: string, missing: string[]}> }}
 */
export function registerServices(ctx, options = {}) {
  const log = options.log ?? (() => {})
  const ok = []
  const failed = []
  const skipped = []

  // 待注册队列（拷贝一份，便于重试）
  let queue = [...SERVICE_TABLE]
  let guard = 0

  while (queue.length > 0 && guard++ < SERVICE_TABLE.length * 3) {
    const remaining = []
    let progress = false

    for (const entry of queue) {
      const deps = entry.deps ?? []
      const missing = deps.filter((d) => ctx.get(d) === undefined)

      if (missing.length > 0) {
        remaining.push(entry)   // 依赖没就绪，下一轮再试
        continue
      }

      try {
        const config = entry.config ? entry.config(ctx) : undefined
        new entry.Klass(ctx, config)
        ok.push(entry.name)
        log(`  ✅ ${entry.name}（${entry.desc}）`)
        progress = true
      } catch (err) {
        const msg = String(err?.message ?? err).slice(0, 120)
        failed.push({ name: entry.name, error: msg })
        log(`  ❌ ${entry.name}（${entry.desc}）: ${msg}`, 'error')
        // 不 push 回 remaining：失败的不重试（避免死循环）
        progress = true
      }
    }

    // 本轮没有任何进展 → 剩下的全是依赖死锁
    if (!progress) {
      for (const entry of remaining) {
        const missing = (entry.deps ?? []).filter((d) => ctx.get(d) === undefined)
        skipped.push({ name: entry.name, missing })
        log(`  ⏭️  ${entry.name} 跳过（依赖缺失: ${missing.join(', ')}）`, 'warn')
      }
      break
    }

    queue = remaining
  }

  return { ok, failed, skipped }
}
