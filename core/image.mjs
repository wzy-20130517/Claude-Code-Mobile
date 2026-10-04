// 图片 → OpenAI 兼容 vision 内容块（data URL）
import { existsSync, readFileSync, statSync, mkdirSync, readdirSync } from 'node:fs'
import { extname, resolve, join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

export const MAX_BYTES = 4 * 1024 * 1024 // 单张 4MB（base64 后约 5.3MB）
const MAX_VIDEO_BYTES = 100 * 1024 * 1024 // 视频 100MB
// vision 模型对「解码后像素总数」有上限，长边过大即使文件不大也会被拒。
// 长边缩到 1568px 内，是多数模型的安全区。
const MAX_LONG_EDGE = 1568
const ALLOWED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const VIDEO_ALLOWED = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi'])

// ImageMagick 命令探测（缓存结果）
let _imCmd // undefined=未探测, null=不可用, string=可用命令名
function detectImageMagick() {
  if (_imCmd !== undefined) return _imCmd
  for (const cmd of ['magick', 'convert']) {
    try {
      execFileSync(cmd, ['-version'], { stdio: 'ignore', timeout: 5000 })
      _imCmd = cmd
      return _imCmd
    } catch {}
  }
  _imCmd = null
  return _imCmd
}

/** 用 identify 读图片尺寸，返回 { w, h } 或 null */
function getImageSize(abs) {
  const im = detectImageMagick()
  if (!im) return null
  // magick 用子命令 identify，convert 时代用独立 identify
  const args = im === 'magick'
    ? ['identify', '-format', '%w %h', abs + '[0]']
    : ['-format', '%w %h', abs + '[0]']
  const bin = im === 'magick' ? 'magick' : 'identify'
  try {
    const out = execFileSync(bin, args, { timeout: 8000 }).toString().trim()
    const m = out.match(/(\d+)\s+(\d+)/)
    if (!m) return null
    return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) }
  } catch {
    return null
  }
}

/**
 * 若图片长边超过 maxLongEdge，等比缩到临时文件并返回新路径。
 * 无需缩放或无 ImageMagick 时返回原路径。
 */
function maybeDownscale(abs, { maxLongEdge = MAX_LONG_EDGE } = {}) {
  const im = detectImageMagick()
  if (!im) return abs
  const size = getImageSize(abs)
  if (!size) return abs
  const longEdge = Math.max(size.w, size.h)
  if (longEdge <= maxLongEdge) return abs
  const ext = extname(abs).toLowerCase()
  const outExt = ext === '.png' ? '.png' : '.jpg'
  const outPath = join(tmpdir(), `vshrink-${Date.now()}-${basename(abs, ext)}${outExt}`)
  const resize = `${maxLongEdge}x${maxLongEdge}>`
  const bin = im === 'magick' ? 'magick' : 'convert'
  const args = im === 'magick'
    ? [abs + '[0]', '-resize', resize, ...(outExt === '.jpg' ? ['-quality', '88'] : []), outPath]
    : [abs + '[0]', '-resize', resize, ...(outExt === '.jpg' ? ['-quality', '88'] : []), outPath]
  try {
    execFileSync(bin, args, { timeout: 20000 })
    if (existsSync(outPath) && statSync(outPath).size > 100) return outPath
  } catch {}
  return abs
}

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

export function isImagePath(p) {
  if (!p || typeof p !== 'string') return false
  return ALLOWED.has(extname(p).toLowerCase())
}

/**
 * 扫描常见媒体目录，返回按修改时间倒序的图片文件列表。
 * 用途：/image 无参数发最新图、/image 3 发最近第 3 张、/image list 看列表。
 * 目录覆盖：截图（DCIM/Pictures 两处）、QQ 接收图、Download、微信图片。
 * 不存在的目录静默跳过；单目录读失败不阻塞其余目录。
 */
const RECENT_DIRS = [
  '/sdcard/DCIM/Screenshots',
  '/sdcard/Pictures/Screenshots',
  '/sdcard/Pictures/QQ',
  '/sdcard/Download',
  '/sdcard/Pictures/Weixin',
  // 小米「贴贴」的保存目录：不加的话从贴贴保存的图 /image 找不到，
  // 它按 mtime 挑的是 QQ 目录里的旧副本（用户实测踩过）
  '/sdcard/DCIM/taplus/taplus_image',
  '/sdcard/DCIM/taplus',
]

