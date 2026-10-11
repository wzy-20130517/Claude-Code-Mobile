// Claude Code Mobile - Termux API 工具集
// 提供 Android 原生能力：toast/notification/share/clipboard/vibrate/location/battery 等
import { Tool } from '../tools/tools.mjs'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * 找 termux-* 命令的路径。
 *
 * 【为什么要探测】
 * 这套工具依赖 Termux 的 termux-api 包（termux-notification 等）。
 * 不在 Termux 里（如 proot 容器）时这些命令不存在，这里给出明确提示，
 * 而不是含糊的 ENOENT。
 */
function findTermuxBin(cmd) {
  // 1. Termux 标准路径
  const prefix = process.env.PREFIX || '/data/data/com.termux/files/usr'
  const candidates = [
    `${prefix}/bin/${cmd}`,
    `/data/data/com.termux/files/usr/bin/${cmd}`,
  ]
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c
    } catch {}
  }
  return null
}

function termuxExec(cmd, args = [], timeout = 10000) {
  const bin = findTermuxBin(cmd)
  if (!bin) {
    throw new Error(
      `${cmd} 不可用。\n` +
      `  · 需要安装 termux-api（pkg install termux-api）\n` +
      `  · 如果不在 Termux 环境（如 proot 容器），这套 Termux API 工具不可用`
    )
  }
  try {
    // 不传 shell 选项：execFileSync 直接 execve，args 不经 shell 解析，天然免命令注入
    return execFileSync(bin, args, { encoding: 'utf-8', timeout }).trim()
  } catch (e) {
    throw new Error(`Termux API 失败: ${e.message}`)
  }
}

// 写入剪贴板
class ClipboardSetTool extends Tool {
  constructor() {
    super({
      name: 'ClipboardSet',
      description: '将文本设置到系统剪贴板。避免长文本手动复制。',
      input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      maxResultSizeChars: 200,
      validateInput: (input) => {
        const errors = []
        if (!input.text) errors.push('text is required')
        return { valid: errors.length === 0, errors }
      },
    })
  }
  async execute(input) {
    // 用数组传参（execFileSync）而非 shell 拼接，避免文本含 $(...)/反引号/; 被 shell 执行（命令注入）
    termuxExec('termux-clipboard-set', [input.text], 5000)
    return `已复制到剪贴板（${input.text.length} 字符）`
  }
}

// 读取剪贴板
class ClipboardGetTool extends Tool {
  constructor() {
    super({
      name: 'ClipboardGet',
      description: '读取系统剪贴板内容。',
      // properties 必须存在（哪怕为空）：Google GenAI 系校验器对 type:'object'
      // 缺 properties 会判 `/properties: null is not of type "object"` 并整体 400。
      input_schema: { type: 'object', properties: {} },
      maxResultSizeChars: 5000,
    })
  }
  async execute() {
    return termuxExec('termux-clipboard-get')
  }
}

// Toast 提示
class ToastTool extends Tool {
  constructor() {
    super({
      name: 'Toast',
      description: '显示 Android Toast 短消息（屏幕底部弹出短提示）。',
      input_schema: { type: 'object', properties: { text: { type: 'string' }, short: { type: 'boolean' } }, required: ['text'] },
      maxResultSizeChars: 200,
    })
  }
  async execute(input) {
    const args = [input.text]
    if (input.short === false) args.unshift('long')
    termuxExec('termux-toast', args, 5000)
    return 'Toast 已显示'
  }
}

// 通知
class NotifyTool extends Tool {
  constructor() {
    super({
      name: 'Notify',
      description: '发送 Android 系统通知。支持标题、内容、震动等。',
      input_schema: { type: 'object', properties: {
        title: { type: 'string' }, content: { type: 'string' },
        priority: { type: 'string', enum: ['high', 'default', 'low'] },
        sound: { type: 'boolean' }, vibrate: { type: 'boolean' },
      }, required: ['title'] },
      maxResultSizeChars: 200,
    })
  }
  async execute(input) {
    const args = ['--title', input.title]
    if (input.content) args.push('--content', input.content)
    if (input.priority) args.push('--priority', input.priority)
    if (input.sound === false) args.push('--sound', 'false')
    if (input.vibrate !== undefined) args.push('--vibrate', input.vibrate ? 'true' : 'false')
    termuxExec('termux-notification', args, 5000)
    return `通知已发送: ${input.title}`
  }
}

// 分享文件/文本
class ShareTool extends Tool {
  constructor() {
    super({
      name: 'Share',
      description: '通过 Android 分享菜单分享文件或文本到其他 App。',
      input_schema: { type: 'object', properties: {
        text: { type: 'string' }, file: { type: 'string' }, action: { type: 'string', enum: ['send', 'view'] }
      } },
      maxResultSizeChars: 200,
    })
  }
  async execute(input) {
    const args = []
    if (input.action) args.push('--action', input.action)
    if (input.text) args.push('--text', input.text)
    if (input.file) args.push(input.file)
    termuxExec('termux-share', args, 30000)
    return '已分享'
  }
}

