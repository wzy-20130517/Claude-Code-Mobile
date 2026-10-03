package vd;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.view.accessibility.AccessibilityNodeInfo;

import java.io.ByteArrayOutputStream;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 虚拟副屏核心。CLI/Web 侧（Termux）用，经 adb 起进程。
 *
 * 设计对齐 CCM 侧的 PhoneUseService（Kotlin），输出格式一致，
 * 这样 Node 侧一套适配代码两边通用。
 */
public class VdCore {

    private VirtualDisplay display;
    private ImageReader reader;
    private byte[] frameJpeg = new byte[0];
    private long frameAt = 0L;
    private final Object frameLock = new Object();
    private final AtomicBoolean encoding = new AtomicBoolean(false);
    private long lastFrameAt = 0L;
    private static final long FRAME_MIN_INTERVAL_MS = 66;

    /**
     * 节点名（text/desc）的最长输出。
     *
     * 【为什么不是随便砍一刀】agent-mobile-use 那边有实测记录：
     * URL 查询参数、订单号、取件码都长在**尾巴**上 —— 一条聊天消息的链接
     * 结尾是 ...?orderId=xyz，按 140 从头部截断后 id 丢了，而 truncated 还报 0
     *（它以为自己没截）。所以截断必须**保头也保尾**，中间用标记说明丢了多少。
     *
     * 4000 是一道「灾难墙」而不是常规预算：实测 8 个富文本界面（知乎/微信/淘宝/
     * 美团/QQ/百科/新闻流），最长的真实字段 311 字符。所以正常内容永远碰不到这个上限，
     * 只有病态节点（整章小说、日志页）才会被截，不会一个节点吃掉整屏预算。
     */
    private static final int MAX_FIELD_CHARS = 4000;
    /** 尾部保留长度，够放一个 URL 查询串。 */
    private static final int FIELD_TAIL_CHARS = 160;
    /** 头部保留长度（扣掉中间那个 [cut:N] 标记的位数）。 */
    private static final int FIELD_HEAD_CHARS = MAX_FIELD_CHARS - FIELD_TAIL_CHARS - 22;

    private volatile int dispW = 0, dispH = 0, dispDpi = 0;

    /**
     * 操作模式 —— 仿 agent-mobile-use 的 /api/mode 设计：
     *   foreground —— 操作**主屏**（display 0）。用户看得见 AI 在干什么，
     *                 但要占用屏幕，会打扰用户。
     *   background —— 操作**虚拟副屏**（默认）。静默跑，不占物理屏，
     *                 用户该干嘛干嘛。代价是副屏渲染可能和真机略有差异。
     *   idle       —— 不操作任何屏（暂停状态）。
     *
     * ⚠️ 关键：**不是无条件用副屏**。所有操作都经 targetDisplayId() 取目标屏，
     * 用户选什么模式就走哪个屏。这是 agent-mobile-use 的核心设计，别丢。
     */
    private volatile String mode = "background";

    public String getMode() { return mode; }

    public String setMode(String m) {
        String lower = m == null ? "" : m.trim().toLowerCase();
        if (lower.equals("foreground") || lower.equals("fg") || lower.equals("0")) {
            mode = "foreground";
        } else if (lower.equals("idle") || lower.equals("standby") || lower.equals("none") || lower.equals("-1")) {
            mode = "idle";
        } else {
            mode = "background";
        }
        VdMain.log("模式切换为 " + mode + "（目标屏 " + targetDisplayId() + "）");
        return mode;
    }

    /**
     * 当前操作的目标 displayId。
     * foreground → 0（主屏）；idle → -1（不操作）；background → 副屏 id。
     */
    public int targetDisplayId() {
        String m = mode;
        if (m.equals("foreground")) return 0;
        if (m.equals("idle")) return -1;
        return displayId();
    }

    /** id → 节点。点击用中心坐标，输入要节点本身。 */
    private final Map<String, Entry> refTable = new HashMap<>();

    private static class Entry {
        final int cx, cy;
        final AccessibilityNodeInfo raw;
        final boolean editable;
        Entry(int cx, int cy, AccessibilityNodeInfo raw, boolean editable) {
            this.cx = cx; this.cy = cy; this.raw = raw; this.editable = editable;
        }
    }

    private Object uiAutomation;
    private Class<?> uiClass;
    private HandlerThread uiThread;

    /** 应用 Context（构造时存下，dumpTree 里探测屏幕状态要用） */
    private final Context appCtx;

    public VdCore(Context ctx) throws Exception {
        this.appCtx = ctx;
        startDisplay(ctx);
    }

    public int displayId() {
        try { return display == null ? -1 : display.getDisplay().getDisplayId(); }
        catch (Throwable t) { return -1; }
    }

    public int[] displayMetrics() { return new int[]{dispW, dispH, dispDpi}; }

    /**
     * 这个虚拟屏在 **SurfaceFlinger** 里的 display token。
     *
     * 【为什么需要它】`screencap -d <id>` 要的不是 DisplayManager 的 displayId，
     * 而是 SurfaceFlinger 的 display token —— 两者是**两套编号**：
     *   DisplayManager 报：displayId = 26
     *   SurfaceFlinger 报：Display 11529215049690880960 (Virtual display)
     * 用 26 去截屏会得到 "Display Id '26' is not valid"，用后者才拿得到图。
     * （2026-09-26 实测确认。）
     *
     * 拿法：Display.getAddress() 返回的就是那个 token（Android 的 IComposerClient
     * 层用它标识物理/虚拟屏）。取不到就返回 -1，调用方落回主屏。
     */
    public long displayToken() {
        try {
            if (display == null) return -1L;
            android.view.Display d = display.getDisplay();
            if (d == null) return -1L;
            java.lang.reflect.Method m = android.view.Display.class.getMethod("getAddress");
            Object v = m.invoke(d);
            return v instanceof Number ? ((Number) v).longValue() : -1L;
        } catch (Throwable t) {
            return -1L;
        }
    }

    // ── 帧缓存 ────────────────────────────────────────────

    /** 副屏最新帧的 JPEG。守护侧一直在更新，取的时候几乎零等待（~60ms vs screencap ~1.8s）。 */
    public byte[] latestFrame() { synchronized (frameLock) { return frameJpeg; } }

    private long frameAgeMs() { return frameAt > 0 ? System.currentTimeMillis() - frameAt : -1; }

    // ── 元素树 ────────────────────────────────────────────

