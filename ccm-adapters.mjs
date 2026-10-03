/**
 * 原生桥适配层 —— 让现有工具在 CCM 原生环境下自动走无障碍服务。
 *
 * 【设计原则：包装而非重写】
 *
 * 现有 core/tools-phone.mjs 的实现是「rish + dumpsys/uiautomator」路线，
 * 它在 Termux 里工作良好。我们不想删掉它（Termux 模式还要用），
 * 也不想 fork 一份（两份代码会漂移）。
 *
 * 所以用**运行时适配**：
 *   1. 启动时探测原生桥
 *   2. 可用 → 用原生实现替换工具实例的 execute
 *   3. 不可用 → 保持原样（Termux 模式）
 *
 * 这样：
 *   - 同一份代码，两种环境都能跑
 *   - Agent 看到的工具名/参数/返回格式完全一致
 *   - 原生实现出问题时可以一键回退
 *
 * 【用法】
 *   import { applyNativeAdapters } from './ccm-adapters.mjs'
 *   const toolkit = createEngineToolkit(...)
 *   await applyNativeAdapters(toolkit)   // 原地替换，返回是否生效
 */

import { hasNativeBridge, nativeCall } from './ccm-bridge.mjs'

/** 标记：是否已应用过原生适配（幂等） */
let _applied = false

/**
 * 上次探测失败的时间戳 + 连续失败次数。
 *
 * 【为什么需要】原生桥（Kotlin 侧 127.0.0.1:3457）可能比 Node 后起来 ——
 * Node 由 CcmService 启动，而桥服务器也在同一个 Service 里，两者有竞态。
 * 如果启动那一刻桥还没就绪，applyNativeAdapters 会返回 applied:false，
 * 然后 toolkit 就**一直**用 Termux 实现（sed/am 那些在 proot 里不存在的命令）。
 *
 * 更糟的是：buildAgent 有缓存（runtime.agent 存在就直接返回），
 * 所以不会重新走适配逻辑 —— 除非用户改配置触发 invalidateRuntimeEngine。
 *
 * 现在记录失败时间，允许在 [RETRY_WINDOW_MS] 内重试。
 * 调用方（buildAgent）每次新建 toolkit 时都会调 applyNativeAdapters，
 * 只要还在重试窗口内且尚未成功，就会再探测一次。
 */
let _lastProbeFailAt = 0
let _probeFailCount = 0
const RETRY_WINDOW_MS = 5 * 60_000   // 5 分钟内允许重试

/** 是否值得再试一次（供 server.mjs 判断要不要重建 toolkit） */
export function shouldRetryNativeAdapters() {
  if (_applied) return false
  if (_lastProbeFailAt === 0) return true          // 从没试过
  return Date.now() - _lastProbeFailAt < RETRY_WINDOW_MS
}

/** 诊断信息（/doctor 用） */
export function nativeAdapterStatus() {
  return { applied: _applied, failCount: _probeFailCount, lastFailAt: _lastProbeFailAt || null }
}

/**
 * 把 toolkit 里的 phone 工具替换成原生实现。
 *
 * @param {object} toolkit 引擎工具集（有 .tools() 方法返回工具数组）
 * @returns {Promise<{applied: boolean, replaced: string[], reason?: string}>}
 */
export async function applyNativeAdapters(toolkit) {
  if (_applied) {
    return { applied: true, replaced: [], reason: '已应用过' }
  }

  const available = await hasNativeBridge()
  if (!available) {
    _lastProbeFailAt = Date.now()
    _probeFailCount++
    return {
      applied: false,
      replaced: [],
      reason: `原生桥不可用（127.0.0.1:3457 无响应，第 ${_probeFailCount} 次探测），保持 Termux 实现`,
      retryable: shouldRetryNativeAdapters(),
    }
  }

  // ⚠️ 每次调用 tools() 都重新取一遍，不用缓存的结果。
  //
  // 【为什么】registry.list() 返回的是**同一批工具实例**，直接改它们的 execute 即可。
  // 但有些 toolkit 实现的 tools() 每次返回新数组（甚至新对象），
  // 那就必须在**替换后重新取**才能拿到被改过的实例。
  // 所以这里取两次：第一次找名字，第二次拿到实例后替换。
  const replaced = []
  const seen = new Set()

  // 反复取直到没有新的可替换工具（兼容 tools() 返回新对象的实现）
  for (let round = 0; round < 3; round++) {
    const tools = typeof toolkit.tools === 'function' ? toolkit.tools() : []
    let changed = false

    for (const tool of tools) {
      if (!tool || !tool.name) continue
      const impl = NATIVE_IMPLS[tool.name]
      if (!impl) continue

      // 已经是原生实现 → 跳过（避免二次包装）
      if (tool.execute === impl || tool._ccmNative) continue

      // 保存原实现（便于回退 / 调试）
      if (!tool._originalExecute) tool._originalExecute = tool.execute
      tool.execute = impl
      tool._ccmNative = true
      changed = true

      if (!seen.has(tool.name)) {
        seen.add(tool.name)
        replaced.push(tool.name)
      }
    }

    // 这一轮没改动 → 说明 tools() 返回的是稳定实例，结束
    if (!changed) break
  }

  _applied = true
  _lastProbeFailAt = 0
  _probeFailCount = 0
  return { applied: true, replaced, reason: `已用原生实现替换 ${replaced.length} 个工具` }
}

