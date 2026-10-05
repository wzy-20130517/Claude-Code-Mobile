/**
 * CCM / Web 侧的 QQ 桥集成。
 *
 * 【为什么单独一个模块】
 * CLI 侧 QQ 桥的接线写在 index.mjs 里（约 1745 行起，200 多行内联逻辑），
 * 那些代码和终端强耦合（C 颜色对象、emit 到 stdout、pendingInputs 队列、
 * queueSuspended 状态、Ctrl+C 的 abortController）。Web 侧没有这些，
 * 照搬过来只会得到一堆 no-op。
 *
 * 这里只保留**桥本身的语义**，把终端相关部分换成 Web 的等价物：
 *   · emit 到 stdout        → emit(runtime, 'qq_message') 走 SSE
 *   · pendingInputs 队列    → runtime.running 判断 + 稍后重试
 *   · abortController.abort → runtime.controller.abort()
 *   · 终端 Ctrl+C 挂起      → 不需要（Web 有停止按钮）
 *
 * 【为什么能跑】QQ 桥只依赖 node:http（监听 NapCat 的 HTTP 上报）
 * 和 fetch（调 NapCat API 回发消息）。NapCat 是用户自己在 Termux 里跑的
 * 独立进程 —— 两者通过 127.0.0.1 通信，proot 和 Termux 共享网络命名空间，
 * 所以 CCM 里连 Termux 的 NapCat 没有任何障碍。
 * 桥**不需要**把 NapCat 装进 proot。
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
// 配置读写统一走 core/qq-config.mjs —— 开关**按端分**（endpoints.cli/.web/.ccm），
// 端口共用（同一时间只允许一个端监听）。详见该文件头部的设计说明。
import {
  QQ_CONFIG_PATH,
  loadQqConfig as loadQqConfigShared,
  saveQqConfig as saveQqConfigShared,
  detectEndpoint,
  otherEnabledEndpoints,
  endpointLabelOf,
} from '../core/integrations/qq-config.mjs'

export { QQ_CONFIG_PATH }

/** 当前端的配置（Web 或 CCM，由 CCM_MODE / CCM_WEB 决定） */
export function loadQqConfig() { return loadQqConfigShared(detectEndpoint()) }

export function saveQqConfig(patch) { return saveQqConfigShared(patch, detectEndpoint()) }

/** 打断关键词（与 CLI 侧保持一致） */
const INTERRUPT_WORDS = /^\s*(停|停下|停止|暂停|打断|中断|别跑了|别做了|stop|abort|cancel|esc|\^c)\s*[。.!！~]*\s*$/i
/** 放行关键词（对应终端里的空行回车） */
const RESUME_WORDS = /^\s*(继续|放行|go|continue|resume)\s*[。.!！~]*\s*$/i

/**
 * 启动 QQ 桥并接到 Web 会话上。
 *
 * @param {object} opts
 * @param {Function} opts.getActiveRuntime  () => 当前应该接收 QQ 消息的会话 runtime
 * @param {Function} opts.runMessage        (runtime, content, attachments) => Promise
 * @param {Function} opts.emit              (runtime, type, data) => void
 * @returns {Promise<{bridge: object|null, reason?: string}>}
 */
