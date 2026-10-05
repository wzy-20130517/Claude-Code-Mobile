// 完整适配原项目 API，对话功能真实连接，其他 mock
const API_BASE = '/api'

export interface Conversation {
  id: string
  title: string
  model: string
  providerId?: string
  created_at: string
  updated_at: string
  workspacePath?: string
}
export interface Provider { id: string; name: string; model: string; protocol: string; vision?: boolean; url?: string; baseUrl?: string; apiKey?: string; models?: any[]; supportsWebSearch?: boolean; webSearchStrategy?: string; thinking?: { enabled?: boolean; effort?: string; show?: boolean; replay?: boolean }; apiKeys?: string[]; maxOutputTokens?: number; systemTopLevel?: boolean; enabled?: boolean; temperature?: number; hasTavilyKey?: boolean; visionProviderId?: string | null;
  // 前端用 format 表示 API 协议（服务端存的是 protocol）；这两个名字历史上并存，
  // 类型里都声明，避免设置页到处报「属性不存在」。
  format?: string; webSearchTestedAt?: string; webSearchTestReason?: string }
export interface ProviderModel { id: string; name?: string; tier?: string; enabled?: number }
export interface ConnectorComposioStatus {
  available?: boolean
  configured?: boolean
  connected?: boolean
  installed?: boolean
  connectedAccountId?: string | null
  serverName?: string | null
  connectors?: Record<string, any>
  configPath?: string | null
  redirectUrl?: string
}
export interface ConnectorMcpStatus {
  available?: boolean
  installed?: boolean
  serverName?: string | null
  connectors?: Record<string, any>
  configPath?: string | null
}

// subcommands：命令 → 子命令表（面板在「/config 」这种状态下列候选）。
// 服务端在 /api/commands 里返回，类型漏了它会导致调用方解构报 TS2339。
export async function getSlashCommands(sessionId?: string): Promise<{
  commands: any[]; skills: any[];
  subcommands?: Record<string, { candidates?: string[]; desc?: Record<string, string>; nested?: Record<string, { candidates?: string[]; desc?: Record<string, string> }> }>
}> {
  const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''
  const res = await fetch(`${API_BASE}/commands${query}`)
  if (!res.ok) throw new Error('无法读取 slash 命令')
  return res.json()
}
export async function getMcpStatus() {
  const res = await fetch(`${API_BASE}/mcp/status`)
  if (!res.ok) throw new Error('无法读取 MCP 状态')
  return res.json()
}
export async function getWebConfig() {
  const res = await fetch(`${API_BASE}/config`)
  if (!res.ok) throw new Error('无法读取配置')
  return res.json()
}
export async function saveChatModelConfig(payload: { chatModels?: any[]; defaultModelId?: string | null }) {
  // 对话模型档位分配 + 默认模型。原来只写 localStorage —— 换设备/清缓存全丢，
  // 用户看到的正是「配置经常不显示」。现在存服务端 web-config.json。
  const res = await fetch(`${API_BASE}/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || `保存模型配置失败（HTTP ${res.status}）`)
  return data
}
export async function setDefaultProvider(providerId: string) {
  // 把默认 Provider 存到服务端（web-config.json）。原来设置页只写 localStorage，
  // 换设备/清缓存就丢 —— 用户看到的就是「选完不保存，每次进去又是配置一」。
  const res = await fetch(`${API_BASE}/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current: providerId }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || `保存默认 Provider 失败（HTTP ${res.status}）`)
  return data
}
export async function getMcpTools() {
  const res = await fetch(`${API_BASE}/mcp`)
  return res.json()
}
export async function getBackupStatusWeb() {
  const res = await fetch(`${API_BASE}/backup`)
  return res.json()
}
export async function runBackupWeb(method?: string) {
  const res = await fetch(`${API_BASE}/backup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method }) })
  return res.json()
}
export async function answerWebQuestion(sessionId: string, requestId: string, answers: any) {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request_id: requestId, answers }) })
  if (!res.ok) throw new Error((await res.json()).error || '回答发送失败')
  return res.json()
}

export async function getConversations(): Promise<Conversation[]> {
  const res = await fetch(`${API_BASE}/sessions`)
  const data = await res.json()
  return data.sessions.map((s: any) => ({
    id: s.id,
    title: s.title,
    model: s.model || s.providerId || 'default',
    providerId: s.providerId,
    created_at: s.createdAt || new Date().toISOString(),
    updated_at: s.updatedAt || new Date().toISOString(),
  }))
}

export async function createConversation(title?: string, model?: string, options?: { workspacePath?: string; [key: string]: unknown }): Promise<Conversation> {
  const res = await fetch(`${API_BASE}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, providerId: options?.providerId || model, model: options?.model || model, workspacePath: options?.workspacePath, ...options }),
  })
  const data = await res.json()
  return { id: data.id, title: data.title, model: data.model || data.providerId || 'default', providerId: data.providerId, workspacePath: data.workspacePath, created_at: data.createdAt || new Date().toISOString(), updated_at: data.updatedAt || new Date().toISOString() }
}