// 震动
class VibrateTool extends Tool {
  constructor() {
    super({
      name: 'Vibrate',
      description: '让手机震动指定毫秒。',
      input_schema: { type: 'object', properties: { duration: { type: 'number' } } },
      maxResultSizeChars: 200,
    })
  }
  async execute(input) {
    const dur = Math.min(10000, Math.max(1, input.duration || 500))
    termuxExec('termux-vibrate', ['-d', String(dur)], 10000)
    return `已震动 ${dur}ms`
  }
}

// 位置
class LocationTool extends Tool {
  constructor() {
    super({
      name: 'Location',
      description: '获取 GPS 位置信息（纬度、经度、海拔等）。',
      input_schema: { type: 'object', properties: { provider: { type: 'string', enum: ['gps', 'network', 'passive'] } } },
      maxResultSizeChars: 2000,
    })
  }
  async execute(input) {
    const args = []
    if (input.provider) args.push('-p', input.provider)
    // 可能需要等 GPS 锁定，给 15 秒
    return termuxExec('termux-location', args, 15000)
  }
}

// 电量
class BatteryTool extends Tool {
  constructor() {
    super({
      name: 'Battery',
      description: '获取电池状态（电百分比、是否充电、温度等）。',
      input_schema: { type: 'object', properties: {} },
      maxResultSizeChars: 1000,
    })
  }
  async execute() {
    return termuxExec('termux-battery-status', [], 5000)
  }
}

// 打开 URL 或本地文件（http(s) → termux-open-url；本地路径 → termux-open）
class OpenUrlTool extends Tool {
  constructor() {
    super({
      name: 'OpenUrl',
      description: '在浏览器中打开 URL，或用系统应用打开本地文件（如 .html/.png）。',
      input_schema: { type: 'object', properties: {
        url: { type: 'string', description: 'http(s) URL 或本地文件路径（/sdcard/... 或 file:///...）' },
      }, required: ['url'] },
      maxResultSizeChars: 200,
      validateInput: (input) => {
        const errors = []
        if (!input.url) errors.push('url is required')
        return { valid: errors.length === 0, errors }
      },
    })
  }
  async execute(input) {
    let target = String(input.url || '').trim()
    // file:///sdcard/x → /sdcard/x
    if (target.startsWith('file://')) {
      try { target = decodeURIComponent(target.replace(/^file:\/\//, '')) } catch { target = target.replace(/^file:\/\//, '') }
    }
    // 本地路径：存在 → termux-open；否则若像 URL 再走 open-url
    const isLocalPath = target.startsWith('/') || target.startsWith('~/') || target.startsWith('./')
    if (isLocalPath) {
      const abs = target.replace(/^~/, process.env.HOME || '/data/data/com.termux/files/home')
      if (!existsSync(abs)) throw new Error(`本地文件不存在: ${abs}`)
      // termux-open 比 open-url 更适合本地文件
      try {
        termuxExec('termux-open', [abs], 10000)
      } catch (e) {
        // 少数环境无 termux-open，退回 content-type 猜测的 open-url（仍可能失败）
        termuxExec('termux-open-url', [`file://${abs}`], 10000)
      }
      return `已打开本地文件: ${abs}`
    }
    // 远程 URL
    if (!/^https?:\/\//i.test(target)) {
      // 无协议时若不是路径，补 https://
      if (!target.includes('://')) target = 'https://' + target
    }
    termuxExec('termux-open-url', [target], 10000)
    return `已打开: ${target}`
  }
}

// TTS 朗读
class TTSTool extends Tool {
  constructor() {
    super({
      name: 'TTS',
      description: '用 Android TTS 朗读文本。',
      input_schema: { type: 'object', properties: { text: { type: 'string' }, language: { type: 'string' }, pitch: { type: 'number' } }, required: ['text'] },
      maxResultSizeChars: 200,
    })
  }
  async execute(input) {
    const args = [input.text]
    if (input.language) args.unshift('-l', input.language)
    if (input.pitch) args.unshift('-p', String(input.pitch))
    termuxExec('termux-tts-speak', args, 30000)
    return `已朗读 ${input.text.length} 字符`
  }
}

export const termuxTools = [
  new ClipboardSetTool(),
  new ClipboardGetTool(),
  new ToastTool(),
  new NotifyTool(),
  new ShareTool(),
  new VibrateTool(),
  new LocationTool(),
  new BatteryTool(),
  new OpenUrlTool(),
  new TTSTool(),
]