export function recentImages(limit = 10, dirs = RECENT_DIRS) {
  const out = []
  for (const dir of dirs) {
    let entries
    try { entries = readdirSync(dir) } catch { continue }
    for (const f of entries) {
      if (!isImagePath(f)) continue
      const full = join(dir, f)
      try {
        const st = statSync(full)
        if (!st.isFile()) continue
        out.push({ path: full, mtime: st.mtimeMs, size: st.size })
      } catch { continue }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out.slice(0, limit)
}

/** 最新一张图；没有则 null */
export function findLatestImage() {
  const list = recentImages(1)
  return list[0]?.path ?? null
}

/**
 * 宽松解析用户手打的图片路径。
 * 中文输入场景常出现两种不完整写法（2026-09-10 实测）：
 *   1.「内部存储/Pictures/QQ/x.png」——「内部存储」是 Android 文件管理器里的显示名，
 *      实际路径是 /storage/emulated/0/（= /sdcard）
 *   2.「有的在内部存储/...」中文前缀剥离后剩下的「/Pictures/QQ/x.png」——
 *      用户把根目录省略了，只知道「在 Pictures 下面」
 * 按常见媒体目录（Pictures/DCIM/Download/Movies/Tencent）逐个映射到 /sdcard，
 * 都对不上再回退 resolve()（保持旧行为：拼当前目录）。
 * 找不到的文件不会在这里报错——调用方（loadImageBlock）会给出明确的不存在提示。
 */
const LOOSE_ROOT_ALIASES = [
  { re: /^\/?(?:内部)?存储(?:卡)?\//, to: '/storage/emulated/0/' },
  { re: /^\/?(Pictures|DCIM|Download|Movies|Tencent|Telegram|MIUI)\//, to: '/sdcard/$1/' },
]

export function resolveImagePath(p) {
  if (!p) return p
  let candidate = p.replace(/^~/, process.env.HOME || '')
  // 绝对路径或 ~/ 开头：先试别名映射（「/Pictures/...」补 /sdcard 前缀）
  if (candidate.startsWith('/')) {
    for (const a of LOOSE_ROOT_ALIASES) {
      if (a.re.test(candidate)) {
        const mapped = candidate.replace(a.re, a.to)
        if (existsSync(mapped)) return mapped
      }
    }
    return candidate
  }
  return resolve(candidate)
}

/** 检查路径是否为支持的视频格式 */
export function isVideoPath(p) {
  if (!p || typeof p !== 'string') return false
  return VIDEO_ALLOWED.has(extname(p).toLowerCase())
}

/**
 * ffmpeg 探测（缓存）
 */
let _ffCmd
export function detectFFmpeg() {
  if (_ffCmd !== undefined) return _ffCmd
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 })
    _ffCmd = 'ffmpeg'
    return _ffCmd
  } catch {}
  _ffCmd = null
  return _ffCmd
}

/**
 * 用 ffprobe 获取视频时长（秒），失败返回 null
 */
function getVideoDuration(abs) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      abs
    ], { timeout: 10000 }).toString().trim()
    return parseFloat(out)
  } catch {
    return null
  }
}

/**
 * 从视频抽取关键帧为 PNG 图片
 * @param {string} filePath - 视频路径
 * @param {object} opts
 * @param {number} opts.maxFrames - 最大帧数，默认 6（不超过 10）
 * @param {number} opts.maxLongEdge - 每帧长边上限，默认 1024（视频帧比图片小，避免上下文爆炸）
 * @returns {Array<{path: string, timestamp: number}>} 抽取的帧列表
 */
