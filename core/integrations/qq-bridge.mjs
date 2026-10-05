// QQ 桥模块（极简版）：让你能在 QQ 上直接跟 Claude Code Mobile 说话。
// 监听 NapCat HTTP 上报（端口/API 用 /qq port、/qq api 配置，默认 3000 / 127.0.0.1:5700）。
//
// 三条入口：
//   1. **主人私聊** → 注入主会话，回复发回私聊
//   2. **主人在群里 @ 机器人** → 注入主会话，回复发回**那个群**（2026-09-13 加）
//   3. **其他群消息** → 不注入，但存进环形缓存，AI 可用 QQRecall 工具主动翻看
//      （场景：群里有人发了张图，你私聊说「看下 aigc 那个鸡蛋能不能用」）
//
// 陌生号私聊仍然静默丢弃 —— owner 限制是安全底线：
// 这个桥直连能跑 Bash、改文件的 agent，放开等于把手机 shell 交给任意好友。
// 群里非主人的消息只进缓存、永不自动注入，同理。
//
// 不调任何外部模型——回复就是 Claude Code Mobile 自己生成的。
import http from 'node:http'

// 默认值：仅作为「没配置过」时的兜底，运行时可用 /qq port|api|owner 改（存 qq-config.json）
const DEFAULT_PORT = 3000
const DEFAULT_NAPCAT_API = 'http://127.0.0.1:5700'
// 主人 QQ 号：只有这个号私聊才会进会话。可用 /qq owner <QQ号> 改。
// 【开源版】默认不预设主人号 —— 用户用 /qq owner <QQ号> 自己配。
// 原来这里硬编码了开发者的 QQ 号，开源时移除了。
const DEFAULT_OWNER = ''

// 超过这个长度就转成图片发，而不是切成一堆消息。
//
// 阈值 1500 是「可读性」上的取舍，不是协议限制：手机上超过这个量要滚很久，
// 转成图反而一眼能看完（尤其带代码块的回复）。
//
// 2026-09-12 实测 NapCat 单条发送上限（汉字数，retcode=0 为成功）：
//   1000 / 2000 / 3000 / 4000 / 5000 → 全部成功
//   8000 / 12000 → EventChecker Failed
//   20000 → Timeout
// 所以真实边界在 5000~8000 之间。HARD_LIMIT 取 4000 留足余量：
// 即使有人把 IMAGE_THRESHOLD 调得很高，也不会撞上发送失败。
const IMAGE_THRESHOLD = 1500
const HARD_LIMIT = 4000

// 群消息环形缓存：只留最近 N 条，够「刚才群里那张图」这种回溯就行。
// 不落盘 —— 群聊内容不该在磁盘上留副本，重启即忘。
const GROUP_CACHE_MAX = 60

/**
 * 判断消息里有没有 @ 指定 QQ 号。
 * 两种形态都要认：CQ 码 `[CQ:at,qq=123]` 和消息数组 `{type:'at',data:{qq:'123'}}`。
 * `qq=all` 是 @全体，**不算 @我** —— 否则群公告会把 agent 唤醒。
 */
/**
 * 取「有效消息体」。
 *
 * 【为什么不能直接 `data.raw_message ?? data.message`】
 * NapCat 的 messagePostFormat 配成 "array" 时（本项目 onebot11.json 就是），
 * `raw_message` 常常是**空字符串**而不是 undefined ——
 * 而 `'' ?? x` 在 JS 里返回 `''`（?? 只对 null/undefined 生效），
 * 于是调用方拿到空串，`hasAtTarget('')` 恒为 false，
 * **群里 @机器人 的消息全部被当成普通群消息丢弃**。
 *
 * 实测：纯数组格式 + raw_message:'' → 队列 0 条（消息进不来）。
 *
 * 规则：字符串要判「非空」，其他类型判「存在」。
 */
function effectiveBody(data) {
  const raw = data?.raw_message
  if (typeof raw === 'string' && raw.trim()) return raw
  if (raw != null && typeof raw !== 'string') return raw   // 数组/对象形态
  return data?.message
}

function hasAtTarget(raw, selfId) {
  const me = String(selfId || '')
  if (!me) return false
  if (typeof raw === 'string') {
    for (const m of raw.matchAll(/\[CQ:at,[^\]]*?qq=([^,\]]+)/g)) {
      if (String(m[1]).trim() === me) return true
    }
    return false
  }
  if (Array.isArray(raw)) {
    return raw.some(seg => seg?.type === 'at' && String(seg.data?.qq ?? '').trim() === me)
  }
  return false
}

/** 去掉文本里的 @我 片段，留下真正的指令内容 */
function stripAtSegments(text, selfId) {
  let out = String(text || '')
  const me = String(selfId || '')
  if (me) {
    out = out.replace(new RegExp(`\\[CQ:at,[^\\]]*?qq=${me}[^\\]]*\\]`, 'g'), ' ')
    // parseNapCatMessage 可能已把 at 转成 `@昵称` 文本，那种去不掉也无妨 ——
    // 多个 @ 前缀不影响我理解指令，硬删反而可能吃掉正文里的人名。
  }
  out = out.replace(/^\s*@\S+\s*/, '')   // 开头的 @昵称
  return out.trim()
}

// 从 CQ 码或消息数组里抽图片 URL（消息转文本后 URL 会丢，单独存供下载）
/**
 * CQ 码转义解码。
 *
 * OneBot 规定 CQ 码里的 & [ ] , 必须转义成 &amp; &#91; &#93; &#44;。
 * 图片 URL 里全是 `&` 分隔的参数，不解码就会变成
 * `...appid=1407&amp;fileid=...` —— curl/fetch 拿到的是坏 URL，下载 404。
 * （2026-09-13 实测群图片下载失败，手动把 &amp; 换回 & 才成功。）
 */
function unescapeCQ(s) {
  return String(s || '')
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&')   // 必须放最后，否则会把上面产生的 & 二次解码
}

