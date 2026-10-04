import { tmpdir } from 'node:os'
import { DshHost } from './plugin-loader.mjs'

const host = new DshHost({ dataDir: tmpdir(), verbose: true })
await host.start()

console.log()
console.log('=== 注册结果 ===')
const r = host.services
console.log(`成功 ${r.ok.length} / 失败 ${r.failed.length} / 跳过 ${r.skipped.length}`)
if (r.failed.length) console.log('失败:', JSON.stringify(r.failed, null, 2))
if (r.skipped.length) console.log('跳过:', JSON.stringify(r.skipped, null, 2))
process.exit(0)
