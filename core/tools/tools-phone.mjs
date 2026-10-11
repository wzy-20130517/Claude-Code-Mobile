// Claude Code Mobile - 手机 UI 自动化工具（Playwright 风格）
//
// 【为什么不用截图流】
// AutoGLM / Anthropic computer-use 那套是「截图 → 视觉定位 → 猜坐标 → 点」，
// 一轮几千 token、好几秒，手机屏幕元素又密，估偏一两个 dp 就点错。
// Playwright 快一个数量级的根本原因是它【不看画面】：browser_snapshot 拿的是
// 无障碍树的文本快照，每个元素带一个 ref，模型只说「点 e42」。
// 整个循环没有图像 token、没有坐标估算。
//
// 【Android 上怎么复刻】
// dumpsys activity top 能拿到视图层级 + bounds + resource-id，且【不依赖 idle 状态】。
// uiautomator dump 虽然带 text 属性，但要等界面 idle —— 前台有动画/流式输出/视频时
// 直接报 "ERROR: could not get idle state"，实测在 DeepSeek 界面必败，所以只作兜底。
//
// 【ref 表存宿主侧】
// snapshot 时把层级解析成 ref → bounds 映射存内存，模型只见 ref 不见坐标，
// 输出永远是符号化指令（click e42），不会因为估错像素点偏。这是 Playwright 的核心设计。
//
// 【保活】
// Shizuku 连接会被系统省电策略掐断（实测 dumpsys 跑两次就 Request timeout）。
// 所以每次操作前确保 audio-keepalive 在跑 —— 复用项目现成脚本，start 幂等，
// 不跟 /keepalive on 冲突。

import { Tool } from './tools.mjs'
import { runShell, captureScreen, loadDeviceConfig, saveDeviceConfig, vdAlive, vdCall, vdStart } from '../phone/device.mjs'
import { loadImageBlock } from '../phone/image.mjs'

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { dataPath } from '../infra/paths.mjs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const AUDIO_SCRIPT = join(HERE, 'audio-keepalive.sh')

// ═══ 操作模式 ═══════════════════════════════════════════════
//
// 仿 agent-mobile-use 的 /api/mode。**三个关键点别搞错**：
//
// 1) 模式是**每次 use 重新选的**，不是长期配置。
//    它的 currentMode 是个内存变量、初值 "idle"，进程重启就回到 idle。
//    所以这里也**不写进 device.json** —— 每次会话第一次用手机工具时问一次。
//
// 2) 初值是 idle（不操作），不是 background。
//    默认就动用户的手机太冒犯；用户明确说了才动。
//
// 3) foreground / background 决定**目标屏**：
//    foreground → display 0（主屏，用户看得见）；background → 副屏。

/** 向导注入点。index.mjs 启动时注入基于 runSelect 的实现（Web 端自动走委托）。 */
let modePrompter = null
export function setPhoneModePrompter(fn) { modePrompter = fn }

/**
 * 手机操作模式。
 *
 * ═══════════════════════════════════════════════════════════════
 * 【两层语义 —— 2026-09-26 按用户要求重做】
 *
 * 1. **偏好**（持久，存 device.json 的 phoneMode 字段）：
 *      'foreground' → 以后都用主屏，**不再弹选择**
 *      'background' → 以后都用副屏，**不再弹选择**
 *      'ask'        → **每次用手机工具都问**
 *      null/缺失    → 从没设过 → 第一次弹选择（选完就变成上面三种之一）
 *
 * 2. **本次会话的生效值**（内存 sessionMode）：由上一步决定，工具读它。
 *
 * 【和另一版设计的区别】之前那版是「每次会话重选、不落盘」，
 * 理由是「怕上次选的前台一直粘着」。用户明确要求改成持久：
 * 设了主屏/副屏就一直用它，想每次问就显式选「选择」。
 * ═══════════════════════════════════════════════════════════════
 */

/** 读偏好：'foreground' | 'background' | 'ask' | null（从没设过） */
export function getPhoneModePreference() {
  try {
    const v = loadDeviceConfig().phoneMode
    return ['foreground', 'background', 'ask'].includes(v) ? v : null
  } catch { return null }
}

/** 写偏好（持久）。传 null 表示清掉，回到「从没设过」。 */
export function setPhoneModePreference(v) {
  const ok = ['foreground', 'background', 'ask'].includes(v) ? v : null
  saveDeviceConfig({ phoneMode: ok })
  // 偏好改变后，本次会话的生效值作废，下次调用按新偏好重新决定
  sessionMode = (ok === 'foreground' || ok === 'background') ? ok : null
  return ok
}

/** 本次会话的生效模式（工具内部读它）。 */
let sessionMode = null

/** 当前生效模式。 */
export function getPhoneMode() { return sessionMode }

/** 直接设置本次会话的生效模式（不落盘，内部/兼容用）。 */
export function setPhoneMode(mode) {
  sessionMode = ['foreground', 'background', 'idle'].includes(mode) ? mode : null
  return sessionMode
}

/** 重置本次会话（下次调用重新按偏好决定）。 */
export function resetPhoneMode() { sessionMode = null }

/**
 * 确保本次会话的模式已定。规则见文件上方那段注释。
 */
async function ensurePhoneMode() {
  // 已有生效值，直接用
  if (sessionMode) {
    await applyModeToTarget(sessionMode)
    return sessionMode
  }

  const pref = getPhoneModePreference()

  // 设了主屏/副屏 → 直接用，不弹
  if (pref === 'foreground' || pref === 'background') {
    setPhoneMode(pref)
    await applyModeToTarget(sessionMode)
    return sessionMode
  }

  // 'ask' 或从没设过 → 弹选择（ask 是每次都弹）
  if (!modePrompter) {
    // 非交互环境（子 agent / 无 Web 委托）→ idle，不动手机
    setPhoneMode('idle')
    return sessionMode
  }
  const picked = await modePrompter()
  const chosen = picked || 'idle'
  setPhoneMode(chosen)
  // 【关键】用户选完之后把偏好记下来 —— 这样下次不再弹。
  // 但如果他选的是「每次问」（prompter 返回 'ask'），就存 'ask'。
  // 选 idle 不存（那是一次性的「这次别动」，不该变成永久设置）。
  if (chosen === 'foreground' || chosen === 'background' || chosen === 'ask') {
    try { saveDeviceConfig({ phoneMode: chosen }) } catch {}
  }
  await applyModeToTarget(sessionMode)
  return sessionMode
}

/**
 * 把模式同步给副屏进程（如果它在跑）。
 *
 * foreground 模式下目标屏是 0，background 是副屏 —— 这个切换在副屏进程里做
 * （见 VdCore.targetDisplayId），所以这里要通知它。
 * 副屏没跑也不报错：foreground 模式本来就不需要副屏。
 */
async function applyModeToTarget(mode) {
  try {
    const alive = await vdAlive(1200)
    if (!alive.alive) {
      // 用户选了 background 但副屏没起 → **自动起一个**。
      //
      // 【为什么自动】用户选「后台（虚拟副屏）」表达的就是「我要在副屏上操作」。
      // 选完还得自己敲 /device vd start 才生效，等于让用户为一个已经表达过的
      // 意图再确认一次 —— 实际表现就是「选了副屏，结果应用开在主屏上」。
      // foreground/idle 不需要副屏，不动它。
      if (mode === 'background') {
        try { await vdStart({ timeout: 45000 }) } catch {}
      }
      return
    }
    await vdCall('mode', { mode }, 8000)
  } catch {}
}

/** 模式的中文名，用在给模型的提示里。 */
export function phoneModeLabel(mode = sessionMode) {
  return { foreground: '前台（操作主屏）', background: '后台（虚拟副屏）', idle: '未操作（idle）' }[mode] || '未选'
}

// ═══ 识图能力降级 ═══════════════════════════════════════════
//
// 网关对不支持的模型**不报错**，而是在响应体里塞一句
// "[Image input omitted: selected model does not support vision.]" 返回 200。
// 结果：图片被静默丢弃，模型完全看不到内容，而工具那边一切"正常"。
//
// 所以需要在「看到那句话」之后记住这个事实，下次截图直接走 OCR ——
// 既省一次无用的请求，也让模型真的拿到画面文字。
// （用户 2026-09-26 问「OCR 哪去了？」指的正是这条从未被触发的降级路径。）

let visionKnownUnavailable = false

/** agent 检测到「图片被网关丢弃」的占位文本时调用。 */
export function markVisionUnavailable() { visionKnownUnavailable = true }

/** 当前会话是否已知识图不可用。 */
export function visionUnavailable() { return visionKnownUnavailable }

/** 重置（用户切了 Provider / 开了备用识图后应重试直传）。 */
export function resetVisionUnavailable() { visionKnownUnavailable = false }

/**
 * OCR 转述：图读不了时的兜底。
 * 优先后端分析（analyzeImage，若配了识图 Provider），失败退本地 tesseract。
 */
async function ocrFallback(imagePath, prompt) {
  const { ocrImage, analyzeImage, availableOcrLangs } = await import('../phone/ocr.mjs')
  try {
    const r = await analyzeImage(imagePath, { prompt: prompt || undefined })
    if (r?.text) return r.text
  } catch {}
  try {
    return await ocrImage(imagePath, { langs: availableOcrLangs().join('+') })
  } catch (e) {
    return `（OCR 也失败了：${e.message.slice(0, 120)}）\n可以用 ViewImage 看原图，或换个支持视觉的 Provider。`
  }
}

/**
 * 本次 snapshot 的数据源。
 * 副屏（vd）的 ref 表在**副屏进程里**，点击要走 vdCall('click', {ref})；
 * dumpsys 的 ref 表在本地（refTable），点击用坐标。
 * 两者不能混 —— 用错源会导致「ref 不存在」或点错位置。
 */
let snapshotSource = 'dumpsys'

/**
 * 标记本次 snapshot 来自副屏。
 *
 * 副屏的节点 id（e0/e1/...）由它自己维护，我们这边只记「这次是副屏的」，
 * 点击时直接透传 id 给 vdCall —— 不做本地映射，避免两套 id 体系打架。
 */
function markVdRefs(text) {
  snapshotSource = 'vd'
  // 清掉本地 ref 表，防止模型拿着副屏的 id 走到 dumpsys 的查表分支
  refTable = new Map()
  return text
}

/**
 * 当前操作目标屏。
 *
 * foreground → 0（主屏）；background → 副屏 id；idle → -1。
 * 所有 input/snapshot 都要问它，别写死副屏或主屏 —— 这是 agent-mobile-use
 * 的核心设计（它的 getTargetDisplayID 就是这个逻辑）。
 */
/**
 * input 命令的 display 前缀。
 * `input -d <displayId> ...` 能把触控注入到指定屏 —— foreground 打主屏(0)，
 * background 打副屏。不指定就默认主屏，那样 background 模式会点错屏。
 */
async function inputPrefix() {
  const d = await targetDisplay()
  return d >= 0 ? `input -d ${d}` : 'input'
}

