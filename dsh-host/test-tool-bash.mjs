/** 验证 bash 工具：插件注册的 shell 执行能力 */
import { tmpdir } from 'node:os'
import { DshHost } from './plugin-loader.mjs'

// dataDir 用系统临时目录，避免往源码目录写运行时文件
const host = new DshHost({ dataDir: tmpdir() })
await host.start()
await host.load('@deepseek-ai/dsh-tool-bash', {})
await new Promise((r) => setTimeout(r, 1500))

const tools = host.get('tools')
const schemas = tools.schemas()
console.log('可用工具:', schemas.map(s => s.name ?? s).join(', '))
console.log()

try {
  const exec = tools.resolveExecution('bash', { command: 'echo "hello from dsh plugin"' }, {})
  console.log('工具:', exec.name)
  const result = await exec.execute({ command: 'echo "hello from dsh plugin" && pwd', description: "测试 bash 工具" }, {})
  console.log('✅ bash 执行结果:')
  console.log(JSON.stringify(result, null, 2).slice(0, 400))
} catch (e) {
  console.log('❌', e.message.slice(0, 250))
  console.log(e.stack?.split('\n').slice(0, 4).join('\n'))
}

await host.dispose()
process.exit(0)