/** 撤销适配（回退到原实现） */
export function revertNativeAdapters(toolkit) {
  const tools = typeof toolkit.tools === 'function' ? toolkit.tools() : []
  let n = 0
  for (const tool of tools) {
    if (tool._originalExecute) {
      tool.execute = tool._originalExecute
      delete tool._originalExecute
      delete tool._ccmNative
      n++
    }
  }
  _applied = false
  return n
}

// ═══════════════════════════════════════════════════
//  原生实现
// ═══════════════════════════════════════════════════

const NATIVE_IMPLS = {

  // ── 界面快照 ────────────────────────────────
  async phone_snapshot(input = {}) {
    const r = await nativeCall('phone.snapshot', {
      interactive_only: input.interactive_only !== false,
      max_nodes: input.max_nodes || 300,
    })
    if (!r.ok) return { ok: false, error: r.error }

    const lines = [`包名: ${r.package}`, `元素数: ${r.count}`, '']
    for (const n of r.nodes || []) {
      const parts = [`[${n.ref}]`, n.cls]
      if (n.text) parts.push(`"${n.text}"`)
      if (n.desc) parts.push(`(${n.desc})`)
      if (n.id) parts.push(`#${String(n.id).split('/').pop()}`)
      parts.push(n.bounds)
      if (n.clickable) parts.push('可点击')
      if (n.editable) parts.push('可输入')
      if (n.scrollable) parts.push('可滚动')
      if (n.checked !== undefined) parts.push(n.checked ? '已选中' : '未选中')
      lines.push(parts.join(' '))
    }
    if (!r.count) lines.push('（没有找到可交互元素）')
    return { ok: true, output: lines.join('\n') }
  },

  // ── 点击 ────────────────────────────────────
  async phone_click(input = {}) {
    const r = await nativeCall('phone.click', {
      ref: input.ref,
      long_press: !!input.long_press,
    })
    return r.ok ? { ok: true, output: r.message } : { ok: false, error: r.error }
  },

  async phone_tap_xy(input = {}) {
    const r = await nativeCall('phone.tap', {
      x: input.x, y: input.y,
      long_press: !!input.long_press,
    })
    return r.ok ? { ok: true, output: r.message } : { ok: false, error: r.error }
  },

  // ── 输入 ────────────────────────────────────
  async phone_type(input = {}) {
    const r = await nativeCall('phone.type', {
      text: input.text,
      ref: input.ref || '',
    })
    return r.ok ? { ok: true, output: r.message } : { ok: false, error: r.error }
  },

  // ── 滑动 / 按键 ─────────────────────────────
  async phone_swipe(input = {}) {
    const params = { duration: input.duration || 300 }
    if (input.direction) params.direction = input.direction
    if (input.x1 !== undefined) {
      params.x1 = input.x1; params.y1 = input.y1
      params.x2 = input.x2; params.y2 = input.y2
    }
    const r = await nativeCall('phone.swipe', params)
    return r.ok ? { ok: true, output: r.message } : { ok: false, error: r.error }
  },

  async phone_key(input = {}) {
    const r = await nativeCall('phone.key', { key: input.key })
    return r.ok ? { ok: true, output: r.message } : { ok: false, error: r.error }
  },

  // ── 应用 ────────────────────────────────────
  async phone_app(input = {}) {
    const r = await nativeCall('phone.app', {
      action: input.action || 'launch',
      package: input.package || '',
      filter: input.filter || '',
    })
    if (!r.ok) return { ok: false, error: r.error }
    if (r.apps) return { ok: true, output: r.apps.join('\n') }
    return { ok: true, output: r.message }
  },

  // ── 截图 ────────────────────────────────────
  async phone_screenshot(input = {}) {
    const r = await nativeCall('phone.screenshot', {
      save_path: input.save_path || '',
      quality: input.quality || 85,
    })
    if (!r.ok) return { ok: false, error: r.error }
    return { ok: true, output: `截图已保存: ${r.path}`, imagePath: r.path }
  },

  // ── Screencap：截屏 + OCR（原走 rish，CCM 走 MediaProjection）──
  //
  // 【注意】CCM 的 MediaProjection 截图返回的是文件路径，
  // 而原 Screencap 工具返回的是「OCR 文字」。这里保持原语义：
  // 截屏 → 存文件 → 返回路径 + 提示（Agent 层会注入多模态让模型自己看）。
  async Screencap(input = {}) {
    const r = await nativeCall('phone.screenshot', {
      save_path: input.save_path || '',
      quality: 85,
    })
    if (!r.ok) {
      return {
        ok: false,
        error: `${r.error}\n（CCM 模式：请在 App 主界面点「授权截屏能力」）`,
      }
    }
    // 返回结构带上 imagePath，让 Agent 层的视觉注入逻辑能拿到
    const out = new String(`截图已保存: ${r.path}`)
    out.imagePath = r.path
    out.__vision = true
    return { ok: true, output: out, imagePath: r.path }
  },

  // ── 系统能力（原 termux-* 命令的替代）────────
  async Notify(input = {}) {
    const r = await nativeCall('sys.notify', {
      title: input.title || 'CCM',
      content: input.content || '',
    })
    return r.ok ? { ok: true, output: r.message } : { ok: false, error: r.error }
  },

  async ClipboardGet() {
    const r = await nativeCall('sys.clipboard.get')
    return r.ok ? { ok: true, output: r.text || '（剪贴板为空）' } : { ok: false, error: r.error }
  },

  async ClipboardSet(input = {}) {
    const r = await nativeCall('sys.clipboard.set', { text: input.text })
    return r.ok ? { ok: true, output: r.message } : { ok: false, error: r.error }
  },

  async Toast(input = {}) {
    const r = await nativeCall('sys.toast', { text: input.text })
    return r.ok ? { ok: true, output: r.message } : { ok: false, error: r.error }
  },

  async Vibrate(input = {}) {
    const r = await nativeCall('sys.vibrate', { duration: input.duration || 200 })
    return r.ok ? { ok: true, output: r.message } : { ok: false, error: r.error }
  },

  async Battery() {
    const r = await nativeCall('sys.battery')
    return r.ok ? { ok: true, output: `电量: ${r.level}%` } : { ok: false, error: r.error }
  },

  // ── phone_wait：等界面稳定 ──────────────────
  // 原生实现更简单：无障碍每次拿的都是实时快照，
  // 轮询两次比较节点数/文本，相同即认为稳定。
  async phone_wait(input = {}) {
    const wantText = input.text || ''
    const wantGone = input.text_gone || ''
    const maxWait = Math.min(input.max_wait_ms || 8000, 30000)
    const start = Date.now()
    let lastSig = null
    let stableCount = 0

    while (Date.now() - start < maxWait) {
      const r = await nativeCall('phone.snapshot', { interactive_only: false, max_nodes: 200 })
      if (!r.ok) {
        await new Promise(res => setTimeout(res, 300))
        continue
      }
      const allText = (r.nodes || []).map(n => `${n.text || ''}${n.desc || ''}`).join('|')

      // 等文字出现
      if (wantText && allText.includes(wantText)) {
        return { ok: true, output: `已出现「${wantText}」（${Date.now() - start}ms）` }
      }
      // 等文字消失
      if (wantGone && !allText.includes(wantGone)) {
        return { ok: true, output: `「${wantGone}」已消失（${Date.now() - start}ms）` }
      }
      // 都没指定 → 等稳定
      if (!wantText && !wantGone) {
        const sig = `${r.count}:${allText.slice(0, 200)}`
        if (sig === lastSig) {
          stableCount++
          if (stableCount >= 2) {
            return { ok: true, output: `界面已稳定（${Date.now() - start}ms，${r.count} 个元素）` }
          }
        } else {
          stableCount = 0
          lastSig = sig
        }
      }
      await new Promise(res => setTimeout(res, 250))
    }

    const what = wantText ? `等「${wantText}」` : wantGone ? `等「${wantGone}」消失` : '等界面稳定'
    return { ok: false, error: `${what}超时（${maxWait}ms）` }
  },

  // ── say：语音播报 ───────────────────────────
  // 原生 TTS（离线、快）。音质不如 edge-tts，但可靠。
  async say(input = {}) {
    const text = input.text || ''
    if (!text) return { ok: false, error: '缺少 text' }
    const r = await nativeCall('sys.tts', {
      text,
      flush: input.flush !== false,
      rate: input.rate || 1.0,
    })
    if (r.ok) {
      return { ok: true, output: input.secret ? `已播报（内容隐藏，${text.length} 字符）` : `已播报：${text}` }
    }
    return { ok: false, error: r.error }
  },

  // ── Location：定位 ──────────────────────────
  async Location(input = {}) {
    const r = await nativeCall('sys.location', { provider: input.provider || 'network' })
    if (!r.ok) return { ok: false, error: r.error }
    return { ok: true, output: `纬度 ${r.latitude}, 经度 ${r.longitude}${r.accuracy ? `, 精度 ${r.accuracy}m` : ''}` }
  },

  async OpenUrl(input = {}) {
    const r = await nativeCall('sys.openUrl', { url: input.url })
    return r.ok ? { ok: true, output: r.message } : { ok: false, error: r.error }
  },

  async Share(input = {}) {
    const r = await nativeCall('sys.share', { text: input.text })
    return r.ok ? { ok: true, output: r.message } : { ok: false, error: r.error }
  },

  async TTS(input = {}) {
    const r = await nativeCall('sys.tts', {
      text: input.text,
      flush: input.flush !== false,
      rate: input.rate || 1.0,
      pitch: input.pitch || 1.0,
    })
    return r.ok ? { ok: true, output: r.message } : { ok: false, error: r.error }
  },
}

export default { applyNativeAdapters, revertNativeAdapters }
