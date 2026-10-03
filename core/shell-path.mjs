// Claude Code Mobile - shell 路径探测（Termux / proot Ubuntu 自适应）
//
// 【为什么需要这个模块】
// 项目原本假设只跑在 Termux 里，shell 固定在 $PREFIX/bin/sh 或 /system/bin/sh。
// 但 CCM（Android 原生外壳）模式下 Node 跑在 proot Ubuntu 里，那里：
//   - $PREFIX 不存在（那是 Termux 的概念）
//   - /system/bin/sh 可能被 bind 成 Android 的 shell，行为不同
//   - 正确的是 /bin/bash（Ubuntu 自带）
//
// 探测顺序（用第一个存在的）：
//   1. $SHELL              用户显式指定
//   2. $PREFIX/bin/sh      Termux
//   3. /bin/bash           Ubuntu/Debian
//   4. /usr/bin/bash       部分发行版
//   5. /bin/sh             POSIX 兜底
//   6. /system/bin/sh      Android（最后才用）
//
// 结果缓存（进程生命周期内 shell 不变）。

import { existsSync } from 'node:fs'

let _cached = null

export function getShellPath() {
  if (_cached) return _cached

  const candidates = [
    process.env.SHELL,
    process.env.PREFIX ? `${process.env.PREFIX}/bin/sh` : null,
    '/bin/bash',
    '/usr/bin/bash',
    '/bin/sh',
    '/system/bin/sh',
  ].filter(Boolean)

  for (const c of candidates) {
    try {
      if (existsSync(c)) {
        _cached = c
        return c
      }
    } catch {}
  }

  _cached = '/bin/sh'
  return _cached
}

/** 当前是否跑在 proot Ubuntu 里（用于其他地方的判断） */
export function isInProot() {
  return existsSync('/bin/bash') && !process.env.PREFIX
}

/** 当前是否跑在 Termux 里 */
export function isInTermux() {
  return !!process.env.PREFIX?.includes('com.termux')
}
