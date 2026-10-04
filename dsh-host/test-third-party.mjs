/** 第三方插件兼容性测试 —— 扩大验证面 */
import { tmpdir } from 'node:os'
import { DshHost } from './plugin-loader.mjs'

// 注意：dsh-plugin-ops-core 不是插件（是共享库，无 apply 导出），不列入测试。
// 它是 dsh-plugin-ops-bundle 的依赖，Cordis 加载时会报 "invalid plugin"（预期行为）。
const CANDIDATES = [
  '@goodandready/dsh-time-machine',
  '@goodandready/dsh-context-lens',
  '@goodandready/dsh-shadow-auditor',
  'dsh-plan-and-execute',
  'dsh-plugin-observatory',      // 兼容性审计工具
  'dsh-find-plugin',             // 插件搜索
  'dsh-plugin-tool-management',  // 工具管理面板
  'dsh-plugin-guide',            // 知识库
  'dsh-plugin-mgr',              // 插件管理器
  'dsh-plugin-model-proxy',      // 模型代理
]

const results = []
for (const spec of CANDIDATES) {
  const host = new DshHost({ dataDir: tmpdir() })
  try {
    await host.start()
    await host.load(spec, {})
    await new Promise((r) => setTimeout(r, 800))
    const providers = host.get('llm').listProviders().map(p => p.id)
    results.push({ spec, status: 'ok', providers })
  } catch (err) {
    const msg = String(err?.message ?? err)
    let kind = 'error'
    if (msg.includes('Cannot find package') || msg.includes('does not provide an export')) kind = 'import_error'
    else if (msg.includes('cannot get') || msg.includes('without inject') || msg.includes('inactive')) kind = 'missing_service'
    results.push({ spec, status: kind, detail: msg.slice(0, 130) })
  } finally {
    try { await host.dispose() } catch {}
  }
}

console.log('\n===== 第三方插件兼容性 =====')
for (const r of results) {
  const icon = r.status === 'ok' ? '✅' : r.status === 'missing_service' ? '⚠️' : '❌'
  const extra = r.providers?.length ? `  [provider: ${r.providers.join(', ')}]` : (r.detail ? `  → ${r.detail}` : '')
  console.log(`${icon} ${r.spec}${extra}`)
}
const ok = results.filter(r => r.status === 'ok').length
const miss = results.filter(r => r.status === 'missing_service').length
console.log(`\n汇总: ✅ ${ok} 加载 / ⚠️ ${miss} 缺服务 / ❌ ${results.length - ok - miss} 失败`)
process.exit(0)
