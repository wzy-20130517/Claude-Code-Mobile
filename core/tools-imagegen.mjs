// Claude Code Mobile - 生图工具（Agent 侧）
// OpenAI 兼容 POST {baseUrl}/images/generations，返回 b64_json 或 url。
// 配置不硬编码：config.json 的 imageGen 字段（/imagegen 命令管理）：
//   "imageGen": {
//     "url":   "https://ai.furry.vg/v1",      // base（自动拼 /images/generations）或完整端点（以 /images/generations 结尾则直接用）
//     "apiKey": "sk-..." 或 "${ENV_NAME}",
//     "model": "fal-ai/gpt-image-2",
//     "size": "1024x1024",                     // 可选默认尺寸
//     "saveDir": "/sdcard/Download/claude-workspace" // 可选保存目录
//   }
import { Tool } from './tools.mjs'
import { ensureParentDir } from './paths.mjs'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, join, basename } from 'node:path'
import { homedir } from 'node:os'
import { loadEnvFile, resolveEnvString } from './env-secrets.mjs'
import { getWorkspacePath } from './workspace.mjs'

// 【必须锚定到模块自身位置，不能用相对路径】（2026-08-30 定位的真 bug）
// './config.json' 跟着进程 CWD 走：从 ~/claude-code-mobile 启动读写的是项目配置，
// 从别的目录启动就会读写【另一份】config.json——表现为
// 「/imagegen key 明明设置成功了，重启后一查字段没了」。
// 用户的历史 url/model 配置就是这么丢的：当时写进了 CWD 所在目录的那份 config.json，
// 换目录启动后读不到了。import.meta.url 锚定：本文件在 core/ 下，
// ../config.json = 项目根的 config.json，与启动位置无关。
// （注意是 ../ 不是 ../../ —— 前者指项目根，后者会飘到家目录。）
const CONFIG_PATH = new URL('../config.json', import.meta.url).pathname

export function getImageGenConfig() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    const ig = cfg.imageGen || null
    if (!ig) return null
    return {
      url: ig.url || '',
      apiKey: ig.apiKey ? (resolveEnvString(ig.apiKey) ?? '') : '',
      model: ig.model || '',
      size: ig.size || 'auto',
      saveDir: ig.saveDir || getWorkspacePath(),
    }
  } catch { return null }
}

export function setImageGenConfig(patch = {}) {
  let cfg = {}
  try { cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) } catch {}
  if (!cfg.imageGen) cfg.imageGen = {}
  for (const k of ['url', 'apiKey', 'model', 'size', 'saveDir']) {
    if (patch[k] !== undefined) cfg.imageGen[k] = patch[k]
  }
  ensureParentDir(CONFIG_PATH)   // 数据目录可能还不存在
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
  return cfg.imageGen
}

function normalizeBase(url) {
  return String(url || '').replace(/\/+$/, '')
}

/**
 * 从 conf.url 推导目标端点：generations（文生图）或 edits（图生图）。
 *
 * ⚠ 必须补 /v1：绝大多数中转站/OpenAI 兼容网关的图像端点都在 /v1 下
 *   （实测 ai.furry.vg：/images/generations 返回 HTML 错误页，
 *    /v1/images/generations 才正常返回 JSON）。
 *   早期版本直接 base + path，用户填 "https://xxx.com" 就会打到
 *   "https://xxx.com/images/generations" —— 404/HTML，报
 *   "Unexpected token '<'" 这种看不懂的错。
 *
 * 规则（按优先级）：
 *   1. 已含 /images/(generations|edits) → 换掉尾部即可
 *   2. 已含 /v1 → 直接拼
 *   3. 其他 → 补 /v1 再拼
 */
