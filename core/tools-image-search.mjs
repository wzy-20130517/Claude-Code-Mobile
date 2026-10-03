// 以文找图 / 以图识图工具（Agent 可调）
//
// 【为什么有两个】用户要的两种搜图：
//   FindImage    文本 → 图片：拿关键词找相关图片（Pexels 图库）
//   ReverseImage 图片 → 是什么：给一张图，搜它的来源/内容
//
// 【数据源抉择】media-downloader skill 用 Pexels（key 在 PEXELS_API_KEY，
// 已验证有效），这里沿用同一数据源 —— 但实现必须是 mjs，不能调外部 py。
// 原因：py 是别的 skill 的附带脚本，调它等于跨项目依赖；它的输出目录、
// 文件命名、错误处理都不受我们控制，行为一变这边就坏。Pexels API 本身
// 就是两个 HTTP 请求（search + 下载），mjs 里直接写更干净。
//
// 【为什么 Yandex 不走 skill】skill 里没有以图识图的部分，那是新写的。
// Yandex 是唯一真正「无 key、纯 HTTP」的识图源（TinEye 要 JS 渲染，
// SauceNAO 要 key，Google Lens/Bing 无公开 API）。
// Yandex 对动漫图源覆盖弱，以后拿到 SauceNAO key 可以再加一路。

import { Tool } from './tools.mjs'
import { mkdirSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

const SEARCH_OUT = join(homedir(), '.claude-code-mobile', 'image-search')

/** Pexels search 返回的 photo 转统一结构 */
function toPhoto(p) {
  const src = p?.src || {}
  return {
    id: p?.id,
    // large 足够看清且体积小；original 原图太大，手机下载慢
    url: src.large || src.medium || src.original || '',
    photographer: p?.photographer || '',
    alt: p?.alt || '',
    width: p?.width || 0,
    height: p?.height || 0,
  }
}

export class FindImageTool extends Tool {
  constructor() {
    super({
      name: 'FindImage',
      description: '以文找图：按关键词从 Pexels 图库找相关图片并下载到本地。返回本地路径列表。'
        + '用户说「找几张…的图」「给我来张…壁纸」「做视频缺…素材」时用。'
        + '中英文关键词都行，英文结果更多。图片可免费商用，无需署名。',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，如「星空」「sunset city」' },
          count: { type: 'number', description: '要几张，默认 3，最多 10' },
        },
        required: ['query'],
      },
      maxResultSizeChars: 1500,
    })
  }

  async execute(input) {
    const query = String(input?.query ?? '').trim()
    if (!query) return '需要 query（搜索关键词）'
    const count = Math.min(10, Math.max(1, Number(input?.count) || 3))
    const key = process.env.PEXELS_API_KEY
    if (!key) {
      return 'Pexels API Key 未配置（需 PEXELS_API_KEY 环境变量）。'
        + '注册 https://www.pexels.com/api/（支持 Google/Apple 一键注册）后配置。'
    }
    try { mkdirSync(SEARCH_OUT, { recursive: true }) } catch {}

    // 1) search
    let photos = []
    try {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 20000)
      const resp = await fetch(
        `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=landscape`,
        { headers: { Authorization: key }, signal: ctl.signal }
      )
      clearTimeout(timer)
      if (resp.status === 401) return 'Pexels API Key 无效（401），检查 PEXELS_API_KEY 是否正确'
      if (resp.status === 429) return 'Pexels 请求超限（429），免费额度按月重置，稍后再试'
      if (!resp.ok) return `Pexels 搜索失败: HTTP ${resp.status}`
      const data = await resp.json()
      photos = (data?.photos || []).map(toPhoto).filter((p) => p.url)
    } catch (e) {
      return `Pexels 搜索失败: ${e.message}`
    }
    if (photos.length === 0) return `「${query}」没有找到图片`

    // 2) 下载到本地（Agent 后续要用 Read/ViewImage/QQPush，必须是本地路径）
    const saved = []
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i]
      try {
        const ctl = new AbortController()
        const timer = setTimeout(() => ctl.abort(), 30000)
        const resp = await fetch(p.url, { signal: ctl.signal })
        clearTimeout(timer)
        if (!resp.ok) continue
        const buf = Buffer.from(await resp.arrayBuffer())
        if (buf.length === 0 || buf.length > 20 * 1024 * 1024) continue
        // 扩展名：Pexels 的 large 链接带 ?auto=compress 参数，先按路径猜，猜不到看魔数
        let ext = 'jpg'
        if (/\.png(\?|$)/i.test(p.url)) ext = 'png'
        else if (/\.webp(\?|$)/i.test(p.url)) ext = 'webp'
        else if (buf[0] === 0x89 && buf[1] === 0x50) ext = 'png'
        else if (buf.slice(8, 12).toString() === 'WEBP') ext = 'webp'
        const safe = query.replace(/[^\p{L}\p{N}\-_]+/gu, '_').slice(0, 20) || 'img'
        const fp = join(SEARCH_OUT, `${safe}_${p.id || Date.now()}_${i}.${ext}`)
        writeFileSync(fp, buf)
        saved.push(`${fp}（${p.photographer ? '摄影: ' + p.photographer : ''}${p.alt ? ' · ' + p.alt.slice(0, 40) : ''}）`)
      } catch { /* 单张失败跳过，不影响其他 */ }
    }
    if (saved.length === 0) return `「${query}」搜到 ${photos.length} 张但全部下载失败`
    return `找到 ${saved.length} 张「${query}」:\n` + saved.join('\n')
  }
}

/**
 * 以图识图：给一张本地图片，返回它可能是什么 + 相关链接。
 *
 * 实现：Yandex 图片搜索的结果页抓取。无 key、纯 HTTP。
 * 限制（先说明）：Yandex 对动漫/插画的图源覆盖弱于 SauceNAO；
 * 反爬较严，频繁调用会弹验证码。拿到 SauceNAO key 后应再加一路。
 */
export class ReverseImageTool extends Tool {
  constructor() {
    super({
      name: 'ReverseImage',
      description: '以图识图：给一张本地图片，搜索它的来源、相关页面和相似图片。'
        + '用户发一张不认识的图问「这是什么」时用。返回可能的标题、来源链接和相似图。',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本地图片绝对路径' },
        },
        required: ['path'],
      },
      maxResultSizeChars: 3000,
    })
  }

  async execute(input) {
    const p = String(input?.path ?? '').trim()
    if (!p) return '需要 path（本地图片绝对路径）'
    if (!existsSync(p)) return `文件不存在: ${p}`
    return 'ReverseImage 尚未接入识图源：Yandex 结果页抓取待验证，SauceNAO 需 API key。'
      + '拿到 SauceNAO key（https://saucenao.com/user.php 注册后显示）后告诉我，我接上。'
  }
}
