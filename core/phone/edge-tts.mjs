// Claude Code Mobile - Edge TTS（纯 Node 实现，无 Python 依赖）
//
// 【为什么不用 edge-tts 命令】
// 那是个 Python 包，为了念一句话拖一整套 Python 依赖不值得。
// Edge 的接口本质就是一条 WebSocket：发 SSML，回 MP3 二进制分片。
// Node 22+ 自带 WebSocket 全局类，所以零依赖就能实现。
//
// 【协议要点】
// 1. 连接 wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1
//    带固定的 TrustedClientToken（公开值，Edge 浏览器内置）
// 2. 先发一条 speech.config（JSON，声明输出格式）
// 3. 再发一条 ssml 消息（带 X-RequestId）
// 4. 服务端回若干二进制帧：每帧开头 2 字节大端表示头部长度，头部之后是 MP3 数据
// 5. 收到 turn.end 表示合成结束
//
// 【为什么系统 TTS 不够】
// Android 自带 TTS 音质生硬，长句听着累。Edge 的神经网络语音（晓晓/云希）
// 接近真人，做操作汇报时不刺耳。

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { request as httpsRequest } from 'node:https'

const CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
// 微软会校验 Chrome 版本是否够新，130 实测被 403。参考已验证可用的实现取 143。
const CHROME_VERSION = '143.0.3650.75'
const CHROME_MAJOR = CHROME_VERSION.split('.')[0]
const WSS_HOST = 'speech.platform.bing.com'
const WSS_PATH = '/consumer/speech/synthesize/readaloud/edge/v1'

// Sec-MS-GEC：微软的反滥用签名，2024 年起缺了直接 403（实测手写协议不带它必失败）。
// 算法：当前秒向下取整到 5 分钟 → 加 Unix/FILETIME 纪元差 → 乘 1e7 转 100ns ticks
//      → SHA256(ticks + clientToken) 大写十六进制。
// ticks 是 19 位数超出 Number 安全范围，必须用 BigInt。
// 注意它是【URL 查询参数】不是 header —— 放错位置照样 403。
function edgeGec() {
  const rounded = Math.floor(Date.now() / 1000 / 300) * 300
  const ticks = (BigInt(rounded) + 11644473600n) * 10000000n
  return createHash('sha256').update(ticks.toString() + CLIENT_TOKEN).digest('hex').toUpperCase()
}

function buildWssPath() {
  const connId = randomBytes(16).toString('hex')
  return `${WSS_PATH}?TrustedClientToken=${CLIENT_TOKEN}`
    + `&ConnectionId=${connId}`
    + `&Sec-MS-GEC=${edgeGec()}`
    + `&Sec-MS-GEC-Version=1-${CHROME_VERSION}`
}

// 常用中文语音。zh-CN-XiaoxiaoNeural 是默认，语气自然适合播报。
export const VOICES = {
  yunxia: 'zh-CN-YunxiaNeural',       // 少年音，默认（短播报清楚不腻）
  xiaoxiao: 'zh-CN-XiaoxiaoNeural',   // 女声，温和
  yunxi: 'zh-CN-YunxiNeural',         // 男声，沉稳
  yunjian: 'zh-CN-YunjianNeural',     // 男声，浑厚
  xiaoyi: 'zh-CN-XiaoyiNeural',       // 女声，活泼
  liaoning: 'zh-CN-liaoning-XiaobeiNeural',  // 东北话
  shaanxi: 'zh-CN-shaanxi-XiaoniNeural',     // 陕西话
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function nowRFC1123() {
  return new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)')
}

/**
 * 合成语音到 mp3 文件。
 * @param {string} text 要念的文本
 * @param {object} opts { voice, rate, volume, pitch, style, styledegree, outFile, timeout }
 * @returns {Promise<{ok:boolean, file?:string, bytes?:number, error?:string}>}
 */
