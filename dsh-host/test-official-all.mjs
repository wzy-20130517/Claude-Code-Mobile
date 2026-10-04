/** 官方插件全量测试：31 个带 apply 的官方包 */
import { tmpdir } from 'node:os'
import { DshHost } from './plugin-loader.mjs'

// 先枚举
import { readdirSync } from 'node:fs'
const dirs = readdirSync('node_modules/@deepseek-ai').filter(d => d.startsWith('dsh-'))

const plugins = []
for (const d of dirs) {
  try {
    const m = await import(`@deepseek-ai/${d}`)
    if (typeof m.apply === 'function') plugins.push(`@deepseek-ai/${d}`)
  } catch {}
}

console.log(`发现 ${plugins.length} 个官方插件，开始逐个测试...\n`)

// 部分插件需要 config（不是宿主问题——测试脚本要给对参数）
const PLUGIN_CONFIG = {
  'dsh-agent-instructions': { maxBytes: 65536 },
  'dsh-tool-todo': { allowParallelInProgress: true },
  'dsh-tool-subagent': { provider: 'spawn' },
  'dsh-storage-json': { root: '/tmp/dsh-storage' },
  'dsh-storage-domain': { backend: 'json' },
}

// 这些插件与宿主已提供的服务冲突（宿主已注册同名服务），跳过
const SKIP = new Set([
  'dsh-shell-env',   // 宿主已提供 ctx.shellEnv
])

const results = []
for (const spec of plugins) {
  const shortName = spec.replace('@deepseek-ai/', '')
  if (SKIP.has(shortName)) {
    results.push({ spec, status: 'skipped_by_host' })
    continue
  }
  const host = new DshHost({ dataDir: tmpdir() })
  try {
    await host.start()
    await host.load(spec, PLUGIN_CONFIG[spec.replace('@deepseek-ai/', '')] ?? {})
    await new Promise((r) => setTimeout(r, 600))
    const st = host.pluginState(spec)
    results.push({ spec, status: st?.active ? 'active' : 'suspended', state: st?.state })
  } catch (err) {
    const msg = String(err?.message ?? err)
    let kind = 'error'
    if (msg.includes('Cannot find package') || msg.includes('does not provide an export')) kind = 'import_error'
    else if (msg.includes('cannot get') || msg.includes('without inject')) kind = 'missing_service'
    results.push({ spec, status: kind, detail: msg.slice(0, 100) })
  } finally {
    try { await host.dispose() } catch {}
  }
}

console.log('===== 官方插件结果 =====')
for (const r of results) {
  const icon = r.status === 'active' ? '✅' : r.status === 'suspended' ? '⏸️' : r.status === 'skipped_by_host' ? '➖' : '❌'
  const extra = r.detail ? `  → ${r.detail}` : (r.status === 'suspended' ? '  （等依赖）' : '')
  console.log(`${icon} ${r.spec.replace('@deepseek-ai/', '')}${extra}`)
}
const active = results.filter(r => r.status === 'active').length
const susp = results.filter(r => r.status === 'suspended').length
const err = results.filter(r => !['active','suspended','skipped_by_host'].includes(r.status)).length
const skip = results.filter(r => r.status === 'skipped_by_host').length
console.log(`\n汇总: ✅ 活跃 ${active} / ⏸️ 挂起 ${susp} / ➖ 跳过 ${skip} / ❌ 失败 ${err}`)
process.exit(0)