function resolveEndpoint(url, kind) {
  const base = normalizeBase(url)
  const path = kind === 'edits' ? '/images/edits' : '/images/generations'
  // 用户可能把完整端点写进配置：任一形态都换成需要的那个
  if (/\/images\/(generations|edits)\/?$/i.test(base)) {
    return base.replace(/\/images\/(generations|edits)\/?$/i, path)
  }
  // 已带版本段（/v1、/v2 等）直接用
  if (/\/v\d+$/i.test(base)) return base + path
  // 其他情况补 /v1
  return base + '/v1' + path
}

const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
}

/** 读取本地参考图 → Blob（供 multipart 上传）。校验存在、后缀、大小 */
function readRefImage(p, label = 'image') {
  const abs = resolve(String(p || '').replace(/^~(?=\/)/, homedir()))
  if (!existsSync(abs)) throw new Error(`${label} 文件不存在: ${abs}`)
  const ext = (abs.match(/\.[^.\/]+$/) || [''])[0].toLowerCase()
  const mime = IMAGE_MIME[ext]
  if (!mime) throw new Error(`${label} 格式不支持（需 png/jpg/webp/gif）: ${abs}`)
  const buf = readFileSync(abs)
  if (buf.length > 25 * 1024 * 1024) throw new Error(`${label} 超过 25MB 上限: ${(buf.length / 1048576).toFixed(1)}MB`)
  return { blob: new Blob([buf], { type: mime }), name: basename(abs), bytes: buf.length, abs }
}

/** 从响应里提取图片数据（兼容 b64_json / url 两种返回） */
async function extractImage(data) {
  const item = data?.data?.[0]
  if (!item) throw new Error('响应里没有图片数据: ' + JSON.stringify(data).slice(0, 200))
  if (item.b64_json) return Buffer.from(item.b64_json, 'base64')
  if (item.url) {
    // ⚠ 网关可能返回**内网地址**（如 http://127.0.0.1:8000/...）——
    //   那是服务端自己的回环地址，客户端根本访问不到。
    //   早期直接 fetch 会得到一个看不懂的网络错误，排查半天。
    //   现在提前识别并给出可操作的提示。
    const u = String(item.url)
    if (/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|\/)/i.test(u)) {
      throw new Error(
        `网关返回的是内网图片地址（${u.slice(0, 80)}），客户端无法访问。` +
        `请在调用时传 extra:{"response_format":"b64_json"} 让网关直接返回图片数据。`
      )
    }
    const resp = await fetch(u)
    if (!resp.ok) throw new Error(`下载生成图片失败 ${resp.status}: ${u.slice(0, 120)}`)
    const ab = await resp.arrayBuffer()
    return Buffer.from(ab)
  }
  throw new Error('响应既无 b64_json 也无 url: ' + JSON.stringify(item).slice(0, 200))
}

