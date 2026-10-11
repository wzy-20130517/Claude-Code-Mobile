#!/usr/bin/env node
// CI 预检 —— 复用 core/infra/restart-preflight.mjs 的检查能力。
//
// 【为什么单独写一个入口，而不是直接 node -e 调】
// preflight 有 stamp 缓存机制（`~/.claude-code-mobile/preflight-ok.json`）：
// 文件哈希全没变时直接放行（~20ms），部分变更时只检查变更文件。
// 那是给「重启前快速自检」用的加速，**CI 里不需要** —— CI 要的是每次全量。
//
// 所以这里先删 stamp 再跑：stamp 不存在 → canFastPass 返回 false →
// 走全量检查。保证 CI 结果不受本机历史状态影响。
//
// 【检查什么】
// 1. 语法（node --check 等价）
// 2. 运行期未声明变量（防 "node --check 查不出的 ReferenceError"）
// 3. ESM import/export 链接（防 named export 不存在）
//
// 【退出码】0 = 通过，1 = 有失败（CI 据此判红）

import { rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runRestartPreflight, formatRestartPreflightFailure } from '../core/infra/restart-preflight.mjs'
import { DATA_DIR } from '../core/infra/paths.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

// 删 stamp 保证全量（文件名与 restart-preflight.mjs:71 的 STAMP_FILE 一致）
try {
  rmSync(join(DATA_DIR, 'preflight-ok.json'), { force: true })
} catch {}

const result = await runRestartPreflight(ROOT)

if (result.ok) {
  const mode = result.cached ? '（缓存命中，未实际检查）' : ''
  console.log(`✓ 预检通过：检查 ${result.checked} 个 .mjs${mode}`)
  process.exit(0)
} else {
  console.error(formatRestartPreflightFailure(result))
  process.exit(1)
}
