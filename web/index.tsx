import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from './src/components/ErrorBoundary'
import './src/index.css'

// 启动时恢复外观设置：原来只在设置页点击时写 DOM 属性，刷新后聊天字体全部回默认
function restoreAppearance() {
  try {
    const profile = JSON.parse(localStorage.getItem('user_profile') || '{}')
    const theme = localStorage.getItem('theme') || profile.theme || 'light'
    const font = localStorage.getItem('chat_font') || profile.chat_font || 'default'
    const root = document.documentElement
    const dark = theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    root.setAttribute('data-theme', dark ? 'dark' : 'light')
    root.classList.toggle('dark', dark)
    root.setAttribute('data-chat-font', font)
  } catch { }
}
restoreAppearance()

/**
 * 屏蔽 lottie 动画的 AbortError 噪音。
 *
 * 【为什么】@lottiefiles/dotlottie-react 在组件卸载时会 abort 掉正在加载的
 * `.lottie` 请求，而库内部是这么处理的（打包产物 motion-*.js 里）：
 *     _dispatchError(i) { console.error(i), this._eventManager.dispatch({type:"loadError", ...}) }
 * 也就是说它**自己吞了异常、主动调 console.error**，不是未处理拒绝 ——
 * 所以 listen 'unhandledrejection' 拦不到（试过，无效）。
 * 实测 7 条路由各切一次就刷 7 条 ERROR，纯噪音（无 pageerror、无渲染问题）。
 *
 * 只能从 console.error 这一层拦：只吞消息里**同时**含 lottie 动画特征词和
 * AbortError 的那一种，其它错误（含真正的加载失败）照常打印，避免掩盖问题。
 */
const LOTTIE_NOISE_RE = /Failed to load animation data from URL.*AbortError|AbortError.*(typing|thinking)[-.]\w*\.lottie/i
const _origConsoleError = console.error.bind(console)
console.error = (...args: unknown[]) => {
  const first = typeof args[0] === 'string' ? args[0] : ''
  if (first && LOTTIE_NOISE_RE.test(first)) return
  _origConsoleError(...args)
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
