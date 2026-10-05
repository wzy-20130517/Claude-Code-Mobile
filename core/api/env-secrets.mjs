// 密钥环境变量解析：让 config.json 里的 key 可以写成 ${ENV_NAME} 引用环境变量。
// 目的：开源时 config.json 只留占位符（如 ${OPENAI_KEY}），真实 key 放 .env / 环境变量。
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'

const ENV_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

let envCache = null

/** 加载 .env 文件（项目根目录），不覆盖已有环境变量；也扫描 ~/.claude-code-mobile/.env */
export function loadEnvFile(rootDir = process.cwd()) {
  if (envCache) return envCache
  envCache = {}
  const candidates = [
    resolve(rootDir, '.env'),
    resolve(homedir(), '.claude-code-mobile', '.env'),
  ]
  for (const f of candidates) {
    if (!existsSync(f)) continue
    try {
      const lines = readFileSync(f, 'utf-8').split('\n')
      for (let line of lines) {
        line = line.trim()
        if (!line || line.startsWith('#') || !line.includes('=')) continue
        const eq = line.indexOf('=')
        const k = line.slice(0, eq).trim()
        let v = line.slice(eq + 1).trim()
        // 去掉引号
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
        // 不覆盖已存在的环境变量【但必须注入 process.env】：
        // 原 bug（2026-08-22）：仅写 envCache 不注入，导致 process.env.TAVILY_API_KEY
        // 永空、WebSearch 永远报「未配置」。tavily.mjs 的三跳全落空。
        if (process.env[k] !== undefined) continue
        envCache[k] = v
        try { process.env[k] = v } catch {}
      }
    } catch { }
  }
  return envCache
}

/** 解析字符串中的 ${VAR} 引用；未定义的环境变量返回 undefined（调用方决定报错还是留空） */
export function resolveEnvString(raw, env = null) {
  if (typeof raw !== 'string' || !raw.includes('${')) return raw
  const source = env || process.env
  let missing = null
  const out = raw.replace(ENV_RE, (m, name) => {
    const val = source[name]
    if (val === undefined) { missing = missing || name; return m }
    return val
  })
  return missing ? undefined : out
}

/** 深度解析对象里的字符串字段（只处理 value 是字符串的字段，递归数组/对象） */
export function resolveEnvDeep(obj, env = null) {
  if (obj === null || obj === undefined) return obj
  if (typeof obj === 'string') return resolveEnvString(obj, env)
  if (Array.isArray(obj)) return obj.map(x => resolveEnvDeep(x, env))
  if (typeof obj === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(obj)) out[k] = resolveEnvDeep(v, env)
    return out
  }
  return obj
}

/** 把 provider 的 key 字段解析：apiKey 或 apiKeys[] 里的 ${VAR} 引用。返回 { apiKey, apiKeys } */
export function resolveProviderKeys(provider, env = null) {
  if (!provider) return { apiKey: '', apiKeys: [] }
  const src = env || process.env
  const apiKeys = Array.isArray(provider.apiKeys) ? provider.apiKeys : []
  const resolvedKeys = apiKeys.map(k => resolveEnvString(k, src)).filter(k => k !== undefined && k !== null)
  const apiKeyRaw = provider.apiKey || resolvedKeys[0] || ''
  const apiKey = resolveEnvString(apiKeyRaw, src)
  return {
    apiKey: apiKey === undefined ? '' : apiKey,
    apiKeys: resolvedKeys,
  }
}

/** 检查 config.json 里是否有未解析的 ${VAR} 占位符（用于启动时警告） */
export function hasUnresolvedPlaceholders(obj) {
  const s = JSON.stringify(obj)
  return ENV_RE.test(s)
}
