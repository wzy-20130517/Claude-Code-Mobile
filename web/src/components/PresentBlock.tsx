import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * PresentBlock —— 渲染 Agent 通过 Present 工具主动推送的可视内容。
 * 与「被动识别代码块」不同：这里是 Agent 明确决定「用户该看图，不该看源码」时才出现。
 *
 * 安全策略：
 * - html：一律塞进 sandbox iframe（allow-scripts，不给 same-origin），脚本无法访问父页面/cookie
 * - svg：同样走 iframe 沙箱。SVG 可内嵌 <script>，直接 innerHTML 等于开 XSS 口子
 * - image/video：只走 /api/present-file（服务端限制在 workspace 根内 + 后缀白名单）
 */

export interface PresentParam {
  name: string;
  label?: string;
  min: number;
  max: number;
  step: number;
  value: number;
}

export interface PresentFile {
  path: string;
  name: string;
  size?: number;
  ext?: string;
}

export interface PresentPayload {
  kind: 'svg' | 'html' | 'mermaid' | 'image' | 'images' | 'video';
  title?: string;
  caption?: string;
  content?: string;
  files?: PresentFile[];
  params?: PresentParam[];
  at?: number;
}

const fileUrl = (path: string) => `/api/present-file?path=${encodeURIComponent(path)}`;

/** 把 {{name}} 占位符替换成当前参数值（占位符模式会整体重渲染，仅适合静态图） */
function applyParams(source: string, values: Record<string, number>): string {
  if (!source) return '';
  let out = source;
  for (const [name, value] of Object.entries(values)) {
    // 转义参数名里的正则元字符，避免 name 含特殊符号时炸掉
    const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\{\\{\\s*${safe}\\s*\\}\\}`, 'g'), String(value));
  }
  return out;
}

/** content 是否用了 {{占位符}}（用了就只能重渲染，没用就能热更新） */
function usesPlaceholder(source: string, params: PresentParam[]): boolean {
  return params.some(p => {
    const safe = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\{\\{\\s*${safe}\\s*\\}\\}`).test(source);
  });
}

/**
 * 注入到 iframe 的参数运行时。让「拖滑块」不重建 iframe：
 * - 参数写成 :root 的 CSS 变量 → content 里 var(--speed) 直接生效，CSS 动画连续不断
 * - 同时挂 window.PARAMS，并在变化时调用 window.onParamChange(name, value)
 * - 高度回报给父窗口，避免固定高度裁切内容
 */
function paramRuntime(initial: Record<string, number>): string {
  return `<script>
(function(){
  var P = ${JSON.stringify(initial)};
  window.PARAMS = P;
  function applyVars(obj){
    var root = document.documentElement;
    for (var k in obj) { try { root.style.setProperty('--' + k, String(obj[k])); } catch(e){} }
  }
  applyVars(P);

  // 速度类参数（speed/rate/velocity/转速…）用 Web Animations 的 playbackRate 接管。
  // 直接改 animation-duration 会让 CSS 按新周期重算进度、画面瞬移；playbackRate 只改快慢，
  // 当前进度保留 —— 这才是"对着画面调参数"的手感。
  var SPEEDISH = /^(speed|rate|velocity|spin|rotation|rotate|fps|转速|速度|速率)$/i;
  var baseRate = null;
  function speedKey(){
    for (var k in P) if (SPEEDISH.test(k)) return k;
    return null;
  }
  function tuneRate(v){
    if (!document.getAnimations) return false;
    var anims = document.getAnimations();
    if (!anims.length) return false;
    if (baseRate === null) baseRate = Number(P.__base) || v || 1;
    var ratio = baseRate ? (v / baseRate) : 1;
    if (!isFinite(ratio) || ratio <= 0) return false;
    var ok = false;
    for (var i = 0; i < anims.length; i++) {
      try { anims[i].playbackRate = ratio; ok = true; } catch(e){}
    }
    return ok;
  }
  var sk = speedKey();
  if (sk) baseRate = Number(P[sk]) || 1;

  window.addEventListener('message', function(e){
    var d = e && e.data;
    if (!d || d.__present !== 'params' || !d.values) return;
    var vals = d.values;
    for (var k in vals) {
      var v = Number(vals[k]);
      if (!isFinite(v) || P[k] === v) continue;
      P[k] = v;
      // 速度参数优先走 playbackRate（保进度）；成功后不再写 CSS 变量，避免 duration 变化引起跳帧
      var handled = false;
      if (SPEEDISH.test(k) && !window.__presentNoRate) handled = tuneRate(v);
      if (!handled) { try { document.documentElement.style.setProperty('--' + k, String(v)); } catch(err){} }
      if (typeof window.onParamChange === 'function') { try { window.onParamChange(k, v); } catch(err){} }
    }
    if (typeof window.onParamsChange === 'function') { try { window.onParamsChange(P); } catch(err){} }
  });
  function reportHeight(){
    try {
      var h = Math.max(
        document.documentElement.scrollHeight || 0,
        document.body ? document.body.scrollHeight : 0
      );
      if (h > 0) parent.postMessage({ __present: 'height', height: h }, '*');
    } catch(e){}
  }
  window.addEventListener('load', reportHeight);
  setTimeout(reportHeight, 60);
  setTimeout(reportHeight, 400);
})();
</script>`;
}