function extractImages(raw) {
  const urls = []
  if (typeof raw === 'string') {
    for (const m of raw.matchAll(/\[CQ:image[^\]]*?url=([^,\]]+)/g)) urls.push(unescapeCQ(m[1]))
  } else if (Array.isArray(raw)) {
    for (const seg of raw) {
      if (seg?.type === 'image' && seg.data?.url) urls.push(unescapeCQ(seg.data.url))
    }
  }
  return urls
}

/**
 * 抽文件段信息。
 *
 * 【为什么单独处理】原来只解析 image 段，file 段被
 * `.replace(/\[CQ:[^\]]*\]/g, '')` 整个吃掉 —— 用户发文件过来，
 * AI 连「有个文件」都不知道（用户问「我发文件你能看吗」时确认了这点）。
 *
 * NapCat 的 file 段通常带 file（文件名）、file_id、file_size，
 * 有时带 url；没 url 时要另外调 get_file API 拿路径。
 */
function extractFiles(raw) {
  const files = []
  if (typeof raw === 'string') {
    for (const m of raw.matchAll(/\[CQ:file,([^\]]*)\]/g)) {
      const kv = {}
      for (const pair of m[1].split(',')) {
        const i = pair.indexOf('=')
        if (i > 0) kv[pair.slice(0, i)] = pair.slice(i + 1)
      }
      files.push({
        name: kv.file || kv.name || '未命名文件',
        fileId: kv.file_id || kv.fileid || '',
        size: Number(kv.file_size || kv.size || 0),
        url: (kv.url || '').replace(/&amp;/g, '&'),
        path: kv.path || '',
      })
    }
  } else if (Array.isArray(raw)) {
    for (const seg of raw) {
      if (seg?.type !== 'file') continue
      const d = seg.data || {}
      files.push({
        name: d.file || d.name || '未命名文件',
        fileId: d.file_id || d.fileid || '',
        size: Number(d.file_size || d.size || 0),
        url: String(d.url || '').replace(/&amp;/g, '&'),
        path: String(d.path || ''),
      })
    }
  }
  return files
}

/**
 * 抽引用（回复）的目标 message_id。
 *
 * 【为什么必须单独处理】用户「引用那张图 + 说看看这是什么」时，
 * 上报里**只有 `[CQ:reply,id=123]` 这个引用标记**，被引用消息的图片和文本
 * 完全不在这次上报的 message 里。原来 parseNapCatMessage 直接把 reply 段删掉，
 * 结果我只收到「看看这是什么」，图片凭空消失 ——
 * 用户报「我其实引用了那张图片」（2026-09-13）。
 *
 * 拿到 id 后要用 NapCat 的 get_msg API 反查原消息内容。
 */
function extractReplyId(raw) {
  if (typeof raw === 'string') {
    const m = /\[CQ:reply,[^\]]*?id=(-?\d+)/.exec(raw)
    return m ? m[1] : null
  }
  if (Array.isArray(raw)) {
    for (const seg of raw) {
      if (seg?.type === 'reply' && seg.data?.id != null) return String(seg.data.id)
    }
  }
  return null
}

// NapCat 消息（数组或 CQ 码字符串）→ 纯文本；图片转 [图片] 占位
function parseNapCatMessage(raw) {
  if (raw == null) return ''
  if (typeof raw === 'string') {
    return raw
      .replace(/\[CQ:image[^\]]*\]/g, '[图片]')
      // 文件段要保留文件名：直接吃掉的话 AI 连「有个文件」都不知道
      .replace(/\[CQ:file,([^\]]*)\]/g, (m, attrs) => {
        const nm = /(?:^|,)file=([^,\]]+)/.exec(attrs)
        return `[文件: ${nm ? nm[1] : '未命名'}]`
      })
      .replace(/\[CQ:face[^\]]*\]/g, '')
      .replace(/\[CQ:reply[^\]]*\]/g, '')
      .replace(/\[CQ:at[^\]]*\]/g, '')
      .replace(/\[CQ:[^\]]*\]/g, '')
      .trim()
  }
  if (!Array.isArray(raw)) return String(raw)
  const out = []
  for (const seg of raw) {
    if (!seg || typeof seg !== 'object') continue
    if (seg.type === 'text') out.push(String(seg.data?.text ?? ''))
    else if (seg.type === 'image') out.push('[图片]')
    else if (seg.type === 'file') out.push(`[文件: ${seg.data?.file || seg.data?.name || '未命名'}]`)
    // face/at/reply 等忽略
  }
  return out.join('').trim()
}

/**
 * 探测某个端口上是不是已经有一个 QQ 桥在跑。
 *
 * 【为什么需要】三个地方能跑桥（CLI / Web / CCM），而 proot 与 Termux
 * 共享网络命名空间 —— 三端抢同一个端口时先起的独占，后起的 EADDRINUSE。
 * 原来那个失败是静默的（只在 console 打一行），用户只会觉得「消息没反应」。
 *
 * 有了这个函数，启动失败时能告诉用户**是谁占着**：
 *   「3000 已被 CLI 占用（pid 1234）—— 请先在那个端执行 /qq off」
 * 而不是干巴巴一句「端口被占用」。
 *
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<null | {endpoint, pid, port, owner, uptime}>}
 *          null = 端口空着，或占用者不是 QQ 桥（那也不用特殊提示）
 */
export async function probeQqBridge(port, timeoutMs = 1200) {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: ctl.signal })
    clearTimeout(t)
    const j = await r.json()
    // 只认自己人 —— 别的服务占着这个端口时不该冒充「QQ 桥」
    if (j?.service === 'claude-code-mobile-qq-bridge') return j
    return null
  } catch {
    return null
  }
}

/** 端标识 → 中文名（报错文案用） */
export function endpointLabelOf(name) {
  return ({ cli: 'CLI（Termux 终端）', web: 'Web 界面', ccm: 'CCM App（proot 内核）' })[name] || name || '未知端'
}

