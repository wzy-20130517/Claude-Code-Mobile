/**
 * 系统提示词的「分段缓存」——对齐官方 Claude Code 的 systemPromptSections.ts
 *
 * ═══ 为什么需要 ═══
 *
 * 提示词缓存（prompt cache）按**前缀**匹配：只要请求开头有一个字节不同，
 * 后面全部内容都要重新计算（按无缓存计费）。
 *
 * CCM 原来每轮调 getCurrentSystemPrompt() 时**从头拼一遍**——8 个段落全部重算：
 *   buildSystemPrompt() + runtimeModel + planMode + deepMode + coordinatorMode
 *   + QQ 桥 + qqEndpointHint + goalPromptSection + 权限模式
 *
 * 结果「碰巧稳定」（读文件内容没变），但这是**靠运气**：
 *   · 任何一段的计算引入不确定性（时间戳、Map 遍历顺序、异步竞态）→ 整段前缀作废
 *   · 没有机制阻止后来者加一段「每次都变」的内容
 *
 * ═══ 官方的做法（constants/systemPromptSections.ts）═══
 *
 *   systemPromptSection(name, compute)              → 算一次，缓存到 /clear 或 /compact
 *   DANGEROUS_uncachedSystemPromptSection(name, f, reason)
 *                                                   → 每轮重算（会破坏缓存，必须写理由）
 *
 * 官方把「缓存」当默认，「重算」需要显式声明并用吓人的名字（DANGEROUS_）提醒后人。
 * 清空时机只有两个：/clear 和 /compact。
 *
 * ═══ CCM 的调整 ═══
 *
 * 官方是 CLI 一次性会话，CCM 有 /memory append、/style、切模式等**运行期改动**，
 * 需要「改了立即生效」。所以除了 /clear 和 /compact，CCM 还支持**按名失效**：
 *   invalidateSystemPromptSection(name)   → 只作废那一段
 *   invalidateAllSections()               → 全清（/clear、/compact 用）
 *
 * 这样既拿到缓存的好处，又不会出现「改了 CLAUDE.md 但提示词不更新」的 bug。
 */

/** 段缓存：name → 已算好的字符串（或 null 表示这段为空） */
const sectionCache = new Map()

/**
 * 声明一个**可缓存**的段。算一次之后复用，直到 /clear、/compact 或显式失效。
 *
 * @param {string} name 段名（用于失效，要唯一且稳定）
 * @param {() => string|null} compute 计算函数
 * @returns {{name: string, compute: Function, cacheBreak: boolean}}
 */
export function systemPromptSection(name, compute) {
  return { name, compute, cacheBreak: false }
}

/**
 * 声明一个**每轮重算**的段。
 *
 * ⚠️ 这会让提示词缓存失效（每次内容不同就全量重算）。
 * 只有在「内容必须实时反映状态」时才用，并且**必须在 reason 里写清为什么**——
 * 官方用 DANGEROUS_ 前缀就是为了让改代码的人停下来想一想。
 *
 * @param {string} name 段名
 * @param {() => string|null} compute 计算函数
 * @param {string} reason 为什么必须每轮重算
 */
export function volatileSection(name, compute, reason) {
  return { name, compute, cacheBreak: true, reason }
}

/**
 * 解析所有段，返回字符串数组（按声明顺序）。
 *
 * 缓存命中时直接用旧值；未命中则计算并写入缓存。
 * 计算函数抛异常时返回 null（不让一段的失败拖垮整个提示词）。
 *
 * @param {Array} sections
 * @returns {Promise<string[]>} 过滤掉 null/空串
 */
export async function resolveSections(sections) {
  const out = []
  for (const s of sections) {
    let value
    if (!s.cacheBreak && sectionCache.has(s.name)) {
      value = sectionCache.get(s.name)
    } else {
      try {
        value = await s.compute()
      } catch {
        value = null
      }
      if (!s.cacheBreak) sectionCache.set(s.name, value)
    }
    if (value) out.push(value)
  }
  return out
}

/** 同步版（段计算函数都是同步的时用）。 */
export function resolveSectionsSync(sections) {
  const out = []
  for (const s of sections) {
    let value
    if (!s.cacheBreak && sectionCache.has(s.name)) {
      value = sectionCache.get(s.name)
    } else {
      try {
        value = s.compute()
      } catch {
        value = null
      }
      if (!s.cacheBreak) sectionCache.set(s.name, value)
    }
    if (value) out.push(value)
  }
  return out
}

/**
 * 按名作废单个段（改了对应内容后调用）。
 * @param {string} name
 */
export function invalidateSystemPromptSection(name) {
  sectionCache.delete(name)
}

/**
 * 全清（/clear、/compact 时调用，对齐官方 clearSystemPromptSections）。
 */
export function invalidateAllSections() {
  sectionCache.clear()
}

/** 调试用：看当前缓存了哪些段。 */
export function listCachedSections() {
  return [...sectionCache.keys()]
}
