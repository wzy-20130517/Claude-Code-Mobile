/**
 * 验证：官方 cordis + LlmRuntime + SettingsProvider 能不能跑真实的 DSH 插件。
 *
 * 验收标准：
 *   1. 插件 apply 被调用（不抛错）
 *   2. adapter 注册进 ctx.llm
 *   3. listProviders() 能列出 provider
 */

import { tmpdir } from 'node:os'
import { DshHost } from './plugin-loader.mjs'

const host = new DshHost({ dataDir: tmpdir() })

console.log('[test] 启动宿主 ...')
await host.start()
console.log('[test] ✅ 宿主启动（Context + Loader + LlmRuntime + SettingsProvider）')

console.log('[test] 加载 dsh-account-pool ...')
try {
  await host.load('dsh-account-pool', { regions: ['cn', 'trae'] })
  console.log('[test] ✅ 插件加载成功（apply 已执行）')
} catch (err) {
  console.error('[test] ❌ 插件加载失败:', err)
  process.exit(1)
}

// 给插件时间完成异步装配（shim 起端口 + 拉目录）
await new Promise((r) => setTimeout(r, 3000))

console.log('[test] 查询已注册的 provider ...')
const providers = await host.providers()
console.log('[test] providers:', JSON.stringify(providers, null, 2))

if (providers.length === 0) {
  console.error('[test] ❌ 没有注册任何 provider')
  process.exit(1)
}

console.log('[test] ✅ 兼容层工作正常')

await host.dispose()
console.log('[test] 清理完成')
process.exit(0)
