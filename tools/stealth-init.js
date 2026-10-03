// 浏览器指纹补齐 —— 在每个 document 创建前注入（Playwright initScript）
//
// 【为什么需要】2026-09-05 在 zeabur.cn 注册时，Cloudflare Turnstile 返回
// 错误码 300010（客户端执行环境被拒）：window.turnstile 加载成功、容器 div
// 也在，但 iframe 永不渲染、cf-turnstile-response 永远为空 → 登录按钮点了没反应。
//
// 实测泄露项（对照真实 Chrome）：
//   1. WEBGL_debug_renderer_info 返回 null   ← 最强信号，真实浏览器一定有值
//      根因：Termux 里 Chromium 走软件渲染，X11 无 GL 后端
//   2. UA-CH brands 是 "Chromium/149"        ← 与 UA 字符串里的 "Chrome" 矛盾
//   3. maxTouchPoints = 20 配 X11 桌面 UA    ← 桌面机器报 20 个触点，自相矛盾
//
// 【定位方法】不要靠猜。turnstile.render() 手动调一次，用 error-callback
// 拿到具体错误码；再逐项 evaluate 对比真实 Chrome 的值。300010 = 环境被拒，
// 不是网络问题（challenges.cloudflare.com 实测可连）。
//
// 【边界】这只补齐"矛盾的指纹"，让环境自洽，不是万能过验证。
// Turnstile 还看行为特征（鼠标轨迹、按键节奏），交互式验证码仍需真人。

'use strict';

(() => {
  const def = (obj, prop, getter) => {
    try {
      Object.defineProperty(obj, prop, { get: getter, configurable: true });
    } catch {}
  };

  // ── 1. WebGL renderer 里的 SwiftShader 字样 ──────────────────
  // 【实测纠正】不要伪造整个 WebGL 上下文。Termux 里 Chromium 的 WebGL 本来是好的：
  //   裸启动实测 → ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0)))
  // 我一开始以为「WebGL 为 null」是环境限制，加了 --use-angle=swiftshader 想补，
  // 结果那个参数**反而让 WebGL 彻底不可用**（探针对比：不加正常、加了变 null）。
  // 会话里偶发的 WebGL=null 是**长期运行实例的 GPU 进程崩了**，新实例不会有。
  //
  // 所以这里只做一件事：把 renderer 字符串里的 "SwiftShader"（软件渲染标志，
  // 真实用户机器上极罕见）替换成常见核显名，其余保持真实值不动。
  const GL_VENDOR = 0x9245;    // UNMASKED_VENDOR_WEBGL
  const GL_RENDERER = 0x9246;  // UNMASKED_RENDERER_WEBGL
  const REAL_LOOKING = 'ANGLE (Intel, Mesa Intel(R) UHD Graphics (CML GT2), OpenGL 4.6)';

  for (const Ctx of [
    globalThis.WebGLRenderingContext,
    globalThis.WebGL2RenderingContext,
  ]) {
    if (!Ctx) continue;
    const orig = Ctx.prototype.getParameter;
    Ctx.prototype.getParameter = function (p) {
      const v = orig.apply(this, arguments);
      // 只在真值里含软件渲染标志时才替换；拿不到值就不管（别造假上下文）
      if (p === GL_RENDERER && typeof v === 'string' && /swiftshader|llvmpipe|mesa offscreen/i.test(v)) {
        return REAL_LOOKING;
      }
      if (p === GL_VENDOR && typeof v === 'string' && /google/i.test(v)) {
        return 'Google Inc. (Intel)';
      }
      return v;
    };
  }

  // ── 2. UA-CH brands：Chromium → Google Chrome ────────────────
  // UA 字符串写 Chrome、UA-CH 写 Chromium，这个矛盾是明确的自动化标记。
  if (navigator.userAgentData) {
    const m = navigator.userAgent.match(/Chrome\/(\d+)/);
    const v = m ? m[1] : '149';
    const brands = [
      { brand: 'Not)A;Brand', version: '24' },
      { brand: 'Chromium', version: v },
      { brand: 'Google Chrome', version: v },
    ];
    // ⚠ 必须改**原型** NavigatorUAData.prototype，不能在实例上 defineProperty ——
    // brands 是原型上的 getter，实例属性会被它遮蔽，改了完全无效（我踩过：
    // 实例上定义后读出来还是 "Chromium | Not)A;Brand"）。实测原型 configurable=true。
    def(Object.getPrototypeOf(navigator.userAgentData), 'brands', () => brands.slice());
    // getHighEntropyValues 也要一致，否则深度探测会对不上
    const origHE = navigator.userAgentData.getHighEntropyValues;
    if (origHE) {
      navigator.userAgentData.getHighEntropyValues = function (hints) {
        return origHE.call(this, hints).then((r) => {
          if (r.brands) r.brands = brands.slice();
          if ('fullVersionList' in r) {
            r.fullVersionList = brands.map((b) => ({
              brand: b.brand,
              version: b.version === '24' ? '24.0.0.0' : `${v}.0.0.0`,
            }));
          }
          return r;
        });
      };
    }
  }

  // ── 3. maxTouchPoints：桌面 UA 不该有 20 个触点 ──────────────
  // Android 底层透上来的值，与 "X11; Linux x86_64" 矛盾。
  def(navigator, 'maxTouchPoints', () => 0);

  // ── 4. window.chrome 补 runtime ──────────────────────────────
  // 真实 Chrome 有 chrome.runtime；只有 loadTimes/csi/app 是 Chromium 特征。
  if (window.chrome && !window.chrome.runtime) {
    try {
      window.chrome.runtime = {
        // 真实值是个带方法的对象，但站点通常只检测存在性
        connect: () => {},
        sendMessage: () => {},
        onMessage: { addListener: () => {}, removeListener: () => {} },
      };
    } catch {}
  }

  // ── 5. 权限查询一致性 ───────────────────────────────────────
  // 无头环境 Notification.permission 常与 permissions.query 结果矛盾。
  if (navigator.permissions?.query) {
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (desc) =>
      desc?.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission, onchange: null })
        : origQuery(desc);
  }
})();
