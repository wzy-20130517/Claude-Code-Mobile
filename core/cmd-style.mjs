// /style —— 输出风格（影响回复方式）
//
// 【为什么单独一个模块】
// 2026-09-20 用户要求「把 web 和 cli 的输出风格同步」。
// 原来 /style 的实现内联在 index.mjs 的 handleCommand 里（约 50 行），
// 含一段 runSelect 交互；web 端完全没有。抽成模块后两端共用同一份逻辑，
// 交互层（runSelect）由 ctx 注入 —— CLI 给终端选择器，Web 给「列出可用风格」。
//
// 【风格从哪来】core/output-styles.mjs：
//   · default（内置，无额外提示词）
//   · Explanatory / Learning（内置，照官方翻译）
//   · 用户级 ~/.claude/output-styles/*.md
//   · 项目级 <cwd>/.claude/output-styles/*.md（同名覆盖用户级）

import {
  listOutputStyles,
  ensureOutputStylesDir,
  DEFAULT_OUTPUT_STYLE_NAME,
} from './output-styles.mjs'

/**
 * @param {object} ctx
 *   config / saveConfig      配置读写（存 outputStyle 字段）
 *   cwd                      () => 工作目录（找项目级风格用）
 *   runSelect                交互式选择器（CLI 有；Web 传 null → 返回列表文本）
 *   rl / fsSession           交互层实例（CLI 用）
 *   C                        颜色
 */
export function makeStyleCommand(ctx) {
  return {
    async style(args) {
      const C = ctx.C || new Proxy({}, { get: () => '' })
      const cwd = (ctx.cwd && ctx.cwd()) || process.cwd()
      ensureOutputStylesDir(cwd)
      const styles = listOutputStyles(cwd)
      const curName = ctx.config.outputStyle || DEFAULT_OUTPUT_STYLE_NAME
      const arg0 = String(args[0] || '').trim()

      // 带参：直接设置（支持 off / none 快速回默认，比敲 default 顺手）
      if (arg0) {
        const want = (arg0 === 'off' || arg0 === 'none') ? DEFAULT_OUTPUT_STYLE_NAME : arg0
        if (!styles.has(want)) {
          return `没有名为「${arg0}」的风格。\n可用: ${[...styles.keys()].join(' / ')}\n`
            + `自定义：在 .claude/output-styles/ 放一个 .md（项目级）\n`
            + `     或 ~/.claude/output-styles/（用户级，所有项目共用）\n`
            + `     文件名即风格名；frontmatter 可写 name / description / keep-coding-instructions`
        }
        ctx.config.outputStyle = want
        ctx.saveConfig(ctx.config)
        const st = styles.get(want)
        return `${C.green}✓${C.reset} 输出风格已设为: ${C.bold}${want}${C.reset}\n`
          + (st?.prompt ? `说明: ${st.description}` : '（无额外风格提示词，使用默认行为）')
          + (st?.source === 'project' || st?.source === 'user' ? `\n来源: ${st.path}` : '')
      }

      // 无参：CLI 弹选择器；Web（无交互）列出可选项
      const items = [...styles.values()].map(st => ({
        value: st.id,
        label: st.id,
        hint: `${st.description}${st.id === curName ? '  ← 当前' : ''}`,
      }))

      if (typeof ctx.runSelect === 'function') {
        const picked = await ctx.runSelect({
          rl: ctx.rl ? ctx.rl() : null,
          fsSession: ctx.fsSession ? ctx.fsSession() : null,
          title: '输出风格（影响回复方式）',
          items,
          initial: Math.max(0, [...styles.keys()].indexOf(curName)),
        })
        if (picked == null) return '已取消'
        return this.style([picked])
      }

      // 非交互：给出列表 + 用法（与 /model 无参的处理一致）
      const lines = [
        `输出风格: ${C.bold}${curName}${C.reset}`,
        '',
        '可用风格:',
      ]
      for (const st of styles.values()) {
        const mark = st.id === curName ? ` ${C.green}← 当前${C.reset}` : ''
        const src = st.source === 'built-in' ? '' : ` ${C.dim}(${st.source})${C.reset}`
        lines.push(`  ${C.bold}${st.id}${C.reset}${src}  ${C.dim}${st.description}${C.reset}${mark}`)
      }
      lines.push('')
      lines.push(`切换: ${C.dim}/style <名字>${C.reset}  回默认: ${C.dim}/style off${C.reset}`)
      lines.push(`${C.dim}自定义风格：.claude/output-styles/<名字>.md 或 ~/.claude/output-styles/<名字>.md${C.reset}`)
      return lines.join('\n')
    },
  }
}

/** 补全候选：动态列可用风格（调用方传入 listOutputStyles 的结果）。 */
export function styleCandidates(styles) {
  return [...styles.keys()]
}
