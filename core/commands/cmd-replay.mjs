// core/cmd-replay.mjs —— /replay 控制会话恢复时是否显示历史
//
// 【为什么有这条命令】
// 2026-10-03 用户：「每次进入一个会话，会显示 ─── Session Recovery ───，
// 上面就是历史了。有的人可能不想看上面这段历史，用 slash 命令可以控制
// 以后进入会话显示不显示历史消息。」
//
// 【背景：三种进入会话的路径都会回放】
//   1. Ctrl+X 重启续接   → index.mjs 启动路径
//   2. /resume <id|名称> → cmd-queries.mjs 带参分支
//   3. /resume（无参）   → cmd-queries.mjs 上一个会话分支
// 三处都要受这个开关控制，只改一处会出现「关了这里还显示」的不一致。
//
// 【默认值】**关**（2026-10-03 用户拍板：「replayHistory 默认关吧」）。
// 考虑：进入会话时先铺一屏历史会刷屏，想要的人自己 /replay on 开更合理。
//
// 【配置字段】config.replayHistory（布尔）
// 放在顶层而不是 per-provider：这是纯显示偏好，跟模型/端点无关。
// 判断用 `=== true`（不是 `!== false`）：未设置 = 关。

/**
 * @param {object} ctx
 *   config / saveConfig   配置读写（字段 replayHistory）
 *   C                     颜色
 */
export function makeReplayCommand(ctx) {
  return {
    replay(args) {
      const C = ctx.C || new Proxy({}, { get: () => '' })
      const sub = String(args[0] || '').trim().toLowerCase()
      const config = ctx.config

      // 默认关：只有显式 true 才算开启（2026-10-03 用户拍板）
      const isOn = () => config.replayHistory === true

      // ── 无参 / status / show：查看状态 ──────────────
      if (!sub || sub === 'status' || sub === 'show') {
        const on = isOn()
        return [
          `会话历史显示: ${C.bold}${on ? '开启' : '关闭'}${C.reset}`,
          '',
          on
            ? `${C.dim}进入会话时（重启续接 / /resume）会把历史画到屏幕上，`
            : `${C.dim}进入会话时不再画历史正文，正文区保持干净：`,
          on
            ? `末尾用 ── Session Recovery ── 分隔线标出「从这里开始是新对话」。${C.reset}`
            : `重启续接完全静默；/resume 仍会告诉你切到了哪个会话。${C.reset}`,
          '',
          `${C.dim}当前是默认值（关）—— 想看历史用 /replay on 打开。${C.reset}`,
          '',
          `切换: ${C.dim}/replay on${C.reset} 显示 · ${C.dim}/replay off${C.reset} 不显示`,
          `${C.dim}只影响「进入会话那一刻」的显示，对话本身完整保留。${C.reset}`,
        ].join('\n')
      }

      // ── on / off ────────────────────────────────────
      const ON_WORDS = new Set(['on', 'true', '1', '开', '开启', '显示', 'yes'])
      const OFF_WORDS = new Set(['off', 'false', '0', '关', '关闭', '隐藏', '不显示', 'no'])

      if (ON_WORDS.has(sub) || OFF_WORDS.has(sub)) {
        const target = ON_WORDS.has(sub)
        try {
          config.replayHistory = target
          ctx.saveConfig(config)
        } catch (e) {
          return `设置失败: ${e?.message || e}\n（配置未保存，重启后回到上次的值）`
        }
        return target
          ? [
            `${C.bold}已开启${C.reset}：进入会话时会显示历史`,
            '',
            `${C.dim}下次重启或 /resume 就会生效。${C.reset}`,
          ].join('\n')
          : [
            `${C.bold}已关闭${C.reset}：进入会话时不再显示历史`,
            '',
            `${C.dim}重启续接：正文区完全静默，什么提示都没有。${C.reset}`,
            `${C.dim}/resume：仍会告诉你切到了哪个会话，只是不铺开历史正文。${C.reset}`,
            `${C.dim}对话内容本身完整保留，随时可 /replay on 看回来。${C.reset}`,
          ].join('\n')
      }

      return [
        `未知参数: ${args[0]}`,
        '',
        '用法:',
        `  ${C.bold}/replay${C.reset}          查看当前状态`,
        `  ${C.bold}/replay on${C.reset}       进入会话时显示历史（默认）`,
        `  ${C.bold}/replay off${C.reset}      进入会话时不显示历史`,
        '',
        `${C.dim}也认中文：开 / 关，显示 / 隐藏${C.reset}`,
      ].join('\n')
    },
  }
}
