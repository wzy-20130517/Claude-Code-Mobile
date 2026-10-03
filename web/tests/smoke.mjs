// Web 端 smoke test（不起服务，纯静态检查）
//
// 为什么需要它：
//   2026-08-28 发现 web 把 TaskCreate/TaskList 等协作工具全塞进 INTERNAL_TOOLS
//   黑名单隐藏了 —— 那份名单是照抄官方的，但官方 Task 是 subagent 内部管道，
//   我们的 Task 是用户要看的显式协作待办。这类「照抄导致语义错位」的问题
//   不会让构建失败，只能靠断言兜住。
//
// 原 package.json 的 test:web 指向 web/tests/render-smoke.mjs，那文件已不存在，
// 跑起来直接 MODULE_NOT_FOUND。这里重建。

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(webRoot, rel), 'utf-8')

let passed = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`)
    process.exitCode = 1
  }
}

console.log('web smoke test')

check('server.mjs 暴露关键端点', () => {
  const src = read('server.mjs')
  for (const ep of ['/api/health', '/api/sessions', '/api/config', '/api/skills']) {
    assert.ok(src.includes(`'${ep}'`), `缺少端点 ${ep}`)
  }
})

check('构建产物存在且含入口脚本', () => {
  assert.ok(existsSync(join(webRoot, 'dist')), 'web/dist 不存在，需要先 vite build')
  const html = read('dist/index.html')
  assert.ok(/<script[^>]+src=/.test(html), 'dist/index.html 没有引用打包脚本')
  const assets = readdirSync(join(webRoot, 'dist', 'assets'))
  assert.ok(assets.some(f => f.endsWith('.js')), 'dist/assets 里没有 js 产物')
})

check('协作工具没有被 INTERNAL_TOOLS 隐藏', () => {
  const src = read('src/components/MainContent.tsx')
  const collab = [
    'TaskCreate', 'TaskList', 'TaskGet', 'TaskUpdate', 'TaskClaim', 'TaskDelete',
    'TeamCreate', 'TeamJoin', 'SendMessage', 'CheckMessages', 'TeamStatus',
  ]
  for (const m of src.matchAll(/INTERNAL_TOOLS\s*=\s*new Set(?:<string>)?\(\[([^\]]*)\]\)/g)) {
    for (const tool of collab) {
      assert.ok(
        !new RegExp(`['"]${tool}['"]`).test(m[1]),
        `${tool} 被塞进 INTERNAL_TOOLS —— 协作过程会在 web 上变黑箱`
      )
    }
  }
})

check('协作工具都有中文显示标签', () => {
  const src = read('src/components/toolThinkingFallback.js')
  const required = [
    'TaskCreate', 'TaskList', 'TaskGet', 'TaskUpdate', 'TaskClaim', 'TaskDelete',
    'TeamCreate', 'TeamJoin', 'SendMessage', 'CheckMessages', 'TeamStatus',
    'TeamLeave', 'TeamDisband',
  ]
  const missing = required.filter(t => !new RegExp(`\\b${t}\\s*:`).test(src))
  assert.strictEqual(missing.length, 0, `缺少标签: ${missing.join(', ')}（web 上会显示裸英文工具名）`)
})

check('vite 配置与 package.json 脚本对齐', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.ok(pkg.scripts?.build?.includes('vite'), 'web/package.json 缺少 vite build')
  assert.ok(existsSync(join(webRoot, 'vite.config.ts')), 'vite.config.ts 不存在')
})

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败项' : ''}`)
