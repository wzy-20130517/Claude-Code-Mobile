#!/bin/bash
# audio-keepalive.sh — Termux 息屏保活（静音音频欺骗法）
#
# 原理：循环播放静音 AMR 文件 → 系统把 Termux 当"正在播放音乐的应用"
#   → 息屏时网络不断、CPU 不冻、进程不被杀（治小米 HyperOS 息屏断流）
#
# 用法：
#   bash core/audio-keepalive.sh start   启动保活（幂等，已运行则跳过）
#   bash core/audio-keepalive.sh stop    停止保活
#   bash core/audio-keepalive.sh status  查看状态
#
# 依赖：termux-api（termux-media-player）+ ffmpeg（生成静音文件）

SILENT_FILE="$HOME/.termux/quiet_1min.amr"
LOOP_CMD="while true; do termux-media-player play $SILENT_FILE > /dev/null 2>&1; sleep 60; done"

# 生成静音文件（如果不存在）
ensure_silent() {
  if [ ! -f "$SILENT_FILE" ]; then
    mkdir -p "$HOME/.termux"
    ffmpeg -y -f lavfi -i anullsrc=r=8000:cl=mono -t 65 -c:a libopencore_amrnb -b:a 4.75k "$SILENT_FILE" > /dev/null 2>&1
  fi
}

# 是否已有循环在跑
is_running() {
  pgrep -f "termux-media-player play $SILENT_FILE" > /dev/null 2>&1
}

start() {
  ensure_silent
  if is_running; then
    echo "audio-keepalive: 已在运行"
    return 0
  fi
  nohup sh -c "$LOOP_CMD" > /dev/null 2>&1 &
  sleep 1
  if is_running; then
    echo "audio-keepalive: 已启动（静音播放中）"
  else
    echo "audio-keepalive: 启动失败（检查 termux-api 是否装了）"
    return 1
  fi
}

stop() {
  pkill -f "termux-media-player play $SILENT_FILE" > /dev/null 2>&1
  pkill -f "$LOOP_CMD" > /dev/null 2>&1
  termux-media-player stop > /dev/null 2>&1
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
  *) echo "用法: $0 {start|stop|status}" ;;
esac
