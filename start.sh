#!/bin/bash
# 记录项目绝对路径：全局 claude 启动器需要它，不能依赖调用时的当前目录。
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P)" || exit 1
cd "$PROJECT_DIR" || exit 1
RED='\033[31m'
DIM='\033[2m'
RESET='\033[0m'

# 首次运行自动安装全局 claude 命令，仿照下面的字体自动安装。
# 换手机只需把项目复制到 Termux 家目录后启动一次；入口会写入新手机自己的
# $PREFIX/bin，不把任何设备绝对路径硬编码进项目。已有非本项目的 claude 不覆盖。
install_global_launcher() {
  [ -n "${PREFIX:-}" ] || return 0
  local bin_dir="$PREFIX/bin"
  local launcher="$bin_dir/claude"
  [ -d "$bin_dir" ] && [ -w "$bin_dir" ] || return 0

  # 允许更新本项目旧版入口；其他程序占用 claude 时保持原样。
  if [ -e "$launcher" ] && ! grep -qE 'claude-code-mobile launcher|Claude Code Mobile 全局启动器' "$launcher" 2>/dev/null; then
    return 0
  fi

  local tmp="${launcher}.tmp.$$"
  {
    printf '#!%s\n' "${BASH:-$bin_dir/bash}"
    printf '%s\n' '# claude-code-mobile launcher (auto-installed by start.sh)'
    printf '%s\n' 'if [ -n "${CLAUDE_CODE_MOBILE_HOME:-}" ]; then'
    printf '%s\n' '  PROJECT_DIR="$CLAUDE_CODE_MOBILE_HOME"'
    printf '%s\n' 'else'
    printf '  PROJECT_DIR=%q\n' "$PROJECT_DIR"
    printf '%s\n' 'fi'
    printf '%s\n' 'exec bash "$PROJECT_DIR/start.sh" "$@"'
  } > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 0; }

  chmod 755 "$tmp" 2>/dev/null || { rm -f "$tmp"; return 0; }
  if ! cmp -s "$tmp" "$launcher" 2>/dev/null; then
    if mv -f "$tmp" "$launcher" 2>/dev/null; then
      echo -e "${DIM}已安装全局 claude 命令（$launcher）${RESET}"
    else
      rm -f "$tmp"
    fi
  else
    rm -f "$tmp"
  fi
}
install_global_launcher

if ! command -v node &> /dev/null; then
  echo -e "${RED}[错误]${RESET} Node.js 未安装！请先装 Node 18+"
  exit 1
fi

# Web 子命令：`claude web` 或首次在新设备执行 `bash start.sh web`。
# 安装全局入口已经在上面完成，因此新设备也能在同一条命令里安装并启动 Web。
# 一键入口采用「后台守护 + 健康检查 + 打开浏览器」；直接 bash start-web.sh 仍可前台调试。
if [ "${1:-}" = "web" ]; then
  shift
  WEB_URL="http://127.0.0.1:3456"
  WEB_LOG_DIR="$HOME/.claude-code-mobile"
  WEB_CONSOLE_LOG="$WEB_LOG_DIR/web-guard-console.log"

  if [ ! -f "$PROJECT_DIR/start-web.sh" ]; then
    echo -e "${RED}[错误]${RESET} 找不到 Web 启动脚本：$PROJECT_DIR/start-web.sh"
    exit 1
  fi

  web_ready() {
    command -v curl >/dev/null 2>&1 || return 1
    curl -fsS --max-time 2 "$WEB_URL/api/health" 2>/dev/null | grep -q '"ok"[[:space:]]*:[[:space:]]*true'
  }

  if ! web_ready; then
    mkdir -p "$WEB_LOG_DIR"
    # nohup + 脱离 stdin：CLI/Web 命令返回后，Web 仍由自己的守护循环维持。
    nohup bash "$PROJECT_DIR/start-web.sh" "$@" >> "$WEB_CONSOLE_LOG" 2>&1 < /dev/null &
    WEB_GUARD_PID=$!

    # server.mjs 首次加载模块可能需要一点时间，最多等 4 秒，不盲等后就直接返回。
    for _ in 1 2 3 4 5 6 7 8; do
      sleep 0.5
      if web_ready; then
        break
      fi
    done
  fi

  if web_ready; then
    # 可用 CLAUDE_WEB_NO_OPEN=1 只启动服务不拉浏览器，便于脚本/调试调用。
    if [ "${CLAUDE_WEB_NO_OPEN:-0}" != "1" ] && command -v termux-open-url >/dev/null 2>&1; then
      termux-open-url "$WEB_URL" >/dev/null 2>&1 || true
    fi
    echo "Web 已启动：$WEB_URL"
    [ -n "${WEB_GUARD_PID:-}" ] && echo "守护 PID：$WEB_GUARD_PID"
    [ "${CLAUDE_WEB_NO_OPEN:-0}" = "1" ] || ! command -v termux-open-url >/dev/null 2>&1 || echo "已请求打开浏览器"
    exit 0
  fi

  echo -e "${RED}[错误]${RESET} Web 进程已发起但未就绪：$WEB_URL"
  echo "请查看日志：$WEB_CONSOLE_LOG"
  [ -n "${WEB_GUARD_PID:-}" ] && echo "守护 PID：$WEB_GUARD_PID"
  exit 1
fi

# 不检查 config.json：没有时 index.mjs 会启动交互式配置向导

# 终端字体（2026-10-01 改）：不再自动安装 —— 字体是用户偏好，
# 首次使用向导里询问三选一（系统 / JetBrains Mono 推荐 / Maple Mono NF），
# 选了才装并立刻生效。装过的用 /font system|jetbrains|maple 随时切换。

# 支持重启：当 Node 进程以 exit code 250 退出时自动重启
# 内存限制：--max-old-space-size=4096 防止大项目时 node 内存飙高被 Android LMK 杀（signal 9）
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=4096"
# 重启标记：只有 Ctrl+X（exit 250）引起的重启才带上。
# Node 侧据此区分「重启续接」（保留当前会话）与「手动启动」（开新对话，对齐官方）。
# 手动敲 claude 启动时该变量为空 → 新对话。
export CCM_RESTART=""
while true; do
  node index.mjs
  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 250 ]; then
    # Ctrl+X 成功重启保持静默：Node 侧已完成预检和会话保存，
    # 这里不再输出「正在重启…」或 sleep 1s，避免终端闪无用日志。
    # 预检失败不会以 250 退出，会由当前 Node 进程原地显示错误。
    export CCM_RESTART=1
    continue
  fi
  break
done