export async function targetDisplay() {
  // 【2026-10-10 修「副屏在跑却截主屏」】
  // 原来 `mode = sessionMode || 'idle'` —— sessionMode 是**内存值**，
  // 进程重启后为 null，直接落进 idle 分支 return -1（**根本不看副屏
  // 是否可用**）。截图代码 `if (shotDisplay < 0) shotDisplay = 0` 于是
  // 落主屏 —— 用户报「让你截副屏，你截我主屏」的根因。
  //
  // 修法（对齐 phone_device 的做法）：sessionMode 为空时回退读**偏好**
  // （device.json 的 phoneMode）——用户设了 background 就按副屏走，
  // 只有真的没设过（null）或设为 ask 且本次未定时，才按 idle 处理。
  let mode = sessionMode
  if (!mode) {
    const pref = getPhoneModePreference()
    if (pref === 'foreground' || pref === 'background') mode = pref
  }
  if (!mode) mode = 'idle'
  if (mode === 'foreground') return 0
  if (mode === 'idle') return -1
  const vd = await vdAlive(1200)
  // 【2026-10-10 改判据】原来用 `usable !== false`（进程活 + 帧缓存新鲜）
  // —— 但**帧缓存旧 ≠ 屏不可用**：screencap 走 SurfaceFlinger token 直接
  // 截**实时**画面（实测 displayId=182 帧缓存 1097 秒未更新，screencap
  // 照样截到当前画面，比帧缓存还新）。用 usable 拦截会把「能用的屏」
  // 误判成不可用 → 落回主屏（用户报「让你截副屏，你截我主屏」的
  // 第二层根因）。
  //
  // 现在：进程活着（alive）就返回 displayId；帧旧只是记个警告，
  // 由调用方在结果里带一句（takeVdWarning）。真的屏被回收时，
  // screencap 会报 "Display Id ... is not valid" → captureScreen 的
  // invalidDisplay 分支会兜底落主屏（那条路已验证可靠）。
  if (vd.alive && vd.displayId > 0) {
    if (vd.stale) lastVdWarning = vd.warn
    return vd.displayId
  }
  if (vd.stale) lastVdWarning = vd.warn
  return 0
}

/** 副屏失效的警告（供各工具在结果里带一句）。取一次就清。 */
let lastVdWarning = null
export function takeVdWarning() { const w = lastVdWarning; lastVdWarning = null; return w }

/**
 * idle 时不该继续操作 —— 工具调用到这里直接返回说明，而不是动手。
 * 返回 null 表示可以继续（模式已选定且不是 idle）。
 */
function idleGuard(toolName) {
  if (sessionMode === 'idle') {
    return `用户这次选择了「不操作手机」（idle 模式），所以 ${toolName} 没有执行。\n`
      + `这是用户自己的选择，不要尝试绕过或自行更改 —— 告诉他这次选了「不操作手机」即可。`
  }
  return null
}



// ref → 元素信息。snapshot 时重建，click/type 时查表。
let refTable = new Map()
let refSeq = 0
let keepaliveEnsured = false

// 本轮是否动过手机界面。只有动过才需要在回复结束时切回 Termux ——
// 没用过 phone 工具还去 am start，等于每轮都无谓地抢一次前台。
let phoneTouched = false

// ★ 2026-10-01 用户要求：「phone_shell 也拉回多此一举」。
//   phone_shell 是**后台诊断通道**（pkill/pm list/dumpsys/读日志），
//   它不动用户看的界面 —— 执行完把前台抢回 Termux 纯属打扰
//   （尤其用户从 CCM/QQ 下指令时，他在别处看结果）。
//   这里区分「界面操作」与「仅 shell」：只有前者才触发切回。
let uiOperated = false

// 最近一次 phone_screenshot 的缩放比例。
// 截图会被缩到长边 2048 省 token，模型看到的坐标是缩放后的；
// 存下比例后 phone_tap_xy 可以自动换算，不用模型做乘法。
let lastShotScale = null   // { sx, sy, from:{w,h}, to:{w,h} }

/**
 * 结束时用什么方式告诉用户「活干完了」。
 *
 * ═══════════════════════════════════════════════════════════════
 * 【为什么要分环境 —— 2026-09-26 用户指出】
 *
 * 原来不管三七二十一，一次回复结束就 `am start com.termux/...TermuxActivity`
 * 把前台切回 Termux。这在 CLI 里是对的（用户抬头就能看到输出）。
 *
 * 但 **Web 端用户根本不在 Termux 前面** —— 他在浏览器里看结果。
 * 此时把手机前台抢到 Termux，等于：
 *   · 用户原本在用的 App 被顶掉（他可能正在刷视频/看文档）
 *   · 切过去也没人看（Termux 不在他的视线里）
 *   · 而且切回来还得他自己再切回去
 *
 * 所以改成按环境：
 *   'cli'  → 切回 Termux（原有行为，用户就在那）
 *   'web'  → 弹 Toast 提示「任务完成」，**不动前台**
 *   'none' → 什么都不做（子 Agent、API 调用等无人在场的场景）
 *
 * 默认 'cli' 保持向后兼容；Web 端启动时调 setPhoneFinishAction('web')。
 * ═══════════════════════════════════════════════════════════════
 */
let finishAction = 'cli'

export function setPhoneFinishAction(mode) {
  finishAction = ['cli', 'web', 'none'].includes(mode) ? mode : 'cli'
  return finishAction
}
export function getPhoneFinishAction() { return finishAction }

export function phoneWasUsed() { return phoneTouched }
export function resetPhoneUsed() { phoneTouched = false; uiOperated = false }

/**
 * 一次回复结束后收尾：告诉用户「手机操作完成了」。
 *
 * - cli 模式：把前台切回 Termux（用户就在那等着看输出）
 * - web 模式：弹 Toast（用户不在 Termux 前，切过去没意义还抢他正在用的 App）
 * - none：静默
 *
 * 没用过 phone 工具时直接跳过，不无谓打扰。
 */
export async function returnToTermux() {
  if (!phoneTouched) return { ok: false, skipped: true }
  phoneTouched = false
  // ★ 2026-10-01：只动过 shell 类后台通道（uiOperated=false）→ 不切前台。
  //   「多此一举」的根因就在这：phone_shell 用完把用户从 CCM/其它界面顶走。
  if (!uiOperated) return { ok: true, skipped: true, reason: 'shell-only' }
  uiOperated = false

  if (finishAction === 'none') return { ok: true, silent: true }

  if (finishAction === 'web') {
    // Toast 不占屏、不抢前台，用户当前在哪个 App 都能看到。
    // 走 termux-toast（Termux:API 提供）—— 它在 **Termux 侧**执行，
    // 不是 Android shell，所以用 execFile 而不是 sh()。
    try {
      await new Promise((resolve) => {
        execFile('termux-toast', ['AI 已完成手机操作'], { timeout: 8000 }, () => resolve())
      })
      return { ok: true, toasted: true }
    } catch (e) {
      return { ok: false, err: e.message }
    }
  }

  // cli 模式：切回 Termux
  const cur = await readFocus(1)
  if (cur.startsWith('com.termux/')) return { ok: true, already: true }
  const r = await sh(`am start -n com.termux/com.termux.app.TermuxActivity >/dev/null 2>&1; echo DONE`, 25000)
  return { ok: /DONE/.test(r.out), from: cur }
}

function sh(cmd, timeout = 45000) {
  // 走 core/device.mjs 的通道抽象：Shizuku 优先，不可用落本机 adb。
  // 原来是直接 execFile(rish)，Shizuku 一挂所有 phone 工具全废；
  // 通道选择/降级/错误归一的逻辑现在收在 device.mjs 一处。
  return runShell(cmd, timeout)
}

// ── 进度 Toast（2026-10-01）──────────────────────────────────
let lastToastAt = 0
/**
 * 屏幕上弹一条进度提示（中下方、短显示）。
 *
 * 用户原话：「让 Agent 操作手机时，正文每次打印在手机中下方，消失很快。
 * 显示得不多，让人知道它在运行就行」。
 *
 * 实现：termux-toast（Termux:API）—— `-g bottom` 中下方、`-s` 短显示。
 * fire-and-forget + 1s 节流；任何失败静默。
 */
function showProgressToast(text) {
  const now = Date.now()
  if (now - lastToastAt < 1000) return   // 节流：连点不刷屏
  lastToastAt = now
  // ✳ 前缀 = Claude 的弹窗标识（2026-10-01 用户要求）
  const t = '✳ ' + String(text).slice(0, 38)
  // 配色（2026-10-01 用户要求）：白底 + Claude 橙字 #D97757
  // termux-toast 的 -b/-c 接受标准色名或 6/8 位 hex（(AA)RRGGBB）
  try {
    execFile(
      'termux-toast',
      ['-g', 'bottom', '-s', '-b', 'white', '-c', '#D97757', t],
      { timeout: 5000 },
      () => {},
    )
  } catch (_) { /* Termux:API 缺失/异常：静默，不影响主流程 */ }
}

/** 确保静音音频保活在跑（幂等，与 /keepalive on 共用同一个 pgrep 判断） */
async function ensureKeepalive(label = '') {
  // 所有 phone 操作都会先走这里，顺便打「本轮动过手机」的标记，
  // 比在 9 个 execute 里各写一行可靠（不会漏）。
  // ★ 2026-10-01：ensureKeepalive 只有「操作手机界面」的工具会调
  //   （snapshot/click/type/swipe/key/app/screenshot…）——它们才是需要
  //   收尾切回 Termux 的。phone_shell / phone_vd 等后台通道不调这里，
  //   也就不触发切回（用户：「phone_shell 也拉回多此一举」）。
  phoneTouched = true
  uiOperated = true

  // ★ 2026-10-01 用户要求：操作手机时给一条屏幕 Toast 进度提示 ——
  //   agent 接管手机后用户看不到聊天记录，Toast 中下方、短显示、一行摘要，
  //   「让人知道它在运行就行」。
  //   要点：
  //   · 不 await（fire-and-forget）—— Toast 是提示不是流程，绝不能拖慢工具
  //   · 1 秒节流：连续操作（点击连点）不刷屏
  //   · 失败静默（Termux:API 没装/权限不足时不影响主流程）
  if (label) showProgressToast(label)
  if (keepaliveEnsured || !existsSync(AUDIO_SCRIPT)) return
  keepaliveEnsured = true
  await new Promise(resolve => {
    try {
      execFile('bash', [AUDIO_SCRIPT, 'start'], { timeout: 30000 }, () => resolve())
    } catch { resolve() }
  })
  try { execFile('termux-wake-lock', [], () => {}) } catch {}
}

