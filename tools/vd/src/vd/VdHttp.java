package vd;

import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.concurrent.Executors;

/**
 * 副屏的本地 HTTP 接口。
 *
 * Termux 侧（CLI/Web）连 127.0.0.1:3458 就能操作副屏，
 * 不用管 binder、不用管进程间通信。
 *
 * 只监听回环，只有 POST /call 一个业务端点。
 * 手写而不是引框架：这个进程跑在 app_process 里，没有 Application、
 * 没有第三方依赖的初始化环境，越简单越不容易出意外。
 */
public class VdHttp {

    private final VdCore core;
    private final int port;
    private final java.util.concurrent.ExecutorService pool = Executors.newCachedThreadPool();

    public VdHttp(VdCore core, int port) {
        this.core = core;
        this.port = port;
    }

    public void start() {
        pool.execute(() -> {
            try {
                ServerSocket ss = new ServerSocket(port, 16, InetAddress.getByName("127.0.0.1"));
                while (!ss.isClosed()) {
                    Socket sock = ss.accept();
                    pool.execute(() -> handle(sock));
                }
            } catch (Throwable t) {
                VdMain.log("HTTP 监听失败: " + t);
            }
        });
    }

    private void handle(Socket sock) {
        try {
            sock.setSoTimeout(60000);
            java.io.InputStream in = sock.getInputStream();

            // 手工按字节读 headers：
            // BufferedReader 会预读 8KB，把 body 一起吞进它的缓冲，
            // 之后再从底层流读 body 什么都读不到（这个坑在 CCM 桥里踩过）。
            ByteArrayOutputStream hb = new ByteArrayOutputStream();
            int state = 0;
            while (state < 4) {
                int b = in.read();
                if (b == -1) return;
                hb.write(b);
                if (state == 0 && b == '\r') state = 1;
                else if (state == 1 && b == '\n') state = 2;
                else if (state == 2 && b == '\r') state = 3;
                else if (state == 3 && b == '\n') state = 4;
                else if (b == '\r') state = 1;
                else state = 0;
                if (hb.size() > 65536) return;
            }

            String headerText = new String(hb.toByteArray(), "ISO-8859-1");
            String[] lines = headerText.split("\r\n");
            String requestLine = lines.length > 0 ? lines[0] : "";
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            String path = parts[1];

            int contentLength = 0;
            for (String l : lines) {
                if (l.toLowerCase().startsWith("content-length:")) {
                    try { contentLength = Integer.parseInt(l.substring(l.indexOf(':') + 1).trim()); }
                    catch (NumberFormatException ignored) {}
                }
            }
            String body = "";
            if (contentLength > 0) {
                byte[] buf = new byte[contentLength];
                int read = 0;
                while (read < contentLength) {
                    int n = in.read(buf, read, contentLength - read);
                    if (n <= 0) break;
                    read += n;
                }
                body = new String(buf, 0, read, "UTF-8");
            }

            String resp;
            if ("/ping".equals(path)) {
                // frame_age_ms 是**副屏是否还活着**的关键信号。
                // 进程活着不代表屏还在 —— 系统会在内存压力下回收虚拟屏，
                // 而本进程察觉不到，照样报 display_id。调用方拿帧新鲜度判断：
                // 长时间不更新 = 屏已失效，应落回主屏而不是继续对着空气操作。
                resp = "{\"ok\":true,\"service\":\"vd\",\"port\":" + port
                        + ",\"display_id\":" + core.displayId()
                        + ",\"display_token\":" + core.displayToken()
                        + ",\"frame_age_ms\":" + core.frameAge() + "}";
            } else if ("/call".equals(path)) {
                resp = dispatch(body);
            } else {
                resp = "{\"ok\":false,\"error\":\"未知路径\"}";
            }
            writeJson(sock.getOutputStream(), resp);
        } catch (Throwable t) {
            VdMain.log("连接处理失败: " + t);
        } finally {
            try { sock.close(); } catch (Throwable ignored) {}
        }
    }

    private void writeJson(OutputStream out, String body) throws Exception {
        byte[] bytes = body.getBytes("UTF-8");
        String head = "HTTP/1.1 200 OK\r\n"
                + "Content-Type: application/json; charset=utf-8\r\n"
                + "Content-Length: " + bytes.length + "\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes("UTF-8"));
        out.write(bytes);
        out.flush();
    }

