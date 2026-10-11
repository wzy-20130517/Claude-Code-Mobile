// Claude Code Mobile - 正文语音朗读（豆包式）
//
// 【为什么需要它】
//   模型说的【正文】自动被念出来，模型不需要（也不应该）知道它存在。
// 所以这里不注册任何工具，只在 onText 流里挂一个钩子。
//
// 【为什么要按句子切】
// 流式正文是一小片一小片来的（有时几个字），逐片合成会得到一堆断句音频，
// 听起来像结巴。必须攒够一个完整句子（。！？；换行）再送去合成。
//
// 【为什么要串行播放】
// termux-media-player 是全局单例播放器，第二次 play 会直接顶掉正在播的。
// 所以维护一个队列：合成可以并发（网络 IO），播放必须一句接一句。
// 播放时长靠 ffprobe 拿 mp3 真实时长后 sleep（speak 不等播完，见 edge-tts 注释）。
//
// 【哪些内容不念】
// 工具调用、代码块、命令行、URL、纯符号行 —— 念出来是噪音。
// 朗读的目标是「像豆包那样把回答读给我听」，不是把屏幕内容逐字转语音。

import { execFile } from 'node:child_process'
import { unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { synthesize, VOICES } from './edge-tts.mjs'

const TTS_DIR = join(homedir(), '.claude-code-mobile')

// ── 状态（模块级单例：整个 CLI 只有一个朗读器）──────────────
let enabled = false
let voice = 'yunxia'
let rate = '+0%'
// 当前轮的句子缓冲；跨轮不保留（换轮就丢，避免把上一轮尾巴念出来）
let buffer = ''
// 播放队列 + 是否正在播
const queue = []
let playing = false
// epoch：轮次标记。打断/换轮时自增，旧任务发现 epoch 变了就自杀，
// 否则打断后队列里的句子还会继续念（用户按了停却还在说话）。
let epoch = 0
// 代码块状态：``` 之间的内容不念
let inCodeFence = false

export function isVoiceEnabled() { return enabled }
export function getVoice() { return voice }
export function getVoiceRate() { return rate }
export function listVoices() { return Object.keys(VOICES) }

export function setVoiceEnabled(on) {
  enabled = !!on
  if (!enabled) stopVoice()
  return enabled
}

export function setVoice(name) {
  if (!name) return { ok: false, error: '音色名不能为空' }
  const key = String(name).trim()
  if (!VOICES[key]) {
    return { ok: false, error: `未知音色: ${key}`, available: Object.keys(VOICES) }
  }
  voice = key
  return { ok: true, voice: key, full: VOICES[key] }
}

export function setVoiceRate(r) {
  const s = String(r || '').trim()
  // Edge TTS 的 rate 格式：+10% / -20% / +0%
  if (!/^[+-]\d{1,3}%$/.test(s)) return { ok: false, error: 'rate 格式应为 +10% 或 -20%' }
  rate = s
  return { ok: true, rate: s }
}

/** 打断：清缓冲、清队列、停当前播放。换轮和 Ctrl+C 都要调。 */
export function stopVoice() {
  epoch++
  buffer = ''
  inCodeFence = false
  queue.length = 0
  playing = false
  try { execFile('termux-media-player', ['stop'], () => {}) } catch {}
  // 打断时正在播的那个文件由 playAndWait 的 done() 删；
  // 但「已合成好、还没轮到播」的文件没人管，这里 sweep 一次兜底。
  // 用 3 秒阈值：刚合成完可能正被播放器打开，太激进会删到正在读的。
  try { sweepVoiceFiles({ maxAgeMs: 3000 }) } catch {}
}

/** 新一轮开始：只清状态，不停播放器（上一轮可能还有尾音，让它自然结束）。 */
export function resetVoiceTurn() {
  epoch++
  buffer = ''
  inCodeFence = false
  queue.length = 0
  playing = false
}

// ── 文本清洗 ─────────────────────────────────────────────
// 目标：把「适合听」的部分留下来，把「只适合看」的去掉。
function cleanForSpeech(raw) {
  let s = String(raw || '')
  // 行内代码、加粗、斜体的标记符号念出来是噪音，去掉符号保留内容
  s = s.replace(/`([^`]+)`/g, '$1')
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/\*([^*]+)\*/g, '$1')
  // ── 孤立标记兜底（2026-10-03 加）───────────────────────
  //
  // 【为什么需要】分句发生在清理**之前**（drainSentences 先切句、
  // enqueueSentence 再清理）。而 `**加粗**` 常常跨句号：
  //
  //   原文：**47 个模型，分三类。**挑几个有意思的实测：
  //   分句：["**47 个模型，分三类。", "**挑几个有意思的实测："]
  //          ↑ 前半带 **，后半也带 **
  //
  // 两边各剩一半 `**`，上面那两条配对正则就匹配不到了，
  // 结果「**」被原样念出来（用户实测反馈）。
  //
  // 修法：分句后残留的孤立标记直接删掉。放在配对替换之后 ——
  // 配对成功的已经在上面处理过，走到这里的一定是落单的。
  s = s.replace(/\*{1,3}/g, '')        // 落单的 * / ** / ***
  s = s.replace(/_{1,3}/g, '')         // 落单的 _ / __ / ___（斜体另一种写法）
  s = s.replace(/~~/g, '')             // 删除线标记
  // markdown 链接：只念标题，不念 URL
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  // 裸 URL / 文件路径：整段替换成简短说法，逐字符念 https://... 极其难听
  s = s.replace(/https?:\/\/\S+/g, '（链接）')
  s = s.replace(/(?:^|\s)(\/[\w./-]{8,})/g, ' （路径）')
  // 标题符号、列表符号、引用符号
  s = s.replace(/^#{1,6}\s*/gm, '')
  s = s.replace(/^\s*[-*+]\s+/gm, '')
  s = s.replace(/^\s*>\s*/gm, '')
  s = s.replace(/^\s*\d+\.\s+/gm, '')
  // 表格行整行丢弃（念表格分隔线毫无意义）
  s = s.replace(/^\s*\|.*\|\s*$/gm, '')
  s = s.replace(/^\s*[-:|\s]+$/gm, '')
  // 剩余的孤立符号压缩
  s = s.replace(/[ \t]{2,}/g, ' ')
  return s.trim()
}

/** 一段文本是否值得念（过滤纯符号、纯英文标识符、太短的碎片）。 */
function worthSpeaking(s) {
  const t = String(s || '').trim()
  if (t.length < 2) return false
  // 至少要有一个中文字或字母，否则是纯符号/数字行
  if (!/[\u4e00-\u9fa5a-zA-Z]/.test(t)) return false
  // 看起来像纯代码/命令的行不念（含大量符号且没有中文）
  if (!/[\u4e00-\u9fa5]/.test(t) && /[{}();=<>$|]/.test(t)) return false
  return true
}

// ── 句子切分 ─────────────────────────────────────────────
// 攒到句末标点才吐一句。中英文标点都算，换行也算（列表项通常一行一句）。
const SENTENCE_END = /[。！？!?；;\n]/

/**
 * 喂入流式正文片段。内部按句子边界切分并送去朗读。
 * 这是唯一的入口，index.mjs 的 onText 调它。
 */
export function feedVoiceText(chunk) {
  if (!enabled || !chunk) return
  buffer += String(chunk)

  // 代码围栏：进入 ``` 就丢弃直到闭合（代码不念）
  while (true) {
    if (inCodeFence) {
      const close = buffer.indexOf('```')
      if (close === -1) { buffer = ''; return }   // 还没闭合，整段丢
      buffer = buffer.slice(close + 3)
      inCodeFence = false
      continue
    }
    const open = buffer.indexOf('```')
    if (open === -1) break
    // 围栏前的内容正常处理，围栏本身之后进入丢弃模式
    const before = buffer.slice(0, open)
    buffer = buffer.slice(open + 3)
    inCodeFence = true
    drainSentences(before, true)
  }

  drainSentences(buffer, false)
  // drainSentences 会把已消费部分从 buffer 去掉（通过返回剩余）
}

