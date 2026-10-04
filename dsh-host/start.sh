#!/data/data/com.termux/files/usr/bin/bash
# dsh-host 启停脚本
#
# 用法：
#   bash start.sh start    启动宿主（后台，日志写 server.log）
#   bash start.sh stop     停止
#   bash start.sh restart  重启
#   bash start.sh status   查看状态
#   bash start.sh log      看日志

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${DSH_HOST_PORT:-8790}"
# 用户数据放 ~/.claude-code-mobile/dsh-host/（与源码分离）
DATA_DIR="${DSH_HOST_DATA:-$HOME/.claude-code-mobile/dsh-host}"
mkdir -p "$DATA_DIR"
LOG="$DATA_DIR/server.log"
PIDFILE="$DATA_DIR/server.pid"

is_running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

case "$1" in
  start)
    if is_running; then
      echo "已在运行 (PID $(cat "$PIDFILE"))"
      exit 0
    fi
    cd "$DIR" || exit 1
    nohup node server.mjs > "$LOG" 2>&1 &
    echo $! > "$PIDFILE"

    # 等真正就绪：进程活着 != 服务可用。
    # webServer listen + 28 服务注册 + 插件装配实测约 12-14 秒，
    # 原来只 sleep 3 就报"已启动"，用户立即访问会失败。
    READY=0
    WAITED=0
    while [ "$WAITED" -lt 20 ]; do
      sleep 1
      WAITED=$((WAITED + 1))
      if ! is_running; then break; fi
      if curl -s --max-time 2 "http://127.0.0.1:$PORT/control/status" > /dev/null 2>&1; then
        READY=1
        break
      fi
    done

    if [ "$READY" = "1" ]; then
      echo "已启动并就绪 (PID $(cat "$PIDFILE"))，端口 $PORT（耗时 ${WAITED}s）"
      echo "控制 API: http://127.0.0.1:$PORT/control/status"
    elif is_running; then
      echo "进程已起但 API 未就绪（等了 ${WAITED}s），可能还在加载："
      echo "  tail -20 $LOG"
    else
      echo "启动失败，看日志: $LOG"
      tail -20 "$LOG"
      exit 1
    fi
    ;;
  stop)
    STOPPED=0
    # 1. 先杀 pid 文件记录的进程
    if is_running; then
      kill "$(cat "$PIDFILE")" 2>/dev/null
      STOPPED=1
    fi
    rm -f "$PIDFILE"

    # 2. 兜底：扫描真实进程（pid 文件可能过期，但进程还在跑）
    #    踩过的坑：新进程因端口被占启动失败，pid 文件指向已死的新进程，
    #    旧进程却还活着 —— 只信 pid 文件会误判"没在运行"。
    for pid in $(pgrep -f "node server.mjs" 2>/dev/null); do
      # 排除自己（pgrep 可能匹配到本脚本的命令行）
      [ "$pid" = "$$" ] && continue
      # 只杀工作目录在本目录下的（避免误杀别的 server.mjs）
      CWD=$(readlink "/proc/$pid/cwd" 2>/dev/null)
      if [ "$CWD" = "$DIR" ]; then
        kill "$pid" 2>/dev/null && STOPPED=1
      fi
    done

    if [ "$STOPPED" = "1" ]; then
      sleep 1
      echo "已停止"
    else
      echo "没在运行"
    fi
    ;;
  restart)
    bash "$DIR/start.sh" stop
    sleep 1
    bash "$DIR/start.sh" start
    ;;
  status)
    if is_running; then
      echo "运行中 (PID $(cat "$PIDFILE"))"
      curl -s --max-time 5 "http://127.0.0.1:$PORT/control/status" 2>/dev/null || echo "(控制 API 无响应)"
    else
      echo "未运行"
    fi
    ;;
  log)
    tail -40 "$LOG"
    ;;
  *)
    echo "用法: bash start.sh {start|stop|restart|status|log}"
    ;;
esac
