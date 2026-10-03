// Claude Code Mobile - API Key 池（负载均衡 + 失效切换）
// 场景：同一个站点有多个账号 key，某个额度用完了自动换下一个，全部用完才报错。
//
// 设计要点：
// - 只有"这个 key 本身不行"的错误才切 key（余额/配额/鉴权失效）。
//   网络抖动、500、超时属于站点问题，换 key 也没用，交给原有重试逻辑。
// - 被判定耗尽的 key 会打上冷却时间戳，冷却期内不再选中；冷却过后自动恢复。
// - 冷却状态【落盘持久化】。早期版本只存内存，重启后 index 归零、冷却全清，
//   于是每次重启都从第一个（往往已经额度耗尽的）key 开始撞，白白浪费一轮
//   请求 + 重试退避。而重启远比 6 小时冷却频繁，这个问题每天都会触发。
// - 轮转从上次成功的 key 开始，避免每轮都从第一个已耗尽的 key 试起。
//
// 落盘只写 key 的 sha256 前 16 位指纹，不写明文 key —— 状态文件泄漏也不会漏密钥。

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

// 冷却 30 分钟。原来设 6 小时（想跨过日额度刷新），但额度恢复的途径不止按天刷新：
// 每日签到、手动充值都可能几分钟内到账，死等 6 小时等于把能用的 key 闲置。
// 配合 current() 的「全部冷却时重试最早耗尽的那个」兜底，30 分钟足够避免
// 反复撞同一个空 key，又不会错过中途恢复的额度。
// 默认冷却 24 小时：额度耗尽的 key（尤其没钱/被封的号）短时间内不会恢复，
// 30 分钟就回滚的话会反复撞到同一个死 key，白等重试。
// 次日签到/充值恢复额度后，_oldestExhausted 会自动把它拉回轮换。
// 默认冷却 5 小时（2026-08-30 用户设定）：免费站点的日额度按天重置，24h 冷却
// 会让 key 闲置太久——实测 sharellm 的 key 额度用尽后，换 key 立刻能用，
// 而 24h 意味着当天再也轮不回来。5h 折中：既给站点额度恢复留时间，
// 又不会一整天只有 1 个 key 在干活。
const DEFAULT_COOLDOWN_MS = 5 * 60 * 60 * 1000
const STATE_FILE = join(homedir(), '.claude-code-mobile', 'key-pool-state.json')

/** key 指纹：只取 sha256 前 16 位，够区分且不可逆 */
function fingerprint(key) {
  return createHash('sha256').update(String(key || '')).digest('hex').slice(0, 16)
}

function loadState(file = STATE_FILE) {
  try {
    const raw = readFileSync(file, 'utf8')
    const d = JSON.parse(raw)
    return d && typeof d === 'object' ? d : {}
  } catch { return {} }
}

function saveState(state, file = STATE_FILE) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 })
  } catch {}
}

