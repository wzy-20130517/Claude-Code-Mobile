// 识图 / 截屏 / 识视频工具：完整视觉分析（当前视觉 Provider → sotamodel claude-opus-5 → 本地 Tesseract OCR）
import { Tool } from './tools.mjs'
import { captureScreen } from './device.mjs'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { isImagePath, isVideoPath, extractVideoFrames, loadImageBlock, MAX_BYTES } from './image.mjs'
import { ocrImage, analyzeImage, availableOcrLangs } from './ocr.mjs'
import { getWorkspacePath } from './workspace.mjs'

const DEFAULT_SHOT_DIR = () => getWorkspacePath()

/**
 * 对图片做完整视觉分析，返回文字、画面描述与路径信息。
 */
let visionApi = null

export function setVisionApi(api) { visionApi = api || null }

// ═══ 识图能力降级（与 tools-phone.mjs 同一套语义）═══
//
// 网关对不支持的模型不报错，而是在正文里塞
//   [Image input omitted: selected model does not support vision.]
// 返回 200。图片被静默丢弃，而工具全程"正常" —— 于是 catch 里的 OCR
// 降级路径永远走不到，用户只看到"模型看不到图"。
// agent 嗅到那句占位文本后会调 markVisionUnavailable()，之后这里直接走 OCR。
let visionKnownUnavailable = false

export function markVisionUnavailable() { visionKnownUnavailable = true }
export function visionUnavailable() { return visionKnownUnavailable }
export function resetVisionUnavailable() { visionKnownUnavailable = false }

/** OCR 转述兜底：先试后端分析（若配了识图 Provider），失败退本地 tesseract。 */
async function ocrDescribe(imagePath, prompt) {
  try {
    const r = await analyzeImage(imagePath, { prompt: prompt || undefined })
    if (r?.text) return r.text
  } catch {}
  try {
    return await ocrImage(imagePath, { langs: availableOcrLangs().join('+') })
  } catch (e) {
    return `（OCR 也失败了：${e.message.slice(0, 120)}）`
  }
}

/** 读取本地图片，以原生多模态直喂主模型（Codex view_image 风格）。 */
export class ViewImageTool extends Tool {
  constructor() {
    super({
      name: 'ViewImage',
      description:
        '读取本地图片（PNG/JPG/WebP/GIF/BMP）并作为图像直接注入对话，主模型亲自看图分析：文字、画面、物体、界面布局、报错等。' +
        '不要用 Read 读取二进制图片。detail 可选 high（默认，长边≤2048px）/ original（原始分辨率，token 消耗大）。',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '图片绝对或相对路径' },
          prompt: { type: 'string', description: '可选：希望重点看什么（会附在图旁）' },
          detail: { type: 'string', enum: ['high', 'original'], description: '图像精度：high=默认缩到2048px省token；original=原图直出（仅大模型/复杂细节时用）' },
        },
        required: ['file_path'],
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      maxResultSizeChars: 4000,
      validateInput: (input) => {
        const errors = []
        if (!input.file_path) errors.push('file_path is required')
        if (input.detail && !['high', 'original'].includes(input.detail)) errors.push("detail 只支持 'high' 或 'original'")
        return { valid: errors.length === 0, errors }
      },
    })
  }

  async execute(input, ctx = {}) {
    const rawPath = String(input.file_path).replace(/^~/, homedir())
    const p = resolve(ctx.cwd || process.cwd(), rawPath)
    if (!existsSync(p)) throw new Error(`图片不存在: ${p}`)
    if (!isImagePath(p)) throw new Error(`不是支持的图片扩展名: ${p}`)
    const st = statSync(p)
    const detail = input.detail === 'original' ? 'original' : 'high'

    // 原生多模态：加载图片块（high 模式缩到 2048px 长边），通过 _vision 旁路直接给主模型看
    try {
      const block = loadImageBlock(p, {
        maxLongEdge: detail === 'original' ? 100000 : 2048,
        maxBytes: detail === 'original' ? 20 * 1024 * 1024 : MAX_BYTES,
      })
      // 只留压缩后仍有价值的存档信息；不复述 prompt——那是调用方自己写的，自己知道
      const header = [
        `path: ${p}`,
        `size: ${(st.size / 1024).toFixed(1)} KB`,
        detail === 'original' ? 'detail: original' : 'detail: high',
      ].filter(Boolean).join('\n')
      // 已知当前模型看不了图 → 直接 OCR，别发出去白跑一轮
      if (visionKnownUnavailable) {
        const text = await ocrDescribe(p, input.prompt)
        return [header, `engine: OCR 转述（当前模型不支持读图，图片未发送）`, '--- 识别结果 ---', text].join('\n')
      }
      // 返回 __type:'vision' → agent 会把 tool_result 存文本摘要，
      // 并把真实图片块作为多模态 user 消息追加——模型直接看到原图
      return {
        __type: 'vision',
        text: header,
        path: p,
        images: [block],
      }
    } catch (e) {
      // 图片无法作为多模态注入（过大/格式问题/vision 被禁）→ 回退 OCR 转述路线
      const langs = availableOcrLangs().join('+')
      let text = ''
      let used = 'tesseract-ocr'
      try {
        const result = await analyzeImage(p, { prompt: input.prompt || undefined })
        text = result.text
        used = result.engine
      } catch {
        text = await ocrImage(p, { langs })
      }
      const lines = [`path: ${p}`, `size: ${(st.size / 1024).toFixed(1)} KB`, `engine: ${used}（图片直传失败已降级转述: ${e.message.slice(0, 80)}）`, '--- 图片分析结果 ---', text || '(未识别到文字)']
      return lines.join('\n')
    }
  }

  async run(input, ctx = {}) {
    const v = this.validateInput(input)
    if (!v.valid) throw new Error(`参数校验失败: ${(v.errors || []).join('; ')}`)
    const perm = await this.checkPermissions(input)
    if (perm.behavior === 'deny') throw new Error(`权限被拒绝: ${perm.message || ''}`)
    return this.execute(perm.updatedInput || input, ctx)
  }
}