export interface WorkspaceDirectory { name: string; path: string }
export interface WorkspaceListing { path: string; parentPath: string | null; entries: WorkspaceDirectory[] }

export async function getWorkspace(): Promise<{ workspacePath: string }> {
  const res = await fetch(`${API_BASE}/workspace`)
  if (!res.ok) throw new Error('无法读取工作目录设置')
  return res.json()
}

export async function saveWorkspace(workspacePath: string): Promise<{ workspacePath: string }> {
  const res = await fetch(`${API_BASE}/workspace`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || '工作目录无效')
  return data
}

export async function listWorkspaceDirectories(path?: string): Promise<WorkspaceListing> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const res = await fetch(`${API_BASE}/directories${query}`)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || '无法读取目录')
  return data
}

export async function updateConversation(id: string, updates: any) {
  const res = await fetch(`${API_BASE}/sessions/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...updates, title: updates.title, providerId: updates.providerId, model: updates.model, thinking: updates.thinking, thinkingEffort: updates.thinkingEffort, workspacePath: updates.workspacePath }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || '会话更新失败')
  return data
}

export async function deleteConversation(id: string) {
  await fetch(`${API_BASE}/sessions/${id}`, { method: 'DELETE' })
}

export async function openConversationFolder(id: string) {
  // 用手机的文件管理器打开会话工作目录。原来那个文件夹按钮指向 Electron 端口，
  // 手机上点了没反应；这里接自建的 endpoint。
  const res = await fetch(`${API_BASE}/sessions/${id}/open-folder`, { method: 'POST' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || `打开目录失败（HTTP ${res.status}）`)
  return data
}
export async function exportConversation(id: string) {
  // 真正实现：拉服务端生成的 Markdown，在浏览器里触发下载。
  // 原来是 return {} 的空壳 —— 界面上那个 Export 按钮点了毫无反应。
  const res = await fetch(`${API_BASE}/sessions/${id}/export`)
  if (!res.ok) throw new Error(`导出失败（HTTP ${res.status}）`)
  const data = await res.json()
  const blob = new Blob([data.content || ''], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = data.filename || 'conversation.md'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return data
}
export async function getSystemStatus(): Promise<any> { return { platform: 'web', gitBash: { required: false, found: true, path: null } } }
export async function sendCode(email: string): Promise<any> { return {} }
export async function register(...args: any[]): Promise<any> { return {} }
export async function login(...args: any[]): Promise<any> { return { token: 'mock', user: {} } }
export async function gatewayLogin(...args: any[]): Promise<any> { return {} }
export function isGatewayLoggedIn() { return false }
export function gatewayLogout() {}
export async function getGatewayUsage(): Promise<any> { return {} }
export async function forgotPassword(...args: any[]): Promise<any> { return {} }
export async function resetPassword(...args: any[]): Promise<any> { return {} }
export function logout() {}

/** profile 事件名：保存成功后广播，让侧栏/首页无需刷新即可更新称呼 */
export const PROFILE_UPDATED_EVENT = 'ccm:profile-updated'

function readCachedProfile(): Record<string, any> {
  try {
    const raw = JSON.parse(localStorage.getItem('user_profile') || '{}')
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  } catch { return {} }
}

export function getUser() {
  const p = readCachedProfile()
  const nickname = p.display_name || p.full_name || 'Local'
  return { id: '1', email: 'local', nickname, ...p }
}

export async function getUserProfile() {
  // 服务端为准，拉到后同步进 localStorage 供 getUser() 同步读取
  try {
    const res = await fetch(`${API_BASE}/profile`)
    if (!res.ok) return readCachedProfile()
    const data = await res.json()
    if (data && typeof data === 'object') {
      localStorage.setItem('user_profile', JSON.stringify(data))
      return data
    }
  } catch { }
  return readCachedProfile()
}

export async function updateUserProfile(patch: Record<string, any> = {}) {
  // 先写本地（即时生效），再同步服务端（systemPrompt 注入要用）
  const merged = { ...readCachedProfile(), ...patch }
  localStorage.setItem('user_profile', JSON.stringify(merged))
  let saved: Record<string, any> = merged
  try {
    const res = await fetch(`${API_BASE}/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (res.ok) {
      const data = await res.json()
      if (data && typeof data === 'object') {
        saved = data
        localStorage.setItem('user_profile', JSON.stringify(data))
      }
    }
  } catch { }
  try { window.dispatchEvent(new CustomEvent(PROFILE_UPDATED_EVENT, { detail: saved })) } catch { }
  return saved
}
export async function getUserUsage(): Promise<any> { return { usage: {} } }
export async function getUnreadAnnouncements(): Promise<any> { return [] }
export async function markAnnouncementRead(...args: any[]) {}
export async function getUserModels() {
  const res = await fetch(`${API_BASE}/config`)
  const data = await res.json()
  return {
    all: (data.providers || []).flatMap((p: Provider) => (p.models || []).map((m: any) => ({ id: m.id, name: m.name || m.id, providerId: p.id, providerName: p.name, enabled: m.enabled === false ? 0 : 1, tier: m.tier || 'extra', thinkingId: m.thinkingId }))),
    common: (data.providers || []).flatMap((p: Provider) => (p.models || []).filter((m: any) => m.enabled !== false).map((m: any) => ({ id: m.id, name: m.name || m.id, providerId: p.id, providerName: p.name, enabled: 1, tier: m.tier || 'extra', thinkingId: m.thinkingId }))),
    fallback_model: data.providers?.[0]?.model || '',
  }
}
export async function getSessions() { return [] }
export async function deleteSession(...args: any[]) {}
export async function logoutOtherSessions() {}
export async function changePassword(...args: any[]) {}
export async function deleteAccount(...args: any[]) {}
export async function getPlans() { return [] }
export async function createPaymentOrder(...args: any[]): Promise<any> { return {} }
export async function getPaymentStatus(...args: any[]): Promise<any> { return {} }
export async function redeemCode(...args: any[]): Promise<any> { return {} }
/**
 * 项目（Projects）—— 持久化知识容器。
 *
 * 【2026-09-20 从 stub 换成真实实现】
 * 用户反馈「web 中有"项目"这个概念，但实际没做」——核实属实：
 * 这 9 个函数原本**全是 stub**（`return []` / `return {}`），
 * UI（ProjectsPage.tsx，858 行）是照抄官方的完整界面，但点了什么都不发生，
 * 服务端也没有任何 /api/projects 端点。
 *
 * 现在服务端补齐了（web/server.mjs + web/projects.mjs，按官方语义：
 * 知识库 + 项目指令 + 对话归属），前端改为真实 fetch。
 */