export async function startWebQqBridge({ getActiveRuntime, runMessage, emit, logger = console, force = false }) {
  const cfg = loadQqConfig()

  // 默认关：用户没显式开过就不启动。
  // 与 CLI 的区别：CLI 是「/qq on」才监听，Web 同样 —— 但 Web 没有启动参数，
  // 所以把开关状态记在配置文件里（enabled 字段），/qq on 会写进去。
  //
  // force=true 供 /qq on 使用：用户刚敲的命令就是明确的开启意图，
  // 不该因为「配置里还没写 enabled」而被拒绝。
  if (!force && cfg.enabled !== true) {
    return { bridge: null, reason: '未启用（用 /qq on 开启）' }
  }

  const { QQBridge } = await import('../core/integrations/qq-bridge.mjs')

  let bridge = null
  bridge = new QQBridge({
    // 只报错误。消息本身注入会话时已经带了「【QQ消息｜来自 xxx】」的头，
    // 再打一行日志就是同一件事说两遍（与 CLI 侧同样处理）。
    logger: {
      log: () => {}, info: () => {},
      warn: (t) => logger.warn?.(t), error: (t) => logger.error?.(t),
    },
    onMessage: () => { try { drain() } catch (e) { logger.error?.('[QQ桥] 处理失败:', e?.message || e) } },
  })

  // 端标识：让端口冲突时能说清「谁占着」（CLI / Web / CCM）
  bridge.setEndpointLabel(detectEndpoint())

  // 配置应用到桥
  bridge.setPort(cfg.port)
  if (cfg.napcatApi) bridge.setApi(cfg.napcatApi)
  if (cfg.owner) bridge.setOwner(cfg.owner)
  if (cfg.allowInterrupt === true) bridge.setAllowInterrupt(true)
  if (cfg.openMode === true) bridge.setOpenMode(true)

  /**
   * 把桥队列里的消息送进会话。
   *
   * 【为什么不直接调 runMessage】
   * runMessage 在 runtime.running 时抛 409。QQ 消息不该打断正在跑的轮次
   * （用户可能正在终端/网页里等一个长任务），所以忙的时候**延迟重试**，
   * 而不是抢占 —— 与 CLI 侧的 drain() 行为一致。
   */
  const drain = async () => {
    if (!bridge.pending()) return

    const head = bridge.peekQueue()[0]
    if (!head) return

    // ── 打断指令 ──
    // 用户人在外面（只有手机 QQ），按不到网页上的停止按钮，
    // 所以必须有 QQ 侧的入口。发「停」即可打断，不需要预先开开关。
    if (INTERRUPT_WORDS.test(head.message || '')) {
      bridge.deleteQueued(0)
      const rt = getActiveRuntime()
      if (rt?.running && rt.controller) {
        try { rt.controller.abort(); rt.interruptedRun = 'qq-stop' } catch {}
        bridge.send(bridge.owner, null, '已打断当前任务。发新消息继续。').catch(() => {})
        emit?.(rt, 'qq_interrupt', { reason: 'stop-word' })
      } else {
        bridge.send(bridge.owner, null, '当前没有正在跑的任务。').catch(() => {})
      }
      if (!bridge.pending()) return
    }

    // ── 放行指令（对应终端空行回车）──
    const head2 = bridge.peekQueue()[0]
    if (head2 && RESUME_WORDS.test(head2.message || '')) {
      bridge.deleteQueued(0)
      if (!bridge.pending()) {
        bridge.send(bridge.owner, null, '队列已空，没有待执行的消息。').catch(() => {})
        return
      }
    }

    // ── 全局打断开关（默认关）──
    const rt0 = getActiveRuntime()
    if (bridge.allowInterrupt && rt0?.running && rt0.controller) {
      try { rt0.controller.abort() } catch {}
    }

    // ── 忙就等，不抢占 ──
    const rt = getActiveRuntime()
    if (!rt || rt.running) {
      setTimeout(drain, 800)
      return
    }

    const item = bridge.next()
    if (!item) return

    // 图片/文件先下载到本地再注入（extractImagePathsFromText 只认本地路径，
    // 直接塞 QQ 的鉴权 URL 是看不到图的）
    const imgs = Array.isArray(item.images) ? item.images : []
    const fls = Array.isArray(item.files) ? item.files : []
    let attachments = []
    try {
      const imgDir = join(homedir(), '.claude-code-mobile', 'qq-images')
      const fileDir = join(homedir(), '.claude-code-mobile', 'qq-files')
      const [imgPaths, filePaths] = await Promise.all([
        imgs.length ? QQBridge.downloadImages(imgs, imgDir) : Promise.resolve([]),
        fls.length ? bridge.fetchFiles(fls, fileDir) : Promise.resolve([]),
      ])
      attachments = [...(imgPaths || []), ...(filePaths || [])]
    } catch (e) { logger.warn?.('[QQ桥] 附件下载失败:', e?.message || e) }

    const who = item.nickname ? `${item.nickname}(${item.userId})` : item.userId
    const from = item.groupId ? `群${item.groupId} · ${who}` : `用户${item.userId}`
    const content = `【QQ消息｜来自 ${from}】\n${item.message || ''}`

    // 回复目标：QQ 消息的回复发回来源（私聊回私聊、群 @ 回那个群）
    bridge.setSyncTarget({ userId: item.userId, groupId: item.groupId || null })
    try {
      emit?.(rt, 'qq_message', { from, text: String(item.message || '').slice(0, 200) })
      await runMessage(rt, content, attachments)
    } catch (e) {
      logger.error?.('[QQ桥] 消息处理失败:', e?.message || e)
      bridge.clearSyncTarget()
      bridge.send(item.userId, item.groupId || null, `处理失败：${e?.message || e}`).catch(() => {})
      return
    }

    // 本轮结束 → 把累积的正文发回 QQ，并清掉目标
    try { await bridge.flushReply() } catch {}
    try { bridge.clearSyncTarget() } catch {}

    if (bridge.pending()) setTimeout(drain, 300)
  }

  // 端口冲突不该让整个 Web 服务起不来 —— QQ 是附加功能。
  //
  // 用 startChecked()：它会先探测端口上的占用者是不是「另一个端的 QQ 桥」，
  // 是的话给出可操作的提示（「3000 已被 CLI 占用，请先在那里 /qq off」），
  // 而不是原来那种静默失败 —— 用户只看到「QQ 消息没反应」，查不出原因。
  const r = await bridge.startChecked()
  if (!r.ok) return { bridge: null, reason: r.reason, conflict: r.conflict }
  return { bridge }
}
