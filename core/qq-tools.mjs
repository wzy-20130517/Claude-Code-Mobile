// QQ 主动推送工具（只有这一个，且只能发给主人号）
//
// 【为什么重写】原来这里有 QQInbox / QQSend / QQReply / QQMute 四个工具，
// 都是 2026-08-21 极简化之前的群聊时代产物，且已经跟当前的桥不兼容：
//   - markReplied() / sendReply() 这些方法随收件箱功能一起删了
//   - send() 的第 4 个参数现在是 opts 对象，旧代码按 boolean 传
//   - QQMute 是群禁言，极简版压根不处理群消息
// 它们从未被 registry 注册（index.mjs:82 注释说明「已按需求移除」），
// 留着只会让人以为「有发消息的工具」。
//
// 【边界】只能发给 owner，不接受目标参数。
// 理由：给出「发给任意 QQ 号」的能力，等于让 AI 可以被诱导向他人发东西
// （对方看到的是用户本人的号在发）。推送目标固定成主人号，风险面小得多。
import { Tool } from './tools.mjs'

export class QQPushTool extends Tool {
  constructor(qqBridge) {
    super({
      name: 'QQPush',
      description: '把消息、图片或文件主动推送到用户的 QQ（只能发给主人号，不能发给别人、不能发群）。'
        + '用户明确要求时才用，比如「把这张图发我 QQ」「把报告发到我手机」「生成完发我」。'
        + '不要用它做进度播报或主动搭话 —— 用户在终端就能看到你的正文。',
      input_schema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: '要发送的文字。单独给它 = 发一条文本消息；配合 path 给 = 作为文件的说明先发出去。超长会自动转成图片。',
          },
          path: {
            type: 'string',
            description: '要发送的本地文件绝对路径。图片（png/jpg/gif/webp/bmp）显示成图片气泡，其他类型作为文件发送。目录不支持，需先打包 zip。',
          },
          as_image: {
            type: 'boolean',
            description: 'true = 把 text 强制渲染成图片再发（表格、代码、长文本用这个，QQ 里看得更清）。默认按长度自动判断。',
          },
        },
        required: [],
      },
      maxResultSizeChars: 400,
    })
    this.qqBridge = qqBridge
  }

  async execute(input) {
    const text = String(input?.text ?? '').trim()
    const path = String(input?.path ?? '').trim()
    if (!text && !path) return '需要 text（发文字）或 path（发文件）至少一个'

    const bridge = this.qqBridge
    if (!bridge) return 'QQ 桥未初始化'
    if (!bridge.running) return 'QQ 桥未启动（用 /qq on 开启）'

    // 发文件：text 作为说明一起带上
    if (path) {
      const r = await bridge.sendFile(path, text)
      return r.ok ? r.msg : r.msg
    }

    // 只发文字
    const r = await bridge.send(bridge.owner, null, text, {
      forceImage: input?.as_image === true,
    })
    return r && r.retcode === 0
      ? `已发送到 QQ（${input?.as_image ? '图片' : text.length + ' 字'}）`
      : `发送失败: ${r?.message || r?.wording || JSON.stringify(r || {}).slice(0, 120)}`
  }
}

/**
 * 回溯群消息（2026-09-13 加）。
 *
 * 【为什么需要】群消息**不会自动注入会话**（那样任何群友都能指挥这台手机）。
 * 但用户经常需要「群里那个东西」：他私聊说「看下 aigc 那个鸡蛋能不能用」，
 * 我得能主动去翻最近的群消息找到那条。
 *
 * 缓存只在内存里（最近 60 条），重启即忘 —— 群聊内容不该在磁盘留副本。
 * 图片只给 URL，要看内容得自己下载（QQ 的 URL 带鉴权、会过期，尽快取）。
 */
export class QQRecallTool extends Tool {
  constructor(qqBridge) {
    super({
      name: 'QQRecall',
      description: '回溯最近的 QQ 群消息（群消息不会自动进对话，需要主动查）。'
        + '用户提到「群里那个/刚才发的/有人发了」但没给具体内容时用它。'
        + '可用 keyword 过滤（匹配消息文本或发送者昵称）、groupId 限定某个群、limit 控制条数。'
        + '返回发送者、时间、文本和图片 URL；要看图片内容再用 ViewImage（先下载到本地）。',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回最近多少条，默认 20，上限 60' },
          groupId: { type: 'string', description: '只看某个群（群号）；省略=所有群' },
          keyword: { type: 'string', description: '按关键词过滤，匹配消息文本或发送者昵称' },
        },
        required: [],
      },
      maxResultSizeChars: 4000,
    })
    this.qqBridge = qqBridge
  }

  async execute(input) {
    const bridge = this.qqBridge
    if (!bridge) return 'QQ 桥未初始化'
    if (typeof bridge.recallGroup !== 'function') {
      return 'QQ 桥版本过旧，不支持群消息缓存（需重启 CLI）'
    }
    const list = bridge.recallGroup({
      limit: input?.limit,
      groupId: input?.groupId,
      keyword: input?.keyword,
    })
    const total = bridge.groupCacheCount?.() ?? 0
    if (!list.length) {
      return total === 0
        ? '群消息缓存为空（桥启动后还没收到过群消息，或刚重启过——缓存不落盘）'
        : `没有匹配的群消息（缓存共 ${total} 条，试试放宽 keyword 或去掉 groupId）`
    }
    const fmt = (m) => {
      const t = new Date(m.at).toLocaleTimeString('zh-CN', { hour12: false })
      const who = m.nickname ? `${m.nickname}(${m.userId})` : m.userId
      const where = m.groupName ? `${m.groupName}` : `群${m.groupId}`
      const imgs = m.images?.length ? `\n    [图片 ${m.images.length} 张] ${m.images.join(' ')}` : ''
      const at = m.atMe ? ' @我' : ''
      return `[${t}] ${where} · ${who}${at}\n    ${m.message || '(无文本)'}${imgs}`
    }
    return `群消息 ${list.length} 条（缓存共 ${total}）:\n\n` + list.map(fmt).join('\n')
  }
}