    /**
     * 平铺式元素树。输出格式与 CCM 侧完全一致：
     *   首行状态 · 次行列头 · 之后一行一元素（#id type name 坐标 flags）
     */
    public String dumpTree(boolean interactiveOnly, int maxNodes, boolean noSystemUi) {
        // ⚠️ 用 targetDisplayId() 而不是 displayId()。
        //
        // displayId() 永远是**副屏自己的 id** —— 之前这里写死它，导致
        // foreground 模式（应该读主屏 0）也在读副屏，而副屏上没有用户的应用，
        // 于是 snapshot 永远返回「副屏上暂时没有可交互元素」。
        // 目标屏由模式决定，读树和点击/输入必须用同一个来源，否则会读 A 屏点 B 屏。
        int id = targetDisplayId();
        if (id < 0) return "错误：当前模式不操作手机（idle）";
        VdMain.log("dumpTree: displayId=" + id);


        List<Object> windows = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            windows = windowsOnDisplay();
            if (windows != null && !windows.isEmpty()) break;
            try { Thread.sleep(350); } catch (InterruptedException e) { break; }
        }
        if (windows == null) {
            // UiAutomation 在纯 app_process 进程里 connect() 会被系统 kill
            //（AccessibilityManagerService 等不到窗口就绪信号，超时后杀进程）。
            // 这不是 bug，是这种进程身份的限制 —— 所以这里不报「错误」而是
            // 明确告诉调用方改走 dumpsys（CLI/Web 侧本来就有成熟的解析实现）。
            return "ui_unavailable: 这个进程不支持 UiAutomation（app_process 起的进程"
                 + "在 connect() 时会被系统杀掉）。请改用 dumpsys 读界面："
                 + "adb shell dumpsys activity top（可按 display 过滤）。"
                 + "副屏的建屏/截图/input 不受影响，仍可用。";
        }
        if (windows.isEmpty()) return "display=" + id + " 副屏上没有窗口（应用还没起来）";

        List<Row> rows = new ArrayList<>();
        int seq = 0;
        for (Object w : windows) {
            AccessibilityNodeInfo root = null;
            Throwable rootErr = null;
            try { root = (AccessibilityNodeInfo) w.getClass().getMethod("getRoot").invoke(w); }
            catch (Throwable t) { rootErr = t; }
            // 【诊断 2026-09-26】窗口有但元素树空 —— 必须区分三种情况：
            //   ① getRoot() 抛异常（反射失败 / 权限）
            //   ② getRoot() 返回 null（窗口还没准备好，或不是 a11y 窗口）
            //   ③ root 拿到了但被 isSystemWindow 滤掉
            // 不打日志的话三种都表现成「没有可交互元素」，完全无从下手。
            if (root == null) {
                VdMain.log("  窗口 " + winTitle(w) + " root=null"
                        + (rootErr != null ? " (异常: " + rootErr + ")" : ""));
                continue;
            }
            String wpkg = "";
            try { wpkg = root.getPackageName() == null ? "" : root.getPackageName().toString(); } catch (Throwable ignored) {}
            if (noSystemUi && isSystemWindow(w, root)) {
                VdMain.log("  窗口 " + winTitle(w) + " pkg=" + wpkg + " 被判为系统 UI，跳过");
                continue;
            }
            int before = rows.size();
            seq = walk(root, rows, seq, 0, interactiveOnly);
            VdMain.log("  窗口 " + winTitle(w) + " → 采到 " + (rows.size() - before) + " 个元素");
        }
        if (rows.isEmpty()) {
            // 【空结果的诊断 —— 2026-09-26】
            //
            // 原来只说「暂时没有可交互元素」，模型和用户都无从判断
            // 「应用还没起来」/「屏幕息了」/「真的就是空界面」。
            // 实测发现最常见的空结果是**息屏**导致的（Doze 下系统暂停
            // 虚拟屏合成、不给窗口分配 Surface），所以这里主动探测一次
            // 屏幕状态，把原因直接写进返回值。
            boolean screenOn = true;
            try {
                Object pm = appCtx.getSystemService(Context.POWER_SERVICE);
                screenOn = (Boolean) pm.getClass().getMethod("isInteractive").invoke(pm);
            } catch (Throwable ignored) {}
            if (!screenOn) {
                return "display=" + id + " 屏幕已关闭（息屏）—— Android 在息屏时暂停虚拟屏合成，"
                     + "应用窗口不会创建 Surface，所以读不到元素。\n"
                     + "请点亮屏幕后重试（点亮即可，不用解锁）。\n"
                     + "这是系统省电机制，不是故障。";
            }
            return "display=" + id + " 副屏上没有可交互元素（界面可能是纯展示页、"
                 + "或应用还在启动中）。可先用 phone_screenshot 看画面确认。";
        }

        // 按有用程度排序（同 CCM 侧）：真元素 > 空壳容器 > 不可见 > 禁用 > 纯展示
        final Map<Row, Integer> prio = new HashMap<>();
        for (Row r : rows) prio.put(r, priorityOf(r));
        rows.sort((a, b) -> {
            int pa = prio.get(a), pb = prio.get(b);
            if (pa != pb) return pa - pb;
            int ca = a.clickable ? 0 : 1, cb = b.clickable ? 0 : 1;
            if (ca != cb) return ca - cb;
            return a.seq - b.seq;
        });

        int total = rows.size();
        int cap = Math.max(1, maxNodes);
        List<Row> capped = rows.subList(0, Math.min(cap, total));

        synchronized (refTable) {
            refTable.clear();
            for (Row r : capped) refTable.put(r.id, new Entry(r.cx, r.cy, r.raw, r.editable));
        }

        // 无损记账：整棵树里有多少可点击元素、实际发了多少。
        // 只报「截断了」不够 —— 模型没法知道丢的是不是它能点的东西。
        // 两个隔几秒的 dump 对比也答不了（界面一直在变），必须当场算。
        int actTotal = 0, actSent = 0;
        for (Row r : rows) if (r.clickable || r.editable) actTotal++;
        for (Row r : capped) if (r.clickable || r.editable) actSent++;

