// 用户资料（称呼 / 职业 / 回复偏好）—— **CLI 专用**
//
// 【为什么不复用 web 的 web-profile.json】
// 两个端的配置来源、生效时机、用户预期都不同：
//   - web 那份由网页设置页写，改动频率高、还带 theme/chat_font 这类前端字段
//   - CLI 这份由用户手改（或 /profile 命令），是"我在终端里希望被怎么对待"
// 混用会让一侧的改动意外影响另一侧，且 CLI 每次启动都得读一堆用不上的前端字段。
// 所以各自独立：`~/.claude-code-mobile/cli-profile.json`。
//
// 【为什么不做成 config.json 的字段】
// config.json 是 Provider 配置（url/key/model/protocol），是白名单序列化的。
// 用户资料语义上不属于"连接配置"，混进去会让 /config 的输出变杂。
//
// 【注入形式】与 web 侧保持一致的文案结构，便于两边体感相同。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PROFILE_PATH = join(homedir(), '.claude-code-mobile', 'cli-profile.json')

/** 可写字段白名单（与 web 侧一致的命名，便于用户理解） */
export const PROFILE_FIELDS = ['display_name', 'full_name', 'work_function', 'personal_preferences']

/** 读取资料；文件不存在或损坏时返回空对象（绝不抛） */
export function loadUserProfile() {
  try {
    const raw = JSON.parse(readFileSync(PROFILE_PATH, 'utf-8'))
    if (!raw || typeof raw !== 'object') return {}
    const out = {}
    for (const k of PROFILE_FIELDS) if (typeof raw[k] === 'string' && raw[k].trim()) out[k] = raw[k].trim()
    return out
  } catch { return {} }
}

/** 写单个字段；value 为空字符串表示清除该字段 */
export function setProfileField(field, value) {
  if (!PROFILE_FIELDS.includes(field)) {
    return { ok: false, error: `不认识的字段: ${field}（可用: ${PROFILE_FIELDS.join(' / ')}）` }
  }
  const cur = loadUserProfile()
  const v = String(value ?? '').trim().slice(0, 2000)
  if (v) cur[field] = v
  else delete cur[field]
  try {
    if (!existsSync(join(homedir(), '.claude-code-mobile'))) {
      mkdirSync(join(homedir(), '.claude-code-mobile'), { recursive: true })
    }
    writeFileSync(PROFILE_PATH, JSON.stringify(cur, null, 2), { encoding: 'utf-8', mode: 0o600 })
  } catch (e) {
    return { ok: false, error: `写入失败: ${e.message}` }
  }
  return { ok: true }
}

/**
 * 渲染成注入 system 提示词的一段。无有效字段时返回空串（不注入空段落）。
 *
 * 注意「称呼」与「怎么对待」是两件事，分开写：
 *   - display_name → 只是叫法
 *   - personal_preferences → 行为约束（要严格遵守，语气更硬）
 * 混成一句的话模型常只记住叫法、忽略偏好。
 */
export function buildUserProfileSection(profile = loadUserProfile()) {
  const name = (profile.display_name || profile.full_name || '').trim()
  const job = (profile.work_function || '').trim()
  const prefs = (profile.personal_preferences || '').trim()
  if (!name && !job && !prefs) return ''
  const lines = ['\n# 用户资料（用户主动填写）']
  if (name) lines.push(`- 称呼用户为：${name}`)
  if (job) lines.push(`- 用户职业：${job}（可据此调整术语深度与举例领域）`)
  if (prefs) lines.push(`- 用户的回复偏好（必须遵守）：${prefs}`)
  return lines.join('\n') + '\n'
}

export function getUserProfilePath() { return PROFILE_PATH }