export async function getProjects(): Promise<Project[]> {
  const res = await fetch(`${API_BASE}/projects`)
  if (!res.ok) return []
  const data = await res.json().catch(() => ({}))
  return data.projects || []
}
/**
 * 建项目。**兼容两种调用姿势**：老的 UI 用位置参数（name, description），
 * 新代码可能传对象 —— 都接住，省得改一堆调用点。
 */
export async function createProject(
  nameOrBody: string | { name: string; description?: string; instructions?: string },
  description?: string,
  instructions?: string,
): Promise<Project> {
  const body = typeof nameOrBody === 'string'
    ? { name: nameOrBody, description: description || '', instructions: instructions || '' }
    : (nameOrBody || { name: '' })
  const res = await fetch(`${API_BASE}/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `创建项目失败（HTTP ${res.status}）`)
  return res.json()
}
export async function getProject(id: string): Promise<Project> {
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '项目不存在')
  return res.json()
}
export async function updateProject(id: string, patch: Partial<Project>): Promise<any> {
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '更新项目失败')
  return res.json()
}
export async function deleteProject(id: string): Promise<void> {
  await fetch(`${API_BASE}/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
/**
 * 把文件挂到项目知识库。
 *
 * 走两步：先 POST /api/uploads 让服务端落盘拿到真实路径（复用已有的
 * multipart 解析，不在这里再实现一遍），再 POST 到项目下登记。
 * 这样大文件、进度、MIME 判断都沿用上传通道的既有实现。
 */
export async function uploadProjectFile(projectId: string, file: File): Promise<ProjectFile> {
  const uploaded: any = await uploadFile(file)   // 复用上传通道 → { fileId, path, ... }
  const sourcePath = uploaded?.path || uploaded?.filePath
  if (!sourcePath) throw new Error('上传成功但没拿到落盘路径')
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(projectId)}/files`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourcePath, fileName: file.name, mimeType: file.type, size: file.size }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '挂载到项目失败')
  return res.json()
}
export async function deleteProjectFile(projectId: string, fileId: string): Promise<void> {
  await fetch(`${API_BASE}/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' })
}
export async function getProjectConversations(projectId: string): Promise<any[]> {
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(projectId)}/conversations`)
  if (!res.ok) return []
  const data = await res.json().catch(() => ({}))
  return data.conversations || []
}
export async function createProjectConversation(projectId: string, title?: string, model?: string): Promise<any> {
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(projectId)}/conversations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title || undefined, model: model || undefined }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '创建项目对话失败')
  return res.json()
}
export async function getUserArtifacts(): Promise<any[]> { return [] }
export async function getArtifactContent(...args: any[]): Promise<any> { return { content: '' } }
/**
 * 连接器状态（GitHub / QQ）。
 *
 * 【2026-09-19】原来 getGithubStatus 是个 stub（永远 connected:false），
 * 所以连接器页面那个「已连接」徽章从来没亮过 —— 配置了 token 也显示未连接。
 * 现在从服务端 /api/connectors/status 读真实状态（那里直接读本地配置文件）。
 */
export async function getConnectorStatuses(): Promise<{
  github: { connected: boolean; detail: string; defaultRepo?: string | null; masked?: string };
  qq: { connected: boolean; detail: string; owner?: string | null };
}> {
  try {
    const res = await fetch(`${API_BASE}/connectors/status`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    // 拉不到就返回未连接（而不是抛错把整个页面搞崩）
    return { github: { connected: false, detail: '状态获取失败' }, qq: { connected: false, detail: '状态获取失败' } };
  }
}

export async function getGithubStatus(): Promise<{ connected: boolean; user?: { login: string; avatar_url: string; name?: string } }> {
  const s = await getConnectorStatuses();
  return { connected: s.github.connected };
}
export async function getGithubAuthUrl(): Promise<any> { return { url: '#' } }
export async function getGithubRepos(_page?: number): Promise<any[]> { return [] }
export async function getGithubContents(...args: any[]): Promise<any[]> { return [] }
export async function getGithubTree(...args: any[]): Promise<any> { return { tree: [] } }
export async function disconnectGithub() {}
export async function getSkills() { const data = await getSlashCommands(); const skills = (data.skills || []).filter((s: any) => !s.passive); return { examples: skills.filter((s: any) => s.scope !== 'global').map((s: any) => ({ ...s, id: s.name, enabled: true, is_example: s.scope !== 'global' })), my_skills: skills.filter((s: any) => s.scope === 'global').map((s: any) => ({ ...s, id: s.name, enabled: true, is_example: false })) } }
export async function getSkillDetail(name: string) { const res = await fetch(`${API_BASE}/skills/${encodeURIComponent(name)}`); if (!res.ok) throw new Error('Skill 不存在'); return res.json() }
export async function getSkillFile(name: string, _filePath?: string) { const res = await fetch(`${API_BASE}/skills/${encodeURIComponent(name)}`); if (!res.ok) throw new Error('Skill 不存在'); const data = await res.json(); return { content: data.content || '' } }
export async function createSkill(input: any) { const res = await fetch(`${API_BASE}/skills`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); const data = await res.json(); if (!res.ok) throw new Error(data.error || '创建 Skill 失败'); return data }
export async function updateSkill(id: string, input: any) { const res = await fetch(`${API_BASE}/skills/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); const data = await res.json(); if (!res.ok) throw new Error(data.error || '保存 Skill 失败'); return data }
export async function deleteSkill(id: string) { const res = await fetch(`${API_BASE}/skills/${encodeURIComponent(id)}`, { method: 'DELETE' }); if (!res.ok) throw new Error('删除 Skill 失败'); return res.json() }
export async function toggleSkill(_id: string, _enabled: boolean): Promise<any> { return { ok: true } }
export async function importSkill(...args: any[]) {}
export async function getConnectorComposioStatus(_userId?: string): Promise<ConnectorComposioStatus> { return { installed: false } }
export async function getConnectorMcpStatus(): Promise<ConnectorMcpStatus> { return { installed: false } }
export async function installConnectorMcp(...args: any[]): Promise<ConnectorMcpStatus> { return { installed: false } }
export async function connectConnectorViaComposio(...args: any[]): Promise<ConnectorComposioStatus> { return { installed: false } }
export async function uninstallConnectorComposio(...args: any[]): Promise<ConnectorComposioStatus> { return { installed: false } }
export async function uninstallConnectorMcp(...args: any[]): Promise<ConnectorMcpStatus> { return { installed: false } }
export async function getProviderModels(): Promise<any[]> { return [] }
/**
 * 项目里的文件。字段名是后端 JSON 的 snake_case（file_name / file_size），
 * 不要按驼峰改 —— 前端直接读这两个字段。
 */
