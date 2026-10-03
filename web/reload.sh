#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
LOG="$HOME/.claude-code-mobile/web.log"

cd "$ROOT/web"
npx vite build

# Only restart the Web server. The CLI process and its session are untouched.
pkill -f 'node .*/web/server\.mjs$' 2>/dev/null || true
nohup node "$ROOT/web/server.mjs" >> "$LOG" 2>&1 &
printf 'Web reloaded: http://127.0.0.1:3456\n'
