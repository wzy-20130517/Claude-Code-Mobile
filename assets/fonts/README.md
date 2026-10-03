# 终端字体（三选项，2026-10-01 起由向导询问）

| 文件 | 字体 | 授权 |
|---|---|---|
| `JetBrainsMono-Regular.ttf` | JetBrains Mono（**推荐**） | Apache License 2.0 |
| `MapleMono-NF-Regular.ttf` | Maple Mono NF（圆润风 + Nerd 图标） | SIL OFL 1.1 |

## 新流程：不再自动安装

以前 `start.sh` 发现 `~/.termux/font.ttf` 不存在就自动装 JetBrains Mono——
字体外观是用户偏好，现在改成：

- **首次使用向导**第一步询问三选一：系统字体 / JetBrains Mono（推荐）/ Maple Mono NF，
  选了才装、装完 `termux-reload-settings` 立即生效。
- 之后随时 `/font system|jetbrains|maple` 切换（实现：`core/font-choice.mjs`，
  向导与 /font 共用同一份选项与安装逻辑）。

## 手动操作（等价于 /font 子命令）

```bash
# 装 JetBrains Mono
cp assets/fonts/JetBrainsMono-Regular.ttf ~/.termux/font.ttf && termux-reload-settings

# 装 Maple Mono NF
cp assets/fonts/MapleMono-NF-Regular.ttf ~/.termux/font.ttf && termux-reload-settings

# 回系统字体
rm ~/.termux/font.ttf && termux-reload-settings
```

装完立即生效，不用重启 Termux。

## 用别的字体

任意等宽 ttf 放到 `~/.termux/font.ttf` 再 `termux-reload-settings` 即可
（自定义字体不会被向导覆盖——向导只在首启跑一次）。

字形要求：吉祥物/状态栏用到 `█▀▄░▒◆⚠✓`，**缺这些字符的字体会 fallback 混排、
图案割裂**（Monaspace 实测全缺，勿用）。三个选项都验证过覆盖。

字体来源：
- JetBrains Mono — https://github.com/JetBrains/JetBrainsMono
- Maple Mono — https://github.com/subframe7536/maple-font（MapleMono-NF v7.9）