export function extractVideoFrames(filePath, { maxFrames = 6, maxLongEdge = 1024 } = {}) {
  const abs = resolve(filePath)
  if (!existsSync(abs)) throw new Error(`视频不存在: ${abs}`)
  const ff = detectFFmpeg()
  if (!ff) throw new Error('ffmpeg 不可用，无法抽帧')

  const st = statSync(abs)
  if (st.size > MAX_VIDEO_BYTES) {
    throw new Error(`视频过大 ${Math.round(st.size / 1048576)}MB，上限 ${Math.round(MAX_VIDEO_BYTES / 1048576)}MB`)
  }

  const dur = getVideoDuration(abs) || 10
  const count = Math.min(Math.max(Math.floor(maxFrames), 1), 10)

  // 均匀分布时间点：跳过开头 0.5s 和结尾 0.5s，中间均匀取 count 个点
  const start = 0.5
  const end = Math.max(start + 0.1, dur - 0.5)
  const step = (end - start) / (count > 1 ? count - 1 : 1)

  const tmpDir = join(tmpdir(), `vframes-${Date.now()}`)
  try { mkdirSync(tmpDir, { recursive: true }) } catch {}

  const frames = []
  for (let i = 0; i < count; i++) {
    const ts = count === 1 ? (start + end) / 2 : start + step * i
    const framePath = join(tmpDir, `frame_${i.toString().padStart(2, '0')}.jpg`)
    // 抽帧：缩放到 maxLongEdge 内，JPEG quality 85
    const vf = `scale='min(${maxLongEdge},iw)':'min(${maxLongEdge},ih)':force_original_aspect_ratio=decrease`
    try {
      execFileSync('ffmpeg', [
        '-y', '-v', 'error',
        '-ss', ts.toFixed(2),
        '-i', abs,
        '-frames:v', '1',
        '-vf', vf,
        '-q:v', '3',
        framePath
      ], { timeout: 15000 })
      if (existsSync(framePath) && statSync(framePath).size > 100) {
        frames.push({ path: framePath, timestamp: ts })
      }
    } catch {}
  }

  if (frames.length === 0) throw new Error('抽帧全部失败（视频可能损坏或 ffmpeg 解码失败）')
  return frames
}

/**
 * 读本地图片 → { type:'image_url', image_url:{ url: data:... }, _resized?:{from,to} }
 * 失败抛 Error（中文消息）
 * 若发生缩放，_resized 记录原始与缩后尺寸——调用方可注入 resize notice 告知模型
 */
export function loadImageBlock(filePath, { maxBytes = MAX_BYTES, maxLongEdge = MAX_LONG_EDGE } = {}) {
  const abs = resolve(filePath)
  if (!existsSync(abs)) throw new Error(`图片不存在: ${abs}`)
  const st = statSync(abs)
  if (!st.isFile()) throw new Error(`不是文件: ${abs}`)
  const ext = extname(abs).toLowerCase()
  if (!ALLOWED.has(ext)) throw new Error(`不支持的格式 ${ext}（支持 png/jpg/gif/webp/bmp）`)

  // 记录缩放前的尺寸（有 ImageMagick 才能探测；探测不到就不标）
  const before = getImageSize(abs)
  const resized = longEdgeBefore(before, maxLongEdge)

  // 长边超限先等比缩小（防 media_image_work_exceeded：解码��素数超限）
  const usePath = maybeDownscale(abs, { maxLongEdge })
  const useExt = extname(usePath).toLowerCase()
  const useSt = statSync(usePath)

  if (useSt.size > maxBytes) {
    throw new Error(`图片过大 ${Math.round(useSt.size / 1024)}KB，上限 ${Math.round(maxBytes / 1024)}KB，请先压缩`)
  }
  const mime = MIME[useExt] || 'application/octet-stream'
  const b64 = readFileSync(usePath).toString('base64')
  const block = {
    type: 'image_url',
    image_url: { url: `data:${mime};base64,${b64}` },
  }
  // 缩放透明化：after 尺寸可测时记录 from→to
  if (resized) {
    const after = getImageSize(usePath)
    block._resized = {
      from: resized,
      to: after ? { w: after.w, h: after.h } : null,
    }
  }
  return block
}

/** 判断是否会发生缩放，返回 {w,h} 或 null */
function longEdgeBefore(size, maxLongEdge) {
  if (!size) return null
  const longEdge = Math.max(size.w, size.h)
  return longEdge > maxLongEdge ? { w: size.w, h: size.h } : null
}

/**
 * 从用户输入解析图片路径：
 * - /image a.png b.jpg 文字...
 * - 任意消息中独立的图片路径 token（.png 等）
 * 返回 { text, paths, cleanedText }
 */
