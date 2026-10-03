// /markdown —— Markdown 渲染样式切换
//
// 【为什么有这条命令】
// 2026-09-19 用户：「看官方的 Markdown 样式，它和我们不一样，把官方的也做进来，
// 但我们这版保留，可以用 slash 命令切换，比如 /markdown 经典/鲜艳」。
//
// 两套样式：
//   · classic（经典）—— 项目原有的 ANSI 16 色方案，兼容性最好。默认值。
//   · official（官方）—— 对齐官方 claude-code darkTheme 的真彩色
//     （~/cc-src/claude-code-main/utils/theme.ts:440）。
//
// 主题值本身在 core/markdown.mjs 里（THEMES），这里只管「读写配置 + 切运行时」。
// 切换后要重渲染已有正文吗？不重渲染 —— 已输出的内容留在终端 scrollback 里，
// 重画整屏代价太大（且全屏模式下会闪烁）。新内容立刻用新样式。

/**
 * @param {object} ctx
 *   config / saveConfig       配置读写（主题存 markdownTheme 字段）
 *   setMarkdownTheme(name)    切运行时（core/markdown.mjs）
 *   getMarkdownTheme()        读当前
 *   markdownThemeNames()      可用主题名
 *   C                         颜色（提示语用）
 */
export function makeMarkdownCommand(ctx) {
  return {
    markdown(args) {
      const C = ctx.C || new Proxy({}, { get: () => '' })
      const available = ctx.markdownThemeNames()
      const sub = String(args[0] || '').trim().toLowerCase()

      // 主题别名：用户可能按中文名敲（用户原话就是「经典/鲜艳」）
      const ALIAS = {
        经典: 'classic',
        默认: 'classic',
        classic: 'classic',
        鲜艳: 'official',
        官方: 'official',
        official: 'official',
      }

      if (!sub || sub === 'status' || sub === 'show') {
        const cur = ctx.getMarkdownTheme()
        const label = cur === 'official' ? '官方（真彩色）' : '经典（ANSI 16 色）'
        return [
          `Markdown 样式: ${C.bold}${label}${C.reset}`,
          '',
          '可用样式:',
          `  ${C.bold}classic${C.reset}   经典 —— ANSI 16 色，兼容性最好（默认）`,
          `  ${C.bold}official${C.reset}  官方 —— 对齐 claude-code darkTheme 的真彩色`,
          '',
          `切换: ${C.dim}/markdown classic${C.reset} 或 ${C.dim}/markdown official${C.reset}`,
          `${C.dim}（也可以敲中文：/markdown 经典 · /markdown 鲜艳）${C.reset}`,
          `${C.dim}已输出的内容不会重画，新内容立刻生效。${C.reset}`,
        ].join('\n')
      }

      const target = ALIAS[sub]
      if (!target) {
        return `未知样式: ${args[0]}\n可用: ${available.join(' / ')}（或中文 经典 / 鲜艳）`
      }

      // 切运行时 + 落盘。两步都要做：
      // 只切运行时 → 重启就丢；只落盘 → 当前会话不生效。
      ctx.setMarkdownTheme(target)
      try {
        const config = ctx.config
        config.markdownTheme = target
        ctx.saveConfig(config)
      } catch (error) {
        return `样式已切换为 ${target}，但保存配置失败：${error?.message || error}\n（重启后会回到上次保存的值）`
      }

      const label = target === 'official' ? '官方（真彩色）' : '经典（ANSI 16 色）'
      return `${C.green}✓${C.reset} Markdown 样式已切换: ${C.bold}${label}${C.reset}\n${C.dim}已保存到 config.json，重启保留。新内容立刻生效。${C.reset}`
    },
  }
}

/** 命令补全的候选（给 /markdown 后面接空格用）。 */
export const MARKDOWN_SUBCOMMANDS = {
  candidates: ['classic', 'official', 'status'],
  desc: {
    classic: '经典 —— ANSI 16 色，兼容性最好',
    official: '官方 —— 对齐 claude-code darkTheme 真彩色',
    status: '看当前样式',
  },
}
