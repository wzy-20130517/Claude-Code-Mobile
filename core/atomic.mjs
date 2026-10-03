// Claude Code Mobile - 原子写入
// 写临时文件 + rename 替换，避免进程被杀/断电时留下半写损坏的文件。
// rename 在同一文件系统上是原子操作：要么旧内容完整，要么新内容完整，不会出现半份。
import { writeFileSync, renameSync, unlinkSync } from 'node:fs'

/**
 * 原子写入文件。写到 <path>.tmp-<随机> 再 rename 到目标。
 * 失败时清理临时文件并抛错（保持原文件不变）。
 * @param {string} path 目标路径
 * @param {string|Buffer} data 内容
 * @param {string} encoding 默认 utf-8
 */
export function atomicWrite(path, data, encoding = 'utf-8') {
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
  try {
    writeFileSync(tmp, data, encoding)
    renameSync(tmp, path)
  } catch (e) {
    try { unlinkSync(tmp) } catch {}
    throw e
  }
}