/**
 * 识视频工具：ffmpeg 抽关键帧，帧作为原生图片直喂主模型（与 ViewImage 同链路）。
 */
export class ViewVideoTool extends Tool {
  constructor() {
    super({
      name: 'ViewVideo',
      description:
        '读取本地视频并抽取关键帧，帧以**原生多模态直接注入对话**——主模型亲自看画面（人物、物体、动作、字幕、界面）' +
        '（MP4/MOV/WebM/MKV，约 100MB 内）。用户说「看看这个视频」「视频里有什么」时用。max_frames 控制抽帧数（默认 4）。',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '视频文件绝对或相对路径' },
          prompt: { type: 'string', description: '可选：希望重点看什么（分析备忘）' },
          max_frames: { type: 'number', description: '可选：最大抽帧数，默认 4（不超过 6；每帧都是一张图，注意 token 消耗）' },
        },
        required: ['file_path'],
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      maxResultSizeChars: 4000,
      validateInput: (input) => {
        const errors = []
        if (!input.file_path) errors.push('file_path is required')
        return { valid: errors.length === 0, errors }
      },
    })
  }

  async execute(input, ctx = {}) {
    const rawPath = String(input.file_path).replace(/^~/, homedir())
    const p = resolve(ctx.cwd || process.cwd(), rawPath)
    if (!existsSync(p)) throw new Error(`视频不存在: ${p}`)
    if (!isVideoPath(p)) throw new Error(`不是支持的视频扩展名: ${p}`)

    const maxFrames = Math.min(Math.max(Math.floor(input.max_frames || 4), 1), 6)
    const frames = extractVideoFrames(p, { maxFrames })
    if (!frames || frames.length === 0) {
      throw new Error(`视频抽帧失败（可能 ffmpeg 不可用或视频损坏）: ${p}`)
    }

    // 原生多模态：每帧作为 image_url 注入（抽帧时已缩到 1024px，体积可控）
    const images = []
    for (const f of frames) {
      try {
        const block = loadImageBlock(f.path, { maxLongEdge: 1024 })
        images.push(block)
      } catch {}
    }
    if (images.length) {
      const frameList = frames.map((f, i) => `帧${i + 1}: @${f.timestamp.toFixed(1)}s`).join(' | ')
      return {
        __type: 'vision',
        text: `视频共抽 ${images.length} 帧，按时间顺序注入：${frameList}\npath: ${p}`,
        path: p,
        images,
      }
    }

    // 帧全部无法直传 → OCR 兜底
    const langs = availableOcrLangs().join('+')
    const lines = [`视频 ${p}，共抽 ${frames.length} 帧（帧直传失败，已降级 OCR）:`]
    for (let i = 0; i < frames.length; i++) {
      let ocrText = ''
      try {
        ocrText = await ocrImage(frames[i].path, { langs })
      } catch (e) {
        ocrText = `(OCR 失败: ${e.message})`
      }
      lines.push(`\n--- 帧${i + 1} @ ${frames[i].timestamp.toFixed(1)}s (${frames[i].path}) ---`)
      lines.push(ocrText || '(未识别到文字)')
    }
    return lines.join('\n')
  }

  async run(input, ctx = {}) {
    const v = this.validateInput(input)
    if (!v.valid) throw new Error(`参数校验失败: ${(v.errors || []).join('; ')}`)
    const perm = await this.checkPermissions(input)
    if (perm.behavior === 'deny') throw new Error(`权限被拒绝: ${perm.message || ''}`)
    return this.execute(perm.updatedInput || input, ctx)
  }
}

