// core/cmd-update.mjs —— /update 一键更新
//
// 【为什么有这条命令】
// 2026-10-03 用户：「加个一键更新的 slash 命令，从镜像更，不会覆盖用户数据」。
// 配套 core/version-check.mjs（启动时检查 + 实际更新逻辑）。
//
// 【用法】
//   /update          检查并更新到最新版
//   /update check    只看有没有新版，不更新
//   /update mirror <url>   设置镜像前缀（存 config.json 的 updateMirror）
//
// 【不覆盖用户数据】
// 用户数据都在 ~/.claude-code-mobile/，源码目录里没有 → 天然隔离。
// 更新前会把「将被改动的文件」备份到 ~/.claude-code-mobile/update-backup/<tag>/，
// 出问题可以手动回滚。

/**
 * @param {object} ctx
 *   config / saveConfig    配置读写（镜像存 updateMirror 字段）
 *   cliVersion             当前版本号
 *   projectDir             项目目录（更新目标）
 *   C                      颜色
 */
export function makeUpdateCommand(ctx) {
  return {
    async update(args) {
      const C = ctx.C || new Proxy({}, { get: () => '' })
      const {
        compareVersions, isNewer, fetchLatestVersion, performUpdate, REPO,
      } = await import('./version-check.mjs')

      const sub = String(args[0] || '').trim().toLowerCase()
      const mirror = ctx.config?.updateMirror || 'https://gh-proxy.com'
      const current = ctx.cliVersion || '0.0.0'

      // ── /update mirror <url> ────────────────────────
      if (sub === 'mirror') {
        const url = String(args.slice(1).join(' ') || '').trim()
        if (!url) {
          return [
            `当前镜像: ${C.bold}${mirror}${C.reset}`,
            '',
            '用法:',
            `  ${C.dim}/update mirror https://gh-proxy.com${C.reset}   设置镜像前缀`,
            `  ${C.dim}/update mirror off${C.reset}                        直连 GitHub（国内可能不通）`,
            '',
            `${C.dim}镜像用于下载源码包。默认 gh-proxy.com（国内可达）。${C.reset}`,
          ].join('\n')
        }
        try {
          const cfg = ctx.config
          cfg.updateMirror = (url === 'off' || url === 'none') ? '' : url.replace(/\/+$/, '')
          ctx.saveConfig(cfg)
          return `镜像已设置: ${cfg.updateMirror || '(直连 GitHub)'}`
        } catch (e) {
          return `保存失败: ${e?.message || e}`
        }
      }

      // ── /update check ───────────────────────────────
      const checkOnly = (sub === 'check' || sub === '-c')

      // ── 抓最新版 ────────────────────────────────────
      let latest
      try {
        latest = await fetchLatestVersion({ timeout: 15000, useCache: false })
      } catch (e) {
        return `检查更新失败: ${e?.message || e}`
      }
      if (!latest) {
        return [
          '检查更新失败（无法访问 GitHub API）。',
          '',
          `${C.dim}可能原因：网络不通 / API 限流 / 仓库暂无 release。${C.reset}`,
          `${C.dim}仓库: https://github.com/${REPO}${C.reset}`,
        ].join('\n')
      }

      // ── 版本比对 ────────────────────────────────────
      const hasUpdate = isNewer(latest.version, current)

      if (!hasUpdate) {
        return [
          `${C.bold}已是最新版本${C.reset}`,
          '',
          `  当前: ${current}`,
          `  最新: ${latest.version}`,
          '',
          `${C.dim}${latest.url}${C.reset}`,
        ].join('\n')
      }

      if (checkOnly) {
        return [
          `${C.bold}发现新版本${C.reset}`,
          '',
          `  当前: ${C.dim}${current}${C.reset}`,
          `  最新: ${C.green || ''}${latest.version}${C.reset}`,
          latest.name ? `  说明: ${latest.name}` : '',
          '',
          `更新: ${C.bold}/update${C.reset}`,
          `${C.dim}${latest.url}${C.reset}`,
        ].filter(Boolean).join('\n')
      }

      // ── 执行更新 ────────────────────────────────────
      const projectDir = ctx.projectDir
      if (!projectDir) return '无法确定项目目录，更新中止'

      const lines = [
        `${C.bold}开始更新${C.reset}  ${current} → ${latest.version}`,
        `${C.dim}镜像: ${mirror || '(直连 GitHub)'}${C.reset}`,
        '',
      ]

      const result = await performUpdate({
        version: latest.version,
        projectDir,
        mirror,
        onLog: (l) => lines.push(`  ${C.dim}${l}${C.reset}`),
      })

      lines.push('')

      if (!result.ok) {
        lines.push(`${C.red || ''}更新失败: ${result.error}${C.reset}`)
        lines.push('')
        lines.push(`${C.dim}源码未被修改（失败发生在覆盖之前，或已备份）。${C.reset}`)
        if (result.backupDir) lines.push(`${C.dim}备份: ${result.backupDir}${C.reset}`)
        return lines.join('\n')
      }

      lines.push(`${C.green || ''}✓ 更新完成${C.reset}  已写入 ${result.updated} 个文件`)
      if (result.backupDir) {
        lines.push(`${C.dim}改动前备份: ${result.backupDir}${C.reset}`)
      }
      lines.push('')
      lines.push(`${C.bold}需要重启才能生效${C.reset}`)
      lines.push(`${C.dim}按 Ctrl+X 重启（会先跑预检，通过才真正重启）${C.reset}`)
      lines.push(`${C.dim}用户数据（~/.claude-code-mobile/）未受影响。${C.reset}`)

      return lines.join('\n')
    },
  }
}
