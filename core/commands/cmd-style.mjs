// /style —— 回复偏好（影响回复方式）
//
// 【2026-10-08 合并】「输出风格」与「回复偏好」原本是两条独立机制，
// 但它们回答的是同一个问题：「希望 AI 怎么回复我」。用户视角就是一件事
// 被造了两个名字。三端（CLI/Web/APK）统一为「回复偏好」。
//
// 现在 /style 直接读写 profile 的 personal_preferences 字段：
//   /style                    → 显示当前偏好
//   /style <自由文本>          → 设置（整句，不切词）
//   /style clear|off|none     → 清空
//   /style list               → 列出旧的内置风格（只读参考，不再可切换）
//
// 【config.outputStyle 字段】保留不删 —— 老配置解析不报错；但不再写入。
// 老的 .claude/output-styles/*.md 文件仍被读取用于 `list` 展示，方便用户
// 把原来的风格提示词内容手动搬进回复偏好。
//
// 【为什么整句不切词】args 是空格分割的数组，`/style 回答要简洁` 会拆成
// 多个词 —— 用 args.join(' ') 还原（与 /me set 的 args.slice(2).join(' ') 同理）。
//
// 【profile 读写为什么走 ctx 注入】
// CLI 与 Web 的用户资料是**两个独立文件**（cli-profile.json / web-profile.json，
// 见 core/session/user-profile.mjs 顶部说明）。这个模块两端共用，不能直接
// import CLI 那份 —— 否则 Web 上敲 /style 会写进 CLI 的 profile。
// ctx.getProfile / ctx.setProfile 由两端各自注入；不传时回退到 CLI 实现。

import {
  listOutputStyles,
} from '../ui/output-styles.mjs'

/** 默认实现：CLI 的 user-profile.mjs（懒加载，避免 Web 侧无谓引入）。 */
async function defaultProfileIO() {
  const mod = await import('../session/user-profile.mjs')
  return {
    get: () => (mod.loadUserProfile().personal_preferences || '').trim(),
    set: (v) => mod.setProfileField('personal_preferences', v),
  }
}

/**
 * @param {object} ctx
 *   C                        颜色
 *   cwd                      () => 工作目录（列旧风格文件用）
 *   onProfileChanged         资料变更回调（提示词缓存失效）
 *   getProfile               可选 () => string：读回复偏好（默认 CLI 实现）
 *   setProfile               可选 (v) => {ok,error}：写回复偏好（默认 CLI 实现）
 */
export function makeStyleCommand(ctx) {
  return {
    async style(args) {
      const C = ctx.C || new Proxy({}, { get: () => '' })
      const argv = Array.isArray(args) ? args : String(args || '').trim().split(/\s+/)
      const first = String(argv[0] || '').trim()

      const io = (typeof ctx.getProfile === 'function' && typeof ctx.setProfile === 'function')
        ? { get: ctx.getProfile, set: ctx.setProfile }
        : await defaultProfileIO()

      // 无参：显示当前回复偏好
      if (!first) {
        const cur = (io.get() || '').trim()
        if (!cur) {
          return `${C.bold}回复偏好${C.reset}（未设置）\n\n`
            + `用 ${C.bold}/style <你的偏好>${C.reset} 设置，例如：\n`
            + `  ${C.dim}/style 回答尽量简洁，使用中文${C.reset}\n`
            + `  ${C.dim}/style 不用 emoji，代码注释用英文${C.reset}\n\n`
            + `${C.dim}查看旧的内置风格模板: /style list${C.reset}`
        }
        return `${C.bold}回复偏好${C.reset}\n\n${cur}\n\n`
          + `${C.dim}修改: /style <新偏好>   清空: /style clear${C.reset}`
      }

      // clear / off / none：清空
      if (first === 'clear' || first === 'off' || first === 'none') {
        const r = io.set('')
        if (r && r.ok === false) return r.error
        ctx.onProfileChanged?.()
        return `${C.green}✓${C.reset} 回复偏好已清空。`
      }

      // list：列出旧风格模板（只读参考 —— 告诉用户这些东西去哪了）
      if (first === 'list') {
        const cwd = (ctx.cwd && ctx.cwd()) || process.cwd()
        let styles
        try { styles = listOutputStyles(cwd) } catch { styles = new Map() }
        const lines = [
          `${C.bold}旧的输出风格模板${C.reset}（只读参考 —— 输出风格已并入回复偏好）`,
          '',
        ]
        for (const st of styles.values()) {
          const src = st.source === 'built-in' ? '' : ` ${C.dim}(${st.source})${C.reset}`
          lines.push(`  ${C.bold}${st.id}${C.reset}${src}  ${C.dim}${st.description}${C.reset}`)
        }
        lines.push('')
        lines.push(`${C.dim}想把某个风格的提示词搬进回复偏好，可以打开对应 .md 复制正文，${C.reset}`)
        lines.push(`${C.dim}然后 /style <粘贴内容>。自定义风格目录: .claude/output-styles/ 或 ~/.claude/output-styles/${C.reset}`)
        return lines.join('\n')
      }

      // 其余：整句作为回复偏好设置
      const value = argv.join(' ').trim()
      if (value.length > 2000) {
        return `回复偏好过长（${value.length} 字符，上限 2000）。请精简后重试。`
      }
      const r = io.set(value)
      if (r && r.ok === false) return r.error
      ctx.onProfileChanged?.()
      return `${C.green}✓${C.reset} 已设置回复偏好：\n\n${value}\n\n${C.dim}（下一轮对话生效）${C.reset}`
    },
  }
}

/** 补全候选：清空 + 列出旧风格（风格名不再是可切换项，但保留展示入口）。 */
export function styleCandidates() {
  return ['clear', 'list']
}