// ── 余额/额度耗尽的真实返回特征（按各网关实证整理）─────────────
// NewAPI (QuantumNous/new-api)：额度不足常见于 code=pre_consume_token_quota_failed，
//   message 形如 "token quota is not enough, token remain quota: $0.25, need quota: $5.5"，
//   type=new_api_error。注意它可能不带 4xx 状态码，光看 status 会漏判。
// one-api：insufficient_user_quota / 用户额度不足 / 令牌额度不足。
// OpenAI：429 + type=insufficient_quota + "exceeded your current quota"。
// DeepSeek：402 专用于余额不足。
// 智谱：429 + 错误码 1316/1317（主账号余额不足）。
const KEY_EXHAUSTED_PATTERNS = [
  // NewAPI / one-api 系
  /pre_consume_token_quota_failed/i,
  /insufficient[_\s-]?user[_\s-]?quota/i,
  /quota\s+is\s+not\s+enough/i,
  /(token|user|channel)\s*quota\s*(is\s*)?(not\s*enough|exhausted|used\s*up)/i,
  /(用户|令牌|渠道|分组)?额度(不足|已用完|耗尽|已用尽)/,
  /剩余额度不足|额度已耗尽/,
  // OpenAI 系
  /insufficient[_\s-]?(balance|quota|credit)/i,
  /exceeded?\s+your\s+current\s+quota/i,
  /quota[_\s-]?(exceeded|exhausted)/i,
  // 通用余额/计费
  /balance\s*(is\s*)?(insufficient|not\s+enough|too\s+low)/i,
  /insufficient\s+balance/i,
  /余额(不足|为负|已用完)|欠费|请充值|请先充值/,
  /no\s+credit|out\s+of\s+credit|run\s+out\s+of\s+credits?/i,
  /payment\s+required|billing\s+(error|issue|problem)/i,
  // key 本身失效（换 key 同样有救）
  /invalid[_\s-]?api[_\s-]?key/i,
  /incorrect\s+api\s+key/i,
  /api\s*key.*(invalid|expired|disabled|revoked|not\s+found)/i,
  /(令牌|密钥|key).*(已失效|无效|已禁用|不存在|已过期)/,
  /token\s+(is\s+)?(invalid|expired|disabled)/i,
  /unauthorized|authentication[_\s-]?(failed|error)/i,
  /account.*(suspended|disabled|banned|frozen)/i,
  /(账号|账户).*(已封禁|被禁用|已冻结|已停用)/,
]

// ── 明确"换 key 也没用"的情况：限流、上游过载、参数错误 ────────
// 这些必须优先判定，否则会把限流误当余额不足，白白把好 key 打进冷却。
const NOT_KEY_FAULT_PATTERNS = [
  /rate[_\s-]?limit(_reached)?(_error)?/i,
  /too\s+many\s+requests/i,
  /请求(过于频繁|速率|频率)/,
  /(TPM|RPM|TPD|QPS)\s*(限制|上限|exceeded|limit)/i,
  /上游负载(已)?饱和|分组.*饱和/,
  /(服务器|上游|渠道).*(繁忙|过载|超载)/,
  /overload|capacity\s+issue|server\s+busy/i,
  /invalid[_\s-]?request/i,
  /model\s+config|unsupported|reasoning|thinking/i,
  /context\s+(length|window)|too\s+long/i,
  /参数(错误|无效)/,
]

/**
 * 判断某个错误是否值得换 key 重试。
 * 顺序很重要：先排除"不是 key 的问题"，再看余额特征，最后才按状态码兜底。
 */
export function isKeyExhaustedError(status, bodyText = '') {
  const text = String(bodyText || '')

  // 1) 限流 / 上游过载 / 参数错误：换 key 无用，直接否
  //    但如果同一段文本里同时出现明确的余额特征（有些网关把两者混在一起报），余额优先。
  const looksLikeQuota = KEY_EXHAUSTED_PATTERNS.some(re => re.test(text))
  if (!looksLikeQuota && NOT_KEY_FAULT_PATTERNS.some(re => re.test(text))) return false

  // 2) 文本里有明确余额/失效特征 → 换 key（覆盖 NewAPI 那种不带 4xx 的情况）
  if (looksLikeQuota) return true

  // 3) 状态码兜底：401 鉴权失败、402 余额不足（DeepSeek 专用）、403 无权限
  if (status === 401 || status === 402 || status === 403) return true

  // 4) 429 无明确文本特征时：可能是限流也可能是配额，保守当限流处理（不烧 key）
  return false
}