// dumpsys activity top 的行形如：
//   ContentFrameLayout{a211e16 V.E...... .......D 0,0-1280,2772 #1020002 android:id/content}
//   LinearLayout{9f3e17c V.E...... ........ 234,65-1124,210}
// 标志位首字符 V=可见（I=不可见则跳过），第 4 位 C 表示 clickable。
const NODE_RE = /^(\s*)([A-Za-z][\w.$]*)\{([0-9a-f]+)\s+([VIG.][\w.]*)\s+(\S*)\s+(-?\d+),(-?\d+)-(-?\d+),(-?\d+)(?:\s+#[0-9a-f]+)?(?:\s+([\w.]+:id\/[\w.]+))?/

// dumpsys 的 bounds 是【相对父容器】的局部坐标，不是屏幕绝对坐标。
// 实测：列表项里的文本节点 bounds 写成 (0,0-890,70)，y=0 并不是屏幕顶端。
// 直接拿去 input tap 会点到完全错误的位置。
// 所以要维护一个按缩进层级的父容器栈，逐层累加 x1/y1 偏移得到绝对坐标。
/**
 * 从 dumpsys activity top 的输出里挑出真正渲染中的那个 activity 段。
 *
 * 【为什么不是取最后一段】
 * 实测输出会分成 4 段（桌面 Launcher、输入法、当前应用等各一段），
 * 节点数分别是 286 / 18 / 38 —— 最前台的在前面，不在末尾。
 * 原来两处代码都写 segs[segs.length-1]，一处恰好蒙对、一处解析出 0 个节点，
 * 导致 phone_wait 的稳定判断永真（0:0 恒等）。
 * 改成按「可解析节点数最多」来选，这个指标直接反映哪个界面真在渲染。
 */
function pickTopSegment(raw, focusPkg = '') {
  const out = String(raw || '')
  const segs = out.split(/^\s*ACTIVITY\s+/m)
  if (segs.length <= 1) return out

  // 首选：按前台包名匹配。段标题形如
  //   com.android.settings/.MainSettings 39325d5 pid=1234
  const pkg = String(focusPkg || '').split('/')[0]
  if (pkg) {
    for (const s of segs) {
      const title = s.split('\n')[0] || ''
      if (title.startsWith(pkg + '/')) return s
    }
  }
  // 兜底：节点最多的段。注意这【不可靠】——实测同一台设备连续三次采样，
  // 段结构是 [350,126] → [0,148,75] → [0,19,227,158]，
  // 后台未销毁的 activity（桌面/输入法/Shizuku）都在里面且顺序不定，
  // 节点最多的可能是桌面而不是前台应用。所以只在拿不到前台包名时用。
  let best = out, bestCount = -1
  for (const s of segs) {
    const c = (s.match(/\{[0-9a-f]+ [VIG]/g) || []).length
    if (c > bestCount) { bestCount = c; best = s }
  }
  return best
}

/**
 * 读当前前台的 包名/类名。
 * activity 转场瞬间 mCurrentFocus 会短暂为 null（实测 snapshot 单次读取
 * 经常拿到空 → 显示「前台: 未知」，而 wait 循环里连读 7 次总能中）。
 * 所以这里自带重试。
 */
/**
 * 粘贴后回读校验 —— 对齐提示词承诺的 verify_mismatch 信号（2026-10-07 补）。
 *
 * 【为什么只有粘贴路径做】`input text`（ASCII）失败时 sh 直接报
 * 「输入失败」，已有执行级校验；而剪贴板粘贴是「发出去了，应用收没收
 * 看不到」—— KEYCODE_PASTE 被应用拒绝、输入法过滤、字段长度截断都会
 * 静默发生，模型会把「已粘贴」当成功。
 *
 * 【怎么读】uiautomator dump 是唯一能拿到 focused 节点文本的通用通道
 * （dumpsys activity top 的行不带 text，parseViewTree 拿不到）。
 * 代价约 1~3s —— 只在粘贴后跑一次；dump 失败/超时**静默跳过**
 * （返回 null），不阻塞、不误报。
 *
 * @returns {boolean} true=回读一致 false=不一致（真 verify_mismatch）
 *          null=无法校验（dump 失败 / 无焦点文本）
 */
async function verifyFocusText(expected) {
  try {
    const u = await sh(`uiautomator dump /dev/stdout 2>&1 | head -c 300000`, 15000)
    const xml = u.out || ''
    if (!xml.includes('<node')) return null
    const tags = xml.match(/<node [^>]+>/g) || []
    let focusText = null
    for (const tag of tags) {
      if (!/focused="true"/.test(tag)) continue
      const tm = tag.match(/ text="([^"]*)"/)
      if (tm && tm[1]) { focusText = tm[1]; break }
    }
    if (focusText == null) return null
    const decoded = focusText
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    return decoded.includes(expected)
  } catch {
    return null
  }
}

async function readFocus(tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await sh(`dumpsys window 2>/dev/null | grep -E 'mCurrentFocus' | head -1`, 25000)
    const hit = (r.out.match(/([\w.]+\/[\w.$]+)/) || [])[1]
    if (hit) return hit
    if (i < tries - 1) await new Promise(res => setTimeout(res, 350))
  }
  return ''
}

function parseViewTree(text) {
  const nodes = []
  const stack = []   // [{ depth, ox, oy }] 父容器的累计偏移
  for (const raw of String(text || '').split('\n')) {
    const m = raw.match(NODE_RE)
    if (!m) continue
    const [, indent, cls, , flags, , sx1, sy1, sx2, sy2, resId] = m
    const depth = Math.floor(indent.length / 2)
    const lx1 = Number(sx1), ly1 = Number(sy1), lx2 = Number(sx2), ly2 = Number(sy2)

    // 退栈到当前节点的父层级
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop()
    const parent = stack[stack.length - 1] || { ox: 0, oy: 0 }
    const ox = parent.ox, oy = parent.oy

    const x1 = ox + lx1, y1 = oy + ly1
    const x2 = ox + lx2, y2 = oy + ly2
    // 本节点作为后代的父容器：偏移是自己的绝对左上角
    stack.push({ depth, ox: x1, oy: y1 })

    const w = lx2 - lx1, h = ly2 - ly1
    if (flags[0] !== 'V') continue         // 不可见，模型看不见也点不到
    if (w <= 0 || h <= 0) continue         // 零尺寸
    nodes.push({
      depth,
      cls: cls.split('.').pop(),
      // 标志位第一组是 9 位：VFEDxxCLx
      //   1 V=visible  2 F=focusable  3 E=enabled  4 D=willNotDraw
      //   7 C=clickable  8 L=longClickable
      // 原来取 flags[3]（第 4 位 D）当 clickable，结果恒为 false —— 设置页
      // 实测有 14 个 VFED..C.. 节点全被 interactive_only 滤掉了。
      clickable: flags[6] === 'C',
      longClickable: flags[7] === 'L',
      resId: resId || '',
      x1, y1, x2, y2, w, h,
      cx: Math.round((x1 + x2) / 2),
      cy: Math.round((y1 + y2) / 2),
    })
  }
  return nodes
}

/** 渲染成 Playwright 风格文本快照，同时重建 ref 表 */
// preserveRefs：补文本后要重渲染快照，但此时 ref 已经分配过了，
// 重编号会让之前返回给模型的 ref 全部错位，所以复用原 ref。
function renderSnapshot(nodes, { onlyInteractive = false, preserveRefs = false } = {}) {
  let refByNode = null
  if (preserveRefs) {
    refByNode = new Map()
    for (const [r, n] of refTable) refByNode.set(n, r)
  } else {
    refTable = new Map()
    refSeq = 0
  }
  const lines = []
  for (const n of nodes) {
    const interesting = n.clickable || n.resId || n.text
    if (onlyInteractive && !interesting) continue
    let ref
    if (preserveRefs) {
      ref = refByNode.get(n)
      if (!ref) continue
    } else {
      ref = `e${++refSeq}`
      refTable.set(ref, n)
    }
    const parts = [`- ${n.cls}`]
    // 真实文本比 resource-id 有用得多（"WLAN" vs "text1"），优先显示
    if (n.text) parts.push(`"${n.text}"`)
    else if (n.resId) parts.push(`"${n.resId.split('/').pop()}"`)
    parts.push(`[ref=${ref}]`)
    parts.push(`(${n.x1},${n.y1}-${n.x2},${n.y2})`)
    if (n.clickable) parts.push('clickable')
    lines.push('  '.repeat(Math.min(n.depth, 8)) + parts.join(' '))
  }
  return lines.join('\n')
}

function lookupRef(ref) {
  const key = String(ref || '').trim()
  if (snapshotSource === 'vd') {
    // 副屏的 ref：不做本地查表，交给副屏进程自己解析（id 在它那边维护）
    return { vdRef: key }
  }
  const n = refTable.get(key)
  if (!n) {
    throw new Error(`ref "${key}" 不存在或已过期。先调 phone_snapshot 重新获取（界面变化后 ref 会失效）`)
  }
  return n
}

export class PhoneSnapshotTool extends Tool {
  constructor() {
    super({
      name: 'phone_snapshot',
      description: '获取当前屏幕的元素树文本快照。输出是【平铺格式】：'
        + '首行状态（display/尺寸/元素数）、次行列头、之后一行一元素，形如'
        + '  #e12 Button "发送" 940,2100,1180,2200 c'
        + '用行首 id（e12）做 phone_click / phone_type 的目标。'
        + 'flags 含义：c=可点 e=可输入 s=可滚 k±=选中 off=禁用 focus=聚焦。'
        + '不截图不识图，比视觉方案快一个数量级。界面变化后必须重新 snapshot（旧 id 会失效）。',
      input_schema: {
        type: 'object',
        properties: {
          interactive_only: { type: 'boolean', description: '只列可点击/带 id 的元素（默认 true，省 token）' },
          max_nodes: { type: 'number', description: '最多返回多少个元素节点（默认 300）' },
          no_system_ui: { type: 'boolean', description: '滤掉状态栏/输入法等系统 UI（默认 true）' },
          include_text: { type: 'boolean', description: '额外用 uiautomator 补文本内容（慢，且界面有动画时会失败）' },
        },
      },
    })
  }

  async execute(input = {}) {
    await ensurePhoneMode()
    { const g = idleGuard('phone_snapshot'); if (g) return g }
    await ensureKeepalive('正在读取屏幕')

    // ⭐ 副屏进程随时可用就优先用它 —— **与模式无关**。
    //
    // 【为什么之前写错了】我原来写成「只有 background 才走副屏」，理由是
    // 「foreground 时副屏读的是主屏、两边 ref 表混用会点错」。
    // 那是基于「副屏只能读副屏」的错误前提 —— 实际上 vd 进程的
    // windowsOnDisplay()/dumpTree() 都走 targetDisplayId()，**模式是 foreground
    // 时它读的就是主屏 0**，且它自己维护 ref、点击/输入也走同一个 targetDisplayId，
    // 全程自洽，不存在混用。
    //
    // 而 dumpsys 路径的根本缺陷在这轮实测里暴露无遗：QQ 的会话列表全是混淆类名
    // （oaq/aua/iag），拿到 `SingleLineTextView "title"` 也**没有文字内容** ——
    // 找不出「S3AI API」是哪一个。UiAutomation 能拿到 text，这是决定性差别。
    const vd = await vdAlive(1200)
    if (vd.alive) {
      const r = await vdCall('snapshot', {
        interactive_only: input.interactive_only !== false,
        max_nodes: input.max_nodes || 300,
        no_system_ui: input.no_system_ui !== false,
      }, 30000)
      if (r.ok && r.text) {
        markVdRefs(r.text)
        return r.text
      }
      // 副屏那条路出问题就落回 dumpsys —— 但把原因带出来，别静默降级
      if (r.error) console.error(`[phone] 副屏 snapshot 失败，回退 dumpsys：${String(r.error).slice(0, 120)}`)
    }

    // 必须先拿前台包名：dumpsys activity top 会输出所有存活 activity
    // （后台的桌面/输入法/Shizuku 都在里面），顺序每次都不同，
    // 只能靠 mCurrentFocus 的包名去认领对应的段。
    const focusApp = await readFocus()
    const r = await sh(`dumpsys activity top 2>/dev/null`, 60000)
    if (!r.ok && !r.out) throw new Error(`获取界面失败：${r.err || '未知错误'}`)

    const nodes = parseViewTree(pickTopSegment(r.out, focusApp))
    if (!nodes.length) throw new Error('未解析到任何可见元素（dumpsys 输出格式可能不匹配，或当前界面是 WebView/Flutter）')

    const onlyInteractive = input.interactive_only !== false
    let snap = renderSnapshot(nodes, { onlyInteractive })

    let textNote = ''
    if (input.include_text) {
      const u = await sh(`uiautomator dump /dev/stdout 2>&1 | head -c 200000`, 60000)
      if (/could not get idle state/i.test(u.out + u.err)) {
        textNote = '\n\n（补文本失败：界面有持续动画，uiautomator 等不到 idle 状态）'
          + '\n改用 phone_snapshot 不带 include_text 拿结构，或直接看画面。'
          + '\n注意：文字内容在 dumpsys 里本来就取不到，只有 uiautomator 能补 —— '
          + '所以这条失败意味着当前界面**只有类名和坐标可用，没有文字**。'
          + '\n如果界面等几秒会静止，稍后重试通常能成功。'
      } else if (u.out.includes('<node')) {
        // R8 混淆后类名是 r / k20 这种，resource-id 也只有 icon/text1 这类通用名，
        // 模型完全看不出这是「WLAN」还是「蓝牙」。所以必须把 uiautomator 的 text
        // 按坐标挂到 dumpsys 的节点上 —— 不能只是并列两份让模型自己对照。
        const texts = [...u.out.matchAll(/text="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)]
          .map(t => ({ text: t[1], x1: +t[2], y1: +t[3], x2: +t[4], y2: +t[5] }))
          .filter(t => t.text.trim())
        // 【为什么反向匹配】
        // 原来是「遍历节点，找落在它里面的文本」——大容器把整片区域都包住，
        // 落在里面的任何文本都会被它认领，实测同一个「设置」挂到 7 个嵌套节点上，
        // ViewPager 和 HotSeats 还抢到了不属于它们的「锁屏」。
        // 改成「遍历文本，找能完整包含它的最小节点」，叶子优先，一个文本只挂一次。
        const nodeList = [...refTable.values()]
        let hit = 0
        const orphanTexts = []
        for (const t of texts) {
          const tArea = Math.max(1, (t.x2 - t.x1) * (t.y2 - t.y1))
          let best = null, bestArea = Infinity
          for (const n of nodeList) {
            if (n.text) continue                       // 已被别的文本占用
            // 要求节点完整包含文本框，而不是只包含中心点
            if (t.x1 < n.x1 || t.x2 > n.x2 || t.y1 < n.y1 || t.y2 > n.y2) continue
            const area = n.w * n.h
            // 尺寸约束：RecyclerView 里未渲染/折叠的项在 dumpsys 层级里没有对应叶子，
            // 能包含它的最小节点就成了全屏容器（1280x2772 vs 文本 300x70，差两三个数量级）。
            // 实测不加这条，ActionBarOverlayLayout 会认领「系统个性化」这类文本。
            if (area > tArea * 12) continue
            if (area < bestArea) { best = n; bestArea = area }
          }
          if (best) { best.text = t.text; hit++ }
          else orphanTexts.push(t)
        }
        // 用带文本的节点重渲染快照
        snap = renderSnapshot([...refTable.values()], { onlyInteractive: false, preserveRefs: true })
        // 未能挂到节点的文本单独列出并附中心坐标 —— 它们多是列表里未渲染的项，
        // 模型仍可能需要点它们，给出坐标让 phone_tap_xy 兜底。
        if (orphanTexts.length) {
          textNote = '\n\n以下文本无对应元素节点（可用 phone_tap_xy 按坐标点击）:\n' +
            orphanTexts.slice(0, 25).map(t =>
              `  "${t.text}" 中心 ${Math.round((t.x1 + t.x2) / 2)},${Math.round((t.y1 + t.y2) / 2)}`
            ).join('\n')
        }
        textNote = `\n（已为 ${hit} 个元素补上文本）` + textNote
      }
    }

    // 实际格式：mCurrentFocus=Window{7eb80b1 u0 com.termux/com.termux.app.TermuxActivity}
    // 原正则按空格取第 3 段，但花括号让分组对不上，恒返回「未知」。
    // 直接抓「包名/类名」这个特征串最稳。
    const focusLine = focusApp || '未知'
    return `前台: ${focusLine}\n元素 ${refSeq} 个${onlyInteractive ? '（仅交互元素）' : ''}\n\n${snap}${textNote}`
  }
}

export class PhoneClickTool extends Tool {
  constructor() {
    super({
      name: 'phone_click',
      description: '点击手机屏幕上的元素。传 phone_snapshot 输出里行首的 id（如 e12，纯数字 12 也行）——'
        + '内部换算成元素中心坐标，不需要你算坐标。'
        + '如果报「已失效」，说明界面刷新过，重新 phone_snapshot 再点。',
      input_schema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'phone_snapshot 里的节点 id，如 e12 或 12' },
          long_press: { type: 'boolean', description: '长按（默认 false）' },
        },
        required: ['ref'],
      },
    })
  }

  async execute(input) {
    await ensurePhoneMode()
    { const g = idleGuard('phone_click'); if (g) return g }
    await ensureKeepalive('正在点击')
    const n = lookupRef(input.ref)
    // 副屏来源：id 交给副屏进程解析（它的 ref 表在那边维护）
    if (n.vdRef) {
      const r = await vdCall('click', { ref: n.vdRef }, 20000)
      if (!r.ok) throw new Error(r.error || `点击 ${n.vdRef} 失败`)
      return `已点击 ${n.vdRef}\n界面可能已变化，需要继续操作请重新 phone_snapshot`
    }
    const cmd = input.long_press
      ? `${await inputPrefix()} swipe ${n.cx} ${n.cy} ${n.cx} ${n.cy} 600`
      : `${await inputPrefix()} tap ${n.cx} ${n.cy}`
    const r = await sh(cmd, 30000)
    if (!r.ok) throw new Error(`点击失败：${r.err}`)
    return `已${input.long_press ? '长按' : '点击'} ${n.cls}${n.resId ? ` (${n.resId.split('/').pop()})` : ''} @ ${n.cx},${n.cy}\n界面可能已变化，需要继续操作请重新 phone_snapshot`
  }
}