export function extractImagePathsFromText(input) {
  // 【逗号也是分隔符】支持一次发多张：
  //   /image 1,2,3 这是最近三张图       （序号列表）
  //   /image /路径/图1,/路径/图2 看这两张  （路径列表）
  // 中英文逗号都认（全角 ，U+FF0C / 半角 ,）。
  //
  // ⚠ 只在**斜杠/波浪线前缀或纯数字**的片段间切逗号，不做无条件 split：
  //   文件名里合法地含逗号（`/sdcard/a,b.png` 是有效路径），
  //   无条件拆开会把一个存在的文件拆成两个不存在的。
  //   这里的策略：先按空白分 token，token 内若含逗号，
  //   切成若干段；**每段都各自像路径或像序号**才拆，否则保留原样。
  const rawTokens = String(input || '').trim().split(/\s+/).filter(Boolean)
  const tokens = []
  for (const t of rawTokens) {
    if (!/[,，]/.test(t)) { tokens.push(t); continue }
    const segs = t.split(/[,，]/).filter(Boolean)
    // 每段都是「纯数字」或「像图片路径」才认作列表；否则当整串处理（含逗号的文件名）
    const allSegLike = segs.length > 1 && segs.every(seg => /^\d+$/.test(seg) || isImagePath(seg) || /^[./~]/.test(seg))
    if (allSegLike) tokens.push(...segs)
    else tokens.push(t)
  }
  const paths = []
  const indexes = []
  const rest = []
  for (const t of tokens) {
    // 去掉包裹引号；@图片路径与 @文件引用语法一致，先剥离 @ 再解析。
    // 否则 '@/sdcard/a.png' 会被 resolve() 错误拼到当前工作目录下。
    const bare = t.replace(/^['"]|['"]$/g, '')
    let pathToken = bare.startsWith('@') ? bare.slice(1) : bare
    // 中文前缀剥离：中文输入法下手打路径，常把「有的在」「看一下」这类词
    // 直接粘在 /storage 或内部存储 前面（如「有的在内部存储/Pictures/...」）。
    // 把开头连续的非 ASCII 路径字符（中文/全角标点）切掉，剩下的才可能是路径。
    // 注意：Android 内部存储的中文说法是「内部存储」，路径主体 /storage/emulated/0
    // 或 Pictures/QQ 都在切完前缀后完整保留。
    const m = pathToken.match(/^[^\x00-\x7F]+(.*)$/)
    if (m && m[1]) {
      const stripped = m[1].replace(/^存储|内部存储|的/, '')
      if (stripped) pathToken = stripped
    }
    if (isImagePath(pathToken) && (pathToken.startsWith('/') || pathToken.startsWith('~'))) {
      paths.push(pathToken)
    } else if (/^[./~]/.test(pathToken) && isImagePath(pathToken)) {
      paths.push(pathToken)
    } else if (/^\d+$/.test(pathToken)) {
      // 纯数字 = 「最近第 N 张」的序号。单独收集，调用方用 recentImages 解析。
      indexes.push(parseInt(pathToken, 10))
    } else {
      rest.push(t)
    }
  }
  // 去重保序 + 宽松解析
  const seen = new Set()
  const uniq = []
  for (const p of paths) {
    const a = resolveImagePath(p)
    if (!seen.has(a)) { seen.add(a); uniq.push(a) }
  }
  return { paths: uniq, indexes, text: rest.join(' ').trim() }
}

/**
 * 组装多模态 user content 数组（text + images）
 *
 * text 为空时**不补任何默认提示**（2026-10-03 用户要求）。
 * 原来会塞一句「请查看这些图片并说明要点。」——用户只发图就是想让你看图，
 * 自动加的那句话既不是他说的、又会让模型以为有什么"要点"要交代，
 * 属于替用户说话。空就是空，只有图片块。
 */
export function buildMultimodalUserContent(text, imagePaths) {
  const content = []
  const t = (text || '').trim()
  const loaded = []
  // 先把路径整理出来（去重保序），路径要一并给模型
  const paths = [...new Set((imagePaths || []).filter(Boolean))]
  // 文本 + 路径说明合成一个 text 块。
  //
  // 【为什么要带路径】2026-10-04 用户要求：「当用户发图时，把路径也一并给 Agent」。
  // 模型光看图不知道文件在哪，后续想引用（Read / ViewImage / 转发）只能靠猜。
  // 带上路径后它能直接说「这张图存在 /sdcard/...，我可以再看」。
  //
  // 格式设计：说明文字在前（用户的意图），路径清单在后（元信息）——
  // 单张直接写路径，多张用列表。路径用反引号包起来，避免被当成 Markdown 链接。
  const pathLines = paths.length === 1
    ? `（图片路径：${paths[0]}）`
    : `（图片路径：\n${paths.map(p => `- ${p}`).join('\n')}）`
  const merged = t ? `${t}\n\n${pathLines}` : pathLines
  content.push({ type: 'text', text: merged })
  for (const p of paths) {
    const block = loadImageBlock(p)
    content.push(block)
    loaded.push(p)
  }
  return { content, loaded }
}