export interface ProjectFile {
  id: string;
  file_name: string;
  file_size: number;
  file_type?: string;
  created_at?: string;
}

/**
 * 项目。原来只有 `{ id, name }` 两个字段，但 ProjectsPage 实际还用了
 * description / instructions / files / conversations —— 类型过窄导致
 * `currentProject.files` 一类访问全报 TS2339（共 17 处噪音都源于此）。
 */
export interface Project {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  files?: ProjectFile[];
  conversations?: { id: string; title?: string }[];
  // 列表页直接显示的计数字段（后端下发，省得前端遍历 files/conversations）
  file_count?: number;
  chat_count?: number;
  is_archived?: boolean;
  created_at?: string;
  updated_at?: string;
}
export function getAttachmentUrl(fileId: string) { return `${API_BASE}/uploads/${encodeURIComponent(fileId)}/raw` }
export async function getConversation(id: string) { 
  const res = await fetch(`${API_BASE}/sessions/${id}`)
  return res.json()
}
/**
 * 共享 SSE 消费者：sendMessage 和 reconnectStream 都用它，避免两份解析逻辑漂移。
 *
 * 【为什么有它】reconnectStream 原来是个空壳函数 —— 切页面回来时前端调它恢复流，
 * 结果什么都没发生，界面永远卡在 loading。而 sendMessage 里那套断线重连逻辑
 * （Last-Event-ID 补发、指数退避）写得很完整，只是没法复用。抽出来两边共用。
 */