export class PhoneTapXYTool extends Tool {
  constructor() {
    super({
      name: 'phone_tap_xy',
      description: '按绝对坐标点击屏幕。仅在没有可用 ref 时使用——比如 phone_snapshot 报「以下文本无对应元素节点」时，用它给出的中心坐标点击。优先用 phone_click 按 ref 点。',
      input_schema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: '横坐标' },
          y: { type: 'number', description: '纵坐标' },
          // 截图会被缩放到长边 2048（省 token），模型看到的坐标是缩放后的。
          // 原来要模型自己乘回原始分辨率，实测十几轮里每轮都要手算一次，
          // 又慢又容易错。现在传 from_screenshot:true 由工具查缩放比例自动换算。
          from_screenshot: { type: 'boolean', description: '坐标来自 phone_screenshot 的缩放图时设 true，工具自动换算成真实像素' },
          long_press: { type: 'boolean', description: '长按（默认 false）' },
        },
        required: ['x', 'y'],
      },
    })
  }

  async execute(input) {
    await ensurePhoneMode()
    { const g = idleGuard('phone_tap_xy'); if (g) return g }
    await ensureKeepalive('正在点击')
    let x = Number(input.x), y = Number(input.y)
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
      throw new Error(`坐标不合法: ${input.x},${input.y}`)
    }

    // 按截图坐标点击：查最近一次截图的缩放比例自动换算。
    // 不加这个的话模型每轮都要手算「缩放图坐标 × 比例」，实测十几轮里
    // 每轮一次乘法，又慢又容易算错。
    let note = ''
    if (input.from_screenshot) {
      if (!lastShotScale) {
        throw new Error('还没有截图记录，无法换算。先调 phone_screenshot，或直接传真实像素坐标（不设 from_screenshot）')
      }
      const ox = x, oy = y
      x = x * lastShotScale.sx
      y = y * lastShotScale.sy
      note = `（截图坐标 ${Math.round(ox)},${Math.round(oy)} → 真实 ${Math.round(x)},${Math.round(y)}）`
    }
    x = Math.round(x); y = Math.round(y)

    const cmd = input.long_press
      ? `${await inputPrefix()} swipe ${x} ${y} ${x} ${y} 600`
      : `${await inputPrefix()} tap ${x} ${y}`
    const r = await sh(cmd, 30000)
    if (!r.ok) throw new Error(`点击失败：${r.err}`)
    if (note) {
      return `已${input.long_press ? '长按' : '点击'} ${x},${y} ${note}\n界面可能已变化，需要继续操作请重新 phone_snapshot`
    }
    return `已${input.long_press ? '长按' : '点击'}坐标 ${x},${y}\n界面可能已变化，需要继续操作请重新 phone_snapshot`
  }
}

export class PhoneTypeTool extends Tool {
  constructor() {
    super({
      name: 'phone_type',
      description: '在手机上输入文本。'
        + '建议先 phone_click 那个输入框（让它获得焦点）再调用，此时不用给 ref；'
        + '也可以直接给 ref=输入框的节点 id（如 e12），跳过点击那一步。'
        + '返回里会说明是否通过回读校验：报 verify_mismatch 说明内容没真正写进去'
        + '（字段有长度/格式限制，或被输入法过滤），别当成成功。'
        + '「节点已失效」表示界面刷新过，重新 snapshot 再试。',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要输入的文本' },
          ref: { type: 'string', description: '可选：先点击这个 ref 聚焦输入框' },
          submit: { type: 'boolean', description: '输入后按回车（默认 false）' },
        },
        required: ['text'],
      },
    })
  }

  async execute(input) {
    await ensurePhoneMode()
    { const g = idleGuard('phone_type'); if (g) return g }
    await ensureKeepalive('正在输入')
    if (input.ref) {
      const n = lookupRef(input.ref)
      await sh(`${await inputPrefix()} tap ${n.cx} ${n.cy}`, 20000)
      await new Promise(r => setTimeout(r, 400))
    }
    const text = String(input.text)
    const nonAscii = /[^\x00-\x7F]/.test(text)

    // 【为什么中文要走剪贴板】
    // adb input text 底层用 KeyCharacterMap 把字符映射成按键事件，非 ASCII
    // 压根没有对应键位，中文直接丢失或变乱码。唯一可靠的办法是写进系统剪贴板
    // 再发粘贴事件 —— termux-clipboard-set 现成可用。
    if (nonAscii) {
      const setOk = await new Promise(resolve => {
        try {
          // 数组传参，不拼 shell，避免文本里的引号/反引号被解释
          execFile('termux-clipboard-set', [text], { timeout: 20000 }, (e) => resolve(!e))
        } catch { resolve(false) }
      })
      if (!setOk) throw new Error('写剪贴板失败（需要 Termux:API 应用 + termux-api 包）')
      // KEYCODE_PASTE(279) 是标准粘贴键，主流 ROM 都响应。
      //
      // 【不要再加「Ctrl+V 兜底」】
      // 原来这里跟了一行 `input keyevent --longpress KEYCODE_V`，注释写的是 Ctrl+V，
      // 但它压根没带 Ctrl 修饰符 —— 实际语义是「长按字母 V 键」，粘贴不会发生，
      // 只会往输入框敲一个字母 v；--longpress 在部分 ROM 上还会重复触发，
      // 于是每次中文输入都在正文后面多出 v 或 vv（2026-08-27 实测微信搜索框复现）。
      // 真要发 Ctrl+V 必须用 `input keyevent --metastate META_CTRL_ON 50`，
      // 但 279 已经够用，多发一次反而有副作用，所以这里只发 279。
      await sh(`${await inputPrefix()} keyevent 279`, 20000)
      await new Promise(r => setTimeout(r, 250))
      if (input.submit) await sh(`${await inputPrefix()} keyevent KEYCODE_ENTER`, 20000)
      // 回读校验（提示词 P:386 承诺的 verify_mismatch 信号 —— 粘贴是
      // 「发射」语义，必须回读才知道应用收没收）。null = 无法校验，跳过。
      const vr = await verifyFocusText(text)
      const verifyNote = vr === true
        ? `\n回读校验通过（内容已写入）。`
        : vr === false
          ? `\n⚠️ verify_mismatch：输入执行了但回读不一致（可能被输入法过滤或字段有限制）。` +
            `请用 phone_snapshot 确认实际内容，别当成成功。`
          : ''
      return `已粘贴文本: ${text.slice(0, 60)}${input.submit ? '（并回车）' : ''}\n` +
        `（含中文，走剪贴板粘贴。若未出现请确认输入框已聚焦，或手动长按输入框选粘贴）` + verifyNote
    }

    // 纯 ASCII 走 input text。空格要转 %s，这是 Android 的约定
    const safe = text.replace(/(["'`$\\])/g, '\\$1').replace(/ /g, '%s')
    const r = await sh(`${await inputPrefix()} text "${safe}"`, 30000)
    if (!r.ok) throw new Error(`输入失败：${r.err}`)
    if (input.submit) await sh(`${await inputPrefix()} keyevent KEYCODE_ENTER`, 20000)
    return `已输入${input.submit ? '并回车' : ''}: ${text.slice(0, 60)}`
  }
}

export class PhoneSwipeTool extends Tool {
  constructor() {
    super({
      name: 'phone_swipe',
      description: '滑动屏幕：滚动列表、翻页、下拉刷新。可给方向（up/down/left/right）或两点坐标。',
      input_schema: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: '滑动方向（up=内容上移即向下翻）' },
          ref: { type: 'string', description: '可选：在这个元素范围内滑动' },
          duration: { type: 'number', description: '毫秒，默认 300' },
        },
      },
    })
  }

  async execute(input = {}) {
    await ensurePhoneMode()
    { const g = idleGuard('phone_swipe'); if (g) return g }
    await ensureKeepalive('正在滑动')
    const dur = Math.max(50, Math.min(3000, Number(input.duration) || 300))
    let cx = 540, cy = 1200, span = 800
    if (input.ref) {
      const n = lookupRef(input.ref)
      cx = n.cx; cy = n.cy
      span = Math.max(200, Math.floor(Math.min(n.h, n.w) * 0.6))
    } else {
      const sz = await sh(`wm size`, 20000)
      const m = sz.out.match(/(\d+)x(\d+)/)
      if (m) { cx = Math.floor(Number(m[1]) / 2); cy = Math.floor(Number(m[2]) / 2); span = Math.floor(Number(m[2]) * 0.35) }
    }
    const dir = input.direction || 'up'
    const map = {
      up: [cx, cy + span / 2, cx, cy - span / 2],
      down: [cx, cy - span / 2, cx, cy + span / 2],
      left: [cx + span / 2, cy, cx - span / 2, cy],
      right: [cx - span / 2, cy, cx + span / 2, cy],
    }
    const [x1, y1, x2, y2] = map[dir].map(v => Math.round(v))
    const r = await sh(`${await inputPrefix()} swipe ${x1} ${y1} ${x2} ${y2} ${dur}`, 30000)
    if (!r.ok) throw new Error(`滑动失败：${r.err}`)
    return `已向 ${dir} 滑动 (${x1},${y1} → ${x2},${y2})\n界面已变化，需要继续操作请重新 phone_snapshot`
  }
}

