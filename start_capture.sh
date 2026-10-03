#!/data/data/com.termux/files/usr/bin/bash
# 卡死现场抓取工具
#
# 【用法】
#   1. 另开一个 Termux 会话（或 QQ 发消息），跑：bash ~/claude-code-mobile/start_capture.sh
#   2. 它会等你按回车，然后冻结当前 node 进程 3 秒并抓栈
#   3. 结果写到 ~/.claude-code-mobile/freeze-stack.txt
#
# 【原理】Node 内置 inspector，通过 SIGUSR1 打开调试端口，
# 连上去抓调用栈。这是唯一能在「事件循环卡死」时拿到栈的办法
# （进程内埋点此时全都执行不到）。

set -u
DIR="$HOME/.claude-code-mobile"
OUT="$DIR/freeze-stack.txt"
PORT=9229

PID=$(ps -eo pid,args 2>/dev/null | grep 'node index.mjs' | grep -v grep | awk '{print $1}' | head -1)
if [ -z "$PID" ]; then echo "❌ 找不到 node index.mjs 进程"; exit 1; fi
echo "找到 CLI 进程 PID=$PID"
echo "给它发 SIGUSR1 打开 inspector..."
kill -USR1 "$PID"
sleep 2

echo "连接 ws://127.0.0.1:$PORT ..."
node -e '
const http = require("http");
http.get("http://127.0.0.1:9229/json/list", (res) => {
  let b = "";
  res.on("data", c => b += c);
  res.on("end", () => {
    let list;
    try { list = JSON.parse(b); } catch (e) { console.log("解析失败:", b.slice(0,200)); process.exit(1); }
    const t = (list.find(x => x.type === "node") || list[0]);
    if (!t) { console.log("没有可用 target"); process.exit(1); }
    console.log("TARGET_URL=" + t.webSocketDebuggerUrl);
  });
}).on("error", e => { console.log("连不上 inspector:", e.message); process.exit(1); });
' > "$DIR/_ws.txt" 2>&1
cat "$DIR/_ws.txt"

WS=$(grep '^TARGET_URL=' "$DIR/_ws.txt" | cut -d= -f2-)
if [ -z "$WS" ]; then echo "❌ 没拿到 ws 地址"; exit 1; fi

echo "抓取调用栈（暂停 3 秒）..."
node -e '
const wsUrl = process.argv[1];
const out = process.argv[2];
// Node 22+ 自带 WebSocket
const ws = new WebSocket(wsUrl);
let id = 0;
const send = (method, params) => { ws.send(JSON.stringify({ id: ++id, method, params })); return id; };
ws.onopen = () => send("Debugger.enable");
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id === 1) {
    // 启用成功 → 暂停并抓栈
    setTimeout(() => send("Debugger.pause"), 100);
  }
  if (m.method === "Debugger.paused") {
    const frames = m.params.callFrames || [];
    const lines = frames.map((f, i) => {
      const loc = f.location || {};
      const fn = f.functionName || "(anonymous)";
      const url = (loc.scriptId !== undefined) ? `scriptId=${loc.scriptId}` : "";
      return `  #${i} ${fn} ${url} line=${loc.lineNumber} col=${loc.columnNumber}`;
    });
    const text = `[${new Date().toISOString()}] 卡死栈（PID 暂停时抓取）\n`
      + frames.map((f, i) => {
          const loc = f.location || {};
          const fn = f.functionName || "(anonymous)";
          return `  #${i} ${fn} at line ${loc.lineNumber}:${loc.columnNumber}`;
        }).join("\n") + "\n\n";
    require("fs").appendFileSync(out, text);
    console.log("✅ 栈已写入 " + out);
    console.log(text);
    send("Debugger.resume");
    setTimeout(() => process.exit(0), 300);
  }
};
ws.onerror = (e) => { console.log("ws 错误:", e.message || e); process.exit(1); };
setTimeout(() => { console.log("超时"); process.exit(1); }, 15000);
' "$WS" "$OUT"