/**
 * 从文本里取出所有完整句子送去朗读。
 * @param {string} text 待处理文本
 * @param {boolean} isolated true=这段是独立片段（不回写 buffer），false=来自 buffer
 */
function drainSentences(text, isolated) {
  let rest = text
  while (true) {
    const m = SENTENCE_END.exec(rest)
    if (!m) break
    const sentence = rest.slice(0, m.index + 1)
    rest = rest.slice(m.index + 1)
    enqueueSentence(sentence)
  }
  if (!isolated) buffer = rest
}

/** 轮末收尾：把 buffer 里剩下的不完整句子也念掉（最后一句常没有句号）。 */
export function flushVoiceText() {
  if (!enabled) return
  const tail = buffer
  buffer = ''
  if (tail) enqueueSentence(tail)
}

function enqueueSentence(raw) {
  const cleaned = cleanForSpeech(raw)
  if (!worthSpeaking(cleaned)) return
  // 单句太长会让合成很慢、也听不清，切成 ≤120 字的小段
  const parts = []
  let s = cleaned
  while (s.length > 120) {
    // 优先在逗号/顿号处断，找不到就硬切
    let cut = s.lastIndexOf('，', 120)
    if (cut < 40) cut = s.lastIndexOf('、', 120)
    if (cut < 40) cut = 120
    parts.push(s.slice(0, cut + 1))
    s = s.slice(cut + 1)
  }
  if (s) parts.push(s)
  for (const p of parts) queue.push({ text: p, epoch })
  pump()
}

