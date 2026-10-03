#!/usr/bin/env node
/**
 * 内核包一致性检查。
 *
 * 【为什么需要】ccm-node-pkg（APK 内核包）和 claude-code-mobile（源码仓库）
 * 有两份相同的 core/ + web/。改了一边忘了同步另一边，就会出现
 * 「改了但没生效」—— 我这轮踩了两次（getCachePolicy、mcp-client），
 * 每次都是白测一轮才发现。
 *
 * 用法：node tools/check-sync.mjs
 * 退出码：0 = 一致，1 = 有差异
 */
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'

const A = '/data/data/com.termux/files/home/claude-code-mobile'
const B = '/data/data/com.termux/files/home/ccm-node-pkg'

// 内核包独有的文件（不需要同步）
const PKG_ONLY = new Set([
  'ccm-adapters.mjs', 'ccm-bridge.mjs', 'ccm-env.mjs', 'ccm-start.mjs', 'ccm-tools.mjs',
])
// 源码仓库独有的
const SRC_ONLY = new Set(['index.mjs', 'package.json'])

function listMjs(root) {
  try {
    return execSync(`find ${root}/core ${root}/web -name '*.mjs' -not -path '*/node_modules/*' 2>/dev/null`, { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).map(p => p.replace(root + '/', ''))
  } catch { return [] }
}

const filesA = listMjs(A)
const filesB = listMjs(B)
const all = [...new Set([...filesA, ...filesB])].sort()

const hash = (p) => {
  try { return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12) }
  catch { return null }
}

const diffs = []
const missing = []
for (const f of all) {
  const pa = `${A}/${f}`, pb = `${B}/${f}`
  const ha = hash(pa), hb = hash(pb)
  if (ha === null && hb === null) continue
  if (ha === null) { missing.push(`  仅内核包有: ${f}`); continue }
  if (hb === null) { missing.push(`  仅源码库有: ${f}`); continue }
  if (ha !== hb) diffs.push(`  ${f}  (源码 ${ha} / 内核 ${hb})`)
}

console.log(`检查 ${all.length} 个文件`)
if (missing.length) { console.log('\n文件存在性差异:'); missing.forEach(m => console.log(m)) }
if (diffs.length) {
  console.log(`\n内容不一致 ${diffs.length} 个:`)
  diffs.forEach(d => console.log(d))
  console.log('\n⚠️  同步命令：cp <源> <目标>（注意方向）')
  process.exit(1)
}
if (!missing.length) console.log('✅ 全部一致')