// 【2026-10-07 从 APK 移植】APK 的 PhoneTools.kt 有 phone_scroll，CLI 只有 phone_swipe。
// 语义差异：phone_swipe 的 ref 是「在元素范围内滑」（span 按元素尺寸 0.6），
// phone_scroll 的 ref 是「滚那个元素」——以元素中心为起点滑固定距离，
// 不按元素高度算（小元素会滑不动）。无 ref 时滑整屏（比 swipe 的 0.35 屏高更接近一屏）。
export class PhoneScrollTool extends Tool {
  constructor() {
    super({
      name: 'phone_scroll',
      description: '滚动。给 ref 就滚那个元素，否则按 direction（up/down）滑一屏。',
      input_schema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '要滚动的元素 id（省略则滑整屏）' },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: '滚动方向（up=内容上移即向下翻），默认 down' },
          duration: { type: 'number', description: '毫秒，默认 300' },
        },
      },
    })
  }

  async execute(input = {}) {
    await ensurePhoneMode()
    { const g = idleGuard('phone_scroll'); if (g) return g }
    await ensureKeepalive('正在滚动')
    const dur = Math.max(50, Math.min(3000, Number(input.duration) || 300))
    const dir = String(input.direction || 'down').toLowerCase()
    if (!['up', 'down', 'left', 'right'].includes(dir)) throw new Error('direction 必须是 up/down/left/right')
    let x1, y1, x2, y2
    if (input.ref) {
      // ref 模式：以元素中心为起点，按方向滑固定 200px
      const n = lookupRef(input.ref)
      if (!n || !Number.isFinite(n.cx) || !Number.isFinite(n.cy)) {
        throw new Error(`ref 已失效（#${input.ref}）—— 重新 phone_snapshot 再试（ref 模式需要节点坐标，副屏 vdRef 不支持）`)
      }
      const { cx, cy } = n, d = 200
      const m = {
        up: [cx, cy + d, cx, cy - d],
        down: [cx, cy - d, cx, cy + d],
        left: [cx + d, cy, cx - d, cy],
        right: [cx - d, cy, cx + d, cy],
      }[dir]
      ;[x1, y1, x2, y2] = m
    } else {
      // 整屏模式：屏幕中心滑 0.8 屏高（接近滑一屏）
      let W = 1080, H = 1920
      const sz = await sh(`wm size`, 20000)
      const mm = sz.out.match(/(\d+)x(\d+)/)
      if (mm) { W = Number(mm[1]); H = Number(mm[2]) }
      const cx = Math.floor(W / 2), cy = Math.floor(H / 2), span = Math.floor(H * 0.8)
      const m = {
        up: [cx, cy + span / 2, cx, cy - span / 2],
        down: [cx, cy - span / 2, cx, cy + span / 2],
        left: [cx + span / 2, cy, cx - span / 2, cy],
        right: [cx - span / 2, cy, cx + span / 2, cy],
      }[dir]
      ;[x1, y1, x2, y2] = m
    }
    const [a, b, c, e] = [x1, y1, x2, y2].map(v => Math.round(v))
    const r = await sh(`${await inputPrefix()} swipe ${a} ${b} ${c} ${e} ${dur}`, 30000)
    if (!r.ok) throw new Error(`滚动失败：${r.err}`)
    const where = input.ref ? `#${input.ref} 上` : '屏幕上'
    return `已在 ${where}向 ${dir} 滚动 (${a},${b} → ${c},${e})\n界面已变化，需要继续操作请重新 phone_snapshot`
  }
}

export class PhoneKeyTool extends Tool {
  constructor() {
    super({
      name: 'phone_key',
      description: '按系统按键：back/home/recent/enter/delete/volume 等。',
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'back|home|recent|enter|delete|tab|escape|volume_up|volume_down|power，或原始 KEYCODE_XXX' },
        },
        required: ['key'],
      },
    })
  }

  async execute(input) {
    await ensurePhoneMode()
    { const g = idleGuard('phone_key'); if (g) return g }
    await ensureKeepalive('正在按键')
    const map = {
      back: 'KEYCODE_BACK', home: 'KEYCODE_HOME', recent: 'KEYCODE_APP_SWITCH',
      enter: 'KEYCODE_ENTER', delete: 'KEYCODE_DEL', tab: 'KEYCODE_TAB',
      escape: 'KEYCODE_ESCAPE', volume_up: 'KEYCODE_VOLUME_UP',
      volume_down: 'KEYCODE_VOLUME_DOWN', power: 'KEYCODE_POWER',
    }
    const raw = String(input.key || '').trim()
    // 【必须全串匹配】原来写的是 /^KEYCODE_/i，只校验开头、后面随便跟什么都放行，
    // 于是 "KEYCODE_A; id > /sdcard/x" 能通过，分号后的命令会被 rish -c 执行。
    // code 是直接拼进 shell 的，这里只允许 KEYCODE_ 加大写字母数字下划线。
    const code = map[raw.toLowerCase()] || (/^KEYCODE_[A-Z0-9_]+$/i.test(raw) ? raw.toUpperCase() : null)
    if (!code) throw new Error(`未知按键 "${raw}"。可用: ${Object.keys(map).join('/')} 或 KEYCODE_XXX`)
    const r = await sh(`${await inputPrefix()} keyevent ${code}`, 25000)
    if (!r.ok) throw new Error(`按键失败：${r.err}`)
    return `已按 ${raw} (${code})`
  }
}

export class PhoneScreenshotTool extends Tool {
  constructor() {
    super({
      name: 'phone_screenshot',
      description: '截取当前手机屏幕，图片直接注入对话由主模型看画面。'
        + '【什么时候用】phone_snapshot 拿不到有用元素时——WebView、Flutter、'
        + 'Canvas 游戏这类界面的内部结构对 dumpsys/uiautomator 是不可见的，'
        + '只能看图。看到目标后用 phone_tap_xy 按坐标点击。'
        + '【别滥用】能用 phone_snapshot 就别截图：文本快照约千把 token 且百毫秒级，'
        + '截图几千 token 还慢。',
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '可选：这次要在画面里找什么' },
        },
      },
    })
  }

  async execute(input = {}) {
    await ensurePhoneMode()
    { const g = idleGuard('phone_screenshot'); if (g) return g }
    await ensureKeepalive('正在截图')
    // 截图下来得能读。
    // 走 device 层是因为两条通道的取图方式不同：
    //   · adb：exec-out 二进制直取到 Termux 本地，不落手机盘、不受 scoped storage 限制
    //   · shizuku：rish 跑在 shell 用户下，只能 screencap 落盘再用 cat 读回
    // 以前写死「落 /sdcard/Download 再读」，在 adb 通道下是多余的绕路。
    const name = `ccm-shot-${Date.now()}.png`
    const shared = join(homedir(), 'tmp', name)
    // Shizuku 连续调用会偶发掉一次（实测连拍两张，第 1 张成功第 2 张失败，
    // 手工跑同样命令又正常）—— 是连接节流不是逻辑错，重试即可。
    // 判据以【文件真实落盘】为准，不只看返回值。
    let ok = false, lastErr = ''
    // 截**当前目标屏**，不是永远主屏。
    // background 模式下目标是副屏，截主屏会拍到用户正在看的界面
    // （2026-09-26 用户报「你截图截的是我主屏」）。
    let shotDisplay = await targetDisplay()
    if (shotDisplay < 0) shotDisplay = 0
    let fellBackToMain = false
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await captureScreen(shared, 45000, shotDisplay)
      if (r.ok && existsSync(shared)) { ok = true; break }
      lastErr = r.err || '截图为空'
      // 目标屏失效 → 落回主屏并如实说明。
      // 副屏进程可能还"活着"（vdAlive 为真）但它建的 display 早被系统回收了
      // （实测：vd status 报 display 23 正常，screencap 却说 Display Id 23 not valid，
      //   帧缓存 1499 秒没更新）。这时硬报错对用户没意义 —— 先给一张能看的图。
      if (r.invalidDisplay && shotDisplay !== 0) {
        shotDisplay = 0
        fellBackToMain = true
        continue
      }
      if (attempt < 3) await new Promise(res => setTimeout(res, 900))
    }
    if (!ok) throw new Error(`截屏失败（重试 3 次）：${lastErr}`)
    // 交给 vision 旁路。注意 images 里必须放【已编码的图片块】而不是路径字符串 ——
    // 塞路径的话 agent 会把它当图片块序列化，结果输出 "[object Object]"（实测踩过）。
    // loadImageBlock 负责缩放到 2048px 长边并做 base64 编码。
    let block
    try {
      block = loadImageBlock(shared, { maxLongEdge: 2048, maxBytes: 4 * 1024 * 1024 })
    } catch (e) {
      throw new Error(`截图编码失败：${e.message}（文件在 ${shared}，可用 ViewImage 手动查看）`)
    }

    // 记下缩放比例供 phone_tap_xy 自动换算
    const rz = block._resized
    if (rz && rz.from && rz.to && rz.to.w && rz.to.h) {
      lastShotScale = {
        sx: rz.from.w / rz.to.w,
        sy: rz.from.h / rz.to.h,
        from: rz.from, to: rz.to,
      }
    } else {
      lastShotScale = { sx: 1, sy: 1, from: null, to: null }
    }
    const scaleNote = lastShotScale.sx !== 1
      ? `\n图已缩放 ${lastShotScale.from.w}x${lastShotScale.from.h} → ${lastShotScale.to.w}x${lastShotScale.to.h}。`
        + `按图上坐标点击时用 phone_tap_xy 并设 from_screenshot:true，工具会自动换算，不要自己乘。`
      : ''

    // ⭐ 已知当前模型看不了图 → 直接走 OCR，别把图发出去白跑一轮。
    //
    // 【为什么要判】网关对不支持的模型**不报错**，而是在响应体里塞一句
    // "[Image input omitted: selected model does not support vision.]" 返回 200。
    // 于是 ViewImageTool 那个「只在 catch 里降级」的 OCR 分支永远走不到 ——
    // 图片被静默丢弃，模型看不到任何内容，用户还以为只是"模型不支持"。
    //
    // 判据由 setVisionUnavailable() 注入（agent 收到过那种占位文本后置位）。
    if (visionUnavailable()) {
      const text = await ocrFallback(shared, input.prompt)
      return `手机屏幕截图（OCR 转述，当前模型不支持读图）\n`
        + `屏幕: display ${shotDisplay >= 0 ? shotDisplay : 0}\n`
        + `path: ${shared}${scaleNote}\n`
        + `--- 识别结果 ---\n${text}`
    }

    return {
      __type: 'vision',
      text: `手机屏幕截图${input.prompt ? `（关注：${input.prompt}）` : ''}\n`
        + `屏幕: display ${shotDisplay}`
        + `${fellBackToMain
          ? '（⚠️ 副屏已失效，回落到主屏。需要副屏请用 /device vd start 重建）'
          : sessionMode === 'background' ? '（虚拟副屏）' : sessionMode === 'foreground' ? '（主屏）' : ''}\n`
        + `path: ${shared}${scaleNote}`,
      path: shared,
      images: [block],
    }
  }
}