    /** 方法名与 CCM 桥保持一致，Node 侧一套适配代码两边通用。 */
    private String dispatch(String body) {
        try {
            org.json.JSONObject req = new org.json.JSONObject(body.isEmpty() ? "{}" : body);
            String method = req.optString("method");
            org.json.JSONObject p = req.optJSONObject("params");
            if (p == null) p = new org.json.JSONObject();

            switch (method) {
                case "mode": {
                    // 查询/切换操作模式（仿 agent-mobile-use 的 /api/mode）
                    if (p.has("mode") && !p.optString("mode").isEmpty()) {
                        core.setMode(p.optString("mode"));
                    }
                    return "{\"ok\":true,\"mode\":\"" + core.getMode() + "\","
                         + "\"target_display_id\":" + core.targetDisplayId() + "}";
                }
                case "status":
                    return "{\"ok\":true,\"mode\":\"" + core.getMode() + "\","
                         + "\"target_display_id\":" + core.targetDisplayId()
                         + ",\"display_id\":" + core.displayId()
                            + ",\"width\":" + core.displayMetrics()[0]
                            + ",\"height\":" + core.displayMetrics()[1]
                            + ",\"dpi\":" + core.displayMetrics()[2]
                            + ",\"frame_age_ms\":" + core.frameAge()
                            + ",\"frame_bytes\":" + core.latestFrame().length + "}";
                case "snapshot": {
                    String text = core.dumpTree(
                            p.optBoolean("interactive_only", true),
                            p.optInt("max_nodes", 300),
                            p.optBoolean("no_system_ui", true));
                    return "{\"ok\":true,\"text\":\"" + VdCore.esc(text) + "\"}";
                }
                case "click": {
                    boolean ok = core.tapRef(p.optString("ref"));
                    return ok ? "{\"ok\":true,\"message\":\"已点击\"}"
                              : "{\"ok\":false,\"error\":\"点击失败（id 可能已失效，重新 snapshot）\"}";
                }
                case "tap": {
                    boolean ok = core.tap(p.optInt("x"), p.optInt("y"));
                    return ok ? "{\"ok\":true,\"message\":\"已点击坐标\"}"
                              : "{\"ok\":false,\"error\":\"坐标点击失败\"}";
                }
                case "swipe": {
                    boolean ok = p.has("direction")
                            ? core.swipeDir(p.optString("direction"), p.optInt("duration", 300))
                            : core.swipe(p.optInt("x1"), p.optInt("y1"),
                                         p.optInt("x2"), p.optInt("y2"), p.optInt("duration", 300));
                    return ok ? "{\"ok\":true,\"message\":\"已滑动\"}"
                              : "{\"ok\":false,\"error\":\"滑动失败\"}";
                }
                case "key": {
                    boolean ok = core.key(p.optInt("keycode"));
                    return ok ? "{\"ok\":true,\"message\":\"已按键\"}"
                              : "{\"ok\":false,\"error\":\"按键失败\"}";
                }
                case "type":
                    return core.typeText(p.optString("text"), p.optString("target", ""));
                case "scroll": {
                    boolean ok = core.scroll(p.optString("ref", ""), p.optString("direction", "down"));
                    return ok ? "{\"ok\":true,\"message\":\"已滚动\"}"
                              : "{\"ok\":false,\"error\":\"滚动失败\"}";
                }
                case "app":
                    return core.app(p.optString("action", "launch"),
                                    p.optString("package"), p.optString("filter", ""));
                case "screenshot": {
                    byte[] frame = core.latestFrame();
                    if (frame.length == 0) {
                        return "{\"ok\":false,\"error\":\"副屏还没有画面（应用可能没启动，或刚建屏还没出帧）\"}";
                    }
                    String path = p.optString("save_path", "");
                    if (path.isEmpty()) path = "/data/local/tmp/vd-shot.jpg";
                    try {
                        java.io.File f = new java.io.File(path);
                        if (f.getParentFile() != null && !f.getParentFile().exists()) f.getParentFile().mkdirs();
                        java.io.FileOutputStream fos = new java.io.FileOutputStream(f);
                        fos.write(frame);
                        fos.close();
                        int[] m = core.displayMetrics();
                        return "{\"ok\":true,\"path\":\"" + VdCore.esc(path) + "\",\"width\":" + m[0]
                                + ",\"height\":" + m[1] + ",\"dpi\":" + m[2]
                                + ",\"source\":\"virtual_display_frame\"}";
                    } catch (Throwable t) {
                        return "{\"ok\":false,\"error\":\"写截图失败：" + VdCore.esc(String.valueOf(t)) + "\"}";
                    }
                }
                case "frameBase64": {
                    // 帧直接回 base64：跨进程读 app 私有目录麻烦，走网络最省事
                    byte[] frame = core.latestFrame();
                    if (frame.length == 0) return "{\"ok\":false,\"error\":\"副屏还没有画面\"}";
                    String b64 = android.util.Base64.encodeToString(frame, android.util.Base64.NO_WRAP);
                    int[] m = core.displayMetrics();
                    return "{\"ok\":true,\"base64\":\"" + b64 + "\",\"width\":" + m[0]
                            + ",\"height\":" + m[1] + ",\"dpi\":" + m[2] + "}";
                }
                case "displayMetrics": {
                    int[] m = core.displayMetrics();
                    return "{\"ok\":true,\"width\":" + m[0] + ",\"height\":" + m[1]
                            + ",\"dpi\":" + m[2] + "}";
                }
                default:
                    return "{\"ok\":false,\"error\":\"未知方法：" + VdCore.esc(method) + "\"}";
            }
        } catch (Throwable t) {
            return "{\"ok\":false,\"error\":\"内部错误：" + VdCore.esc(String.valueOf(t)) + "\"}";
        }
    }
}
