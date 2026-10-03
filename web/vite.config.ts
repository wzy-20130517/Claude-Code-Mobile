import path from 'path'
import { readFileSync } from 'fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 【版本号真值源】读项目根的 package.json，而不是 web/package.json。
// web/package.json 是前端自己的包版本（长期停在 0.5.0），跟产品版本无关 ——
// 原来用它，于是设置里一直显示 v0.5.0，而 CLI 那边早就是 0.8.x 了。
const rootPkg = (() => {
  try { return JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8')) }
  catch { return {} }
})()

export default defineConfig({
  base: '/',
  assetsInclude: ['**/*.lottie'],
  server: {
    port: 3000,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3456',
        changeOrigin: true,
      },
    },
  },
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version || '0.0.0'),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  build: {
    outDir: 'dist',
    reportCompressedSize: false,
    // 原来全部打进一个 index.js（2.7MB），首屏必须整包下载完才能渲染。
    // 按功能域拆开：常用的 react 核心单独一块长期缓存，
    // 重量级但非首屏必需的（katex/图表/动画/代码高亮）各自独立，
    // 浏览器可并行下载，改动业务代码也不会让这些大块缓存失效。
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-core': ['react', 'react-dom', 'react-router-dom'],
          // 数学公式渲染：只有消息里出现公式才用得上
          katex: ['katex', 'rehype-katex', 'remark-math'],
          // Markdown 管线
          markdown: ['react-markdown', 'remark-gfm'],
          // 代码高亮不在这里手动分块：
          // 它已由 LazyHighlighter 的动态 import 自动切成独立 chunk，
          // 写进 manualChunks 反而会把它拉回首屏依赖图。
          // 图表（recharts）不手动分块：
          // 唯一使用者 AdminDashboard 已改成 React.lazy，
          // 让 Rollup 顺着动态 import 自己切，才不会进首屏。
          // 动画（lottie + gsap）
          motion: ['@lottiefiles/dotlottie-react', 'gsap'],
          // 图标集
          icons: ['lucide-react'],
        },
      },
    },
  },
})
