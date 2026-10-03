#!/data/data/com.termux/files/usr/bin/bash
# 字体安装（2026-10-01 起参数化 —— 不再无条件装 JetBrains Mono）
#
# 用法: install.sh [system|jetbrains|maple]   （默认 jetbrains）
# 正常入口是首次使用向导或 CLI 的 /font system|jetbrains|maple；
# 本脚本留给无 CLI 环境的手动兜底。
set -e

CHOICE="${1:-jetbrains}"
DIR="$(cd "$(dirname "$0")" && pwd)"
FONT_DST="$HOME/.termux/font.ttf"

mkdir -p "$HOME/.termux"

case "$CHOICE" in
  system)
    rm -f "$FONT_DST"
    echo "已移除自定义字体（恢复系统默认）"
    ;;
  jetbrains)
    [ -f "$DIR/JetBrainsMono-Regular.ttf" ] || { echo "缺 JetBrainsMono-Regular.ttf"; exit 1; }
    [ -f "$FONT_DST" ] && cp "$FONT_DST" "$FONT_DST.bak"
    cp "$DIR/JetBrainsMono-Regular.ttf" "$FONT_DST"
    echo "已安装 JetBrains Mono"
    ;;
  maple)
    [ -f "$DIR/MapleMono-NF-Regular.ttf" ] || { echo "缺 MapleMono-NF-Regular.ttf"; exit 1; }
    [ -f "$FONT_DST" ] && cp "$FONT_DST" "$FONT_DST.bak"
    cp "$DIR/MapleMono-NF-Regular.ttf" "$FONT_DST"
    echo "已安装 Maple Mono NF"
    ;;
  *)
    echo "用法: install.sh [system|jetbrains|maple]"; exit 1
    ;;
esac

if command -v termux-reload-settings >/dev/null 2>&1; then
  termux-reload-settings
  echo "已重载 Termux 设置，字体立即生效"
else
  echo "找不到 termux-reload-settings，请手动重启 Termux"
fi