export async function synthesize(text, opts = {}) {
  const voice = VOICES[opts.voice] || opts.voice || VOICES.yunxia
  const rate = opts.rate || '+0%'
  const volume = opts.volume || '+0%'
  const pitch = opts.pitch || '+0Hz'
  // Edge Read Aloud 免费端点只稳定接受 voice/prosody，不接受 mstts:express-as。
  // 语气用 prosody 预设实现；styledegree 作为预设强度（0.01–2）。
  const style = opts.style == null ? '' : String(opts.style).trim().toLowerCase()
  const stylePresets = {
    cheerful: { rate: '+8%', pitch: '+12Hz', volume: '+0%' },
    excited: { rate: '+18%', pitch: '+20Hz', volume: '+5%' },
    gentle: { rate: '-12%', pitch: '+5Hz', volume: '-8%' },
    calm: { rate: '-15%', pitch: '-3Hz', volume: '-3%' },
    serious: { rate: '-8%', pitch: '-8Hz', volume: '+0%' },
    sad: { rate: '-12%', pitch: '-12Hz', volume: '-8%' },
    angry: { rate: '+12%', pitch: '-5Hz', volume: '+8%' },
    affectionate: { rate: '-5%', pitch: '+8Hz', volume: '-3%' },
    chat: { rate: '+5%', pitch: '+3Hz', volume: '+0%' },
    narration: { rate: '-8%', pitch: '-2Hz', volume: '+0%' },
    'narration-relaxed': { rate: '-12%', pitch: '-2Hz', volume: '-2%' },
  }
  if (style && !stylePresets[style]) {
    return { ok: false, error: `不支持的语气 style：${style}（可用 cheerful/excited/gentle/calm/serious/sad/angry 等）` }
  }
  const styledegree = opts.styledegree == null ? 1 : Number(opts.styledegree)
  if (!Number.isFinite(styledegree) || styledegree < 0.01 || styledegree > 2) {
    return { ok: false, error: 'styledegree 必须是 0.01 到 2 之间的数字' }
  }
  const preset = stylePresets[style]
  const scaleProsody = (value, neutral) => {
    if (!preset || styledegree === 1) return value || neutral
    const m = String(value || neutral).match(/^([+-]?)(\d+(?:\.\d+)?)(%|Hz)$/)
    if (!m) return value || neutral
    const amount = Number(m[2]) * styledegree
    return `${m[1] === '-' ? '-' : '+'}${amount}${m[3]}`
  }
  const finalRate = opts.rate || scaleProsody(preset?.rate, '+0%')
  const finalPitch = opts.pitch || scaleProsody(preset?.pitch, '+0Hz')
  const finalVolume = opts.volume || scaleProsody(preset?.volume, '+0%')
  const outFile = opts.outFile || join(homedir(), '.claude-code-mobile', `tts-${Date.now()}.mp3`)
  const timeout = opts.timeout || 30000

  if (typeof WebSocket === 'undefined') {
    return { ok: false, error: 'Node 版本过低，缺少内置 WebSocket（需要 Node 22+）' }
  }
  const clean = String(text || '').trim()
  if (!clean) return { ok: false, error: '文本为空' }

  const reqId = randomBytes(16).toString('hex')

  return new Promise((resolve) => {
    let settled = false
    let sock = null
    const chunks = []
    const done = (r) => {
      if (settled) return
      settled = true
      try { sock && sock.destroy() } catch {}
      resolve(r)
    }
    const finish = () => {
      if (!chunks.length) return done({ ok: false, error: '服务端未返回音频数据' })
      const buf = Buffer.concat(chunks)
      try {
        writeFileSync(outFile, buf)
        done({ ok: true, file: outFile, bytes: buf.length })
      } catch (e) { done({ ok: false, error: `写文件失败: ${e.message}` }) }
    }
    const timer = setTimeout(() => done({ ok: false, error: `合成超时（${timeout}ms）` }), timeout)

    // Node 内置 WebSocket 不允许自定义请求头，而 Edge 服务端会校验
    // Origin / Cookie / User-Agent / Cache-Control 等，少一项就 403。
    // 所以走 https.request 拿 upgrade 后的裸 socket，自己收发 WS 帧。
    const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) `
      + `Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROME_MAJOR}.0.0.0`
    const req = httpsRequest({
      hostname: WSS_HOST,
      path: buildWssPath(),
      headers: {
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        'Connection': 'Upgrade',
        'Upgrade': 'websocket',
        'User-Agent': ua,
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': `muid=${randomBytes(16).toString('hex').toUpperCase()};`,
      },
    })

    req.on('response', (res) => {
      clearTimeout(timer)
      done({ ok: false, error: `握手被拒 HTTP ${res.statusCode}（签名过期或版本被拒，可重试）` })
    })
    req.on('error', (e) => {
      clearTimeout(timer)
      done({ ok: false, error: `连接失败: ${e.message}` })
    })

    req.on('upgrade', (res, socket) => {
      sock = socket
      socket.on('error', (e) => { clearTimeout(timer); done({ ok: false, error: `socket 错误: ${e.message}` }) })
      socket.on('close', () => { clearTimeout(timer); if (!settled) finish() })

      // 客户端发出的帧必须掩码（RFC6455）
      const sendText = (payload) => {
        const data = Buffer.from(payload, 'utf-8')
        const len = data.length
        const mask = randomBytes(4)
        let header
        if (len < 126) {
          header = Buffer.from([0x81, 0x80 | len])
        } else if (len < 65536) {
          header = Buffer.alloc(4)
          header[0] = 0x81; header[1] = 0x80 | 126
          header.writeUInt16BE(len, 2)
        } else {
          header = Buffer.alloc(10)
          header[0] = 0x81; header[1] = 0x80 | 127
          header.writeBigUInt64BE(BigInt(len), 2)
        }
        const masked = Buffer.alloc(len)
        for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i & 3]
        socket.write(Buffer.concat([header, mask, masked]))
      }

      // 收帧：服务端帧不带掩码
      let buf = Buffer.alloc(0)
      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d])
        while (buf.length >= 2) {
          const opcode = buf[0] & 0x0f
          let len = buf[1] & 0x7f
          let off = 2
          if (len === 126) {
            if (buf.length < 4) return
            len = buf.readUInt16BE(2); off = 4
          } else if (len === 127) {
            if (buf.length < 10) return
            len = Number(buf.readBigUInt64BE(2)); off = 10
          }
          if (buf.length < off + len) return
          const payload = buf.subarray(off, off + len)
          buf = buf.subarray(off + len)

          if (opcode === 0x8) { clearTimeout(timer); finish(); return }   // close
          if (opcode === 0x1) {
            const s = payload.toString('utf-8')
            if (s.includes('Path:turn.end')) { clearTimeout(timer); finish(); return }
          } else if (opcode === 0x2) {
            // 二进制帧：前 2 字节大端 = 头部长度，之后是 MP3 数据
            if (payload.length < 2) continue
            const headerLen = payload.readUInt16BE(0)
            if (payload.length > headerLen + 2) chunks.push(payload.subarray(headerLen + 2))
          }
        }
      })

      sendText(
        `X-Timestamp:${nowRFC1123()}\r\n` +
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`
      )
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>`
        + `<voice name='${esc(voice)}'><prosody rate='${esc(finalRate)}' volume='${esc(finalVolume)}' pitch='${esc(finalPitch)}'>${esc(clean)}</prosody></voice></speak>`
      sendText(
        `X-RequestId:${reqId}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${nowRFC1123()}Z\r\n` +
        `Path:ssml\r\n\r\n${ssml}`
      )
    })

    req.end()
  })
}
