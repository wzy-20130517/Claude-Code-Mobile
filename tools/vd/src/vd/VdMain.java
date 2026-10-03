package vd;

import android.content.Context;
import android.os.Looper;

/**
 * Termux 侧虚拟副屏的进程入口。
 *
 * 【为什么单独起一个进程】
 * CLI/Web 跑在 Termux 里（普通 Linux 进程），拿不到 Android 的 binder，
 * 连不上 Shizuku 的用户服务。但 adb 能给 shell uid —— 权限和 Shizuku 完全等价。
 * 麻烦在于「建虚拟屏」是 Java API，adb 只能跑命令。
 *
 * 解法：`app_process` 起一个 Java 进程，在里面建屏 + 开本地 HTTP 端口，
 * Termux 侧只管发 HTTP。
 *
 * 【为什么这条路成立】（曾经以为不行，实测推翻）
 * 一度认为 Android 16 上 app_process 会撞 /data/dalvik-cache 的 chown 而 abort。
 * 实际是 AOSP app_main.cpp 里 maybeCreateDalvikCache() 只在 **zygote 分支**
 * （不带类名启动）调用；带类名启动根本不碰那个目录。
 * 实测 `CLASSPATH=<jar> app_process /system/bin <类名>` 能正常加载类。
 *
 * 【启动命令】
 *   CLASSPATH=<vd.dex> /system/bin/app_process /system/bin --nice-name=ccm-vd vd.VdMain
 */
public class VdMain {

    public static void main(String[] args) {
        try {
            // UiAutomation.connect() 内部要 new Handler(Looper.getMainLooper())，
            // 没有主 Looper 会抛异常并被 RuntimeInit 杀掉整个进程。
            if (Looper.myLooper() == null) Looper.prepare();

            Context ctx = systemContext();
            if (ctx == null) {
                log("拿不到系统 Context，退出");
                return;
            }

            VdCore core = new VdCore(ctx);
            log("副屏 displayId=" + core.displayId());

            int port = 3458;
            if (args != null && args.length > 0) {
                try { port = Integer.parseInt(args[0]); } catch (NumberFormatException ignored) {}
            }
            VdHttp http = new VdHttp(core, port);
            http.start();
            log("HTTP 服务已监听 127.0.0.1:" + port);

            // 主线程进 Looper 循环 —— UiAutomation 的回调靠它派发
            Looper.loop();
        } catch (Throwable t) {
            log("启动失败: " + t);
        }
    }

    /** app_process 起的进程没有 Application，用 ActivityThread 的 system context。 */
    private static Context systemContext() {
        try {
            Class<?> atClass = Class.forName("android.app.ActivityThread");
            Object at = atClass.getMethod("systemMain").invoke(null);
            Object holder = atClass.getMethod("getSystemContext").invoke(at);
            return (Context) holder;
        } catch (Throwable t) {
            log("systemContext 失败: " + t);
            return null;
        }
    }

    static void log(String s) {
        System.out.println("[vd] " + s);
    }
}