// ── 播放泵（流水线：播当前句的同时预合成下一句）─────────────
//
// 【为什么要流水线】2026-10-03 用户反馈「读得太慢了」。
// 实测：合成一句要 1.2~1.9 秒（Edge TTS 网络请求），播放一句 2~3 秒。
// 原来的实现是严格串行 —— 合成1 → 播放1 → 合成2 → 播放2 ……
// 于是 N 句回复的总耗时 = N×(合成 + 播放)，模型早说完了声音还在追。
//
// 改成流水线后：播放第 1 句的同时，后台已经在合成第 2 句；
// 播放第 2 句时合成第 3 句……首句延迟不变（仍要等一次合成），
// 但后续每句省掉一次合成时间。
//
//   3 句：12s → 9s   10 句：40s → 27s（句子越多省得越多）
//
// 【为什么不用「全部预合成」】那会让首句延迟变长（要等队列里所有句子
// 都合成完才开始播），且并发请求太多可能触发限流。
// 只提前一句是「首句最快 + 明显省时」的平衡点。
async function pump() {
  if (playing) return
  playing = true
  const myEpoch = epoch
  // 正在预合成的下一句（Promise），避免重复发起
  let prefetch = null

  try {
    while (queue.length) {
      // epoch 变了说明被打断/换轮，剩下的不念了
      if (myEpoch !== epoch) break
      const item = queue.shift()
      if (!item || item.epoch !== epoch) { prefetch = null; continue }

      try {
        // 取「已预合成的这句」或现合成（首句走这里）
        const synthPromise = (prefetch && prefetch.text === item.text)
          ? prefetch.promise
          : (async () => {
            const r = await synthesize(item.text, { voice, rate })
            // 合成完立刻量时长 —— 此刻播放器空闲，ffprobe 只要 ~330ms；
            // 等播放开始后再量会因 Termux API 抢资源变成 ~4.7s（见 playAndWait 注释）
            const ms = r?.ok && r.file ? await probeDuration(r.file) : 0
            return { ...r, durationMs: ms }
          })()
        prefetch = null

        // 合成当前句的同时，把下一句也发出去合成（流水线核心）
        const next = queue[0]
        if (next && next.epoch === epoch) {
          prefetch = {
            text: next.text,
            promise: (async () => {
              const r = await synthesize(next.text, { voice, rate })
              const ms = r?.ok && r.file ? await probeDuration(r.file) : 0
              return { ...r, durationMs: ms }
            })(),
          }
          // 预合成失败不能让整个流程崩 —— 挂个 catch，真正用的时候再看结果
          prefetch.promise.catch(() => {})
        }

        const r = await synthPromise
        if (myEpoch !== epoch) break        // 合成期间被打断
        if (!r?.ok || !r.file) continue
        await playAndWait(r.file, myEpoch, r.durationMs)
      } catch { /* 单句失败不影响后续 */ }
    }
  } finally {
    playing = false
  }
}