export class KeyPool {
  /**
   * @param {string[]} keys key 列表
   * @param {object} opts { cooldownMs, onSwitch, initialKey }
   */
  constructor(keys = [], opts = {}) {
    const list = (Array.isArray(keys) ? keys : [keys])
      .map(k => (typeof k === 'string' ? k.trim() : ''))
      .filter(Boolean)
    // 去重但保持顺序
    this.keys = [...new Set(list)]
    this.cooldownMs = Number(opts.cooldownMs) > 0 ? Number(opts.cooldownMs) : DEFAULT_COOLDOWN_MS
    this.onSwitch = typeof opts.onSwitch === 'function' ? opts.onSwitch : null
    // config.json 里的 apiKey 记录上次实际使用的 key；重启时优先从它开始。
    const initialKey = typeof opts.initialKey === 'string' ? opts.initialKey.trim() : ''
    this.initialIndex = initialKey ? this.keys.indexOf(initialKey) : -1
    this.index = 0
    // key -> { until: number, reason: string }
    this.cooldown = new Map()
    this.stats = new Map()  // key -> { ok, fail }
    // persist=false 用于测试，避免污染真实状态文件；
    // stateFile 可注入自定义路径（测试用临时文件隔离）
    this.persist = opts.persist !== false
    this.stateFile = opts.stateFile || STATE_FILE
    // 轮转策略：默认 0 = 只在失败时切换（老行为）。
    // 设为 N（>0）时每 N 次成功请求就前进一个 key ——
    // 让池子里每个账号都有真实调用记录。
    // 起因：多账号池长期只用第一个 key，其余号只签到不消费，
    // 站点会判定为「刷签到额度的小号」而封号（wlh0517@ 就是这么没的）。
    this.rotateEveryRequests = Number(opts.rotateEveryRequests) > 0
      ? Math.floor(Number(opts.rotateEveryRequests))
      : 0
    this._sinceRotate = 0
    this._restore()
  }

  /** 从磁盘恢复冷却状态；已过期的条目直接丢掉 */
  _restore() {
    if (!this.keys.length) return
    // 测试/内存池也应尊重 initialKey，只是不读写持久化状态。
    if (!this.persist) {
      if (this.initialIndex >= 0) this.index = this.initialIndex
      return
    }
    const state = loadState(this.stateFile)
    const now = Date.now()
    for (const key of this.keys) {
      const rec = state[fingerprint(key)]
      if (rec && Number(rec.until) > now) {
        this.cooldown.set(key, { until: Number(rec.until), reason: String(rec.reason || '') })
      }
    }
    // 优先恢复配置里保存的当前 key；如果它正在冷却，再定位到第一个可用 key。
    // 这样自动换号写回 config.json 后，重启不会又从第一个 key 开始。
    const firstOk = this.keys.findIndex(k => !this._isCoolingDown(k, now))
    if (this.initialIndex >= 0 && !this._isCoolingDown(this.keys[this.initialIndex], now)) {
      this.index = this.initialIndex
    } else {
      this.index = firstOk >= 0 ? firstOk : (this.initialIndex >= 0 ? this.initialIndex : 0)
    }
  }

  /** 把当前冷却状态写盘（只存指纹，不存明文 key） */
  _flush() {
    if (!this.persist) return
    const state = loadState(this.stateFile)
    const now = Date.now()
    // 清理所有已过期条目，避免文件无限增长
    for (const [fp, rec] of Object.entries(state)) {
      if (!rec || Number(rec.until) <= now) delete state[fp]
    }
    // 先删掉本池所有 key 的条目，再写回当前仍在冷却的。
    // 只做「合并写入」是不够的：resetCooldown() 清空内存后，磁盘上未过期的
    // 旧条目会残留，重启又被读回来 —— 用户充值后重置了冷却，重启却依然跳过该 key。
    // 注意只动本池的 key，其他 provider 的冷却状态必须保留。
    for (const key of this.keys) delete state[fingerprint(key)]
    for (const [key, c] of this.cooldown) {
      if (c.until > now) state[fingerprint(key)] = { until: c.until, reason: c.reason }
    }
    saveState(state, this.stateFile)
  }

  get size() { return this.keys.length }

  /** 池里是否有多个 key（单 key 时调用方可以走原有简单逻辑） */
  get isPool() { return this.keys.length > 1 }

  _isCoolingDown(key, now = Date.now()) {
    const c = this.cooldown.get(key)
    if (!c) return false
    if (c.until <= now) { this.cooldown.delete(key); return false }
    return true
  }