function createSseConsumer(conversationId: string, signal?: AbortSignal) {
  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''
  let fullThinking = ''
  let settledFlag = false
  let lastEventId = 0
  let reconnects = 0
  // 快照覆盖到的事件序号：≤ 它的补发 text/thinking 必须丢弃，
  // 否则重连时「快照 + 补发」会把同一段正文追加两遍（实测复现过）。
  let snapshotUntil = 0
  // 最近一次收到任何字节的时间。用于心跳看门狗：
  // 手机切后台会把 SSE 冻住，恢复后 reader 可能既不返回数据也不报错 ——
  // 没有这个看门狗，那种「半死连接」永远不会触发重连，界面永远停在半截输出。
  let lastByteAt = Date.now()
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  const MAX_RECONNECT = 8

  const openStream = async (afterId: number) => {
    const headers: Record<string, string> = { Accept: 'text/event-stream' }
    if (afterId > 0) headers['Last-Event-ID'] = String(afterId)
    const qs = afterId > 0 ? `?lastEventId=${afterId}` : ''
    const response = await fetch(`${API_BASE}/sessions/${conversationId}/events${qs}`, { headers, signal })
    if (!response.ok || !response.body) throw new Error(`无法连接消息流（HTTP ${response.status}）`)
    return response.body.getReader()
  }

  /** 解析一帧 SSE 文本并分发给 handlers。返回 true 表示会话已结束。 */
  const handleEvent = (raw: string, h: SseHandlers) => {
    const lines = raw.split(/\r?\n/)
    let event = 'message'
    const dataLines: string[] = []
    for (const line of lines) {
      if (line.startsWith('id:')) {
        const n = Number(line.slice(3).trim())
        if (Number.isFinite(n) && n > 0) lastEventId = n
      } else if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    if (dataLines.length === 0) return
    let data: any
    try { data = JSON.parse(dataLines.join('\n')) } catch { data = { message: dataLines.join('\n') } }

    // ready 是连接握手事件，不该透给上层当业务事件。
    // 若服务端报告缓冲缺口（断太久），通知上层整体重载会话。
    if (event === 'ready') {
      // 快照是服务端「本轮跑到此刻」的完整正文。它已经包含了 at 序号之前的所有
      // text/thinking，所以那些补发事件要丢掉，否则同一段会被追加两次。
      if (data?.snapshot && Number.isFinite(data.snapshot.at)) {
        snapshotUntil = Number(data.snapshot.at)
        if (typeof data.snapshot.text === 'string') fullText = data.snapshot.text
        if (typeof data.snapshot.thinking === 'string') fullThinking = data.snapshot.thinking
      }
      if (data?.gap) h.onEvent?.('stream_gap', '', data)
      // 握手数据（running / snapshot）必须透传：重连方要据此立即对齐当前文本，
      // 只把它当内部事件吞掉的话，切页面回来就看不到已产出的部分。
      h.onEvent?.('ready', '', data)
      return
    }
    h.onEvent?.(event, data.message || '', data)

    if (event === 'text') {
      const delta = String(data.text || '')
      // 快照已覆盖这段（补发回放），跳过；否则重复追加
      if (lastEventId <= snapshotUntil) return
      fullText += delta
      h.onText?.(delta, fullText)
    } else if (event === 'thinking') {
      const delta = String(data.text || '')
      if (lastEventId <= snapshotUntil) return
      fullThinking += delta
      h.onThinking?.(delta, fullThinking)
    } else if (event === 'tool_start') {
      let toolInput: any = {}
      try { toolInput = data.input ? JSON.parse(data.input) : {} } catch { toolInput = {} }
      h.onToolEvent?.({ type: 'start', tool_use_id: data.id, tool_name: data.name, tool_input: toolInput })
    } else if (event === 'tool_result') {
      h.onToolEvent?.({ type: 'done', tool_use_id: data.id, tool_name: data.name, content: data.result, is_error: data.error })
    } else if (event === 'done') {
      settledFlag = true
      h.onDone?.(fullText)
    } else if (event === 'command_result') {
      const text = String(data.content || '')
      // 命令可能改了 Provider/模型，交给上层刷新下拉框。
      // 【注意】这一步必须无条件调用：select / wizard 分支的 content 是空串，
      // 但 data 里带着 items / steps，上层要靠 onEvent 才能拿到并弹窗。
      h.onEvent?.('command_applied', text, data)
      // 【2026-09-20】select / wizard 是「弹窗等待用户操作」，不是回复内容。
      // 原来无条件 onText('') + onDone('')，会在聊天区插一条空 assistant 气泡，
      // 用户看到的就是「敲 /model 后多出一条空白回复」。
      const isInteractive = !!(data?.select || data?.wizard)
      if (!isInteractive) {
        fullText = text
        h.onText?.(text, text)
      }
      settledFlag = true
      h.onDone?.(text)
    } else if (event === 'error') {
      settledFlag = true
      h.onError?.(String(data.message || '生成失败'))
    }
  }

  /** 读循环：断线自动重连（带 Last-Event-ID 补发），返回前一定释放 reader */
  const pump = async (h: SseHandlers) => {
    // 看门狗：服务端每 15s 发一次 ': ping'，60s 没收到任何字节即视为死链，
    // 主动 cancel() 让阻塞中的 read() 返回，走下面的重连分支。
    const watchdog = setInterval(() => {
      if (settledFlag) return
      if (Date.now() - lastByteAt > 60000) {
        try { reader?.cancel() } catch {}
      }
    }, 10000)
    try {
      while (!settledFlag) {
        let chunk: ReadableStreamReadResult<Uint8Array>
        try {
          chunk = await reader!.read()
        } catch (readError: any) {
          if (readError?.name === 'AbortError') throw readError
          // 读失败视为断线，走重连
          chunk = { done: true, value: undefined } as any
        }
        const { done, value } = chunk
        if (done) {
          if (buffer.trim()) handleEvent(buffer, h)
          buffer = ''
          if (settledFlag) break
          // 服务端可能仍在生成：确认一下是否真的还在跑，再决定重连
          if (reconnects >= MAX_RECONNECT) { settledFlag = true; h.onError?.('消息流多次断开，已停止重连'); break }
          reconnects += 1
          h.onEvent?.('stream_reconnecting', '', { attempt: reconnects, lastEventId })
          // 指数退避，上限 5s
          await new Promise(r => setTimeout(r, Math.min(5000, 400 * reconnects)))
          if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
          try {
            try { reader!.releaseLock() } catch {}
            reader = await openStream(lastEventId)
            continue
          } catch (reopenError: any) {
            if (reopenError?.name === 'AbortError') throw reopenError
            // 重连失败：如果服务端已经不在跑了，说明这一轮已结束，按完成处理
            try {
              const status = await getConversation(conversationId)
              if (!status?.running) { settledFlag = true; h.onDone?.(fullText); break }
            } catch {}
            continue
          }
        }
        // 收到数据 = 连接健康：重置重连计数（MAX_RECONNECT 表示「连续失败次数」，
        // 而不是整个会话的累计次数 —— 否则长时间挂机反复切后台会耗尽配额）。
        lastByteAt = Date.now()
        reconnects = 0
        buffer += decoder.decode(value, { stream: true })
        const frames = buffer.split(/\r?\n\r?\n/)
        buffer = frames.pop() || ''
        for (const frame of frames) {
          if (frame.trim()) handleEvent(frame, h)
          if (settledFlag) break
        }
      }
    } finally {
      clearInterval(watchdog)
      try { await reader?.cancel() } catch {}
      try { reader?.releaseLock() } catch {}
      reader = null
    }
  }

  return {
    // afterId 显式传入时以它为准（重连方记录过上次事件 id）；
    // 省略则用内部进度（首次连接是 0 → 服务端会补发全部缓冲）。
    open: async (afterId?: number) => {
      if (typeof afterId === 'number' && Number.isFinite(afterId)) lastEventId = afterId
      reader = await openStream(lastEventId)
    },
    pump,
    handleEvent,
    abortIfSettled: () => settledFlag,
    getFullText: () => fullText,
    getLastEventId: () => lastEventId,
  }
}

interface SseHandlers {
  onText?: (delta: string, full: string) => void
  onDone?: (full: string) => void
  onError?: (error: string) => void
  onThinking?: (delta: string, full: string) => void
  onEvent?: (event: string, message: string, data: any) => void
  onToolEvent?: (event: any) => void
}

export async function sendMessage(
  conversationId: string,
  content: string,
  attachments: any[] = [],
  onText?: (delta: string, full: string) => void,
  onDone?: (full: string) => void,
  onError?: (error: string) => void,
  onThinking?: (delta: string, full: string) => void,
  onEvent?: (event: string, message: string, data: any) => void,
  onSources?: (sources: any[], query?: string, tokens?: number) => void,
  onDocument?: (document: any) => void,
  onDocumentDraft?: (draft: any) => void,
  onCodeExecution?: (data: any) => void,
  onToolEvent?: (event: any) => void,
  signal?: AbortSignal,
): Promise<void> {
  // SSE 会因手机切后台被冻结、WiFi 切换等原因断开。服务端为每个事件编了 id
  // 并保留最近 200 条，这里断开后带 Last-Event-ID 重连，补回缺口再继续。
  try {
    const accepted = await fetch(`${API_BASE}/sessions/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, attachments: attachments || [] }),
      signal,
    })
    if (!accepted.ok) {
      let message = `发送消息失败（HTTP ${accepted.status}）`
      try {
        const data = await accepted.json()
        if (data?.error) message = String(data.error)
      } catch {}
      onError?.(message)
      return
    }
    const consumer = createSseConsumer(conversationId, signal)
    await consumer.open()
    await consumer.pump({ onText, onDone, onError, onThinking, onEvent, onToolEvent })
  } catch (error: any) {
    if (error?.name === 'AbortError') throw error
    onError?.(error?.message || String(error))
  }
}

/**
 * 重连一个**已经在跑**的会话的流（不发送新消息）。
 *
 * 【为什么需要】用户切到别的页面再切回来时，原来的 SSE 连接已经随组件卸载断开，
 * 而服务端 agent 还在跑。前端必须重新挂上事件流才能继续看到输出。
 * 服务端带 Last-Event-ID 补发断线期间的事件（SSE_BUFFER_LIMIT=200 条）。
 *
 * 语义与 CLI 的「Ctrl+X 重启后接续」一致：接上已有的 run，而不是发起新的。
 */
export async function reconnectStream(
  conversationId: string,
  onText?: (delta: string, full: string) => void,
  onDone?: (full: string) => void,
  onError?: (error: string) => void,
  onThinking?: (delta: string, full: string) => void,
  onEvent?: (event: string, message: string, data: any) => void,
  onToolEvent?: (event: any) => void,
  signal?: AbortSignal,
  afterEventId?: number,
): Promise<void> {
  try {
    const consumer = createSseConsumer(conversationId, signal)
    // 【2026-09-19 修】afterEventId 原来收了却没用（形参全文件只此一处出现），
    // 于是重连永远从 0 接 —— 撞上「断开期间刚好收到 done」时，补发拿不到、
    // settledFlag 不置位、onDone 不触发 → loading 卡住。
    await consumer.open(afterEventId)
    await consumer.pump({ onText, onDone, onError, onThinking, onEvent, onToolEvent })
  } catch (error: any) {
    if (error?.name === 'AbortError') throw error
    onError?.(error?.message || String(error))
  }
}

export async function uploadFile(file: File, onProgress?: (percent: number) => void, _conversationId?: string) {
  const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error || new Error('文件读取失败')); reader.readAsDataURL(file) })
  onProgress?.(50)
  const res = await fetch(`${API_BASE}/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileName: file.name, data }) })
  const result = await res.json()
  if (!res.ok) throw new Error(result.error || '文件上传失败')
  onProgress?.(100)
  return result
}
export async function deleteAttachment(fileId: string) { const res = await fetch(`${API_BASE}/uploads/${encodeURIComponent(fileId)}`, { method: 'DELETE' }); return res.ok }
export async function compactConversation(...args: any[]): Promise<any> { return {} }
export async function answerUserQuestion(...args: any[]) {}
export async function getGenerationStatus(id: string): Promise<any> { const data = await getConversation(id); return { active: !!data.running, status: data.running ? 'generating' : 'idle' } }
export async function stopGeneration(id: string) { return fetch(`${API_BASE}/sessions/${id}/abort`, { method: 'POST' }).then(r => r.json()) }
export async function getContextSize(id: string) {
  // 服务端 sessionPayload 直接给真实 prompt_tokens（与 CLI /context 同源）；
  // 老数据或未发过请求时它会退回字符估算，这里只做兜底。
  const data = await getConversation(id)
  const tokens = Number(data?.contextTokens)
  if (Number.isFinite(tokens) && tokens >= 0) {
    return { tokens, limit: Number(data?.contextLimit) || 1000000, exact: !!data?.contextTokensExact }
  }
  const text = JSON.stringify(data?.messages || [])
  return { tokens: Math.ceil(text.length / 4), limit: 1000000, exact: false }
}
export async function getStreamStatus(id: string) { const data = await getConversation(id); return { active: !!data.running } }
export async function getProviders(): Promise<Provider[]> { const res = await fetch(`${API_BASE}/config`); const data = await res.json(); return data.providers || [] }
export async function warmEngine(_id: string): Promise<any> { return { ok: true } }
export async function materializeGithub(...args: any[]): Promise<any> { return {} }
export async function deleteMessagesFrom(conversationId: string, messageId: string, _attachmentIds: string[] = []) {
  // m-<historyIndex> 是服务端 toUiMessages 生成的稳定历史索引；编辑/重发从该 user block 起截断。
  const match = String(messageId || '').match(/^m-(\d+)$/)
  if (!match) throw new Error('无法确定要截断的消息位置')
  const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(conversationId)}/messages?fromIndex=${match[1]}`, { method: 'DELETE' })
  let data: any = {}
  try { data = await res.json() } catch { }
  if (!res.ok) throw new Error(data?.error || `删除消息失败（HTTP ${res.status}）`)
  return data
}
export async function deleteMessagesTail(conversationId: string, tailCount: number, _attachmentIds: string[] = []) {
  const count = Math.max(1, Math.floor(Number(tailCount) || 0))
  const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(conversationId)}/messages?tailCount=${count}`, { method: 'DELETE' })
  let data: any = {}
  try { data = await res.json() } catch { }
  if (!res.ok) throw new Error(data?.error || `删除消息失败（HTTP ${res.status}）`)
  return data
}
export async function testProviderWebSearch(id: string) {
  const res = await fetch(`${API_BASE}/providers/${encodeURIComponent(id)}/web-search-test`, { method: 'POST' })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || '网页搜索测试失败')
  return data
}
export async function createProvider(input: any) { const res = await fetch(`${API_BASE}/providers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); const data = await res.json(); if (!res.ok) throw new Error(data.error || '创建 Provider 失败'); return data }
export async function updateProvider(id: string, input: any) { const res = await fetch(`${API_BASE}/providers/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); const data = await res.json(); if (!res.ok) throw new Error(data.error || '更新 Provider 失败'); return data }
export async function deleteProvider(id: string) { const res = await fetch(`${API_BASE}/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }); if (!res.ok) throw new Error('删除 Provider 失败'); return res.json() }
export async function testProvider(...args: any[]): Promise<any> { return {} }
export async function getKeyPoolStatus(...args: any[]): Promise<any> { return {} }
export async function addKeyToPool(...args: any[]) {}
export async function removeKeyFromPool(...args: any[]) {}
export async function getAllUsers(...args: any[]) { return [] }
export async function updateUserPlan(...args: any[]) {}
export async function getAllPlans(...args: any[]) { return [] }
export async function createPlan(...args: any[]) {}
export async function updatePlan(...args: any[]) {}
export async function deletePlan(...args: any[]) {}
export async function getRedemptionCodes(...args: any[]) { return [] }
export async function createRedemptionCode(...args: any[]) {}
export async function getAllModels(...args: any[]) { return [] }
export async function createModel(...args: any[]) {}
export async function updateModel(...args: any[]) {}
export async function deleteModel(...args: any[]) {}
export async function getAnnouncements(...args: any[]) { return [] }
export async function createAnnouncement(...args: any[]) {}
export async function updateAnnouncement(...args: any[]) {}
export async function deleteAnnouncement(...args: any[]) {}

// ── 插件（DSH 插件宿主）───────────────────────────────────────────────
// 【2026-10-05 新增】对齐 CLI 的 /plugin 命令。
//
// 背景：CLI 侧 10-04 接入 DSH 插件宿主（116 个官方包 + 28 个服务），
// 但 Web 端一个入口都没有 —— 用户指出「web 端其实有点落后了」。
//
// 服务端在 /api/plugins 代理宿主的 /control/* API（含自愈拉起），
// 前端只需调这几个函数。

export interface DshPluginStatus {
  ok: boolean
  running: boolean
  error?: string
  hint?: string
  plugins?: string[]
  /**
   * 插件运行状态。宿主实际返回对象形态 `{ state: 2, active: true }`
   * （见 dsh-host/server.mjs 的 pluginState()），旧版可能是裸数字 —— 两种都声明。
   * state: 2=活跃 0=挂起（等依赖）
   */
  pluginStates?: Record<string, number | { state: number; active?: boolean }>
  services?: { count: number; ok: string[]; failed?: string[]; skipped?: string[] }
  providers?: Array<{
    id: string; name: string; shimReady: boolean; webEndpoint: boolean
    ready: boolean; modelCount: number
  }>
}

export interface DshProvider {
  id: string
  name: string
  /** CCM 接入地址（稳定门面，自动路由到 shim 或 webEndpoint） */
  ccmBaseUrl: string
  ccmApiKey: string
  shimReady: boolean
  webEndpoint: boolean
  ready: boolean
  models: string[]
}

export interface DshBundle {
  name: string
  description?: string
  installed?: boolean
  [key: string]: any
}

/** 宿主状态（含插件列表、服务数、provider）。宿主没跑时服务端会自动拉起。 */
export async function getPluginsStatus(): Promise<DshPluginStatus> {
  const res = await fetch(`${API_BASE}/plugins/status`)
  if (!res.ok) throw new Error('无法读取插件状态')
  return res.json()
}

/** provider 清单（含 CCM 接入地址）。 */
export async function getPluginProviders(): Promise<{ providers: DshProvider[] }> {
  const res = await fetch(`${API_BASE}/plugins/providers`)
  if (!res.ok) throw new Error('无法读取 provider 列表')
  return res.json()
}

/** 可安装的插件包。 */
export async function getPluginBundles(): Promise<{ bundles: DshBundle[] }> {
  const res = await fetch(`${API_BASE}/plugins/bundles`)
  if (!res.ok) throw new Error('无法读取插件包列表')
  return res.json()
}

/** 启用/禁用插件。 */
export async function setPluginEnabled(target: string, enabled: boolean) {
  const res = await fetch(`${API_BASE}/plugins/set-plugin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, enabled }),
  })
  const data = await res.json()
  if (!res.ok || data?.ok === false) throw new Error(data?.error || '操作失败')
  return data
}

/** 安装插件（npm 装包 + 热加载，可能较慢）。 */
export async function installPlugin(target: string, config?: Record<string, any>) {
  const res = await fetch(`${API_BASE}/plugins/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, config }),
  })
  const data = await res.json()
  if (!res.ok || data?.ok === false) throw new Error(data?.error || '安装失败')
  return data
}

/** 卸载插件。 */
export async function removePlugin(target: string) {
  const res = await fetch(`${API_BASE}/plugins/remove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target }),
  })
  const data = await res.json()
  if (!res.ok || data?.ok === false) throw new Error(data?.error || '卸载失败')
  return data
}