export class QQBridge {
  constructor({ logger = console, onMessage = null } = {}) {
    this.logger = logger
    this.server = null
    this.running = false
    this.onMessage = onMessage   // 私聊消息回调（由 index.mjs 注入 processInput）
    // 待处理队列：{ userId, message, messageId, images }
    this.queue = []
    // 当前这轮回复的收集
    this.replyParts = []
    this.replyTarget = null      // { userId, groupId }（groupId 非空 = 回复发到群）
    this._sendChain = Promise.resolve()
    this.incoming = false        // 当前 processInput 是否来自 QQ
    // CLI 同步：终端对话时把回复也发到 QQ（双端可见）
    this.syncTarget = null
    this.syncParts = ''
    // 本轮 flushReply 是否已发过：给 flushSync 做互斥，防同一段正文发两遍
    this._flushedThisRun = false
    // 运行时可配置项
    /** 端标识（'cli' / 'web' / 'ccm'），由宿主环境设置 —— 用于端口冲突时告诉用户「谁占着」 */
    this.endpointLabel = null
    /** 启动时间（GET 身份端点用来算 uptime） */
    this.startedAt = 0
    this.port = DEFAULT_PORT
    this.napcatApi = DEFAULT_NAPCAT_API
    this.owner = DEFAULT_OWNER
    /**
     * QQ 消息是否允许打断正在跑的 agent。默认 false（只排队）。
     *
     * 开着的风险：被打断那轮的收尾路径会命中 `myEpoch !== runEpoch` 直接 return，
     * 跳过错误提示/耗时输出/spinner 收尾，终端上看起来像「任务莫名其妙停了」。
     * 所以做成开关而不是默认行为，用 /qq interrupt on 打开。
     */
    this.allowInterrupt = false
    /**
     * 【放行模式】开启后群里**任何人** @ 机器人都能唤醒会话（不限主人）。
     *
     * 默认关闭。开着的风险很实在：这个桥直连能跑 Bash、改文件的 agent，
     * 放开等于把手机 shell 权限交给群里的每个人。所以：
     *   - 有恶意消息时 agent 自己能 /qq open off 关上（用户明确要求的能力）
     *   - 非主人唤醒的轮次会在注入文本里标明是谁，让 agent 知道来源不可信
     */
    this.openMode = false
    /**
     * 群消息环形缓存。**不注入会话**，只供 AI 用 QQRecall 主动回溯。
     * 元素: { groupId, groupName, userId, nickname, message, images[], at, atMe }
     */
    this.groupCache = []
    /** 机器人自己的 QQ 号（从上报的 self_id 学到，用于判断「@我」） */
    this.selfId = null
  }