export class ImageGenTool extends Tool {
  constructor(opts = {}) {
    super({
      name: 'ImageGen',
      description: '生图工具（OpenAI images 兼容）。两种模式：①文生图——只给 prompt，走 /images/generations；②图生图——给 image（本地图片路径，可多张）+ prompt，走 /images/edits，按描述改写参考图。用户说「画/生成一张图」用①，说「改这张图/参考这张图/换成…」用②。',
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '图片描述（文生图）或修改要求（图生图），建议英文或中英混合' },
          image: {
            type: ['string', 'array'],
            items: { type: 'string' },
            description: '图生图的参考图本地路径（png/jpg/webp/gif，单张字符串或多张数组，单张 ≤25MB）。给了它就自动走 /images/edits 图生图模式',
          },
          mask: { type: 'string', description: '可选遮罩图路径（png，透明区域=要重绘的部分）。只在图生图时有效，用于局部重绘（inpainting）' },
          size: { type: 'string', description: '尺寸，如 1024x1024、1536x1024、1024x1536、auto。省略则用配置默认' },
          filename: { type: 'string', description: '保存文件名（不含目录），如 cat.png。省略则按时间戳命名' },
          n: { type: 'number', description: '生成几张（1-10），默认 1' },
          style: { type: 'string', enum: ['vivid', 'natural'], description: '风格（仅 dall-e-3）：vivid 鲜艳戏剧化，natural 自然写实' },
          background: { type: 'string', enum: ['transparent', 'opaque', 'auto'], description: '背景透明度（gpt-image 系）' },
          output_format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: '输出格式（gpt-image 系），默认 png' },
          output_compression: { type: 'number', description: '压缩率 0-100（仅 jpeg/webp）' },
          moderation: { type: 'string', enum: ['low', 'auto'], description: '内容审核严格度（gpt-image 系）' },
          partial_images: { type: 'number', description: '流式部分图数量 0-3（gpt-image 流式用）' },
          extra: { type: 'object', description: '其他要透传给 API 的参数（键值对），用于非标参数或新参数兜底' },
        },
        required: ['prompt'],
      },
      maxResultSizeChars: 3000,
      validateInput: (input) => {
        const errors = []
        if (!input.prompt || !String(input.prompt).trim()) errors.push('prompt is required')
        if (input.size && !/^\d{3,4}x\d{3,4}$/.test(input.size) && input.size !== 'auto') errors.push('size 格式应为 宽x高（如 1024x1024）或 auto')
        if (input.image !== undefined) {
          const arr = Array.isArray(input.image) ? input.image : [input.image]
          if (arr.length === 0) errors.push('image 不能是空数组')
          if (arr.length > 16) errors.push('image 最多 16 张')
          for (const p of arr) {
            if (typeof p !== 'string' || !p.trim()) { errors.push('image 每项须为非空路径字符串'); break }
          }
        }
        if (input.mask !== undefined) {
          if (input.image === undefined) errors.push('mask 只能配合 image 使用（图生图模式）')
          if (typeof input.mask !== 'string' || !input.mask.trim()) errors.push('mask 须为非空路径字符串')
        }
        return { valid: errors.length === 0, errors }
      },
    })
    // 生成成功后自动推送前端展示（web 端注入；CLI 未传则无副作用）
    this._onPresent = typeof opts.onPresent === 'function' ? opts.onPresent : null
  }

  async execute(input) {
    const conf = getImageGenConfig()
    if (!conf || !conf.url) {
      return '生图未配置：请先用 /imagegen url <地址> 和 /imagegen key <密钥> 和 /imagegen model <模型> 配置（存 config.json 的 imageGen 字段）'
    }
    if (!conf.apiKey) return '生图 API key 未配置：/imagegen key <密钥>'
    if (!conf.model) return '生图模型未配置：/imagegen model <模型名>'

    // 有 image → 图生图（multipart 传 /images/edits）；否则文生图（JSON 传 /images/generations）
    const isEdit = input.image !== undefined && input.image !== null
    const n = Math.min(10, Math.max(1, Number(input.n) || 1))
    const size = input.size || conf.size
    const optionalKeys = ['quality', 'style', 'background', 'output_format', 'output_compression', 'moderation', 'partial_images']

    // 参考图只读一次，重试时复用 Blob（Blob 可重复读取）
    let refImages = [], refMask = null
    if (isEdit) {
      const paths = Array.isArray(input.image) ? input.image : [input.image]
      refImages = paths.map((p, i) => readRefImage(p, `image[${i}]`))
      if (input.mask) refMask = readRefImage(input.mask, 'mask')
    }

    const body = {
      model: conf.model,
      prompt: String(input.prompt),
      n,
      // ⚠ 默认要 b64_json，不要 URL。
      //   原因：不少网关返回的 URL 是**服务端内网地址**（实测 ai.furry.vg
      //   返回 http://127.0.0.1:8000/v1/media/images/xxx），客户端访问不到，
      //   表现为一个看不懂的网络错误。b64_json 直接把图片数据带回来，最稳。
      //   对不认这个字段的网关无害（多余字段被忽略，仍走 URL 分支）。
      response_format: 'b64_json',
    }
    if (size && size !== 'auto') body.size = size
    // 可选自定义参数：只在用户显式给出时才带上，避免干扰不支持这些字段的网关
    for (const k of optionalKeys) {
      if (input[k] !== undefined && input[k] !== null && input[k] !== '') body[k] = input[k]
    }
    // extra 兜底：任意非标参数直接合并进请求体
    if (input.extra && typeof input.extra === 'object' && !Array.isArray(input.extra)) {
      Object.assign(body, input.extra)
    }

    // 图生图每次重试都要新建 FormData（流式 body 不可复用）
    const buildForm = () => {
      const fd = new FormData()
      fd.append('model', conf.model)
      fd.append('prompt', String(input.prompt))
      fd.append('n', String(n))
      if (size && size !== 'auto') fd.append('size', size)
      for (const k of optionalKeys) {
        if (input[k] !== undefined && input[k] !== null && input[k] !== '') fd.append(k, String(input[k]))
      }
      if (input.extra && typeof input.extra === 'object' && !Array.isArray(input.extra)) {
        for (const [k, v] of Object.entries(input.extra)) fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
      }
      // 单张用 image，多张用 image[]（OpenAI gpt-image 多图编辑约定）
      const field = refImages.length > 1 ? 'image[]' : 'image'
      for (const r of refImages) fd.append(field, r.blob, r.name)
      if (refMask) fd.append('mask', refMask.blob, refMask.name)
      return fd
    }

    // 生图慢，Cloudflare 100s 网关超时（524）是常态：自动重试最多 2 次
    const endpoint = resolveEndpoint(conf.url, isEdit ? 'edits' : 'generations')
    let resp, data
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        resp = await fetch(endpoint, {
          method: 'POST',
          // multipart 的 Content-Type 必须由 fetch 自动带 boundary，不能手写
          headers: isEdit
            ? { 'Authorization': `Bearer ${conf.apiKey}` }
            : { 'Content-Type': 'application/json', 'Authorization': `Bearer ${conf.apiKey}` },
          body: isEdit ? buildForm() : JSON.stringify(body),
        })
      } catch (e) {
        if (attempt === 2) throw new Error(`生图请求失败（网络）: ${e.message} | endpoint=${endpoint}`)
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
        continue
      }
      if (resp.ok) { data = await resp.json(); break }
      const errText = await resp.text().catch(() => '')
      // 524(CF网关超时)/429(限流)/5xx(源站抖动)：重试；4xx 参数错：直接报
      if ((resp.status === 524 || resp.status === 429 || resp.status >= 500) && attempt < 2) {
        await new Promise(r => setTimeout(r, 3000 * (attempt + 1)))
        continue
      }
      throw new Error(`生图 API error ${resp.status}: ${errText.slice(0, 300)}${resp.status === 524 ? '（源站生成超时，已自动重试仍失败，可再试一次）' : ''}`)
    }

    const buf = await extractImage(data)

    // 保存：saveDir/filename 或时间戳
    const dir = conf.saveDir && existsSync(conf.saveDir) ? conf.saveDir : getWorkspacePath()
    try { mkdirSync(dir, { recursive: true }) } catch {}
    const name = (input.filename && /^[\w\u4e00-\u9fa5.\-]+$/.test(input.filename))
      ? input.filename
      : `${isEdit ? 'edit' : 'gen'}-${Date.now()}.png`
    const abs = resolve(join(dir, name))
    writeFileSync(abs, buf)

    // 生成后自动推送展示（web 端注入 onPresent；CLI 未传则跳过）
    try { if (typeof this._onPresent === 'function') this._onPresent({ kind: 'image', paths: [abs] }) } catch {}

    const refInfo = isEdit
      ? `\n参考图: ${refImages.map(r => basename(r.abs)).join(', ')}${refMask ? ` (mask: ${basename(refMask.abs)})` : ''}`
      : ''
    return `已${isEdit ? '改写' : '生成'}图片: ${abs}\n(${(buf.length / 1024).toFixed(1)} KB, prompt: ${String(input.prompt).slice(0, 80)})${refInfo}`
  }
}
