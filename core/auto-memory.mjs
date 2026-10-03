// 自动记忆提取（对照官方 services/extractMemories/extractMemories.ts）
//
// 触发：每轮 agent.run 正常结束后（有最终回复、非打断）。
// 三个核心机制与官方对齐：
//   1. cursor 增量：只处理上次提取之后的新消息（按消息条数当 cursor——
//      官方用 message uuid，我们历史对象没有稳定 uuid，用数组下标即可，
//      因为历史只 append/compact，compact 后 cursor 重置）
//   2. 互斥：主 agent 本轮若自己写了 CLAUDE.md（Memory 工具），跳过本轮提取
//   3. 并发保护：同一时间只跑一个提取；提取期间来的新消息留到下一轮
//
// 其他保护：
//   - 只在消息净增量 ≥ MIN_DELTA_MESSAGES 时跑（打招呼/查状态不烧这一发）
//   - 提取用同 provider 的非流式小请求，maxTokens 小，纯判断+提炼
//   - 失败静默，绝不打扰主流程
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './paths.mjs'

// 【2026-10-03】原为相对路径 → 写进源码目录。改家目录绝对路径。
const STATE_PATH = join(DATA_DIR, 'automem.json')
const MIN_DELTA_MESSAGES = 4       // 净增消息少于此数不提取（一问一答就 4 条边界）
const LOOKBACK_CAP = 12           // 最多回看的消息条数
const TEXT_CAP = 3000             // 喂给提取模型的素材上限

function loadState() {
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf-8')) } catch {}
  return { cursor: 0, running: false, enabled: true, runs: 0 }
}
function saveState(st) {
  try { writeFileSync(STATE_PATH, JSON.stringify(st, null, 2)) } catch {}
}

export function getAutoMemStatus() {
  const st = loadState()
  return { enabled: st.enabled !== false, cursor: st.cursor, runs: st.runs || 0 }
}
export function setAutoMemEnabled(v) {
  const st = loadState(); st.enabled = !!v; saveState(st)
}

// 主 agent 写 CLAUDE.md 时置这个标志（MemoryTool 调用处设置），本周期提取跳过
let mainWroteMemoryThisRun = false
export function markMainWroteMemory() { mainWroteMemoryThisRun = true }

const EXTRACT_PROMPT = `你是记忆提取器。从下面这段对话增量中判断：有没有值得写进项目 CLAUDE.md 的长期记忆？

值得记：项目级约定、用户长期偏好、构建/运行命令、踩过的坑及教训、关键路径/配置位置。
不值得记：闲聊、一次性操作、报错细节、临时心态、具体的代码内容、已经写过的内容。

只输出 JSON（不要任何其他文本）：
{"remember": false}
或
{"remember": true, "text": "要追加的记忆（一两句话，中文）"}`

function messagesToText(messages) {
  return messages.map(m => {
    let text = ''
    if (typeof m.content === 'string') text = m.content
    else if (Array.isArray(m.content)) {
      text = m.content.filter(b => b?.type === 'text').map(b => b.text).join(' ')
    }
    return `${m.role === 'user' ? '用户' : '助手'}: ${text}`.slice(0, 400)
  }).join('\n').slice(-TEXT_CAP)
}

/**
 * 每轮结束后调用一次。
 * @param {Agent} agent 主 agent（读历史增量）
 * @param {ApiClient} api 复用主 API 客户端
 * @param {object} opts { cwd, memoryFile, logger, incognito }
 */
export async function maybeExtractMemory(agent, api, opts = {}) {
  const st = loadState()
  if (st.enabled === false) return
  if (st.running) return                       // 并发放门外
  if (opts.incognito) return                   // 隔离会话不记
  if (mainWroteMemoryThisRun) {                // 主 agent 自己写过了 → 不重复
    mainWroteMemoryThisRun = false
    // 仍然推进 cursor，否则这段历史下轮又爆增量
    st.cursor = agent.getHistory().length
    saveState(st)
    return
  }

  const history = agent.getHistory()
  const cursor = Math.min(st.cursor || 0, history.length)
  const delta = history.slice(cursor)
  if (delta.length < MIN_DELTA_MESSAGES) return

  const material = messagesToText(delta.slice(-LOOKBACK_CAP))
  if (!material.trim()) return

  st.running = true; st.cursor = history.length; st.runs = (st.runs || 0) + 1
  saveState(st)

  try {
    const resp = await api.createMessage({
      system: EXTRACT_PROMPT,
      messages: [
        { role: 'user', content: '当前 CLAUDE.md 头部（判断不要重复记）：\n' + readMemHead(opts.memoryFile) + '\n\n---\n\n对话增量：\n' + material },
      ],
      maxTokens: 300,
      temperature: 0.2,
    })
    const msg = resp?.choices?.[0]?.message
    const text = msg?.content || (Array.isArray(msg) ? msg.filter(b=>b?.type==='text').map(b=>b.text).join('') : '')
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return
    const parsed = JSON.parse(m[0])
    if (parsed.remember === true && typeof parsed.text === 'string' && parsed.text.trim()) {
      // 【2026-10-03】默认写数据目录（同 Memory 工具）
      appendMemory(opts.memoryFile || join(DATA_DIR, 'CLAUDE.md'), parsed.text.trim())
      opts.logger?.log?.(`[automem] 已记入: ${parsed.text.trim().slice(0, 60)}`)
    }
  } catch (e) {
    opts.logger?.log?.(`[automem] 提取失败（静默）: ${e.message}`)
  } finally {
    st.running = false
    saveState(st)
  }
}

function readMemHead(memoryFile) {
  try {
    const f = memoryFile || join(process.cwd(), 'CLAUDE.md')
    if (!existsSync(f)) return '(空)'
    return readFileSync(f, 'utf-8').slice(0, 1500)
  } catch { return '(读取失败)' }
}

function appendMemory(file, text) {
  const cur = existsSync(file) ? readFileSync(file, 'utf-8') : '# CLAUDE.md\n\n'
  const sep = cur.endsWith('\n') ? '' : '\n'
  writeFileSync(file, cur + sep + '- ' + text.replace(/\n+/g, '\n- ') + '\n', 'utf-8')
}