  /**
   * 反查被引用的消息（走 NapCat get_msg API）。
   *
   * 引用消息的上报里只有 message_id，内容要单独拉。
   * 返回 { text, images[] }；拉不到就返回 null（不让引用失败阻断整条消息）。
   */
  async fetchQuoted(messageId) {
    const id = String(messageId || '').trim()
    if (!id) return null
    try {
      const r = await fetch(`${this.napcatApi}/get_msg`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_id: Number(id) }),
        signal: AbortSignal.timeout(10000),
      })
      const j = await r.json()
      if (j?.retcode !== 0 || !j.data) return null
      const raw = j.data.message ?? j.data.raw_message
      return {
        text: parseNapCatMessage(raw),
        images: extractImages(raw),
        sender: String(j.data.sender?.nickname || j.data.sender?.card || j.data.user_id || ''),
      }
    } catch {
      return null   // 拉不到不算错：至少让用户那句话正常进会话
    }
  }

  /** 开关放行模式（群里任何人都能 @ 唤醒） */
  setOpenMode(on) {
    const before = this.openMode
    this.openMode = !!on
    return {
      ok: true, openMode: this.openMode,
      msg: this.openMode
        ? `QQ 放行模式: 开启（群内任何人 @ 都能唤醒，不再限主人）`
          + (before ? '' : '\n⚠ 这等于把手机的操作权限开放给群里所有人 —— 有可疑消息随时 /qq open off 关上')
        : 'QQ 放行模式: 关闭（只有主人能唤醒）',
    }
  }

  /** 取群消息缓存（供 QQRecall 工具用）。limit 默认 20，可按群过滤 */
  recallGroup({ limit = 20, groupId = null, keyword = null } = {}) {
    let list = this.groupCache
    if (groupId) list = list.filter(m => m.groupId === String(groupId))
    if (keyword) {
      const k = String(keyword).toLowerCase()
      list = list.filter(m => m.message.toLowerCase().includes(k)
        || (m.nickname || '').toLowerCase().includes(k))
    }
    const n = Math.max(1, Math.min(Number(limit) || 20, GROUP_CACHE_MAX))
    return list.slice(-n)
  }

  /** 缓存里有几条 */
  groupCacheCount() { return this.groupCache.length }

  /** 开关「QQ 消息可打断 agent」 */
  setAllowInterrupt(on) {
    this.allowInterrupt = !!on
    return {
      ok: true, allowInterrupt: this.allowInterrupt,
      msg: `QQ 消息打断 Agent: ${this.allowInterrupt ? '开启（新消息会中止当前任务）' : '关闭（只排队，不打断）'}`,
    }
  }

  /** 设置监听端口（运行中需 /qq off && /qq on 重新监听） */
  /**
   * 设置端标识。宿主环境启动时调一次（CLI 传 'cli'，Web 传 'web'，CCM 传 'ccm'）。
   *
   * 【用途】端口被占用时，探测占用者的 GET / 响应，把它的 endpoint 报给用户：
   * 「3000 已被 CLI 占用」比「端口被占用」有用得多 —— 用户知道该去哪关。
   */
  setEndpointLabel(label) { this.endpointLabel = String(label || '') || null }

  setPort(port) {
    const n = Number(port)
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return { ok: false, msg: `端口无效: ${port}（需 1-65535 的整数）` }
    }
    const old = this.port
    this.port = n
    return { ok: true, port: n, msg: `QQ 桥监听端口: ${old} → ${n}` + (this.running ? '\n（正在运行，需 /qq off 再 /qq on 重新监听）' : '') }
  }

  /** 设置 NapCat HTTP API 地址 */
  setApi(url) {
    const u = String(url || '').trim()
    if (!/^https?:\/\/[^\s]+$/i.test(u)) {
      return { ok: false, msg: `地址无效: ${url}（需 http:// 或 https:// 开头）` }
    }
    const old = this.napcatApi
    this.napcatApi = u.replace(/\/+$/, '')
    return { ok: true, api: this.napcatApi, msg: `NapCat API: ${old} → ${this.napcatApi}` }
  }

  /** 设置主人 QQ 号（只有这个号私聊才进会话） */
  setOwner(userId) {
    const id = String(userId || '').trim()
    if (!/^\d{5,12}$/.test(id)) return { ok: false, msg: `QQ 号无效: ${userId}` }
    const old = this.owner
    this.owner = id
    return { ok: true, owner: id, msg: `主人 QQ: ${old} → ${id}` }
  }

  getEndpoints() {
    return {
      port: this.port, api: this.napcatApi, owner: this.owner,
      running: this.running, allowInterrupt: this.allowInterrupt,
      openMode: this.openMode,
    }
  }

  start() {
    if (this.running) return
    this.server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })

      // 【2026-09-24 加】GET 返回身份标识，而不是干巴巴的 {ok:true}。
      //
      // 【为什么】三个地方能跑桥（CLI / Web / CCM），而 proot 与 Termux 共享
      // 网络命名空间 —— 三端抢同一个端口时，先起的独占，后起的 EADDRINUSE。
      // 原来那个失败是静默的，用户只会觉得「QQ 消息没反应」。
      // 现在启动失败前先 GET 一下占用者，就能告诉用户「3000 被 CLI 占着，
      // 请先在那里 /qq off」，而不是干巴巴一句「端口被占用」。
      if (req.method === 'GET') {
        res.end(JSON.stringify({
          ok: true,
          service: 'claude-code-mobile-qq-bridge',
          // 端标识：由宿主环境启动时传入（见 setEndpointLabel）
          endpoint: this.endpointLabel || 'unknown',
          pid: process.pid,
          port: this.port,
          owner: this.owner,
          uptime: Math.round((Date.now() - (this.startedAt || Date.now())) / 1000),
        }))
        return
      }
      if (req.method !== 'POST') { res.end(JSON.stringify({ ok: true })); return }
      let body = ''
      req.on('data', c => body += c)
      req.on('end', async () => {
        try {
          const data = JSON.parse(body)
          const userId = String(data.user_id || '')
          const groupId = data.group_id ? String(data.group_id) : null
          const self = String(data.self_id || '')

          // 记住自己的 QQ 号，用来判断「@我」
          if (self) this.selfId = self
          // 自己发出去的消息不要回环处理
          if (self && self === userId) { res.end(JSON.stringify({ ok: true })); return }

          const rawStr = data.raw_message != null ? String(data.raw_message).trim() : ''
          const parsed = parseNapCatMessage(data.message)
          let rawMessage = parsed || rawStr
          const messageId = String(data.message_id ?? data.msg_id ?? '')
          const images = extractImages(effectiveBody(data))
          const files = extractFiles(effectiveBody(data))

          // ── 引用（回复）消息：把被引用的内容一并带进来 ──
          // 用户「引用那张图 + 问看看这是什么」时，上报里只有 [CQ:reply,id=x]，
          // 图片和原文都不在这次上报里，必须用 get_msg 反查（2026-09-13 修）。
          const replyId = extractReplyId(effectiveBody(data))
          if (replyId) {
            const q = await this.fetchQuoted(replyId)
            if (q && (q.text || q.images.length)) {
              // 被引用的图片合并进 images，让下载/多模态路径照常处理
              for (const u of q.images) if (!images.includes(u)) images.push(u)
              const who = q.sender ? `${q.sender}` : '某人'
              const quotedLine = q.text
                ? `【引用 ${who} 的消息】${q.text}`
                : `【引用 ${who} 的消息】(图片 ${q.images.length} 张)`
              rawMessage = rawMessage ? `${quotedLine}\n${rawMessage}` : quotedLine
            }
          }

          // ── 群消息 ──
          if (groupId) {
            const atMe = this.selfId
              ? hasAtTarget(effectiveBody(data), this.selfId)
              : false
            const nickname = String(data.sender?.card || data.sender?.nickname || '').trim()
            const groupName = String(data.group_name || '').trim()

            // 【@ 我 → 当成正式指令，回复发回这个群】
            // 默认只认主人：别人 @ 我也只是进缓存，否则群里任何人都能指挥这台手机。
            // 放行模式（/qq open on）下放开这条限制 —— 代价是 shell 权限对全群开放，
            // 所以给 agent 的能力是「发现可疑就自己关上」。
            const isOwnerMsg = userId === this.owner
            if (atMe && (isOwnerMsg || this.openMode)) {
              const cleaned = stripAtSegments(rawMessage, this.selfId)
              if (cleaned) {
                // 非主人的消息要在注入文本里标明来源 ——
                // agent 得知道这条指令不来自可信任的人，涉及敏感操作该先确认。
                const tagged = isOwnerMsg
                  ? cleaned
                  : `（放行模式｜非主人消息，来自 ${nickname || userId}）\n${cleaned}`
                this.queue.push({
                  userId, groupId, message: tagged, messageId, images, files,
                  isOwner: isOwnerMsg, nickname,
                })
                this.logger.log(`[QQ桥] 群 ${groupId} ${isOwnerMsg ? '主人' : '放行'}@我: ${cleaned.slice(0, 50)}`)
                if (typeof this.onMessage === 'function') {
                  this.onMessage({
                    userId, groupId, message: tagged,
                    isOwner: isOwnerMsg, nickname,
                  })
                }
                res.end(JSON.stringify({ ok: true }))
                return
              }
            }

            // 【其他群消息 → 只进缓存，不注入会话】
            // 供 AI 用 QQRecall 主动回溯（「看下刚才群里那张图」）。
            if (rawMessage || images.length) {
              this.groupCache.push({
                groupId, groupName, userId, nickname,
                message: rawMessage, images, atMe,
                at: Date.now(),
              })
              if (this.groupCache.length > GROUP_CACHE_MAX) {
                this.groupCache.splice(0, this.groupCache.length - GROUP_CACHE_MAX)
              }
            }
            res.end(JSON.stringify({ ok: true }))
            return
          }

          // ── 私聊：只有主人能用，别人静默丢弃 ──
          if (userId !== this.owner) { res.end(JSON.stringify({ ok: true })); return }
          if (!rawMessage) { res.end(JSON.stringify({ ok: true })); return }

          const dmNick = String(data.sender?.card || data.sender?.nickname || '').trim()
          this.queue.push({
            userId, groupId: null, message: rawMessage, messageId, images, files,
            isOwner: true, nickname: dmNick,
          })
          this.logger.log(`[QQ桥] 收到私聊 ${userId}: ${rawMessage.slice(0, 60)}`)
          if (typeof this.onMessage === 'function') this.onMessage({ userId, groupId: null, message: rawMessage })
          res.end(JSON.stringify({ ok: true }))
        } catch (e) {
          this.logger.error(`[QQ桥] 解析上报失败: ${e.message}`)
          res.end(JSON.stringify({ ok: true, error: e.message }))
        }
      })
    })
    this.server.on('error', (e) => {
      this.running = false
      this.logger.error(`[QQ桥] 监听 ${this.port} 失败: ${e.message}`)
    })
    this.server.listen(this.port, () => {
      this.running = true
      this.startedAt = Date.now()
      this.logger.log(`[QQ桥] 已启动，监听 ${this.port}（仅主人 ${this.owner} 私聊）`)
    })
  }

  /**
   * 带冲突诊断的启动。
   *
   * 【与 start() 的区别】start() 是同步的、失败只往 logger 写一行 ——
   * 那是 2026-09 之前只有 CLI 一个使用者时的写法。现在三个端可能抢同一个
   * 端口（proot 与 Termux 共享网络命名空间），静默失败会变成
   * 「QQ 消息没反应」这种查不出原因的怪现象。
   *
   * 这里做三件事：
   *   1. 先探测端口 —— 如果已经有一个**自己人**占着，直接返回冲突详情，
   *      连 start() 都不用试（省掉一次必然失败的 listen）
   *   2. 正常 start()
   *   3. 如果 listen 仍失败（比如探测时刚好还没起来），回退到错误事件里的信息
   *
   * @returns {Promise<{ok: boolean, conflict?: {endpoint, pid, port}, reason?: string}>}
   */
  async startChecked() {
    if (this.running) return { ok: true }

    // ① 探测占用者
    const occupant = await probeQqBridge(this.port)
    if (occupant) {
      const who = endpointLabelOf(occupant.endpoint)
      return {
        ok: false,
        conflict: occupant,
        reason: `端口 ${this.port} 已被${who}占用（pid ${occupant.pid}）。`
          + `\nQQ 消息会全部进那个端 —— 请先在那里执行 /qq off，再回来开启。`,
      }
    }

    // ② 正常启动，捕获 listen 错误
    const err = await new Promise((resolve) => {
      let settled = false
      const onErr = (e) => { if (!settled) { settled = true; this.server?.off?.('error', onErr); resolve(e) } }
      try {
        this.server = null   // start() 内部会重建
        this.server = undefined
        // start() 是同步的，它自己注册 error 监听；这里临时再挂一个捕获首次错误
        const origCreate = this.server
        this.start()
        // start() 里 `this.server` 已被赋值
        this.server?.once?.('error', onErr)
        // 给 listen 一点时间：成功的话 running 会变 true
        setTimeout(() => { if (!settled) { settled = true; resolve(null) } }, 400)
      } catch (e) { if (!settled) { settled = true; resolve(e) } }
    })

    if (err) {
      // 兜底：可能是探测之后才被占的
      const occ2 = await probeQqBridge(this.port)
      return {
        ok: false,
        conflict: occ2 || undefined,
        reason: occ2
          ? `端口 ${this.port} 已被${endpointLabelOf(occ2.endpoint)}占用（pid ${occ2.pid}）。`
            + `\nQQ 消息会全部进那个端 —— 请先在那里执行 /qq off。`
          : `监听 ${this.port} 失败：${err.message}`,
      }
    }

    return this.running ? { ok: true } : { ok: false, reason: `监听 ${this.port} 未成功（可能端口被非 QQ 桥程序占用）` }
  }

  stop() {
    if (this.server) { try { this.server.close() } catch {} this.server = null }
    this.running = false
  }

  pending() { return this.queue.length > 0 }

  /** 队列里还有几条待处理 */
  pendingCount() { return this.queue.length }

  /**
   * 预览队列（不消费）。给 Ctrl+P/N 翻看、Ctrl+G 删除用。
   * 返回 [{ index, userId, message, hasImages }]
   */
  /**
   * 查看队列（不消费）。
   *
   * 【2026-09-24 补字段】原来只返回 index/userId/message/hasImages 四个，
   * groupId 被丢掉了 —— 后果是调用方拿不到「这条来自群还是私聊」，
   * 群里 @我 的回复会不知道该发回哪（replyTarget 的 groupId 依赖它）。
   * 实测：web/qq-integration.mjs 的 drain() 从 peekQueue 取 groupId 拿到 undefined。
   *
   * 补上 groupId / nickname / isOwner —— 这几个都是「显示来源」和
   * 「决定回复目标」需要的，不是内部状态，适合暴露。
   */
  peekQueue() {
    return this.queue.map((it, i) => ({
      index: i,
      userId: it.userId,
      groupId: it.groupId || null,
      nickname: it.nickname || '',
      isOwner: it.isOwner !== false,
      message: String(it.message || ''),
      hasImages: Array.isArray(it.images) && it.images.length > 0,
    }))
  }

  /**
   * 按下标删除一条排队消息。
   *
   * 【为什么必须有】QQ 队列是桥内部的独立数组，终端的 Ctrl+G 只删 pendingInputs，
   * 删不到这里 —— 用户报「QQ 消息排队后删不掉」。
   * @returns {object|null} 被删掉的那条（供调用方回显），越界返回 null
   */
  deleteQueued(index) {
    const i = Number(index)
    if (!Number.isInteger(i) || i < 0 || i >= this.queue.length) return null
    return this.queue.splice(i, 1)[0] || null
  }

  /** 清空整个队列，返回清掉的条数 */
  clearQueue() {
    const n = this.queue.length
    this.queue = []
    return n
  }

  /**
   * 把 QQ 图片 URL 下载到本地，返回本地路径数组。
   *
   * 为什么要落盘：QQ 图片 URL 带鉴权参数且很快失效，不能直接丢给模型；
   * 而 CLI 已有的多模态机制（core/image.mjs 的 extractImagePathsFromText）
   * 只认**本地路径**——消息文本里出现图片路径就会自动附带。
   * 所以下载到本地后把路径拼进注入文本，图片就能被看见，无需另造一套通道。
   */
  static async downloadImages(urls, dir) {
    const out = []
    if (!Array.isArray(urls) || urls.length === 0) return out
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    try { mkdirSync(dir, { recursive: true }) } catch {}
    for (let i = 0; i < urls.length && i < 4; i++) {   // 单条消息最多取 4 张，防刷
      const url = String(urls[i] || '').replace(/&amp;/g, '&')   // CQ 码里 & 被转义过
      if (!/^https?:\/\//i.test(url)) continue
      try {
        const ctl = new AbortController()
        const timer = setTimeout(() => ctl.abort(), 20000)
        const resp = await fetch(url, { signal: ctl.signal })
        clearTimeout(timer)
        if (!resp.ok) continue
        const buf = Buffer.from(await resp.arrayBuffer())
        if (buf.length === 0 || buf.length > 12 * 1024 * 1024) continue   // 空/超大跳过
        // 按魔数判扩展名：QQ 的 URL 常常不带后缀，靠后缀猜会得到 .png 假名
        let ext = 'jpg'
        if (buf[0] === 0x89 && buf[1] === 0x50) ext = 'png'
        else if (buf[0] === 0x47 && buf[1] === 0x49) ext = 'gif'
        else if (buf.slice(8, 12).toString() === 'WEBP') ext = 'webp'
        const p = join(dir, `qq-${Date.now()}-${i}.${ext}`)
        writeFileSync(p, buf)
        out.push(p)
      } catch {}   // 单张失败不影响其他张，也不该让整条消息进不来
    }
    return out
  }

  next() {
    const item = this.queue.shift()
    if (!item) return null
    // 标记本轮来自 QQ，回复要发回去
    this.incoming = true
    // 带上 groupId：群里 @我 的消息，回复要发回**那个群**而不是私聊。
    // _post 早就支持 group_id，只是原来 replyTarget 只存 userId 丢掉了群信息。
    this.replyTarget = { userId: item.userId, groupId: item.groupId || null }
    this.replyParts = []
    // ⚠ 必须清掉同步通道，否则每轮末尾会多发一条（用户报「回复完最后又多了张图」）。
    //
    // syncTarget 是「终端对话时把回复也同步到 QQ」用的，由上一轮终端输入设置，
    // 而它只在 isQqInput 分支被 clear —— QQ 的 slash 命令剥包装后 isQqInput 是 false，
    // 普通 QQ 消息虽然会 clear，但那是在 processInput 里、晚于这里。
    // 结果 incoming 和 syncTarget 同时为真，收尾时 flushReply + flushSync 各发一次。
    // QQ 轮次的回复由 replyTarget 负责，不需要同步通道。
    this.syncTarget = null
    this.syncParts = ''
    return item
  }

  /** 把疑似密钥打码，避免回复里把 key 发到 QQ 上 */
  static maskSensitive(text) {
    return String(text)
      .replace(/\b(sk-[A-Za-z0-9_\-]{8,})/g, (m) => m.slice(0, 6) + '***' + m.slice(-4))
      .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,})/g, (m) => m.slice(0, 7) + '***' + m.slice(-4))
      .replace(/\b(Bearer\s+)[A-Za-z0-9._\-]{16,}/gi, '$1***')
  }

  /**
   * 把收到的 QQ 文件落到本地，返回本地路径数组。
   *
   * NapCat 的 file 段多数不带可直接下载的 url，要调 get_file API 用 file_id
   * 换取本地路径（NapCat 自己已经把文件下到它的缓存目录了）。
   * 两条路都试：有 url 就下载，没有就问 API 要路径。
   */
  async fetchFiles(files, dir) {
    const out = []
    if (!Array.isArray(files) || files.length === 0) return out
    const { mkdirSync, writeFileSync, existsSync, copyFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    try { mkdirSync(dir, { recursive: true }) } catch {}

    for (let i = 0; i < files.length && i < 3; i++) {   // 单条消息最多取 3 个
      const f = files[i]
      const safeName = String(f.name || `file-${i}`).replace(/[/\\:*?"<>|]/g, '_').slice(0, 80)
      const dest = join(dir, `${Date.now()}-${safeName}`)
      try {
        // 1) NapCat 已有本地路径 → 直接复制（最快，不走网络）
        if (f.path && existsSync(f.path)) {
          copyFileSync(f.path, dest)
          out.push(dest); continue
        }
        // 2) 有 url → 下载
        if (f.url && /^https?:\/\//i.test(f.url)) {
          const ctl = new AbortController()
          const timer = setTimeout(() => ctl.abort(), 60000)
          const resp = await fetch(f.url, { signal: ctl.signal })
          clearTimeout(timer)
          if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer())
            if (buf.length > 0 && buf.length <= 64 * 1024 * 1024) {
              writeFileSync(dest, buf)
              out.push(dest); continue
            }
          }
        }
        // 3) 只有 file_id → 问 NapCat 要路径
        if (f.fileId) {
          const r = await fetch(`${this.napcatApi}/get_file`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_id: f.fileId }),
            signal: AbortSignal.timeout(30000),
          })
          const j = await r.json()
          const p = j?.data?.file || j?.data?.path || ''
          if (p && existsSync(p)) { copyFileSync(p, dest); out.push(dest); continue }
        }
      } catch {
        // 静默：单个附件拉取失败不打扰终端（可能只是那张图过期了）
      }
    }
    return out
  }

  /**
   * 主动推送本地文件到主人 QQ。
   *
   * 图片走 CQ:image（显示成图片气泡），其他走 CQ:file（文件传输）。
   * 只发给 owner —— 不给「发给任意人」的能力，避免 AI 被诱导向他人发东西。
   *
   * @param {string} filePath 本地绝对路径
   * @param {string} [caption] 附带的文字说明（先发文字再发文件）
   */
  async sendFile(filePath, caption = '') {
    const p = String(filePath || '').trim()
    if (!p) return { ok: false, msg: '路径为空' }
    const { existsSync, statSync } = await import('node:fs')
    if (!existsSync(p)) return { ok: false, msg: `文件不存在: ${p}` }
    let size = 0
    try {
      const st = statSync(p)
      if (st.isDirectory()) return { ok: false, msg: '不能直接发目录，请先打包成 zip' }
      size = st.size
    } catch (e) { return { ok: false, msg: `读取失败: ${e.message}` } }
    if (size === 0) return { ok: false, msg: '文件为空' }
    // QQ 私聊文件上限约 1GB，但手机上传大文件不现实，卡在 200MB
    if (size > 200 * 1024 * 1024) {
      return { ok: false, msg: `文件过大（${(size / 1024 / 1024).toFixed(1)}MB），上限 200MB` }
    }

    if (caption && caption.trim()) {
      await this._post(this.owner, null, QQBridge.maskSensitive(caption))
      await new Promise((r) => setTimeout(r, 300))
    }

    const isImg = /\.(png|jpe?g|gif|webp|bmp)$/i.test(p)
    const seg = isImg
      ? `[CQ:image,file=file://${p}]`
      : `[CQ:file,file=file://${p}]`
    const r = await this._post(this.owner, null, seg)
    if (r && r.retcode === 0) {
      return { ok: true, kind: isImg ? 'image' : 'file', size, msg: `已发送${isImg ? '图片' : '文件'}（${(size / 1024).toFixed(0)}KB）` }
    }
    return { ok: false, msg: `发送失败: ${r?.message || r?.wording || JSON.stringify(r || {}).slice(0, 120)}` }
  }

  /** 底层发送：把一个 message 段（文本或 CQ 码）POST 给 NapCat */
  async _post(userId, groupId, message) {
    const payload = groupId ? { group_id: groupId, message } : { user_id: userId, message }
    try {
      const r = await fetch(`${this.napcatApi}/send_msg`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      })
      return await r.json()
    } catch (e) {
      // 发送失败静默：QQ 发不出去不该影响终端使用
      return { status: 'error', msg: e.message }
    }
  }

  /**
   * 发送 QQ 私聊消息。
   *
   * 【为什么不再按标点切分】原来 splitForQQ 按 250 字符 + 标点硬切，
   * 加上 feedText 流式过程中又按句号边界一句句发，一段话被切得七零八落
   * （用户原话「句子拆分也跟坨屎一样」）。现在改成：
   *   - 一轮回复整体发一条，不切
   *   - 超过 IMAGE_THRESHOLD 就渲染成图片发（带代码块的长回复看图比看几十条消息清楚）
   *   - 转图失败则降级：直接发原文（宁可长，也不能发不出去）
   */
  /**
   * @param {object} [opts]
   *   - forceImage: 无论长短都转图。slash 命令输出用它 ——
   *     那些输出大多是表格/面板（/context、/config list、/help），
   *     纯文本发到 QQ 会因为等宽假设失效而错行，转图才看得清。
   *   - title: 图片顶部标题
   */
  async send(userId, groupId, text, opts = {}) {
    if (!text || !text.trim()) return { status: 'error', msg: 'empty' }
    const masked = QQBridge.maskSensitive(text)
    // 打码照做但不提示 —— 这是保护措施正常生效，不是异常

    if (opts.forceImage || masked.length > Math.min(IMAGE_THRESHOLD, HARD_LIMIT)) {
      try {
        const { textToImage } = await import('../phone/text2image.mjs')
        const png = await textToImage(masked, { title: opts.title || '' })
        if (png) {
          // CQ 码发本地文件：file:// 前缀，NapCat 自己读盘上传
          const r = await this._post(userId, groupId, `[CQ:image,file=file://${png}]`)
          if (r && r.retcode === 0) return r
          // 图发失败（比如 NapCat 读不到路径）→ 落回文本，不让消息丢
          // 静默：降级为文本已经发生，用户能收到就够了
        }
      } catch {
        // 静默：降级为文本已经发生，用户能收到就够了
      }
    }
    // 降级发文本时也要守住协议上限：超过 HARD_LIMIT 直接发会被 QQ 拒收
    // （实测 8000 汉字就 EventChecker Failed），截断并标注比整条发不出去好。
    if (masked.length > HARD_LIMIT) {
      const cut = masked.slice(0, HARD_LIMIT - 40)
      return await this._post(userId, groupId, `${cut}\n\n…（内容过长已截断，完整内容见终端）`)
    }
    return await this._post(userId, groupId, masked)
  }

  // === 回复收集 ===
  // QQ 来的轮次：按句子边界一句句发（像真人说话，不攒到整轮结束）
  // CLI 来的轮次：若设了 syncTarget，整段攒着，flushSync 时一次发出
  setSyncTarget(target) { this.syncTarget = target || null }
  clearSyncTarget() { this.syncTarget = null }

  /**
   * 收集流式正文。
   *
   * 【按 turn 发，不按标点发】原来这里一边收流一边匹配句末标点，凑够一句就发一条，
   * 结果一轮回复变成十几条碎消息，且断点常常在半句话上。
   * 现在只攒不发，等 flushReply()（一轮结束）统一发一条 —— 超长的会转成图片。
   */
  feedText(text) {
    if (!this.incoming && !this.syncTarget) return
    if (!text) return
    // incoming 优先：QQ 轮次只走 replyParts，绝不能同时往 syncParts 写，
    // 否则 flushReply + flushSync 会把同一段正文发两遍。
    if (this.incoming) { this.replyParts.push(text); return }
    this.syncParts = (this.syncParts || '') + text
  }

  /** @param {object} [explicitTarget] flushReply 清状态后仍要发，故显式传入 */
  _queueSend(text, explicitTarget = null) {
    const target = explicitTarget || this.replyTarget
    if (!target) return
    // catch 必须挂在链上：一次失败若让 _sendChain 变成 rejected 状态，
    // 后面所有 .then 都会被跳过 —— 一条发失败会导致之后再也发不出去。
    this._sendChain = this._sendChain.then(async () => {
      // ⚠ groupId 必须从 target 取，不能写死 null ——
      //   写死的话群里 @我 的回复会跑到私聊去（2026-09-13 加群支持时发现）。
      await this.send(target.userId, target.groupId || null, text)
      await new Promise(res => setTimeout(res, 200))
    }).catch((e) => {
      // 静默：QQ 发不出去不该影响终端使用（用户可能压根没连桥）
    })
  }

  /**
   * 一个 turn 结束：把这个 turn 攒的正文发一条。
   *
   * 用户要的是「按 turn 发」——一次 run 里可能有十几个 turn（每轮工具调用算一个），
   * 全攒到最后发一条会变成一坨巨长消息。这里在每个 turn 边界发一次，
   * 既不像原来按标点切得七零八落，也不会攒成一整坨。
   *
   * 注意 replyTarget 不清：run 还没结束，后续 turn 和 flushReply 还要用它。
   */
  flushTurn() {
    // QQ 轮次：按 turn 发一条
    if (this.incoming && this.replyTarget) {
      const text = this.replyParts.join('').trim()
      this.replyParts = []
      if (!text) return Promise.resolve()
      this._queueSend(text, this.replyTarget)
      return this._sendChain
    }
    // 终端对话 + 开了同步（syncTarget）：同样要按 turn 发。
    //
    // ⚠ 这条路径原来完全没有 turn 边界处理：feedText 把整轮所有 turn 的正文
    //   都攒进 syncParts，最后 flushSync 合成一条发出去 ——
    //   用户看到的就是「回复完最后又多一张按老版本攒轮数切分的超长图」。
    //   按 turn 发的改造只覆盖了 incoming 分支，漏了这条。
    if (this.syncTarget) {
      const text = (this.syncParts || '').trim()
      this.syncParts = ''
      if (!text) return Promise.resolve()
      const target = this.syncTarget
      this._sendChain = this._sendChain.then(async () => {
        await this.send(target.userId, target.groupId, text)
        await new Promise((res) => setTimeout(res, 200))
      }).catch((e) => {
        // 静默：QQ 发不出去不该影响终端使用（用户可能压根没连桥）
      })
      return this._sendChain
    }
    return Promise.resolve()
  }

  /**
   * 一轮结束：把攒好的回复发回 QQ。
   *
   * 【必须 await】原来这是同步函数，只把任务挂进 _sendChain 就返回。
   * 按句子发的时代无所谓（流式过程中已经发出去好几条了），
   * 但改成「整轮只发一次」之后，挂完链就没人等 —— 转图要跑几秒 python，
   * 这期间进程去处理下一轮，链上的发送和异常都被静默吞掉，
   * 表现就是「回复压根没发到 QQ」。所以返回 _sendChain 让调用方能等。
   */
  flushReply() {
    if (!this.incoming || !this.replyTarget) return Promise.resolve()
    const text = this.replyParts.join('').trim()
    // ⚠ 先取出 target 再清状态：_queueSend 读的是 this.replyTarget，
    //   如果先置 null 再调它，那句 `if (!this.replyTarget) return` 会直接返回，
    //   一个字都发不出去。所以这里把 target 显式传进去。
    const target = this.replyTarget
    this.incoming = false
    this.replyTarget = null
    this.replyParts = []
    // 标记「这是 QQ 轮次，已由 replyTarget 通道发出」：
    // 紧随其后的 flushSync 据此跳过，避免同一段经 syncTarget 再发一遍。
    // 只对 QQ 轮次置位 —— 终端对话轮次要让 flushSync 正常工作。
    this._flushedThisRun = true
    if (!text) return Promise.resolve()
    this._queueSend(text, target)
    return this._sendChain
  }

  /**
   * CLI 同步模式收尾：把攒的回复发到 syncTarget（失败静默）。
   *
   * 【与 flushReply 互斥】两者都在 index.mjs 收尾处被连续调用。
   * 如果本轮是 QQ 轮次（flushReply 已经发过），这里必须什么都不做，
   * 否则同一段正文发两遍 —— 用户看到的就是「回复完最后又多一条」。
   */
  async flushSync() {
    const target = this.syncTarget
    const text = (this.syncParts || '').trim()
    this.syncParts = ''
    if (!target || !text) return
    // QQ 轮次的回复已由 flushReply 走 replyTarget 发出，不重复发
    if (this._flushedThisRun) { this._flushedThisRun = false; return }
    try { await this.send(target.userId, target.groupId, text) } catch {}
  }

  cancel() {
    this.incoming = false
    this.replyTarget = null
    this.replyParts = []
  }
}
