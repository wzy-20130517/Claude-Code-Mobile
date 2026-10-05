// Claude Code Mobile - Hashline 锚点系统
// 基于 Grok Build 的 hashline 设计：用行内容哈希做锚点，编辑时验证行未被改动
// ContentOnly 方案：anchor = 行号:local（3个小写字母 FNV-1a 哈希）

// FNV-1a 32-bit 常量
const FNV_OFFSET = 0x811c9dc5 >>> 0  // 2166136261
const FNV_PRIME = 0x01000193 >>> 0    // 16777619

// FNV-1a 32-bit 哈希
function fnv1a32(data) {
  let h = FNV_OFFSET
  for (let i = 0; i < data.length; i++) {
    h ^= data[i]
    h = Math.imul(h, FNV_PRIME) >>> 0
  }
  return h >>> 0
}

// 空白归一化的行哈希：trim + 内部空白折叠为单个空格
function lineHash(line) {
  const trimmed = line.trim()
  let h = FNV_OFFSET
  let prevWs = false
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i)
    if (code === 9 || code === 11 || code === 12 || code === 32 || code === 13) {
      // 空白字符
      if (!prevWs) {
        h ^= 0x20 // space
        h = Math.imul(h, FNV_PRIME) >>> 0
        prevWs = true
      }
    } else {
      h ^= code
      h = Math.imul(h, FNV_PRIME) >>> 0
      prevWs = false
    }
  }
  return h >>> 0
}

// 将 u32 哈希编码为 n 个小写字母（a-z）
// len=5：26^5≈1188万空间（原 3 字母仅 1.7万，大文件里不同行 anchor 易碰撞→改错行）
// 用除余而非移位取字节，让 32bit 熵更均匀铺到 5 位
function encodeHash(hash, len = 5) {
  let result = ''
  let h = hash >>> 0
  for (let i = 0; i < len; i++) {
    result += String.fromCharCode((h % 26) + 0x61) // 'a' = 0x61
    h = Math.floor(h / 26)
  }
  return result
}

// 生成 anchor：返回 "行号:local" 格式
function generateAnchor(line, lineNum) {
  const h = lineHash(line)
  return `${lineNum}:${encodeHash(h)}`
}

// 批量生成 anchors
function generateAnchors(lines) {
  return lines.map((line, i) => generateAnchor(line, i + 1))
}

// 解析 anchor 字符串 → { line, local } 或 null
function parseAnchor(str) {
  if (typeof str !== 'string') return null  // 上游可能传 undefined（如 edit.anchor 缺失）
  const parts = str.split(':')
  if (parts.length < 2) return null
  const line = parseInt(parts[0], 10)
  if (isNaN(line) || line === 0) return null
  const local = parts[1]
  if (!local || !/^[a-z]+$/.test(local)) return null
  return { line, local }
}

// 验证 anchor 是否匹配当前行内容
// 返回: 'valid' | 'stale' | 'out_of_range'
function validateAnchor(anchor, lines) {
  const idx = anchor.line - 1
  if (idx < 0 || idx >= lines.length) return 'out_of_range'
  const expected = encodeHash(lineHash(lines[idx]))
  return anchor.local === expected ? 'valid' : 'stale'
}

// 搜索偏移的 anchor：在原位置 ±radius 范围内查找匹配行
// 返回: { found: lineNum } | { ambiguous: [lineNum, ...] } | { notFound: true }
function findShifted(anchor, lines, searchRadius = 15) {
  const origIdx = anchor.line - 1
  const start = Math.max(0, origIdx - searchRadius)
  const end = Math.min(lines.length, origIdx + searchRadius + 1)
  const candidates = []

  for (let idx = start; idx < end; idx++) {
    if (idx === origIdx) continue // 跳过原位置（已验证失败）
    const local = encodeHash(lineHash(lines[idx]))
    if (local !== anchor.local) continue
    candidates.push(idx + 1)
  }

  if (candidates.length === 0) return { notFound: true }
  if (candidates.length === 1) return { found: candidates[0] }
  return { ambiguous: candidates }
}

// 格式化文件内容为 hashline 格式：每行 "行号:local→内容"
function formatHashlineContent(content, offset, limit) {
  const allLines = content.split('\n')
  // 如果文件以 \n 结尾，split 会产生一个空末尾元素，去掉它
  if (allLines.length > 1 && allLines[allLines.length - 1] === '') {
    allLines.pop()
  }

  const skip = Math.max(0, (offset || 1) - 1)  // 防 offset<=0 时 skip 变负导致越界访问 undefined
  const take = limit || allLines.length

  const lines = []
  for (let i = skip; i < Math.min(skip + take, allLines.length); i++) {
    const lineNum = i + 1
    const anchor = generateAnchor(allLines[i], lineNum)
    lines.push(`${anchor}→${allLines[i]}`)
  }
  return lines.join('\n')
}

export {
  fnv1a32,
  lineHash,
  encodeHash,
  generateAnchor,
  generateAnchors,
  parseAnchor,
  validateAnchor,
  findShifted,
  formatHashlineContent,
}
