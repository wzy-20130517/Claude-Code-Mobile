// 图片分析：优先当前 Provider（仅在 vision=true 时），再用配置中的 sotamodel claude-opus-5，
// 最后才降级本地 tesseract OCR。验证码仍走 ddddocr，不经过这里。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { ApiClient } from '../api/api.mjs'

const TESSERACT_BIN = '/data/data/com.termux/files/usr/bin/tesseract'
const TESSDATA_DIR = '/data/data/com.termux/files/usr/share/tessdata'
const VISION_TIMEOUT = 60000

let activeVisionConfig = null
let fallbackVisionProvider = null
let fallbackVisionApi = null

function imageMime(filePath) {
  if (/\.png$/i.test(filePath)) return 'image/png'
  if (/\.webp$/i.test(filePath)) return 'image/webp'
  if (/\.gif$/i.test(filePath)) return 'image/gif'
  if (/\.bmp$/i.test(filePath)) return 'image/bmp'
  return 'image/jpeg'
}

function imagePrompt(prompt) {
  return prompt || '请完整分析这张图片：先描述画面、界面布局、人物/物体和状态；再准确抄录所有可见文字。若是截图，说明它是什么界面、有哪些关键控件或报错。不要只做 OCR。'
}

/** 设置当前 Provider 的视觉能力配置；vision=true 时优先走当前模型。 */
export function setVisionConfig(config = null, api = null, fallbackProvider = undefined) {
  activeVisionConfig = config && typeof config === 'object' ? { ...config, api: api || null } : null
  // fallbackProvider 未传时保留当前备用配置，避免普通 Provider 切换把它清空。
  if (fallbackProvider !== undefined) setVisionFallbackConfig(fallbackProvider)
}

/**
 * 设置备用视觉 Provider。
 * 由 CLI/Web 各自把配置 6（sotamodel claude-opus-5）传入；这里绝不硬编码 URL 或 Key，
 * 因此 Web/CLI 配置隔离仍然成立，也不会把密钥写进源码。
 */
export function setVisionFallbackConfig(provider = null) {
  fallbackVisionProvider = provider && typeof provider === 'object' ? { ...provider } : null
  fallbackVisionApi = null
  if (!fallbackVisionProvider?.url || !(fallbackVisionProvider.apiKey || fallbackVisionProvider.apiKeys?.length)) return
  try {
    fallbackVisionApi = new ApiClient({
      baseUrl: fallbackVisionProvider.url,
      apiKey: fallbackVisionProvider.apiKey,
      apiKeys: fallbackVisionProvider.apiKeys,
      model: fallbackVisionProvider.model || 'claude-opus-5',
      protocol: fallbackVisionProvider.protocol || 'openai',
      temperature: Number(fallbackVisionProvider.temperature) || 1,
      maxOutputTokens: fallbackVisionProvider.maxOutputTokens || null,
      systemTopLevel: !!fallbackVisionProvider.systemTopLevel,
      noTools: true,
      timeout: VISION_TIMEOUT,
    })
  } catch {
    fallbackVisionApi = null
  }
}

function currentVisionSupported() {
  return activeVisionConfig?.vision === true
}

/** 当前 Provider 是否开启了视觉（/config vision on）。/image 原图直入的判据。 */
export function visionEnabled() {
  return currentVisionSupported()
}

/** 检测 tesseract 是否可用 */
export function tesseractAvailable() {
  return existsSync(TESSERACT_BIN)
}

async function analyzeWithApi(api, filePath, prompt) {
  if (!api?.createMessage) throw new Error('视觉 Provider 未配置')
  const b64 = readFileSync(filePath).toString('base64')
  const response = await api.createMessage({
    system: '',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: imagePrompt(prompt) },
        { type: 'image_url', image_url: { url: `data:${imageMime(filePath)};base64,${b64}` } },
      ],
    }],
    tools: [],
    maxTokens: 1200,
  })
  const text = response?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || !text.trim()) throw new Error('视觉模型返回空内容')
  return text.trim()
}

/**
 * 完整图片分析，附带实际使用的引擎。
 * @returns {Promise<{text:string, engine:string, fallbackUsed:boolean}>}
 */
export async function analyzeImage(filePath, opts = {}) {
  const p = String(filePath).replace(/^~/, homedir())
  if (!existsSync(p)) throw new Error(`文件不存在: ${p}`)
  const prompt = opts.prompt

  // 1) 当前 Provider 仅在用户明确开启视觉能力时使用
  if (currentVisionSupported()) {
    try {
      const api = opts.visionApi || activeVisionConfig?.api
      const text = await analyzeWithApi(api, p, prompt)
      return { text, engine: `current-provider:${activeVisionConfig?.model || 'vision'}`, fallbackUsed: false }
    } catch {
      // 当前模型实际不支持视觉、额度不足或网络失败时，继续备用 sotamodel。
    }
  }

  // 2) 专用备用：sotamodel 配置 6 的 claude-opus-5
  try {
    const text = await analyzeWithApi(fallbackVisionApi, p, prompt)
    return { text, engine: `sotamodel:${fallbackVisionProvider?.model || 'claude-opus-5'}`, fallbackUsed: true }
  } catch {
    // 继续本地 OCR
  }

  // 3) 最后才是纯文字 OCR
  if (!tesseractAvailable()) throw new Error('视觉备用模型不可用，且 tesseract 未安装；请运行: pkg install tesseract')
  const text = await ocrImage(p, opts)
  return { text: text || '(OCR 未识别到文字)', engine: 'tesseract-ocr', fallbackUsed: true }
}

/** 兼容旧调用方：只返回分析文字。新调用方应使用 analyzeImage() 取得 engine。 */
export async function ocrFile(filePath, opts = {}) {
  return (await analyzeImage(filePath, opts)).text
}

/**
 * 检测可用语言：chi_sim / eng / 其他。
 */
export function availableOcrLangs() {
  try {
    if (existsSync(TESSDATA_DIR)) {
      const langs = readdirSync(TESSDATA_DIR)
        .filter(f => f.endsWith('.traineddata'))
        .map(f => f.replace(/\.traineddata$/, ''))
        .filter(l => l !== 'osd')
      if (langs.includes('chi_sim')) return ['chi_sim', ...langs.filter(l => l !== 'chi_sim' && l !== 'eng'), 'eng']
      if (langs.length) return langs
    }
    return ['eng']
  } catch { return ['eng'] }
}

/** 纯本地 Tesseract OCR（只识别文字，不做画面理解）。 */
export function ocrImage(filePath, opts = {}) {
  const langsRaw = opts.langs || availableOcrLangs()
  const langs = Array.isArray(langsRaw) ? langsRaw.join('+') : String(langsRaw)
  const psm = opts.psm != null ? opts.psm : 3
  const args = [filePath, 'stdout', '-l', langs, '--psm', String(psm)]
  const env = { ...process.env, TESSDATA_PREFIX: TESSDATA_DIR, PATH: process.env.PATH || '/data/data/com.termux/files/usr/bin' }
  return new Promise((resolve, reject) => {
    execFile(TESSERACT_BIN, args, { env, timeout: 60000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`OCR 失败: ${(stderr && stderr.toString()) || err.message}`))
      resolve((stdout || '').toString().trim())
    })
  })
}
