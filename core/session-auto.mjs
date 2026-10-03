// Claude Code Mobile - 自动会话管理
import { SessionStore } from './persistence.mjs'

// 默认自动保存间隔——导出供系统提示词引用，避免文档与实现漂移
export const DEFAULT_AUTOSAVE_INTERVAL_MS = 30000

export function setupAutoSession(agent, getSessionId, sessionStore, options = {}) {
  const saveInterval = options.saveInterval || DEFAULT_AUTOSAVE_INTERVAL_MS
  const getTitle = options.getTitle || (() => null)
  const getMetadata = options.getMetadata || (() => ({}))

  const buildData = () => ({
    sessionId: typeof getSessionId === 'function' ? getSessionId() : getSessionId,
    title: getTitle(),
    savedAt: new Date().toISOString(),
    messages: agent.getHistory(),
    tokenUsage: agent.getTokenUsage(),
    // 同 index.mjs：存 API 真值，重启后免估算
    lastPromptTokens: agent.getLastPromptTokens?.() || 0,
    ...getMetadata(),
  })

  // buildData() 会序列化整份历史，原来调两次（第一次只为取 sessionId），
  // 历史长了白白多算一遍。现在只算一次。
  const persist = () => {
    try {
      const data = buildData()
      sessionStore.save(data.sessionId, data)
    } catch {}
  }

  // 自动保存定时器（兜底；正常路径是 index.mjs 每轮对话结束后立即 saveSession）
  const timer = setInterval(persist, saveInterval)

  // 保存函数（同步，可在 exit 中安全调用）
  const saveNow = () => {
    clearInterval(timer)
    persist()
  }

  // 只在 exit 时保存，不单独处理 SIGINT/SIGTERM
  // pty.mjs 的 exit 监听先触发 killAllChildren，然后这里再保存
  process.on('exit', saveNow)

  // 恢复上次会话
  // 【bug 修复 2026-09-04】原来 `messages.length === 0` 直接 return null，
  // 导致 /clear 之后重启会话 ID 漂移：/clear 存盘时 messages 是空数组，
  // 重启时这里判定「没有可恢复会话」→ index.mjs 恢复 sessionId 的分支不执行
  // → 沿用启动时 randomUUID() 的新 ID，用户看到「clear 竟然开了新对话」。
  // 现在把「恢复会话指针」和「恢复历史内容」拆开：只要文件能解析就恢复指针，
  // 历史为空时单纯不 setHistory（agent 本来就是空的，无需操作）。
  function tryResume() {
    const latest = sessionStore.latest()
    if (!latest) return null
    const data = sessionStore.load(latest)
    if (!data) return null
    const msgs = Array.isArray(data.messages) ? data.messages : []
    if (msgs.length > 0) agent.setHistory(msgs)
    // 返回 sessionId 让调用方可以恢复原会话指针，避免重启后 sessionId 漂移
    // messages 一律给数组，调用方直接读 .length 不会炸
    return { ...data, messages: msgs, sessionId: latest, empty: msgs.length === 0 }
  }

  return { cleanup: saveNow, tryResume, timer }
}