  /** 当前应该使用的 key；全部冷却中时返回 null */
  current() {
    if (!this.keys.length) return null
    const now = Date.now()
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.index + i) % this.keys.length
      const key = this.keys[idx]
      if (!this._isCoolingDown(key, now)) {
        this.index = idx
        return key
      }
    }
    // 全部在冷却中 → 不是直接放弃，而是回头重试【最早耗尽】的那个。
    // 理由：额度会中途恢复（每日签到、手动充值、按天刷新），
    // 死等 6 小时冷却等于把能用的 key 白白闲置。
    // 挑最早耗尽的 = 冷却了最久的 = 最可能已经恢复的。
    // 这样轮转就成了闭环：1 没钱→2，2 没钱→3，3 没钱→回头撞 1。
    return this._oldestExhausted()
  }

  /** 全部冷却时的兜底：返回冷却开始最早的那个 key，并把 index 指向它 */
  _oldestExhausted() {
    let bestIdx = -1
    let bestUntil = Infinity
    for (let i = 0; i < this.keys.length; i++) {
      const c = this.cooldown.get(this.keys[i])
      if (!c) continue
      // until 最小 = 最早进入冷却（冷却时长相同）= 闲置最久
      if (c.until < bestUntil) { bestUntil = c.until; bestIdx = i }
    }
    if (bestIdx < 0) return null
    this.index = bestIdx
    return this.keys[bestIdx]
  }

  /**
   * 标记当前 key 不可用并切换到下一个可用 key。
   * @returns {string|null} 下一个可用 key；没有了返回 null
   */
  markExhaustedAndRotate(reason = '') {
    const failed = this.keys[this.index]
    if (failed) {
      this.cooldown.set(failed, { until: Date.now() + this.cooldownMs, reason: String(reason).slice(0, 200) })
      const s = this.stats.get(failed) || { ok: 0, fail: 0 }
      s.fail++
      this.stats.set(failed, s)
      this._flush()   // 立刻落盘：进程可能马上就被 Ctrl+C 掉
    }
    const before = this.index
    this.index = (this.index + 1) % Math.max(1, this.keys.length)
    const next = this.current()
    // 全池冷却时 current() 的兜底会硬试「最早耗尽」的 key（_oldestExhausted），
    // 那个 key 可能恰好就是刚失败的 failed —— 若不拦，下次循环又打同一把坏 key，
    // 429/额度耗尽的 key 被无限重试，表现为「同一个报错永远延续」。
    // 只有 next 不是 failed 时才继续；否则视为无可用 key，让上层抛错停止。
    const nextIsFailed = next === failed
    if (next && !nextIsFailed && this.onSwitch) {
      try {
        this.onSwitch({
          from: maskKey(failed),
          to: maskKey(next),
          // 仅供内部回调同步配置；日志仍只使用上面的掩码字段。
          toIndex: this.index,
          reason: String(reason).slice(0, 120),
          remaining: this.availableCount(),
        })
      } catch {}
    }
    if (!next || nextIsFailed) this.index = before
    return nextIsFailed ? null : next
  }

  /**
   * 限流（HTTP 429）轮换：和余额耗尽不同，限流是「这个账号当下太快」，几分钟就缓过来。
   * 所以不能进 cooldownMs（24h）长冷宫，用短冷却（默认 5 分钟，可选传参）。
   * @returns {string|null} 下一个可用 key；没有了返回 null
   */
  markRateLimitedAndRotate(reason = '', cooldownMs = 5 * 60 * 1000) {
    const failed = this.keys[this.index]
    if (failed) {
      this.cooldown.set(failed, { until: Date.now() + cooldownMs, reason: `rate-limit: ${String(reason).slice(0, 180)}` })
      const s = this.stats.get(failed) || { ok: 0, fail: 0 }
      s.fail++
      this.stats.set(failed, s)
      this._flush()
    }
    const before = this.index
    this.index = (this.index + 1) % Math.max(1, this.keys.length)
    const next = this.current()
    // 同上：全池冷却时 current() 兜底硬试可能返回刚失败的同一把 key，
    // 拦掉避免 429 无限循环（详见 markExhaustedAndRotate 的注释）。
    const nextIsFailed = next === failed
    if (next && !nextIsFailed && this.onSwitch) {
      try {
        this.onSwitch({
          from: maskKey(failed),
          to: maskKey(next),
          toIndex: this.index,
          reason: `429 限流: ${String(reason).slice(0, 100)}`,
          remaining: this.availableCount(),
        })
      } catch {}
    }
    if (!next || nextIsFailed) this.index = before
    return nextIsFailed ? null : next
  }

  markSuccess() {
    const key = this.keys[this.index]
    if (!key) return
    // 兜底 key 成功即清冷却：全池冷却时 current() 的兜底会挑「最早耗尽」的 key
    // 硬试，试成了说明额度已恢复，但 24h 冷却时间戳还挂着 → /config list 照显
    // 「冷却中」，信息滞后且轮换一直跳过这个其实能用的 key。请求成功是最准的恢复信号。
    if (this.cooldown?.has(key)) this.cooldown.delete(key)
    const s = this.stats.get(key) || { ok: 0, fail: 0 }
    s.ok++
    this.stats.set(key, s)
    // 主动轮转：每 rotateEveryRequests 次成功就换下一个可用 key。
    // 与失败切换不同 —— 这里不打冷却、不算 fail，纯粹是把用量摊到各账号头上。
    if (this.rotateEveryRequests > 0 && this.keys.length > 1) {
      this._sinceRotate++
      if (this._sinceRotate >= this.rotateEveryRequests) {
        this._sinceRotate = 0
        this.advance()
      }
    }
  }

  /**
   * 前进到下一个可用 key（不标记失败、不设冷却）。
   * 供「按请求数轮转」使用，跳过正在冷却的 key。
   * @returns {string|null} 切换后的 key
   */
  advance() {
    if (this.keys.length < 2) return this.current()
    const now = Date.now()
    const from = this.keys[this.index]
    for (let i = 1; i <= this.keys.length; i++) {
      const idx = (this.index + i) % this.keys.length
      const key = this.keys[idx]
      if (!this._isCoolingDown(key, now)) {
        if (idx === this.index) break        // 绕回自己，没有别的可用
        this.index = idx
        this._flush()
        if (this.onSwitch) {
          try {
            this.onSwitch({
              from: maskKey(from),
              to: maskKey(key),
              toIndex: idx,
              reason: 'rotate',              // 区别于失败切换
              remaining: this.availableCount(),
            })
          } catch {}
        }
        return key
      }
    }
    return this.current()
  }

  availableCount() {
    const now = Date.now()
    return this.keys.filter(k => !this._isCoolingDown(k, now)).length
  }

  /** 全部 key 都在冷却中 */
  allExhausted() {
    return this.keys.length > 0 && this.availableCount() === 0
  }

  /** 人类可读状态，供 /config 或报错信息展示 */
  describe() {
    const now = Date.now()
    return this.keys.map((k, i) => {
      const c = this.cooldown.get(k)
      const cooling = c && c.until > now
      const s = this.stats.get(k) || { ok: 0, fail: 0 }
      const mins = cooling ? Math.ceil((c.until - now) / 60000) : 0
      return {
        index: i + 1,
        key: maskKey(k),
        active: i === this.index && !cooling,
        cooling,
        cooldownMinutes: mins,
        reason: cooling ? c.reason : '',
        ok: s.ok,
        fail: s.fail,
      }
    })
  }

  /** 手动清空冷却（用户换了套餐/充值后立即恢复） */
  resetCooldown() {
    this.cooldown.clear()
    this.index = 0
    this._flush()
  }
}

export function maskKey(key) {
  const s = String(key || '')
  if (!s) return '(空)'
  if (s.length <= 12) return s.slice(0, 4) + '***'
  return `${s.slice(0, 8)}***${s.slice(-4)}`
}