export class PhoneWaitTool extends Tool {
  constructor() {
    super({
      name: 'phone_wait',
      description: '等界面稳定或等某段文字出现/消失，再继续操作。'
        + '这比盲等固定毫秒可靠：点完不知道该等多久，等短了抓到旧界面，等长了浪费时间。'
        + '不给参数=等界面不再变化（连续两次采样一致即认为稳定）。',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '等这段文字出现在屏幕上' },
          text_gone: { type: 'string', description: '等这段文字从屏幕消失（如等 loading 结束）' },
          // 切记不能叫 timeout：框架把工具入参的 timeout 当成「这个工具最多跑多久」
          // 的覆盖值，实测传 10000 直接把 phone_wait 本体掉断（工具当场失效）。
          max_wait_ms: { type: 'number', description: '最长等待毫秒，默认 8000，上限 30000' },
        },
      },
    })
  }

  async execute(input = {}) {
    await ensurePhoneMode()
    { const g = idleGuard('这个工具'); if (g) return g }
    await ensureKeepalive('等待界面')
    const waitMs = Number(input.max_wait_ms ?? input.timeout) || 8000
    const deadline = Date.now() + Math.max(1000, Math.min(30000, waitMs))
    const want = String(input.text || '').trim()
    const gone = String(input.text_gone || '').trim()

    // 界面指纹：节点数 + 各节点位置的聚合值。比逐字比对便宜，
    // 又足以反映「布局还在动」这件事（动画/加载会不断改变位置）。
    const fingerprint = async () => {
      // 不能 tail 截断：视图树在输出后段，切掉就解析出 0 个节点，
      // 指纹恒等于「0:0」，任意两次采样都"一致" —— 稳定判断变成永真，
      // 实测直接返回「界面已稳定（0 个元素）」，等于没等。
      const r = await sh(`dumpsys activity top 2>/dev/null`, 40000)
      const focusApp = await readFocus()
      const nodes = parseViewTree(pickTopSegment(r.out, focusApp))
      let sum = 0
      for (const n of nodes) sum += n.x1 * 31 + n.y1 * 17 + n.w * 7 + n.h
      // 包名也进指纹：前台从 A 切到 B 时元素数可能碰巧相同，
      // 不带包名会误判成「稳定」。
      return { sig: `${focusApp}|${nodes.length}:${sum}`, count: nodes.length, app: focusApp }
    }
    // 文字检测走 uiautomator（dumpsys 拿不到 text）
    const screenText = async () => {
      const u = await sh(`uiautomator dump /dev/stdout 2>&1 | head -c 200000`, 40000)
      if (/could not get idle state/i.test(u.out + u.err)) return null   // 界面还在动
      return [...u.out.matchAll(/text="([^"]+)"/g)].map(m => m[1]).join('\n')
    }

    let rounds = 0
    let prev = null
    while (Date.now() < deadline) {
      rounds++
      if (want || gone) {
        const t = await screenText()
        if (t !== null) {
          if (want && t.includes(want)) return `"${want}" 已出现（第 ${rounds} 次采样）`
          if (gone && !t.includes(gone)) return `"${gone}" 已消失（第 ${rounds} 次采样）`
        }
      } else {
        const f = await fingerprint()
        if (prev && prev === f.sig) {
          return `界面已稳定（${f.app || '未知'}，${f.count} 个元素，第 ${rounds} 次采样）\n可以 phone_snapshot 取最新元素树`
        }
        prev = f.sig
      }
      await new Promise(r => setTimeout(r, 600))
    }
    const what = want ? `等 "${want}" 出现` : gone ? `等 "${gone}" 消失` : '等界面稳定'
    return `超时未满足条件（${what}，采样 ${rounds} 次）。界面可能仍在变化，或条件本身不会达成`
  }
}

// ── 应用中文名（label）读取 ──────────────────────────────────
//
// 【为什么需要】2026-10-04 用户点出：`phone_app list` 只给包名，
// 而包名是拼音/英文（如「柠檬音乐」= com.yixiu.magicsquare），
// 用户说中文名时搜不到、找不到对应包。
//
// 【为什么不用 dumpsys】实测确认 `dumpsys package` 输出里**没有 label 字段**
// （网上流传的 `dumpsys package 包名 | grep -i label` 对本机无效），
// `dumpsys activity` 的 taskDescription 也全是 null。
// label 是**资源**（存在 APK 的 resources.arsc 里），唯一可靠来源是 aapt 读 APK。
//
// 【速度】单个 App 约 0.5~1.3 秒（复制整个 APK 到 /data/local/tmp + aapt 解析，
// 耗时取决于 APK 大小——QQ 的 APK 有 400MB）。实测 71 个第三方 App 全量扫描
// 要 60~90 秒、期间手机明显发热，所以**不做批量扫描**，只按需读单个。
// 结果缓存在 ~/.claude-code-mobile/app-labels.json，list 时只展示已缓存的。

const APP_LABELS_CACHE = dataPath('app-labels.json')

/** 读 label 缓存（失败返回空对象，不阻塞） */
function loadLabelCache() {
  try {
    if (!existsSync(APP_LABELS_CACHE)) return {}
    const d = JSON.parse(readFileSync(APP_LABELS_CACHE, 'utf-8'))
    return (d && typeof d === 'object') ? d : {}
  } catch { return {} }
}

/** 写 label 缓存（失败静默） */
function saveLabelCache(cache) {
  try {
    writeFileSync(APP_LABELS_CACHE, JSON.stringify(cache, null, 2), 'utf-8')
  } catch {}
}

/**
 * 读单个 App 的中文名。返回 label 字符串或 null。
 *
 * 【为什么绕一圈 /data/local/tmp】
 * Android shell（uid=2000）和 Termux（uid=u0_a286）是**两个沙箱**：
 * - shell 写不了 Termux 的 $TMPDIR（实测 Permission denied）
 * - Termux 读不了 /data/app（APK 所在，权限拒绝）
 * /data/local/tmp 是**双方都能访问的中立区**（shell 可写、Termux 可读）。
 * 所以流程是：shell 复制 APK 到中立区 → Termux 用 aapt 解析 → 删除中转文件。
 */
