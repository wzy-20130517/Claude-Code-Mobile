// 终端字体三选项（2026-10-01 用户拍板）
//
// 设计：不再在 start.sh 里「没字体就自动装 JetBrains Mono」——
// 字体外观是用户偏好，首次使用向导里**询问**，选了哪个才装哪个并立刻生效。
// 向导（core/onboarding.mjs）与 /font 命令（core/cmd-misc.mjs）共用本模块，
// 选项定义与安装逻辑只此一份，避免两处漂移。
import { cpSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ASSETS_FONTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts')
const FONT_DST = join(process.env.HOME || '', '.termux', 'font.ttf')

/** 三选项。file=null 表示系统字体（删掉自定义文件即回退）。 */
export const FONT_CHOICES = [
  { id: 'system', name: '系统字体（Termux 默认）', file: null },
  { id: 'jetbrains', name: 'JetBrains Mono（推荐）', file: 'JetBrainsMono-Regular.ttf' },
  { id: 'maple', name: 'Maple Mono NF', file: 'MapleMono-NF-Regular.ttf' },
]

/** /font 子命令别名 → id。 */
export const FONT_ALIASES = {
  system: 'system', 系统: 'system', reset: 'system', rm: 'system',
  jbm: 'jetbrains', jetbrains: 'jetbrains', mono: 'jetbrains',
  maple: 'maple', 'maple-mono': 'maple',
}

/**
 * 安装（或回退）指定字体并立刻生效（termux-reload-settings）。
 * @returns {{ok: boolean, msg: string}}
 */
export function installFont(id) {
  const c = FONT_CHOICES.find((f) => f.id === id)
  if (!c) return { ok: false, msg: `未知字体：${id}（可选：${FONT_CHOICES.map((f) => f.id).join(' / ')}）` }
  try {
    if (c.file) {
      const src = join(ASSETS_FONTS, c.file)
      if (!existsSync(src)) return { ok: false, msg: `字体文件不存在：${src}` }
      // 备份已有字体（保留一份回退路径）
      if (existsSync(FONT_DST)) {
        try { cpSync(FONT_DST, FONT_DST + '.bak') } catch {}
      }
      cpSync(src, FONT_DST)
    } else {
      // 系统字体 = 删除自定义字体文件
      rmSync(FONT_DST, { force: true })
    }
    try {
      execFileSync('termux-reload-settings', [], { timeout: 8000, stdio: 'ignore' })
    } catch {}
    return {
      ok: true,
      msg: c.file ? `已安装 ${c.name}，已重载立即生效。` : '已恢复系统字体，已重载立即生效。',
    }
  } catch (e) {
    return { ok: false, msg: `字体操作失败：${e.message}` }
  }
}