        StringBuilder sb = new StringBuilder();
        sb.append("# display=").append(id).append(' ').append(dispW).append('x').append(dispH);
        sb.append(" count=").append(capped.size());
        if (total > capped.size()) {
            sb.append(" truncated=1 total=").append(total);
            sb.append(" omitted=").append(total - capped.size());
            sb.append(" actionable_sent=").append(actSent).append('/').append(actTotal);
            if (actSent < actTotal) sb.append(" (!)");
        }
        sb.append('\n');
        sb.append("# 一行一元素：id type name x1,y1,x2,y2 flags");
        sb.append(" | flags: c=可点 e=可输入 s=可滚 k+=选中 k-=未选 off=禁用 focus=聚焦 dN=深度\n");
        sb.append("# 元素已按有用程度排序（能点、有名字的在前），从上往下读就是推荐顺序\n");
        for (Row r : capped) {
            sb.append('#').append(r.id).append(' ').append(r.cls).append(' ');
            // 名称加引号 —— 与 Node 侧 dumpsys 路径的渲染格式统一。
            // 原来裸写（`TextView 搜索系统设置项`），模型无法区分
            // 「这是元素名」还是「这是又一个字段」，也难用 grep 抓。
            // 无名称时用 (无名称) 占位，保持列数一致便于扫读。
            sb.append(r.name.isEmpty() ? "(无名称)" : '"' + r.name + '"').append(' ');
            sb.append(r.x1).append(',').append(r.y1).append(',')
              .append(r.x2).append(',').append(r.y2).append(' ');
            if (r.clickable) sb.append("c ");
            if (r.editable) sb.append("e ");
            if (r.scrollable) sb.append("s ");
            if (r.checked) sb.append("k+ ");
            if (r.focused) sb.append("focus ");
            if (!r.enabled) sb.append("off ");
            if (!r.visible) sb.append("gone ");
            sb.append("d").append(r.depth).append(' ');
            if (!r.resId.isEmpty()) sb.append("id=").append(r.resId.substring(r.resId.lastIndexOf('/') + 1)).append(' ');
            sb.append('\n');
        }
        return sb.toString();
    }

    private static class Row {
        String id, cls, name, resId;
        int x1, y1, x2, y2, cx, cy, seq, depth;
        AccessibilityNodeInfo raw;
        boolean clickable, editable, scrollable, checked, focused, enabled, visible;
    }

    private int walk(AccessibilityNodeInfo node, List<Row> out, int seq, int depth, boolean interactiveOnly) {
        if (depth > 40 || out.size() >= 1500) return seq;
        Rect r = new Rect();
        try { node.getBoundsInScreen(r); } catch (Throwable t) { return seq; }

        boolean visible = true, clickable = false, editable = false, scrollable = false;
        boolean checked = false, focused = false, enabled = true;
        String text = "", desc = "", resId = "", cls = "";
        try { visible = node.isVisibleToUser(); } catch (Throwable ignored) {}
        try { clickable = node.isClickable(); } catch (Throwable ignored) {}
        try { editable = node.isEditable(); } catch (Throwable ignored) {}
        try { scrollable = node.isScrollable(); } catch (Throwable ignored) {}
        try { checked = node.isChecked(); } catch (Throwable ignored) {}
        try { focused = node.isFocused(); } catch (Throwable ignored) {}
        try { enabled = node.isEnabled(); } catch (Throwable ignored) {}
        try { text = node.getText() == null ? "" : node.getText().toString(); } catch (Throwable ignored) {}
        try { desc = node.getContentDescription() == null ? "" : node.getContentDescription().toString(); } catch (Throwable ignored) {}
        try { resId = node.getViewIdResourceName() == null ? "" : node.getViewIdResourceName(); } catch (Throwable ignored) {}
        try { cls = node.getClassName() == null ? "" : node.getClassName().toString(); } catch (Throwable ignored) {}

        String name = clip(text.isEmpty() ? desc : text);
        if (cls.contains(".")) cls = cls.substring(cls.lastIndexOf('.') + 1);

        // 【2026-09-26 给「空容器」补子节点文本】
        //
        // 实测症状（设置页）：前 9 行全是
        //   #e2 LinearLayout (无名称) 39,562,1241,790 c d12
        //   #e3 LinearLayout (无名称) 39,790,1241,972 c d12
        // 它们是列表项容器（整行可点），但**自己的 text/desc 都是空** ——
        // 文本在子节点上（TextView "WLAN"）。模型完全无法判断哪个是什么。
        //
        // 反过来，如果直接把这些空容器过滤掉（第一版改法），
        // 15 个元素会掉到 3 个 —— 因为设置页的**每个列表项**都是这种结构，
        // 全被砍光，用户要点的东西反而没了。
        //
        // 正确做法：**保留它，但把子孙里第一段非空文本摘出来当名字**。
        // 这样 `LinearLayout` 变成 `LinearLayout "WLAN"`，既能认又能点。
        if (name.isEmpty() && (clickable || editable)) {
            String sub = firstTextInSubtree(node, 3);
            if (!sub.isEmpty()) name = clip(sub);
        }

        boolean take = interactiveOnly
                ? (clickable || editable || scrollable)
                : (clickable || editable || scrollable || !name.isEmpty());

        // 兜底过滤：连子孙文本都找不到的空容器才丢掉
        // （scrollable / editable 永远保留 —— 能滚能输入就有用）
        boolean emptyContainer = clickable && name.isEmpty() && resId.isEmpty()
                && !scrollable && !editable;
        if (emptyContainer) take = false;

        if (take && r.width() > 0 && r.height() > 0 && visible) {
            Row row = new Row();
            row.id = "e" + seq;
            row.raw = node;
            row.seq = seq;
            row.depth = depth;
            row.cls = cls;
            row.name = name;
            row.resId = resId;
            row.x1 = r.left; row.y1 = r.top; row.x2 = r.right; row.y2 = r.bottom;
            row.cx = (r.left + r.right) / 2; row.cy = (r.top + r.bottom) / 2;
            row.clickable = clickable; row.editable = editable; row.scrollable = scrollable;
            row.checked = checked; row.focused = focused; row.enabled = enabled; row.visible = visible;
            out.add(row);
            seq++;
        }

        int n = 0;
        try { n = node.getChildCount(); } catch (Throwable ignored) {}
        for (int i = 0; i < n; i++) {
            if (out.size() >= 1500) break;
            AccessibilityNodeInfo ch = null;
            try { ch = node.getChild(i); } catch (Throwable ignored) {}
            if (ch == null) continue;
            seq = walk(ch, out, seq, depth + 1, interactiveOnly);
        }
        return seq;
    }

    /**
     * 在子树里找第一段非空文本（用于给「空容器」补名字）。
     *
     * 【为什么需要】列表项容器（LinearLayout）自己的 text/desc 是空的，
     * 真正的文字在子节点上。不给它补名字，模型看到的就是
     * `LinearLayout (无名称) 39,562,1241,790` —— 完全不知道是什么。
     *
     * 【深度限制 3 层】设置页的列表项结构通常是
     *   LinearLayout > RelativeLayout > TextView
     * 3 层够覆盖绝大多数；再深容易摘到不相关的东西（比如整页容器的
     * 第一个子孙恰好是顶部标题）。
     *
     * 【优先 getText 再 getContentDescription】与主 walk 一致：
     * text 是给人看的文字，desc 是给无障碍的说明，前者更直观。
     */
    private String firstTextInSubtree(AccessibilityNodeInfo node, int maxDepth) {
        if (node == null || maxDepth < 0) return "";
        try {
            int n = node.getChildCount();
            for (int i = 0; i < n; i++) {
                AccessibilityNodeInfo ch = null;
                try { ch = node.getChild(i); } catch (Throwable ignored) {}
                if (ch == null) continue;
                String t = "";
                try { t = ch.getText() == null ? "" : ch.getText().toString(); } catch (Throwable ignored) {}
                if (t.isEmpty()) {
                    try { t = ch.getContentDescription() == null ? "" : ch.getContentDescription().toString(); } catch (Throwable ignored) {}
                }
                if (!t.isEmpty() && !t.trim().isEmpty()) return t.trim();
                // 本层没有就往下找
                String deeper = firstTextInSubtree(ch, maxDepth - 1);
                if (!deeper.isEmpty()) return deeper;
            }
        } catch (Throwable ignored) {}
        return "";
    }

    private int priorityOf(Row n) {
        boolean interactive = n.clickable || n.editable;
        if (!interactive) return n.visible ? 8 : 9;
        if (!n.enabled) return 7;
        if (!n.visible) return 6;
        // 【2026-09-26 细化】原来只有「有名字/有id = 0，都没有 = 1」两档，
        // 于是 `FrameLayout id=header_view`（有 id、纯容器、没用）和
        // `TextView "搜索系统设置项"`（有真文本、才是要找的）**同档**，
        // 排序退化成按 seq（树的遍历顺序）→ 容器永远在前。
        //
        // 实测症状：问「设置页有什么」，前 9 行全是 `LinearLayout (无名称)`
        // 和 `FrameLayout (无名称) id=xxx`，真正有文本的元素被挤到后面，
        // 而模型通常只看前十几行。
        //
        // 新分档（数字越小越靠前）：
        //   0 有文本（name 非空）    ← 最有用：能直接读懂是什么
        //   1 可输入（editable）     ← 输入框通常也带 name，但兜底
        //   2 有 id 无文本           ← 可能是按钮（id=btn_ok），有一定价值
        //   3 什么都没有的可点元素   ← 纯容器，最没用
        if (!n.name.isEmpty()) return 0;
        if (n.editable) return 1;
        if (!n.resId.isEmpty()) return 2;
        return 3;
    }

    /** 取窗口标题（诊断用，失败返回 ?） */
    private String winTitle(Object win) {
        try { return String.valueOf(win.getClass().getMethod("getTitle").invoke(win)); }
        catch (Throwable t) { return "?"; }
    }

    private boolean isSystemWindow(Object win, AccessibilityNodeInfo root) {
        String pkg = "";
        try { pkg = root.getPackageName() == null ? "" : root.getPackageName().toString(); } catch (Throwable ignored) {}
        if ("com.android.systemui".equals(pkg)) return true;
        String title = "";
        try { title = String.valueOf(win.getClass().getMethod("getTitle").invoke(win)); } catch (Throwable ignored) {}
        String t = title.toLowerCase();
        return t.contains("statusbar") || t.contains("navigationbar")
                || t.contains("inputmethod") || t.contains("ime");
    }

    // ── 输入 ──────────────────────────────────────────────

    public boolean tapRef(String ref) {
        Entry e;
        synchronized (refTable) { e = refTable.get(ref); }
        if (e == null) return false;
        return tap(e.cx, e.cy);
    }

    public boolean tap(int x, int y) { return input("tap", String.valueOf(x), String.valueOf(y)); }

    public boolean swipe(int x1, int y1, int x2, int y2, int dur) {
        return input("swipe", String.valueOf(x1), String.valueOf(y1),
                String.valueOf(x2), String.valueOf(y2), String.valueOf(dur));
    }

    public boolean swipeDir(String dir, int dur) {
        if (dispW <= 0 || dispH <= 0) return false;
        int cx = dispW / 2, cy = dispH / 2, d = dispH / 4;
        int[] p;
        switch (dir.toLowerCase()) {
            case "up":    p = new int[]{cx, cy + d, cx, cy - d}; break;
            case "down":  p = new int[]{cx, cy - d, cx, cy + d}; break;
            case "left":  p = new int[]{cx + d, cy, cx - d, cy}; break;
            case "right": p = new int[]{cx - d, cy, cx + d, cy}; break;
            default: return false;
        }
        return swipe(p[0], p[1], p[2], p[3], dur);
    }

    public boolean key(int keyCode) { return input("keyevent", String.valueOf(keyCode)); }

    public boolean scroll(String ref, String dir) {
        if (ref != null && !ref.isEmpty()) {
            Entry e;
            synchronized (refTable) { e = refTable.get(ref); }
            if (e != null && e.raw != null) {
                try {
                    if (e.raw.isScrollable()) {
                        int action = dir.equalsIgnoreCase("up")
                                ? AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
                                : AccessibilityNodeInfo.ACTION_SCROLL_FORWARD;
                        if (e.raw.performAction(action)) return true;
                    }
                } catch (Throwable ignored) {}
            }
        }
        return swipeDir(dir.equalsIgnoreCase("up") ? "down" : "up", 300);
    }

    /**
     * 文字注入。双轨定位 + 回读校验，对齐 CCM 侧：
     *   target 空 = 当前焦点框；target=e12/12 = dump 里的节点
     * 失败分类明确，不退回坐标点击（那会把「定位错」变成「在别处误操作」）。
     */
    public String typeText(String text, String target) {
        StringBuilder sb = new StringBuilder("{\"ok\":false,\"mode\":\"none\",\"verified\":false");
        try {
            if (ui() == null) return sb.append(",\"error\":\"ui_unavailable\"}").toString();

            AccessibilityNodeInfo node = null;
            boolean focusMode = target == null || target.trim().isEmpty()
                    || target.trim().equalsIgnoreCase("focused");

            if (focusMode) {
                node = findFocusedEditable();
                if (node == null) {
                    AccessibilityNodeInfo any = findFocusedAny();
                    sb.append(",\"error\":\"no_focused_input\"");
                    sb.append(",\"focus_hint\":\"").append(any == null ? "nothing" : rectOf(any)).append('"');
                    sb.append(",\"reason\":\"没有获得焦点的输入框。先点击输入框再输入。\"}");
                    return sb.toString();
                }
            } else {
                String clean = target.trim();
                if (clean.startsWith("node:")) clean = clean.substring(5).trim();
                if (clean.startsWith("e")) clean = clean.substring(1);
                int id;
                try { id = Integer.parseInt(clean); }
                catch (NumberFormatException nfe) {
                    return sb.append(",\"error\":\"invalid_target\"")
                            .append(",\"reason\":\"target 只能是 dump 里的节点 id（如 e12 或 12）\"}").toString();
                }
                Entry e;
                synchronized (refTable) { e = refTable.get("e" + id); }
                if (e == null) {
                    return sb.append(",\"error\":\"target_not_found\"")
                            .append(",\"reason\":\"节点 e").append(id)
                            .append(" 不在上次 dump 里（界面可能已刷新）\"}").toString();
                }
                if (e.raw == null) {
                    return sb.append(",\"error\":\"target_stale\"")
                            .append(",\"reason\":\"节点 e").append(id).append(" 已失效，重新 snapshot\"}").toString();
                }
                boolean isEd = false;
                try { isEd = e.raw.isEditable(); } catch (Throwable ignored) {}
                node = isEd ? e.raw : findEditable(e.raw);
                if (node == null) {
                    return sb.append(",\"error\":\"target_not_editable\"")
                            .append(",\"reason\":\"节点 e").append(id).append(" 及其子节点都不是输入框\"}").toString();
                }
            }

            String before = null;
            try { before = node.getText() == null ? null : node.getText().toString(); } catch (Throwable ignored) {}

            boolean ok;
            try {
                Bundle args = new Bundle();
                args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
                ok = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
            } catch (Throwable t) {
                return sb.append(",\"error\":\"internal_error\",\"reason\":\"")
                        .append(esc(String.valueOf(t))).append("\"}").toString();
            }
            if (!ok) {
                return sb.append(",\"error\":\"inject_rejected\"")
                        .append(",\"reason\":\"ACTION_SET_TEXT 被拒绝（只读或已失效）\"}").toString();
            }

            String after = null;
            try { after = node.getText() == null ? null : node.getText().toString(); } catch (Throwable ignored) {}

            sb.append(",\"mode\":\"").append(focusMode ? "focused" : "node").append('"');
            sb.append(",\"before_text\":\"").append(esc(before == null ? "" : before)).append('"');
            if (after == null) {
                sb.append(",\"ok\":true,\"verified\":false,\"error\":\"verify_unavailable\"")
                  .append(",\"reason\":\"已写入但读不回\"}");
            } else if (after.equals(text)) {
                sb.append(",\"ok\":true,\"verified\":true,\"verified_text\":\"").append(esc(after)).append("\"}");
            } else {
                sb.append(",\"ok\":true,\"verified\":false,\"error\":\"verify_mismatch\"")
                  .append(",\"verified_text\":\"").append(esc(after))
                  .append("\",\"reason\":\"回读与写入不一致（输入法过滤或字段限制）\"}");
            }
            return sb.toString();
        } catch (Throwable t) {
            return sb.append(",\"error\":\"internal_error\",\"reason\":\"").append(esc(String.valueOf(t))).append("\"}").toString();
        }
    }

    private String rectOf(AccessibilityNodeInfo n) {
        Rect r = new Rect();
        try { n.getBoundsInScreen(r); return r.left + "," + r.top + "," + r.right + "," + r.bottom; }
        catch (Throwable t) { return "?,?,?,?"; }
    }

    /**
     * 超出上限时保头 + 保尾，中间标注丢了多少字符。
     * 不这样做会丢掉 URL 参数/订单号/取件码这类只出现在末尾的关键信息。
     */
    static String clip(String s) {
        if (s == null) return "";
        if (s.length() <= MAX_FIELD_CHARS) return s;
        int dropped = s.length() - FIELD_HEAD_CHARS - FIELD_TAIL_CHARS;
        return s.substring(0, FIELD_HEAD_CHARS)
                + "...[cut:" + dropped + "]..."
                + s.substring(s.length() - FIELD_TAIL_CHARS);
    }

    static String esc(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r");
    }

    // ── 应用 ──────────────────────────────────────────────

    /**
     * 应用操作。launch 三分支（对齐 agent-mobile-use）：
     * 已在副屏 → 不动；在别的屏 → move-stack 平滑搬运；没在跑 → am start --display。
     */
    public String app(String action, String pkg, String filter) {
        try {
            if ("list".equalsIgnoreCase(action)) {
                String out = shell("pm list packages 2>/dev/null");
                StringBuilder arr = new StringBuilder();
                int count = 0;
                for (String line : out.split("\n")) {
                    String p = line.replace("package:", "").trim();
                    if (p.isEmpty()) continue;
                    if (!filter.isEmpty() && !p.toLowerCase().contains(filter.toLowerCase())) continue;
                    if (count++ > 0) arr.append(',');
                    arr.append('"').append(p).append('"');
                }
                return "{\"ok\":true,\"count\":" + count + ",\"apps\":[" + arr + "]}";
            }
            if ("current".equalsIgnoreCase(action)) {
                String out = shell("dumpsys window 2>/dev/null | grep -E 'mCurrentFocus' | head -1");
                java.util.regex.Matcher m = java.util.regex.Pattern
                        .compile("u\\d+\\s+([\\w.]+)/").matcher(out);
                String p = m.find() ? m.group(1) : "";
                return "{\"ok\":" + (!p.isEmpty()) + ",\"package\":\"" + p + "\"}";
            }
            if ("launch".equalsIgnoreCase(action)) {
                if (pkg.isEmpty()) return "{\"ok\":false,\"error\":\"缺少 package\"}";
                return launchOnDisplay(pkg);
            }
            return "{\"ok\":false,\"error\":\"未知 action: " + action + "\"}";
        } catch (Throwable t) {
            return "{\"ok\":false,\"error\":\"" + esc(String.valueOf(t)) + "\"}";
        }
    }

    /** 当前模式的自然语言名字，用在提示里（别写死「副屏」——foreground 时是主屏）。 */
    private String whereName() {
        String m = mode;
        if (m.equals("foreground")) return "主屏";
        if (m.equals("idle")) return "（idle，不该走到这里）";
        return "副屏";
    }

    private String launchOnDisplay(String pkg) {
        // 目标屏同样由模式决定：foreground 模式下就在主屏启动，不改用户当前界面之外的屏
        int id = targetDisplayId();
        if (id < 0) return "{\"ok\":false,\"error\":\"idle 模式下不启动应用（先 /device mode background 或 foreground）\"}";

        int[] stack = findStackOfPackage(pkg);
        if (stack != null) {
            if (stack[1] == id) {
                return "{\"ok\":true,\"message\":\"" + pkg + " 已在" + whereName() + "运行\",\"display_id\":" + id
                        + ",\"already\":true}";
            }
            String mv = shell("cmd activity display move-stack " + stack[0] + " " + id + " 2>&1; echo \"__exit=$?\"");
            if (mv.contains("__exit=0")) {
                return "{\"ok\":true,\"message\":\"已把 " + pkg + " 从 display " + stack[1]
                        + " 平滑移到" + whereName() + "（未重启）\",\"display_id\":" + id + ",\"moved\":true}";
            }
        }

        // 不要用 monkey：不支持 --display（会在主屏起），且不主动退出会挂住
        String out = shell("am start --display " + id + " --user 0 -a android.intent.action.MAIN "
                + "-c android.intent.category.LAUNCHER -p " + pkg + " 2>&1; echo \"__exit=$?\"");
        boolean started = out.contains("Starting: Intent") || out.contains("Status: ok");
        if (!out.contains("__exit=0") || !started) {
            String first = "";
            for (String l : out.split("\n")) {
                if (!l.trim().isEmpty() && !l.startsWith("Warning")) { first = l; break; }
            }
            return "{\"ok\":false,\"error\":\"在" + whereName() + "启动 " + pkg + " 失败：" + esc(first) + "\"}";
        }
        return "{\"ok\":true,\"message\":\"已在" + whereName() + "启动 " + pkg + "\",\"display_id\":" + id + "}";
    }

    /** 找包所在的 activity stack，返回 [stackId, displayId]，找不到 null。 */
    private int[] findStackOfPackage(String pkg) {
        String out = shell("dumpsys activity activities 2>/dev/null | grep -E 'RootTask id=|mResumedActivity|topResumedActivity' | head -120");
        int curStack = -1, curDisplay = -1;
        for (String line : out.split("\n")) {
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("RootTask id=(\\d+) displayId=(-?\\d+)").matcher(line);
            if (m.find()) {
                curStack = Integer.parseInt(m.group(1));
                curDisplay = Integer.parseInt(m.group(2));
                continue;
            }
            if (curStack >= 0 && line.contains(pkg)) return new int[]{curStack, curDisplay};
        }
        return null;
    }

    // ── shell ─────────────────────────────────────────────

    public String shell(String cmd) {
        return shell(cmd, 15000);
    }

    public String shell(String cmd, int timeoutMs) {
        try {
            Process p = new ProcessBuilder("/system/bin/sh", "-c", cmd)
                    .redirectErrorStream(true).start();
            final StringBuilder out = new StringBuilder();
            Thread rt = new Thread(() -> {
                try {
                    byte[] buf = new byte[8192];
                    java.io.InputStream in = p.getInputStream();
                    int n;
                    while ((n = in.read(buf)) > 0) out.append(new String(buf, 0, n));
                } catch (Throwable ignored) {}
            });
            rt.setDaemon(true);
            rt.start();
            if (!p.waitFor(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)) {
                p.destroyForcibly();
                return "命令超时";
            }
            rt.join(800);
            return out.toString();
        } catch (Throwable t) {
            return "执行失败: " + t;
        }
    }

    // ── UiAutomation ──────────────────────────────────────

    /**
     * UiAutomation 单例。
     *
     * ⚠️ 在纯 app_process 进程里 connect() 会被系统 SIGKILL
     * （AccessibilityManagerService 等窗口就绪信号超时后杀进程）。
     * 所以加一个开关：启动时可以用 -Duiautomation=0 显式关掉，
     * 避免一次误调用就把整个副屏进程带走。
     * 默认仍然尝试（在自己能控制的场景下它是有用的）。
     */
    private static final boolean UIA_ENABLED =
            !"0".equals(System.getProperty("uiautomation"));

    private Object ui() {
        if (!UIA_ENABLED) return null;
        if (uiAutomation != null) return uiAutomation;
        try {
            VdMain.log("ui(): 开始建立 UiAutomation");
            // ⚠️ 必须用**主 Looper**，不能自己开 HandlerThread。
            //
            // AOSP 里 UiAutomationService 的构造函数明确检查这一点：
            //   final boolean isMainHandler = mainHandler.getLooper() == Looper.getMainLooper();
            //   if (IS_USERDEBUG) Preconditions.checkArgument(isMainHandler, "must use the main handler");
            // 而且服务端 connectServiceUnknownThread() 是往这个 handler **post** 回调的 ——
            // 传了别的 Looper，回调就投递不到，客户端等到 CONNECT_TIMEOUT_MILLIS(5s) 抛异常。
            //
            // 官方入口也印证：UiAutomation(Context, IUiAutomationConnection) 内部就是
            // `this(displayId, context.getMainLooper(), connection)`。
            //
            // 所以进程启动时先把主 Looper prepare 好（VdMain.main 里做了），这里直接用。
            android.os.Looper mainLooper = android.os.Looper.getMainLooper();
            if (mainLooper == null) {
                // 没有主 Looper 就先建一个（不该发生 —— VdMain 里 prepare 过了）
                android.os.Looper.prepareMainLooper();
                mainLooper = android.os.Looper.getMainLooper();
            }
            Class<?> uacClass = Class.forName("android.app.UiAutomationConnection");
            Object uac = uacClass.getConstructor().newInstance();
            Class<?> cls = Class.forName("android.app.UiAutomation");
            Class<?> iuac = Class.forName("android.app.IUiAutomationConnection");
            Object inst = cls.getConstructor(android.os.Looper.class, iuac).newInstance(mainLooper, uac);
            VdMain.log("ui(): 构造完成，准备 connect");
            try { cls.getMethod("connect", int.class).invoke(inst, 0); }
            catch (NoSuchMethodException e) { cls.getMethod("connect").invoke(inst); }
            VdMain.log("ui(): connect 完成");

            android.accessibilityservice.AccessibilityServiceInfo info =
                    new android.accessibilityservice.AccessibilityServiceInfo();
            info.eventTypes = -1;
            info.feedbackType = 16;
            // INCLUDE_NOT_IMPORTANT_VIEWS | REPORT_VIEW_IDS | RETRIEVE_INTERACTIVE_WINDOWS
            info.flags = 0x2 | 0x10 | 0x40;
            cls.getMethod("setServiceInfo", android.accessibilityservice.AccessibilityServiceInfo.class)
                    .invoke(inst, info);

            VdMain.log("ui(): setServiceInfo 完成");
            uiClass = cls;
            uiAutomation = inst;
            return inst;
        } catch (Throwable t) {
            VdMain.log("UiAutomation 连接失败: " + t);
            return null;
        }
    }

    private List<Object> windowsOnDisplay() {
        Object ui = ui();
        if (ui == null) return null;
        // 同 dumpTree：按**当前目标屏**取窗口，不是永远取副屏。
        // foreground(0) 时这里取的就是主屏的窗口 → 能读到用户正在用的应用。
        int id = targetDisplayId();
        if (id < 0) return null;
        try {
            Object map = uiClass.getMethod("getWindowsOnAllDisplays").invoke(ui);
            if (map == null) return null;
            int size = (Integer) map.getClass().getMethod("size").invoke(map);
            Method keyAt = map.getClass().getMethod("keyAt", int.class);
            Method valueAt = map.getClass().getMethod("valueAt", int.class);
            // 【诊断：把 map 里实际有哪些 display 打出来】
            // 2026-09-26 排查「息屏后副屏读不到元素」时加。
            // 症状：activity 确实在 displayId=46 上（am stack list 可见），
            // 但这里拿不到窗口，元素树返回「没有可交互元素」。
            // 打出来才能区分「46 不在 map 里」还是「在 map 里但列表为空」。
            StringBuilder keys = new StringBuilder();
            for (int i = 0; i < size; i++) {
                try { keys.append(keyAt.invoke(map, i)).append(','); } catch (Throwable ignored) {}
            }
            VdMain.log("windowsOnDisplay: want=" + id + " available=[" + keys + "]");

            for (int i = 0; i < size; i++) {
                if ((Integer) keyAt.invoke(map, i) != id) continue;
                Object list = valueAt.invoke(map, i);
                if (list == null) { VdMain.log("  display " + id + " 的窗口列表为 null"); return null; }
                int n = (Integer) list.getClass().getMethod("size").invoke(list);
                VdMain.log("  display " + id + " 有 " + n + " 个窗口");
                Method get = list.getClass().getMethod("get", int.class);
                List<Object> out = new ArrayList<>();
                for (int j = 0; j < n; j++) out.add(get.invoke(list, j));
                return out;
            }
            VdMain.log("  ⚠️ display " + id + " 不在 map 里（系统不认为它是活动显示）");
            return null;
        } catch (Throwable t) {
            return null;
        }
    }

    private AccessibilityNodeInfo rootOf(Object w) {
        try { return (AccessibilityNodeInfo) w.getClass().getMethod("getRoot").invoke(w); }
        catch (Throwable t) { return null; }
    }

    private AccessibilityNodeInfo findFocusedEditable() {
        List<Object> ws = windowsOnDisplay();
        if (ws == null) return null;
        for (Object w : ws) {
            AccessibilityNodeInfo root = rootOf(w);
            if (root == null) continue;
            AccessibilityNodeInfo n = findEditable(root);
            if (n != null) return n;
        }
        return null;
    }

    private AccessibilityNodeInfo findEditable(AccessibilityNodeInfo node) {
        boolean focused = false, editable = false;
        try { focused = node.isFocused(); } catch (Throwable ignored) {}
        try { editable = node.isEditable(); } catch (Throwable ignored) {}
        if (focused && editable) return node;
        int n = 0;
        try { n = node.getChildCount(); } catch (Throwable ignored) {}
        for (int i = 0; i < n; i++) {
            AccessibilityNodeInfo ch = null;
            try { ch = node.getChild(i); } catch (Throwable ignored) {}
            if (ch == null) continue;
            AccessibilityNodeInfo r = findEditable(ch);
            if (r != null) return r;
        }
        return null;
    }

    private AccessibilityNodeInfo findFocusedAny() {
        List<Object> ws = windowsOnDisplay();
        if (ws == null) return null;
        for (Object w : ws) {
            AccessibilityNodeInfo root = rootOf(w);
            if (root == null) continue;
            AccessibilityNodeInfo n = findFocusedAnyIn(root);
            if (n != null) return n;
        }
        return null;
    }

    private AccessibilityNodeInfo findFocusedAnyIn(AccessibilityNodeInfo node) {
        try { if (node.isFocused()) return node; } catch (Throwable ignored) {}
        int n = 0;
        try { n = node.getChildCount(); } catch (Throwable ignored) {}
        for (int i = 0; i < n; i++) {
            AccessibilityNodeInfo ch = null;
            try { ch = node.getChild(i); } catch (Throwable ignored) {}
            if (ch == null) continue;
            AccessibilityNodeInfo r = findFocusedAnyIn(ch);
            if (r != null) return r;
        }
        return null;
    }

    private boolean input(String... args) {
        // 目标屏由模式决定：foreground 打主屏，background 打副屏，idle 不打
        int id = targetDisplayId();
        if (id < 0) return false;
        try {
            List<String> cmd = new ArrayList<>();
            cmd.add("/system/bin/input");
            cmd.add("-d");
            cmd.add(String.valueOf(id));
            for (String a : args) cmd.add(a);
            Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
            return p.waitFor() == 0;
        } catch (Throwable t) {
            return false;
        }
    }

    // ── 建屏 + 帧缓存 ─────────────────────────────────────

    /**
     * 建副屏并启动帧缓存。
     *
     * 帧编码必须独立线程（一次 JPEG 约 16ms，放 drain 线程上会一直占着
     * ImageReader 的 buffer，后续帧被丢）。节流 66ms/帧。
     * 缓存保持全分辨率 —— 调用方按像素尺寸算缩放比例，缩过会打乱坐标映射。
     */
    private void startDisplay(Context ctx) throws Exception {
        android.util.DisplayMetrics m = ctx.getResources().getDisplayMetrics();
        dispW = m.widthPixels > 0 ? m.widthPixels : 1080;
        dispH = m.heightPixels > 0 ? m.heightPixels : 2400;
        dispDpi = m.densityDpi > 0 ? m.densityDpi : 420;

        final HandlerThread drainThread = new HandlerThread("vd-drain");
        drainThread.start();
        HandlerThread encodeThread = new HandlerThread("vd-encode");
        encodeThread.start();
        final Handler encodeHandler = new Handler(encodeThread.getLooper());

        reader = ImageReader.newInstance(dispW, dispH, PixelFormat.RGBA_8888, 2);
        reader.setOnImageAvailableListener(r -> {
            Image img = null;
            try {
                img = r.acquireLatestImage();
                if (img == null) return;
                long now = System.currentTimeMillis();
                if (now - lastFrameAt < FRAME_MIN_INTERVAL_MS) return;
                if (!encoding.compareAndSet(false, true)) return;
                lastFrameAt = now;

                // 拷出来再放 buffer（只有两个，按住编码会丢帧）
                ByteBuffer buf = img.getPlanes()[0].getBuffer();
                final byte[] bytes = new byte[buf.remaining()];
                buf.get(bytes);
                final int fw = img.getWidth(), fh = img.getHeight();
                img.close();
                img = null;

                encodeHandler.post(() -> {
                    try {
                        Bitmap bmp = Bitmap.createBitmap(fw, fh, Bitmap.Config.ARGB_8888);
                        bmp.copyPixelsFromBuffer(ByteBuffer.wrap(bytes));
                        ByteArrayOutputStream bos = new ByteArrayOutputStream();
                        bmp.compress(Bitmap.CompressFormat.JPEG, 85, bos);
                        synchronized (frameLock) {
                            frameJpeg = bos.toByteArray();
                            frameAt = System.currentTimeMillis();
                        }
                        bmp.recycle();
                    } catch (Throwable ignored) {
                    } finally {
                        encoding.set(false);
                    }
                });
            } catch (Throwable t) {
                if (img != null) try { img.close(); } catch (Throwable ignored) {}
                encoding.set(false);
            }
        }, new Handler(drainThread.getLooper()));

        // 【flags 组成 —— 2026-09-26 补 NEVER_BLANK，修「息屏后副屏变黑」】
        //
        //   0x001 PUBLIC                      别的应用也能投到这个屏
        //   0x008 OWN_CONTENT_ONLY            只显示本进程内容（不镜像主屏）
        //   0x200 SHOULD_SHOW_SYSTEM_DECORATIONS  显示状态栏/导航栏
        //   0x400 TRUSTED                     受信任（可显示 secure 内容）
        //   0x040 NEVER_BLANK                 ★ 屏幕关闭时**也不停止合成**
        //   0x800 ALWAYS_UNLOCKED             锁定状态下也可用
        //
        // ═══════════════════════════════════════════════════════════
        // 【2026-09-26 实测：息屏/Doze 下副屏读不到元素 —— 这是系统限制】
        //
        // 用户报「手机息屏时 phone use 没用」。实测排查结论：
        //
        //   副屏进程      活着 ✅
        //   display 创建  成功 ✅（加 NEVER_BLANK 后 dumpsys display 能看到）
        //   activity      在 task 里、是 mFocusedApp ✅（am stack list 可见）
        //   **应用窗口    mHasSurface=false · mDrawState=NO_SURFACE ❌**
        //   帧缓存        frame_bytes 一度有值但停在某个时刻不再更新 ❌
        //   元素树        「没有可交互元素」❌
        //
        // 根因：**Android 在 Doze（mWakefulness=Dozing）下暂停虚拟屏合成，
        // 也不给虚拟屏上的新窗口分配 Surface**。这不是代码问题 ——
        //   ① `input keyevent KEYCODE_WAKEUP` 唤醒后立刻测，窗口仍无 Surface
        //      （短暂唤醒不够，系统要持续的屏幕活动）
        //   ② 主屏同期的窗口正常（22 个），只有副屏受影响
        //   ③ 早上屏幕亮着时同样代码能正常读到元素树
        //
        // 能做的缓解（已做）：NEVER_BLANK + ALWAYS_UNLOCKED，
        // 让 display 在息屏时仍存在、仍能收到**部分**帧。
        // 但「窗口绘制 + 元素树」仍需要屏幕处于活动状态。
        //
        // 结论：**息屏时 phone use 不可用是预期行为**，不是 bug。
        // 用户要用 phone 工具时需要让屏幕亮着（或至少刚点亮过）。
        // ═══════════════════════════════════════════════════════════
        //
        // 【为什么必须加 NEVER_BLANK】
        // 实测（2026-09-26 用户息屏后）：副屏进程活着、display 也建了，
        // 但 frame_bytes=0、frame_age_ms=-1 —— **一帧都没拿到**，
        // 截图全黑（20KB PNG），元素树也是空的。
        // 根因：Android 在物理屏关闭时会暂停虚拟显示的合成，
        // 没有 NEVER_BLANK 就跟着一起停。加了这个 flag 才会继续出帧。
        //
        // 加 ALWAYS_UNLOCKED 是因为锁屏状态下同样需要能操作
        // （用户睡着时手机自动锁屏，不该让副屏跟着失效）。
        //   0x2000 OWN_FOCUS                   ★ 虚拟屏自己有焦点
        //
        // 【为什么加 OWN_FOCUS】
        // 只加 NEVER_BLANK 后，display 确实在系统里可见了（dumpsys display 能查到），
        // 但**仍然 frame_bytes=0** —— onImageAvailable 一次都没触发。
        // 说明「display 存在」不等于「有帧在合成」：息屏时 SurfaceFlinger
        // 不认为这个屏需要合成，除非它自己有焦点/被视为活动显示。
        // OWN_FOCUS 让它不依赖主屏焦点，独立参与合成。
        final int flags = 0x001 | 0x008 | 0x200 | 0x400 | 0x040 | 0x800 | 0x2000;
        DisplayManager dm = displayManagerForSelf(ctx);
        display = dm.createVirtualDisplay("TermuxVirtualDisplay", dispW, dispH, dispDpi,
                reader.getSurface(), flags);
    }

    /**
     * 拿「包名与当前进程 uid 匹配」的 DisplayManager。
     *
     * Android 16 的 system_server 建虚拟屏时会校验
     * `packageName must match the calling uid`。DisplayManager 会把构造它的
     * Context 的包名一路透传下去 —— 用 CCM 的 Context（包名 com.ccm.app）
     * 在 shell 进程里必定被拒（这条实测过）。
     *
     * shell uid 对应的包是 com.android.shell，用它建 Context 才带对包名。
     */
    private DisplayManager displayManagerForSelf(Context ctx) {
        DisplayManager fallback = (DisplayManager) ctx.getSystemService(Context.DISPLAY_SERVICE);
        try {
            String[] pkgs = ctx.getPackageManager().getPackagesForUid(android.os.Process.myUid());
            if (pkgs == null || pkgs.length == 0) return fallback;
            Context self = ctx.createPackageContext(pkgs[0], 0);
            DisplayManager dm = (DisplayManager) self.getSystemService(Context.DISPLAY_SERVICE);
            return dm != null ? dm : fallback;
        } catch (Throwable t) {
            VdMain.log("displayManagerForSelf 失败，用 fallback: " + t);
            return fallback;
        }
    }

    public long frameAge() { return frameAgeMs(); }
}