async function readAppLabel(pkg) {
  const relay = `/data/local/tmp/ccm-label-${pkg.replace(/[^\w]/g, '_')}.apk`
  try {
    // 1. Android shell 把 APK 复制到中立区
    const c = await sh(
      `APK=$(pm path ${pkg} 2>/dev/null | head -1 | sed 's/^package://'); ` +
      `[ -n "$APK" ] && cp "$APK" ${relay} && chmod 644 ${relay} && echo COPY_OK`,
      30000)
    if (!/COPY_OK/.test(c.out)) return null
    // 2. Termux 侧读中转文件（直接用 execFile 跑 aapt，不走 shell 通道）
    const { execFileSync } = await import('node:child_process')
    const out = execFileSync('aapt', ['dump', 'badging', relay],
      { encoding: 'utf-8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] })
    const m = out.match(/application-label:'([^']*)'/)
    return m ? m[1] : null
  } catch {
    return null
  } finally {
    // 3. 清理中转文件（失败静默）
    try { await sh(`rm -f ${relay}`, 10000) } catch {}
  }
}

export class PhoneAppTool extends Tool {
  constructor() {
    super({
      name: 'phone_app',
      description: '启动/切换应用，或列已安装应用。'
        + 'list 加 labels:true 可显示中文名（只显示缓存里已有的，不现场扫描——'
        + '实测全量扫描 71 个 App 要 60~90 秒且手机发烫，所以改成按需读）。'
        + '要看某个应用的中文名用 action:label + package（单个约 0.5~1.3 秒，读完进缓存）。',
      input_schema: {
        type: 'object',
        properties: {
          package: { type: 'string', description: '包名，如 com.android.settings' },
          action: { type: 'string', enum: ['launch', 'list', 'current', 'stop', 'label'], description: '默认 launch；label=读单个应用的中文名' },
          filter: { type: 'string', description: 'list 时按关键词过滤（包名或已缓存的中文名）' },
          labels: { type: 'boolean', description: 'list 时显示中文名（默认 false，只显示缓存里已有的，不现场扫描）' },
        },
      },
    })
  }

  async execute(input = {}) {
    await ensurePhoneMode()
    { const g = idleGuard('phone_app'); if (g) return g }
    await ensureKeepalive('正在切换应用')
    const action = input.action || (input.package ? 'launch' : 'current')

    if (action === 'current') {
      const r = await sh(`dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -2`, 25000)
      return r.out.trim() || '未获取到前台应用'
    }
    if (action === 'list') {
      // 默认只列第三方（-3）用户应用；filter 非空时查全部（含系统应用）——
      // 2026-09-11 用户反馈：列不出系统应用（com.android.settings 这类）。
      // 全量列表 200+ 行会淹掉有用信息，所以系统应用只在明确过滤时出现。
      const kw = String(input.filter || '').trim()
      const includeSystem = !!kw
      const flag = includeSystem ? '' : '-3'
      const r = await sh(`pm list packages ${flag} 2>/dev/null | sed 's/^package://' | sort`, 40000)
      let list = r.out.split('\n').map(s => s.trim()).filter(Boolean)

      // labels:true → **只显示缓存里已有的中文名**，不现场扫描。
      //
      // 【为什么不做批量扫描】2026-10-04 实测：单个 label 要 0.5~1.3 秒
      // （复制整个 APK 到 /data/local/tmp + aapt 解析，QQ 的 APK 有 400MB）。
      // 71 个第三方 App 全扫要 60~90 秒，期间手机明显发热——
      // 用户当场反馈「手机太烫了」，这条路不可行。
      //
      // 现在的策略：**按需读单个**（phone_app label <包名>），
      // 缓存逐步积累，list 时只展示已缓存的。
      const wantLabels = input.labels === true
      let labels = {}
      const kwLower = kw ? kw.toLowerCase() : ''

      if (wantLabels) {
        labels = loadLabelCache()
        // filter 支持中文名（只对缓存里有的）
        if (kw) {
          list = list.filter(p => p.toLowerCase().includes(kwLower)
            || String(labels[p] || '').toLowerCase().includes(kwLower))
        }
      } else if (kw) {
        list = list.filter(p => p.toLowerCase().includes(kwLower))
      }

      const tag = includeSystem ? '全部（含系统）' : '第三方'
      const show = list.slice(0, 80)
      const lines = wantLabels
        ? show.map(p => {
            const l = labels[p]
            return l ? `${p}  ${l}` : p
          })
        : show
      let out = `已安装应用（${tag}）${list.length} 个${kw ? `（含 "${kw}"）` : ''}:\n` + lines.join('\n')
      if (wantLabels) {
        const known = list.filter(p => labels[p]).length
        if (known === 0) {
          out += '\n（中文名缓存为空。要看某个应用名：phone_app label <包名>）'
        } else if (known < list.length) {
          out += `\n（中文名只显示了缓存里已有的 ${known} 个；其余用 phone_app label <包名> 按需读）`
        }
      }
      if (!includeSystem && list.length >= 80) {
        out += '\n（只显示前 80 个，加 filter 关键词可搜系统应用）'
      }
      return out
    }

    // action: 'label' —— 读单个 App 的中文名（按需，约 0.5~1.3 秒）
    if (action === 'label') {
      if (!input.package) throw new Error('label 需要 package 参数')
      if (!/^[\w.]+$/.test(input.package)) throw new Error('包名格式不合法')
      const cache = loadLabelCache()
      if (cache[input.package]) {
        return `${input.package}  ${cache[input.package]}（缓存）`
      }
      const lbl = await readAppLabel(input.package)
      if (!lbl) return `${input.package}  读不到中文名（APK 可能被加固或不存在）`
      cache[input.package] = lbl
      saveLabelCache(cache)
      return `${input.package}  ${lbl}`
    }
    if (!input.package) throw new Error('launch/stop 需要 package 参数')
    if (!/^[\w.]+$/.test(input.package)) throw new Error('包名格式不合法')

    if (action === 'stop') {
      const r = await sh(`am force-stop ${input.package}`, 30000)
      if (!r.ok) throw new Error(`停止失败：${r.err}`)
      return `已停止 ${input.package}`
    }
    // 启动到**目标屏**，不是永远主屏。
    //
    // 【原来的 bug】这里写死 `monkey -p <pkg> -c LAUNCHER 1` —— monkey 只会把应用
    // 拉到主屏（display 0）。于是 background 模式下 AI 以为自己在副屏操作，
    // 应用却开在主屏上：用户看着手机莫名其妙被打开应用，而 AI 读副屏永远是空的。
    //
    // 正解是用 `am start --display <id>` 显式指定屏。monkey 那条留着兜底 ——
    // 有些应用（尤其加固过的）不响应显式 am start，但能响应 LAUNCHER intent。
    const disp = await targetDisplay()
    const wantDisplay = disp > 0
    if (wantDisplay) {
      // 先查启动 Activity（monkey 不给组件名，am start 需要）
      const q = await sh(
        `cmd package resolve-activity --brief ${input.package} 2>/dev/null | tail -1`, 30000)
      const comp = q.out.trim()
      if (comp && comp.includes('/')) {
        const r = await sh(`am start --display ${disp} -n ${comp}`, 40000)
        // Success / Warning: Activity not started（已在前面）都算成功
        if (!/Error|Exception|does not exist/i.test(r.out + r.err)) {
          await new Promise(res => setTimeout(res, 1200))
          return `已在${sessionMode === 'background' ? '副屏' : '主屏'}启动 ${input.package}\n用 phone_snapshot 查看当前界面`
        }
      }
    }
    const r = await sh(`monkey -p ${input.package} -c android.intent.category.LAUNCHER 1 2>&1 | tail -2`, 40000)
    if (/No activities found|Error/i.test(r.out)) throw new Error(`启动失败：${r.out.trim()}`)
    await new Promise(res => setTimeout(res, 1200))
    const where = sessionMode === 'background' && !wantDisplay ? '（注意：副屏未启动，开在了主屏）' : ''
    return `已启动 ${input.package}${where}\n用 phone_snapshot 查看当前界面`
  }
}

/**
 * 在手机上执行任意 shell 命令。
 *
 * ═══════════════════════════════════════════════════════════════
 * 【为什么需要它 —— 2026-09-26 用户点出来的缺口】
 *
 * 原来的 10 个 phone 工具全是**固定动作**（点/滑/输/截/等/启动）。
 * 但实际操作手机时，大量场景需要的是**任意 shell**：
 *
 *   pkill -f ccm-vd                          重启副屏进程
 *   pm list packages | grep ccm              找包名
 *   run-as com.ccm.app cat files/install.log 读应用私有文件
 *   adb connect 127.0.0.1:5555               修通道
 *   settings get global xxx                  读系统设置
 *   dumpsys ...                              任意诊断
 *
 * ⚠️ **界面操作（am start / input tap 等）不要在这里写** —— 用专用 phone 工具
 * （phone_app / phone_click / phone_type），它们遵循当前模式的目标屏，不会搞错屏。
 *
 * 没有这个工具时，我只能绕路：
 *     Bash → node -e "import('../phone/device.mjs').then(m => m.runShell('...'))"
 * 这既啰嗦又慢（每次起一个 node 进程 ~1s），还容易因为引号转义写错。
 * 用户观察到「经常 import('../phone/device.mjs')」说的就是这件事。
 *
 * 【与 Bash 工具的区别（关键）】
 *   Bash        → 跑在 **Termux 里**（uid=Termux 应用，能读写 ~/ 和 /sdcard）
 *   phone_shell → 跑在 **Android 系统里**（uid=2000 shell，能 input/screencap/am/pm/dumpsys）
 * 两者权限域完全不同，不能互相替代。想在手机上操作就用这个。
 * ═══════════════════════════════════════════════════════════════
 */
export class PhoneShellTool extends Tool {
  constructor() {
    super({
      name: 'phone_shell',
      description: '在 Android 系统里执行 shell 命令（uid=2000 shell）。'
        + '**这是诊断通道，不是界面操作通道** —— 点击/输入/滑动/启动 App 等界面操作'
        + '一律用专用工具（phone_click / phone_type / phone_app / phone_screenshot），'
        + '它们遵循当前模式的目标屏（前台=主屏 / 后台=副屏），不会搞错屏；'
        + '不要在这里手写 am start / input tap 这类命令。'
        + '典型用途：pkill 重启进程、pm list 找包名、run-as 读应用私有文件、settings/dumpsys 诊断。'
        + '通道自动选（Shizuku 优先，失败落 adb 回环）。',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令，如 "pm list packages | grep ccm"' },
          timeout: { type: 'number', description: '超时毫秒（默认 30000，最长 120000）' },
        },
        required: ['command'],
      },
      maxResultSizeChars: 12000,
      validateInput: (input) => {
        const errors = []
        if (!input.command || !String(input.command).trim()) errors.push('command is required')
        return { valid: errors.length === 0, errors }
      },
    })
  }

  async execute(input = {}) {
    // 【不走 ensurePhoneMode / idleGuard】
    // 那两个是给「操作手机界面」用的：idle 模式下不该点击/输入。
    // 但 shell 是**通用通道**（诊断、查包名、读日志），与「要不要操作手机界面」
    // 是两件事 —— 用户选了 idle 只是说「别动我屏幕」，不代表「别执行 pwd」。
    // 强制它反而会挡住合理的诊断需求（比如查副屏为什么没起来）。
    const cmd = String(input.command || '').trim()
    const t = Math.min(Math.max(Number(input.timeout) || 30000, 1000), 120000)
    try {
      const r = await runShell(cmd, t)
      const out = (r.out || '').trim()
      const err = (r.err || '').trim()
      // 空输出也要给个明确回执，否则模型不知道是「命令没输出」还是「工具坏了」
      if (!out && !err) return `（命令已执行，无输出）\n$ ${cmd}`
      let s = out
      if (err) s += (s ? '\n' : '') + `[stderr] ${err}`
      return s
    } catch (e) {
      throw new Error(`执行失败：${e.message}\n命令：${cmd}`)
    }
  }
}

/**
 * 虚拟副屏进程管理。
 *
 * 【为什么需要】原来 /device vd start|stop|status 是 slash 命令，我虽然能用
 * CommandExec 调（用户 2026-09-26 提醒过「slash 命令你全能跑」），
 * 但「副屏起没起来」是操作手机时的**高频前置检查** —— 每次都要切到 CommandExec
 * 再切回来，不如做成工具顺手。两者底层是同一套 core/device.mjs，不会漂移。
 */
export class PhoneVdTool extends Tool {
  constructor() {
    super({
      name: 'phone_vd',
      description: '虚拟副屏进程管理（后台操作手机用的那个屏）。'
        + 'status 看状态（含 display id、帧缓存新鲜度）；start 启动；stop 停止；restart 重启。'
        + '副屏「帧缓存过期」时 snapshot 会读到旧画面，此时需要 restart。',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'start', 'stop', 'restart'], description: '默认 status' },
        },
      },
    })
  }

  async execute(input = {}) {
    const action = input.action || 'status'
    const { vdStart, vdStop, vdAlive } = await import('../phone/device.mjs')

    if (action === 'status') {
      const a = await vdAlive(3000)
      if (!a.alive) return '副屏未运行。用 phone_vd start 启动。'
      const fresh = a.usable ? '新鲜' : '已过期'
      return [
        `副屏运行中`,
        `  display id: ${a.displayId}`,
        `  帧缓存    : ${fresh}（${Math.round((a.frameAgeMs || 0) / 1000)} 秒前更新）`,
        a.stale ? `  ⚠️ ${a.warn || '帧缓存过期，画面可能是旧的。建议 phone_vd restart'}` : '',
      ].filter(Boolean).join('\n')
    }

    if (action === 'stop') {
      await vdStop()
      return '副屏已停止'
    }

    if (action === 'restart') {
      // 先杀残留（pkill 比 vdStop 更彻底 —— 有时进程活着但 HTTP 端口没响应，
      // 此时 vdStop 的握手会失败，进程却还占着屏）
      try { await runShell('pkill -f ccm-vd', 8000) } catch {}
      await new Promise(r => setTimeout(r, 2000))
    }

    const r = await vdStart({ timeout: 50000 })
    if (!r.ok) throw new Error(`副屏启动失败：${r.err || JSON.stringify(r)}`)
    await new Promise(res => setTimeout(res, 2500))
    const a = await vdAlive(3000)
    return `副屏已启动\n  display id: ${a.displayId}\n  可用: ${a.usable ? '是' : '否（帧缓存还没刷新，稍等再试）'}`
  }
}

/**
 * 通道与设备状态总览。
 *
 * 【与 /device 的关系】/device 无参就是干这个的。做成工具是为了让我
 * 在操作手机卡住时能**立刻自查**（通道通不通、走的哪条、目标屏是几），
 * 不用切 CommandExec。
 */