/** 截当前屏幕并交给主模型看（失败降级 OCR） */
export class ScreencapTool extends Tool {
  constructor() {
    super({
      name: 'Screencap',
      description:
        '截取当前手机屏幕并用 OCR 提取屏幕文字。' +
        '用户说「看看我屏幕」「截屏看看」「屏幕上有什么字」时用。' +
        '通道走 /device 配置（Shizuku 优先，不可用则本机 adb）。' +
        '注意：OCR 只输出文字，不含画面布局。',
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '可选：截屏后要分析的重点' },
          save_path: { type: 'string', description: '可选：保存路径，默认 workspace 下自动命名' },
        },
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => false,
      maxResultSizeChars: 4000,
    })
  }

  async execute(input) {
    const dir = DEFAULT_SHOT_DIR()
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch {}
    const savePath = input.save_path
      ? resolve(String(input.save_path).replace(/^~/, homedir()))
      : join(dir, `screen-${Date.now()}.png`)
    if (!/^[\w./\-\u4e00-\u9fa5]+$/.test(savePath)) {
      throw new Error(`save_path 含非法字符（仅允许字母数字中文和 . / - _）: ${savePath}`)
    }
    try { if (!existsSync(dirname(savePath))) mkdirSync(dirname(savePath), { recursive: true }) } catch {}

    // 走 device 通道层：adb 用 exec-out 直取（不落手机盘），shizuku 走 screencap+cat
    const shot = await captureScreen(savePath, 20000)
    if (!shot.ok) throw new Error(`截屏失败（通道 ${shot.channel}）: ${shot.err}`)
    if (!existsSync(savePath) || statSync(savePath).size < 100) {
      throw new Error(`截屏文件无效: ${savePath}`)
    }
    const note = '这是刚截的手机屏幕。'
    // 原生多模态：截图直接给主模型看（与 ViewImage 一致）；失败降级 OCR 转述
    try {
      const block = loadImageBlock(savePath, { maxLongEdge: 2048 })
      return {
        __type: 'vision',
        text: `path: ${savePath}`,
        path: savePath,
        images: [block],
      }
    } catch (e) {
      const langs = availableOcrLangs().join('+')
      let text = ''
      let used = 'tesseract-ocr'
      try {
        const result = await analyzeImage(savePath, { prompt: input.prompt || undefined })
        text = result.text
        used = result.engine
      } catch {
        text = await ocrImage(savePath, { langs })
      }
      return [note, `path: ${savePath}`, `engine: ${used}（截图直传失败已降级: ${e.message.slice(0, 80)}）`, '--- 屏幕文字 ---', text || '(未识别到文字)'].join('\n')
    }
  }

  async run(input, ctx = {}) {
    const v = this.validateInput(input)
    if (!v.valid) throw new Error(`参数校验失败: ${(v.errors || []).join('; ')}`)
    const perm = await this.checkPermissions(input)
    if (perm.behavior === 'deny') throw new Error(`权限被拒绝: ${perm.message || ''}`)
    return this.execute(perm.updatedInput || input, ctx)
  }
}
