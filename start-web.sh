#!/data/data/com.termux/files/usr/bin/bash
# Claude Code Mobile Web 后端启动器（带守护循环）
# server.mjs 遇到 uncaughtException 会主动 exit 1；这里负责把它重新拉起，
# 避免一次异步异常就让整个 Web 服务长时间下线。
cd "$(dirname "$0")"

LOG_DIR="$HOME/.claude-code-mobile"
mkdir -p "$LOG_DIR"
GUARD_LOG="$LOG_DIR/web-guard.log"

# 退出码 250 = 主动请求停止（不重启），与 CLI 约定一致
STOP_CODE=250
# 连续快速崩溃保护：10 秒内退出算「快速失败」，累计 5 次就停下，避免疯狂刷日志
FAST_FAIL_LIMIT=5
fast_fails=0

cleanup() {
  echo "[$(date '+%F %T')] 守护进程收到退出信号，停止" >> "$GUARD_LOG"
  # 子进程自己会在 SIGTERM 里清理保活（音频/通知/wake-lock）
  [ -n "$child" ] && kill -TERM "$child" 2>/dev/null
  exit 0
}
trap cleanup INT TERM

echo "[$(date '+%F %T')] 守护进程启动" >> "$GUARD_LOG"

while true; do
  start_ts=$(date +%s)

  node web/server.mjs "$@" &
  child=$!
  wait "$child"
  code=$?
  child=""

  elapsed=$(( $(date +%s) - start_ts ))

  if [ "$code" -eq 0 ] || [ "$code" -eq "$STOP_CODE" ]; then
    echo "[$(date '+%F %T')] 正常退出（code=$code），不再重启" >> "$GUARD_LOG"
    break
  fi

  if [ "$elapsed" -lt 10 ]; then
    fast_fails=$(( fast_fails + 1 ))
  else
    fast_fails=0
  fi

  if [ "$fast_fails" -ge "$FAST_FAIL_LIMIT" ]; then
    echo "[$(date '+%F %T')] 连续 $fast_fails 次快速崩溃，停止重启。请查看 $LOG_DIR/web-crash.log" >> "$GUARD_LOG"
    echo "连续崩溃 $fast_fails 次，已停止。查看 $LOG_DIR/web-crash.log 排查。"
    break
  fi

  # 快速失败时退避，正常运行一段时间后崩溃则立即重启
  if [ "$elapsed" -lt 10 ]; then delay=$(( fast_fails * 3 )); else delay=1; fi
  echo "[$(date '+%F %T')] 异常退出（code=$code, 运行 ${elapsed}s），${delay}s 后重启" >> "$GUARD_LOG"
  sleep "$delay"
done