export class PhoneDeviceTool extends Tool {
  constructor() {
    super({
      name: 'phone_device',
      description: '手机操作通道状态总览：当前走哪条通道（Shizuku/adb）、目标屏是几、'
        + '手机操作模式、副屏是否可用。操作手机遇到问题时先看它。'
        + 'test 会实际跑一条命令验证通道可用性。',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'test'], description: '默认 status' },
        },
      },
    })
  }

  async execute(input = {}) {
    const action = input.action || 'status'
    const cfg = loadDeviceConfig()

    if (action === 'test') {
      const t0 = Date.now()
      try {
        const r = await runShell('echo ok; id | cut -d" " -f1', 20000)
        const out = (r.out || '').trim()
        return `通道可用（${Date.now() - t0}ms）\n  ${out.replace(/\n/g, '\n  ')}`
      } catch (e) {
        return `通道不可用：${e.message}\n\n排查：\n`
          + `  · 配置的通道: ${cfg.shell}\n`
          + `  · Shizuku 是否在跑（打开 Shizuku app 看）\n`
          + `  · adb 是否连着: adb connect 127.0.0.1:5555\n`
          + `  · 无线调试是否开着（系统设置 → 开发者选项）`
      }
    }

    // status：一次拿全
    const lines = []
    // 【2026-10-09 修】目标屏按「有效模式」推算 —— 原来直接调 targetDisplay()，
    // 而 sessionMode 未定时它按 idle 返回 -1，显示「（无，idle 模式）」，
    // 与用户设的偏好自相矛盾（设了主屏却报无目标屏），Agent 会被带偏。
    const effMode = sessionMode || (() => {
      const p = getPhoneModePreference()
      return (p === 'foreground' || p === 'background') ? p : null
    })()
    try {
      if (effMode === 'foreground') {
        lines.push('目标屏: 0（主屏）')
      } else if (effMode === 'background') {
        // ⚠️ 不能调 targetDisplay() —— 它依赖 sessionMode，null 时按 idle 返回 -1。
        // 这里直接查副屏本身。
        const vd = await vdAlive(1200).catch(() => ({ alive: false }))
        lines.push(`目标屏: ${vd.alive && vd.displayId > 0 ? vd.displayId : '（副屏未建；后台模式需要虚拟屏）'}`)
      } else {
        lines.push('目标屏: （未定 —— 首次用手机工具时会弹框询问）')
      }
    } catch { lines.push('目标屏: 获取失败') }
    // 【2026-10-05 修】原来只显示 sessionMode（本次会话内存值），而 sessionMode
    // 要等首次调用手机工具时才由 ensurePhoneMode() 初始化。用户设了偏好
    // （device.json 的 phoneMode）但还没操作过手机时，这里会误导性地显示「未选」。
    // 修法：sessionMode 为空时回退显示偏好值，并标注来源。
    if (sessionMode) {
      lines.push(`操作模式: ${sessionMode}`)
    } else {
      const pref = getPhoneModePreference()
      const prefLabel = pref === 'foreground' ? '前台（操作主屏）'
        : pref === 'background' ? '后台（虚拟副屏）'
        : pref === 'ask' ? '每次询问'
        : null
      lines.push(`操作模式: ${prefLabel ? `${prefLabel}（偏好，下次调用生效）` : '（未选）'}`)
    }
    lines.push(`配置通道: ${cfg.shell}${cfg.shell === 'auto' ? '（自动：先试 Shizuku，失败落 adb）' : ''}`)
    lines.push(`adb 目标: ${cfg.adb ? `${cfg.adb.host}:${cfg.adb.port}` : '（未配置）'}`)

    try {
      const r = await runShell('echo $USER; id 2>/dev/null | head -c 80', 15000)
      const who = (r.out || '').trim().split('\n')[0] || '?'
      lines.push(`实际身份: ${who}（通道通了）`)
    } catch (e) {
      lines.push(`实际身份: ❌ 通道不通 — ${e.message.slice(0, 80)}`)
    }

    const a = await vdAlive(2000).catch(() => ({ alive: false }))
    lines.push(`副屏: ${a.alive ? `运行中 (display ${a.displayId}${a.usable ? '' : '，帧缓存过期'})` : '未运行'}`)

    return lines.join('\n') + '\n\n（phone_device test 可实测通道；/device 命令有更多选项）'
  }
}

/**
 * phone_handoff —— 跨屏接力（把 App 从一个屏迁到另一个屏）。
 *
 * 【为什么需要】参考 AcidGr/agent-mobile-use 的 /api/handoff。
 * 「无感后台」的核心：用户正在主屏看某个 App，AI 要操作它时，
 * 不该粗暴地「抢过来自己点」，而应该**把那个 App 迁到副屏**继续，
 * 用户的主屏回到桌面（或继续干别的）。
 *
 * 【实现】就两行 Android 原生命令（照抄 amu 的做法）：
 *   1. 找源屏最顶层的 task：
 *      dumpsys activity activities | grep -A 8 "Display #<id>" | grep topResumedActivity
 *   2. 移动整个 task：
 *      cmd activity display move-stack <taskId> <目标屏>
 *
 * 【为什么用 move-stack 而不是 am start --display】
 * am start 是「在新屏重新启动」，App 会重走启动流程（可能丢状态、重放广告）。
 * move-stack 是「把已经在跑的 task 整体搬过去」，界面状态完整保留 —— 这才是「接力」。
 */
export class PhoneHandoffTool extends Tool {
  constructor() {
    super({
      name: 'phone_handoff',
      description: '跨屏接力：把某个屏上正在运行的 App 整体搬到另一个屏。'
        + '\n【典型场景】后台模式（操作副屏）时，用户主屏开着某个 App，你要操作它但不想占他屏幕 —— '
        + '先 phone_handoff 把它迁到副屏，再在副屏操作。'
        + '\n【与 phone_app 的区别】phone_app 是「在新屏重新启动」（会重走启动流程、可能丢状态）；'
        + 'phone_handoff 是「把正在跑的 task 整体搬过去」（状态完整保留）。'
        + '\n【参数】省略 from/to 时：from 默认主屏(0)，to 默认跟随当前模式（前台=主屏 / 后台=副屏）。',
      input_schema: {
        type: 'object',
        properties: {
          from: { type: 'number', description: '源屏 display id，默认 0（主屏）' },
          to: { type: 'number', description: '目标屏 display id，默认跟随当前模式（前台=主屏 / 后台=副屏）' },
          package: { type: 'string', description: '可选：指定搬哪个包（默认搬源屏最顶层的 App）' },
        },
      },
    })
  }

  async execute(input = {}) {
    const from = Number.isFinite(input.from) ? input.from : 0
    let to = Number.isFinite(input.to) ? input.to : null

    // 目标屏默认跟随当前模式（【2026-10-09 修】原来无脑默认副屏 ——
    // 前台模式下 Agent 调 handoff 也会把 App 往副屏搬，与用户选的模式相悖）。
    // 前台模式 → 目标屏 = 主屏 0（与默认 from=0 相同 → 走下方「无需接力」分支）。
    // sessionMode 未定时回退读偏好（与 phone_device 同款逻辑）。
    const effMode = sessionMode || (() => {
      const p = getPhoneModePreference()
      return (p === 'foreground' || p === 'background') ? p : null
    })()
    if (to === null) {
      if (effMode === 'foreground') {
        to = 0
      } else {
        const a = await vdAlive(3000).catch(() => ({ alive: false }))
        if (!a.alive) return '副屏未运行，无法接力。先用 phone_vd start 启动副屏，或显式传 to 参数。'
        to = a.displayId
      }
    }
    if (from === to) {
      return `源屏和目标屏相同（${from}），无需接力。`
        + (effMode === 'foreground'
          ? '\n当前是前台模式（操作主屏）—— 直接在主屏上用 phone_snapshot / phone_click 操作即可，不需要搬运。确实要搬到副屏请显式传 to。'
          : '')
    }

    // ① 找源屏最顶层的 task
    let taskId = 0
    let component = ''
    const wantPkg = String(input.package || '').trim()

    try {
      const r = await runShell(`dumpsys activity activities 2>/dev/null | grep -A 12 "Display #${from}"`, 20000)
      const text = r.out || ''

      // 匹配 topResumedActivity=ActivityRecord{hash u0 包名/Activity t<taskId>}
      // 也兼容 taskId= 的写法（不同 Android 版本 dumpsys 格式有差异）
      const lines = text.split('\n')
      for (const line of lines) {
        const m = line.match(/topResumedActivity=ActivityRecord\{[0-9a-fA-F]+\s+u\d+\s+([\w.]+)\/([\w.$]+)\s+t(\d+)/)
          || line.match(/topResumedActivity=ActivityRecord\{[0-9a-fA-F]+\s+u\d+\s+([\w.]+)\/([\w.$]+)\s+taskId=(\d+)/)
        if (m) {
          component = `${m[1]}/${m[2]}`
          taskId = parseInt(m[3], 10)
          break
        }
      }

      // 兜底：从 Task{...} 行找（格式：* Task{hash #12345 type=standard A=10349:com.xxx ...}）
      if (!taskId) {
        for (const line of lines) {
          const m = line.match(/\* Task\{[0-9a-fA-F]+\s+#(\d+)\s+[^}]*A=\d+:([\w.]+)/)
          if (m) {
            const pkg = m[2]
            if (pkg.includes('launcher') || pkg.includes('systemui')) continue
            if (wantPkg && !pkg.includes(wantPkg)) continue
            taskId = parseInt(m[1], 10)
            component = pkg
            break
          }
        }
      }

      // 指定了包名时，再按包名过滤一遍
      if (taskId && wantPkg && !component.includes(wantPkg)) {
        for (const line of lines) {
          const m = line.match(/\* Task\{[0-9a-fA-F]+\s+#(\d+)\s+[^}]*A=\d+:([\w.]+)/)
          if (m && m[2].includes(wantPkg)) {
            taskId = parseInt(m[1], 10)
            component = m[2]
            break
          }
        }
      }
    } catch (e) {
      return `读取 display ${from} 的活动栈失败：${e.message}`
    }

    if (!taskId) {
      return `display ${from} 上没找到可搬的 App（可能只有桌面/系统界面）。`
        + (wantPkg ? `\n指定了包名 ${wantPkg}，但该屏顶层没有它。` : '')
        + '\n提示：先确认那屏上确实开着目标 App（phone_snapshot 看一眼）。'
    }

    // ② 移动 task
    try {
      const r = await runShell(`cmd activity display move-stack ${taskId} ${to} 2>&1`, 20000)
      const out = (r.out || '').trim()
      // move-stack 成功时通常无输出（或 "Display move-stack completed"）
      const failed = /error|exception|not found|denied/i.test(out)
      if (failed) {
        return `接力失败（task ${taskId} → display ${to}）：\n${out.slice(0, 400)}`
          + '\n\n【常见原因】'
          + '\n· Android 版本不支持 move-stack（13+ 部分机型改了权限）'
          + '\n· 跨屏移动需要系统权限（我们的 shell 通道可能不够）'
          + '\n· 备选：用 am start --display <to> -n <component> 重新启动（会丢状态）'
      }
      return `✅ 已接力：${component || '顶层 App'}（task ${taskId}）从 display ${from} → ${to}`
        + (out ? `\n输出：${out.slice(0, 200)}` : '')
        + '\n\n接下来可以在目标屏上操作它了（phone_snapshot / phone_click）。'
    } catch (e) {
      return `执行 move-stack 失败：${e.message}`
    }
  }
}

export const PHONE_TOOLS = [
  PhoneSnapshotTool, PhoneScreenshotTool, PhoneClickTool, PhoneTapXYTool,
  PhoneTypeTool, PhoneSwipeTool, PhoneScrollTool, PhoneKeyTool, PhoneWaitTool,
  PhoneAppTool,
  PhoneShellTool, PhoneVdTool, PhoneDeviceTool, PhoneHandoffTool,
]

