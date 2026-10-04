#!/bin/bash
# audio-keepalive.sh — Termux 息屏保活（静音音频欺骗法）
#
# 原理：循环播放静音 AMR 文件 → 系统把 Termux 当"正在播放音乐的应用"
#   → 息屏时网络不断、CPU 不冻、进程不被杀（治小米 HyperOS 息屏断流）
#
# 【2026-10-04 优化：不跟用户听歌打架】
# 问题：termux-media-player 是**单实例**播放器（"can only play one file at a time"）。
#   用户用 `termux-media-player play 歌曲.mp3` 听歌时：
#     · 保活的下一次循环会抢占播放器 → 用户的歌被顶掉
#     · 用户重新播放 → 又顶掉保活 → 循环死掉，保活失效
# 解决：**保活循环每轮先检查播放器状态**——
#   若正在播放且不是自己的静音文件（说明用户在听歌），本轮跳过、不抢。
#   用户的音频本身就能保活（系统不会冻结有音频在播的进程），所以让路是正确的。
#
# 用法：
#   bash core/audio-keepalive.sh start   启动保活（幂等，已运行则跳过）
#   bash core/audio-keepalive.sh stop    停止保活
#   bash core/audio-keepalive.sh status  查看状态
#   bash core/audio-keepalive.sh loop    （内部用）保活循环本体
#
# 依赖：termux-api（termux-media-player）+ ffmpeg（生成静音文件）

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
SILENT_FILE="$HOME/.termux/quiet_1min.amr"
LOOP_TAG="ccm-keepalive-loop"   # 循环进程的命令行标记，pgrep 靠它识别（环境变量 pgrep 看不到）

# 生成静音文件（如果不存在）
ensure_silent() {
  if [ ! -f "$SILENT_FILE" ]; then
    mkdir -p "$HOME/.termux"
    ffmpeg -y -f lavfi -i anullsrc=r=8000:cl=mono -t 65 -c:a libopencore_amrnb -b:a 4.75k "$SILENT_FILE" > /dev/null 2>&1
  fi
}

# 保活循环本体（start 时后台调用）
loop() {
  while true; do
    info=$(termux-media-player info 2>/dev/null)
    if echo "$info" | grep -q "Playing"; then
      # 有东西在播——是不是自己的静音？
      if echo "$info" | grep -q "quiet_1min"; then
        # 自己还在播 → 续播（重置 65 秒计时，保持连续）
        termux-media-player play "$SILENT_FILE" > /dev/null 2>&1
      fi
      # 否则是用户在听歌 → 什么都不做，让路
    else
      # 没人在播 → 播静音顶上
      termux-media-player play "$SILENT_FILE" > /dev/null 2>&1
    fi
    sleep 55
  done
}

# 是否已有循环在跑（靠命令行标记识别）
is_running() {
  pgrep -f "$LOOP_TAG" > /dev/null 2>&1
}

start() {
  ensure_silent
  if is_running; then
    echo "audio-keepalive: 已在运行"
    return 0
  fi
  # 用命令行参数带标记：pgrep -f 能看到
  nohup bash "$SELF" loop "$LOOP_TAG" > /dev/null 2>&1 &
  sleep 1
  if is_running; then
    echo "audio-keepalive: 已启动（静音播放中，用户听歌时自动让路）"
  else
    echo "audio-keepalive: 启动失败（检查 termux-api 是否装了）"
    return 1
  fi
}

stop() {
  pkill -f "$LOOP_TAG" > /dev/null 2>&1
  # 兜底：只停自己的静音，不动用户正在放的歌
  info=$(termux-media-player info 2>/dev/null)
  if echo "$info" | grep -q "quiet_1min"; then
    termux-media-player stop > /dev/null 2>&1
  fi
  echo "audio-keepalive: 已停止"
}

status() {
  ensure_silent
  if is_running; then
    echo "audio-keepalive: 运行中 ✓"
    termux-media-player info 2>/dev/null | head -3 || true
  else
    echo "audio-keepalive: 未运行 ✗"
  fi
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  loop) loop ;;
  *) echo "用法: $0 {start|stop|status}" ;;
esac