/**
 * 包一层最小 HTML 骨架展示 SVG。
 *
 * 【2026-09-19 修渲染问题】原来是：
 *   html,body{height:100%;overflow:hidden} + svg{max-height:100%}
 * 两个毛病：
 *   1) body 高度 = iframe 的初始高度（320px），svg 的 max-height:100% 被这个
 *      死高度卡住 —— 比 320 高的图直接被压扁/裁掉，用户看到的就是「渲染不对」。
 *   2) 上报高度的脚本量的是被压过的 body，永远报 320，iframe 也就永远不涨。
 * 改成：body 高度跟随内容（不设 height:100%），svg 宽度撑满、高度按自身比例。
 * 这样上报脚本量到的就是真实内容高度，iframe 会自动长到合适尺寸。
 */
function wrapSvg(svg: string, initial: Record<string, number>): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent}
body{display:flex;align-items:center;justify-content:center;padding:8px;box-sizing:border-box}
svg{max-width:100%;height:auto;display:block}
</style>${paramRuntime(initial)}</head><body>${svg}</body></html>`;
}

/** html 类型：把参数运行时注入到用户 HTML 里（有 <head> 插进去，否则前置） */
function wrapHtml(html: string, initial: Record<string, number>): string {
  const rt = paramRuntime(initial);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, (m) => `${m}${rt}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html([^>]*)>/i, (m) => `${m}<head>${rt}</head>`);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${rt}</head><body>${html}</body></html>`;
}

/** mermaid 从 CDN 动态加载渲染，失败则退回显示源码 */
function wrapMermaid(code: string): string {
  const escaped = code.replace(/<\/script>/gi, '<\\/script>');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:12px;background:transparent;font-family:system-ui,-apple-system,sans-serif}
#err{color:#b91c1c;font-size:12px;white-space:pre-wrap}
</style></head><body>
<div class="mermaid">${escaped}</div><pre id="err"></pre>
<script type="module">
try {
  const m = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs');
  m.default.initialize({ startOnLoad: true, theme: 'default' });
} catch (e) {
  document.getElementById('err').textContent = 'mermaid 加载失败（可能无网络）：\\n' + (e?.message || e);
}
</script></body></html>`;
}

