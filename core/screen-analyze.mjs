#!/usr/bin/env node
// 屏幕调试助手：截屏 → 智谱 glm-4v-flash 免费视觉模型分析
// 用法: node ~/claude-code-mobile/core/screen-analyze.mjs [描述重点]
// 依赖: shell 通道（Shizuku 或本机 adb，见 core/device.mjs）+ z.ai key（免费视觉 glm-4v-flash）
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { captureScreen } from './device.mjs'
const KEY = process.env.ZAI_KEY || '7200c8277a544220b08061702e72be3d.NfRVrohRSeBtc7Tk'
const BASE = 'https://open.bigmodel.cn/api/paas/v4'
const MODEL = 'glm-4v-flash'  // 免费视觉模型
const SHOT_DIR = join(homedir(), '.claude-code-mobile', 'screen-shots')

async function capture(savePath) {
  try { if (!existsSync(dirname(savePath))) mkdirSync(dirname(savePath), { recursive: true }) } catch {}
  const shot = await captureScreen(savePath, 20000)
  if (!shot.ok) throw new Error(`截屏失败（通道 ${shot.channel}）: ${shot.err}`)
  if (!existsSync(savePath) || statSync(savePath).size < 100) throw new Error(`截屏文件无效: ${savePath}`)
}

async function analyze(imgPath, prompt) {
  const b64 = readFileSync(imgPath).toString('base64')
  const ext = imgPath.toLowerCase().endsWith('.jpg') || imgPath.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png'
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${ext};base64,${b64}` } },
        { type: 'text', text: prompt || '描述这张屏幕截图的内容' },
      ] }],
      max_tokens: 800,
    }),
  })
  const t = await r.text()
  if (!r.ok) throw new Error(`API ${r.status}: ${t.slice(0, 300)}`)
  const j = JSON.parse(t)
  return j.choices?.[0]?.message?.content || '(空)'
}

// 支持两种模式：截屏分析（默认）或分析已有图片（传路径）
const arg = process.argv[2] || ''
const prompt = process.argv[3] || '详细描述这张屏幕截图：1) 屏幕上有几行文字？2) 有没有文字重叠/叠加/错位的现象？3) 如果有重叠，具体在哪一行、哪个位置、哪些字符叠在一起？4) 光标（如果有）在哪？尽量精确描述坐标位置。'

try {
  let target
  if (arg.endsWith('.png') || arg.endsWith('.jpg') || arg.endsWith('.jpeg')) {
    target = arg  // 分析已有图片
    if (!existsSync(target)) throw new Error(`文件不存在: ${target}`)
  } else {
    target = join(SHOT_DIR, `shot-${Date.now()}.png`)
    await capture(target)
  }
  console.log(`[图片] ${target}`)
  const result = await analyze(target, prompt)
  console.log(`[glm-4v-flash 分析]\n${result}`)
} catch (e) {
  console.error(`[错误] ${e.message}`)
  process.exit(1)
}