/**
 * 播放并等它放完，播完删文件。
 *
 * 【2026-10-03 修：卡顿根因】用户反馈「读都读不顺，中间间隔老大了」。
 * 实测时间线暴露问题：
 *
 *   3447ms  合成完成
 *   3450ms  开始播放
 *   8125ms  ffprobe 返回 ← 等了 4.7 秒！
 *   10622ms 播放结束
 *
 * 两个原因叠加：
 *   1. `termux-media-player play` 的 execFile 回调**要等播放器响应**
 *      （实测 715ms，播放期间更久）
 *   2. 拿到回调后才跑 ffprobe 拿时长 —— 而**播放期间跑 ffprobe 要 4.7 秒**
 *      （Termux API 调用会互相排队抢资源；单独跑只要 329ms）
 *
 * 结果每句之间白白多等 ~5 秒，听起来就是「一顿一顿的」。
 *
 * 修法：**合成完立刻拿时长**（那时播放器空闲，ffprobe 快），
 * 播放时直接用拿到的值，不再等 play 回调、不再在播放中跑 ffprobe。
 */
function probeDuration(file) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', file,
    ], (err, stdout) => {
      const dur = Number(String(stdout || '').trim())
      resolve(Number.isFinite(dur) && dur > 0 ? dur * 1000 : 0)
    })
  })
}

function playAndWait(file, myEpoch, durationMs) {
  return new Promise((resolve) => {
    const done = () => {
      // 播完即删。删失败不影响流程（下次启动的 sweep 会兜底）。
      try { unlinkSync(file) } catch {}
      resolve()
    }
    // 不传回调 —— 不等播放器响应（那会白白多等几百毫秒到几秒）
    try { execFile('termux-media-player', ['play', file], () => {}) } catch {}
    // 用预先量好的时长直接等；量不到就按字数估（中文约 4.5 字/秒）
    const ms = durationMs > 0 ? durationMs + 120 : 2500
    const t = setTimeout(done, ms)
    if (t.unref) t.unref()
  })
}

/**
 * 清理残留的 tts-*.mp3（进程崩溃/被杀时会留下没删掉的）。
 * 只删 5 分钟以上的，避免删到正在播的文件。
 */
export function sweepVoiceFiles({ maxAgeMs = 300000 } = {}) {
  let removed = 0
  try {
    for (const f of readdirSync(TTS_DIR)) {
      const m = /^tts-(\d+)\.mp3$/.exec(f)
      if (!m) continue
      if (Date.now() - Number(m[1]) < maxAgeMs) continue
      try { unlinkSync(join(TTS_DIR, f)); removed++ } catch {}
    }
  } catch {}
  return removed
}

/** 供 /voice 命令展示状态。 */
export function voiceStatus() {
  return {
    enabled,
    voice,
    full: VOICES[voice] || voice,
    rate,
    queued: queue.length,
    playing,
    available: Object.keys(VOICES),
  }
}