export const PresentBlock: React.FC<{ payload: PresentPayload }> = ({ payload }) => {
  const { kind, title, caption, content = '', files = [], params = [] } = payload;

  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(params.map(p => [p.name, p.value]))
  );
  const [showSource, setShowSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [height, setHeight] = useState(320);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // params 变化（新的 present 事件复用同组件）时重置滑块值
  useEffect(() => {
    setValues(Object.fromEntries(params.map(p => [p.name, p.value])));
  }, [payload.at]);

  // 初始值：iframe 首帧用它构建，之后不再参与 srcDoc（否则拖滑块会重建、动画重播）
  const initialValues = useMemo(
    () => Object.fromEntries(params.map(p => [p.name, p.value])),
    [payload.at]
  );

  // content 里用了 {{占位符}} → 只能整体重渲染；否则走热更新（CSS 变量 / window.PARAMS）
  const placeholderMode = useMemo(
    () => (params.length > 0 ? usesPlaceholder(content, params) : false),
    [content, payload.at]
  );

  // 源码视图 & 占位符模式用当前值；热更新模式的 srcDoc 只认初始值
  const resolved = useMemo(() => applyParams(content, values), [content, values]);
  const frameSource = placeholderMode ? resolved : applyParams(content, initialValues);

  const srcDoc = useMemo(() => {
    if (kind === 'svg') return wrapSvg(frameSource, initialValues);
    if (kind === 'mermaid') return wrapMermaid(frameSource);
    if (kind === 'html') return wrapHtml(frameSource, initialValues);
    return '';
  }, [kind, frameSource, initialValues]);

  // 热更新：值变了就 postMessage 进 iframe，不动 srcDoc
  useEffect(() => {
    if (placeholderMode) return;
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    try { win.postMessage({ __present: 'params', values }, '*'); } catch { }
  }, [values, placeholderMode]);

  // iframe 自报高度，避免固定 320 裁切内容
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d: any = e?.data;
      if (!d || d.__present !== 'height') return;
      if (e.source !== iframeRef.current?.contentWindow) return;
      const h = Number(d.height);
      // 上限放宽到 1200：SVG/HTML 展示类内容可能很高，720 会把长图截断
      if (Number.isFinite(h) && h > 40) setHeight(Math.min(Math.max(h, 160), 1200));
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // 复制按钮的「已复制」反馈状态
  const [copied, setCopied] = useState(false);
  const isFramed = kind === 'svg' || kind === 'html' || kind === 'mermaid';
  const hasSource = isFramed && !!content;

  return (
    <div className="my-3 rounded-xl border border-black/10 dark:border-white/12 overflow-hidden bg-white/60 dark:bg-white/[0.03]">
      {/* 顶栏：标题 + 操作 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-black/8 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.02]">
        <span className="text-[11px] uppercase tracking-wide font-medium text-black/45 dark:text-white/45">
          {kind}
        </span>
        {title && (
          <span className="text-[13px] font-medium text-black/80 dark:text-white/85 truncate">{title}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {/* 【复制按钮】用户明确要求「没有一个复制按钮在 svg 上」。
              复制的是**原始源码**（resolved 含参数替换后的内容），
              这样粘到别处能直接用；svg/html/mermaid 都能用。 */}
          {hasSource && (
            <button
              onClick={async () => {
                const text = resolved;
                try {
                  await navigator.clipboard.writeText(text);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                } catch {
                  // 非 HTTPS / 无权限时降级：弹一个可全选的输入框
                  window.prompt('复制以下内容（Ctrl/Cmd+C）：', text);
                }
              }}
              className="px-2 py-1 text-[11px] rounded-md text-black/55 dark:text-white/55 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
              aria-label="复制源码"
            >
              {copied ? '已复制' : '复制'}
            </button>
          )}
          {hasSource && (
            <button
              onClick={() => setShowSource(v => !v)}
              className="px-2 py-1 text-[11px] rounded-md text-black/55 dark:text-white/55 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
              aria-label={showSource ? '显示预览' : '显示源码'}
            >
              {showSource ? '预览' : '源码'}
            </button>
          )}
          {isFramed && (
            <button
              onClick={() => setExpanded(v => !v)}
              className="px-2 py-1 text-[11px] rounded-md text-black/55 dark:text-white/55 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
              aria-label={expanded ? '收起' : '放大'}
            >
              {expanded ? '收起' : '放大'}
            </button>
          )}
        </div>
      </div>

      {/* 主体 */}
      {showSource && hasSource ? (
        <pre className="p-3 text-[12px] leading-relaxed overflow-auto max-h-[480px] font-mono text-black/75 dark:text-white/75">
          {resolved}
        </pre>
      ) : (
        <div className="relative">
          {isFramed && (
            <iframe
              ref={iframeRef}
              title={title || `${kind} 展示`}
              srcDoc={srcDoc}
              sandbox="allow-scripts"
              className="w-full block border-0 bg-transparent"
              style={{ height: expanded ? Math.max(height, 560) : height }}
              loading="lazy"
            />
          )}

          {(kind === 'image' || kind === 'images') && (
            <div
              className={
                kind === 'images' && files.length > 1
                  ? 'grid grid-cols-2 sm:grid-cols-3 gap-2 p-3'
                  : 'p-3'
              }
            >
              {files.map((f, i) => (
                <a
                  key={f.path + i}
                  href={fileUrl(f.path)}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded-lg overflow-hidden border border-black/8 dark:border-white/10 hover:border-black/20 dark:hover:border-white/25 transition-colors"
                  title={f.name}
                >
                  <img
                    src={fileUrl(f.path)}
                    alt={f.name}
                    loading="lazy"
                    className="w-full h-auto block bg-black/[0.03] dark:bg-white/[0.03]"
                  />
                  {kind === 'images' && files.length > 1 && (
                    <div className="px-2 py-1 text-[10px] text-black/50 dark:text-white/45 truncate">
                      {f.name}
                    </div>
                  )}
                </a>
              ))}
            </div>
          )}

          {kind === 'video' && files[0] && (
            <div className="p-3">
              <video
                src={fileUrl(files[0].path)}
                controls
                playsInline
                preload="metadata"
                className="w-full rounded-lg bg-black"
              />
            </div>
          )}
        </div>
      )}

      {/* 参数滑块 */}
      {params.length > 0 && !showSource && (
        <div className="px-3 py-2.5 border-t border-black/8 dark:border-white/10 space-y-2 bg-black/[0.015] dark:bg-white/[0.02]">
          <div className="flex items-center gap-2 pb-0.5">
            <span className="text-[10.5px] uppercase tracking-wide text-black/35 dark:text-white/35">
              {placeholderMode ? '调整参数（重新渲染）' : '实时调整'}
            </span>
            <button
              onClick={() => setValues(initialValues)}
              className="ml-auto px-1.5 py-0.5 text-[10.5px] rounded text-black/45 dark:text-white/45 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
            >
              重置
            </button>
          </div>
          {params.map(p => (
            <div key={p.name} className="flex items-center gap-3">
              <label
                htmlFor={`present-${payload.at}-${p.name}`}
                className="text-[12px] text-black/60 dark:text-white/60 min-w-[72px] truncate"
              >
                {p.label || p.name}
              </label>
              <input
                id={`present-${payload.at}-${p.name}`}
                type="range"
                min={p.min}
                max={p.max}
                step={p.step}
                value={values[p.name] ?? p.value}
                onChange={e => setValues(v => ({ ...v, [p.name]: Number(e.target.value) }))}
                className="flex-1 accent-current h-1.5"
              />
              <span className="text-[11px] font-mono text-black/50 dark:text-white/50 min-w-[38px] text-right tabular-nums">
                {values[p.name] ?? p.value}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 说明文字 */}
      {caption && (
        <div className="px-3 py-2 border-t border-black/8 dark:border-white/10 text-[12px] text-black/55 dark:text-white/55 leading-relaxed">
          {caption}
        </div>
      )}
    </div>
  );
};

export default PresentBlock;
