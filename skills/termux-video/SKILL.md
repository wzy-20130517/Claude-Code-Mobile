---
name: termux-video
description: 在 Termux/Android 上做动态视频（产品演示、进展汇报、功能介绍）的唯一可行路线：HTML/CSS 写画面 + headless Chromium 逐帧截图 + ffmpeg 合成。当用户说「做个视频」「做进展视频」「渲染视频」时使用。包含现成项目位置、Remotion 官方缓动参数，以及为什么 Remotion 官方渲染器和 Python+PIL 两条路都行不通的实测结论。
---

# 在 Termux 上做视频

## 铁律：只走 HTML + headless Chromium 这条路

两条**已实测失败**的路线，不要再试：

**Remotion 官方渲染器 —— 装不上。**
`@remotion/bundler` 硬依赖 `@rspack/core`，rspack 是 Rust 原生模块：
- 14 个平台预编译产物里没有 android
- Termux 的 bionic libc 装不上 `linux-arm64-gnu`
- WASI 兜底被 Android SELinux 拒绝（`UVWASI_EACCES`）

**Python + PIL 逐像素画图 —— 做得出来但很丑。**
实测产物是「空心圆角矩形 + 一条蓝胖鱼」。用 PIL 得一个椭圆一个三角形地拼，
同样的工作量用 CSS 是写排版。弃用的例子在 `/sdcard/Download/claude-workspace/videos/`（dsv4flash_v*.py）。

## 每个视频都要重新设计画面，不是套模板

**只复用管道，不复用画面。**

可以照抄的（这些是环境适配，每次都一样）：
- `capture.mjs` 的 chromium 启动参数、逐帧 screenshot 循环
- ffmpeg 合成命令
- 帧号驱动动画的写法、缓动函数

**不要照抄 `frame.html` 的场景结构。** 那 229 行是为「8-28 进展汇报」这一件事设计的
（左上小标题 + 打字机清单 + 模拟终端窗口）。换个主题就该换画面：
讲架构就画模块关系图，讲性能就画对比曲线，讲交互就录真实操作。
把它抽成"模板+文案"等于以后每个视频都是同一个骨架换字 —— 那是填表，不是做视频。

参考实现在 `~/remotion-demo/`：
- `frame.html` — 8-28 那期的画面，**当例子读，不当模板用**
- `capture.mjs` — 渲染管道，这个可以直接复制
- `src/Video.tsx` — 原始 Remotion 组件，设计稿参考，不参与渲染

### 新视频的做法
每期开一个独立目录，别改旧的（否则上一期源码就没了，不可重现）：

```
~/video-projects/<主题>-<日期>/
  frame.html     ← 这一期自己的画面设计
  capture.mjs    ← 从 remotion-demo 复制，一般不用改
  frames/        ← 中间产物
```

1. 先想清这期要讲什么、用什么画面形式讲（这一步不写代码）
2. 写这期的 `frame.html`
3. `node capture.mjs`
4. `ffmpeg -framerate 30 -i frames/%04d.png -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 20 out.mp4`
5. **必须复制到 `/sdcard/Download/claude-workspace/video/`**

第 5 步不是可选项：`~/video-projects/` 在 Termux 私有目录下，
用户的相册和播放器**完全访问不到**，做完不复制等于没交付。
命名 `<主题>-<日期>.mp4`，交付时告诉用户文件管理器里的路径
（`Download/claude-workspace/video/`），不要只给 Termux 路径。

参考成品 `ccm-2026-08-28.mp4`：510 帧 / 17s / 30fps / 1280x720 / h264 High / 无音轨 / 190KB。

## 动画必须按帧号驱动

**不要用 CSS animation / transition** —— 截图时机不可控，会拍到动画中间态或完全没动。
一切都从 `renderFrame(f)` 的帧号算出来。

```js
// 场景分段（等价 Remotion 的 <Sequence>）
const SCENES = [[id, fromFrame, durationInFrames], ...]

// 打字机：按帧推进字符数
const n = Math.floor((frame - start) / fps * cps)   // cps 默认 28 字/秒
// 未打完时追加闪烁光标，frame % 16 < 8 控制明暗
if (n < text.length) out += (frame % 16 < 8) ? '▌' : ' '
```

## 缓动参数（取自 Remotion 官方 best-practices）

官方默认值，比自己瞎调靠谱：

```js
// 通用入场缓动，对应 Easing.bezier(0.16, 1, 0.3, 1)
// easeOutExpo 风格：起步极快、尾部长距离减速，适合滑入/淡入
function easeOutExpo(t) { return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t) }

// spring 用 damping: 200（官方推荐，几乎不回弹）
// 不需要弹跳感时 easeOutCubic 近似就够：
function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3) }
```

要真回弹（overshoot）才用低阻尼参数，产品演示类视频**不要用**，显得廉价。
时长换算一律走 `fps`，别写死帧数：`0.3 * fps` 而不是 `9`。

## 设计基调：配色必须取自产品自身

`~/remotion-demo/src/Video.tsx` 原注释：
> 深色底 + 单一强调色（终端橙），字体用等宽 —— 这是个 CLI 项目，视觉语言要一致。动效走 spring 而非线性，避免生硬。

Claude Code Mobile 用的值：

```
BG      #0d1117   终端底色
ACCENT  #ff8a3d   CLI 里 ❯ 的橙
GREEN   #3fb950   完成态
字体     JetBrains Mono
```

通用的「深蓝 + 亮蓝 + 金色」看着也行，但套任何产品都成立，等于没有身份。

### 该固定 vs 该每次变

固定（同一产品的视频要认得出是一家的）：配色、字体、logo 处理、整体气质。

每次都该不一样：画面结构、信息呈现形式、镜头节奏、用什么视觉隐喻。

判断标准：**观众该觉得"这是同一个产品的视频"，而不是"这是同一个模板"。**

## 内容原则（比技术更重要）

8-28 那个视频好，**不是因为克制、不堆特效，而是因为画面上真有内容**：

- 真实的终端会话（`❯ /team` 连同真实输出，状态图标颜色都对）
- 两级文字层级：加粗白色主标题说「是什么」，灰色副标题说「具体到什么程度」
- 逐字打字机 —— 作用是引导阅读节奏，不是炫技

**开工前先确认：有没有真东西可展示？** 没有就别做。
没内容时人会本能地拿装饰图形填时间，结果就是一堆空框加一条鱼。

## 评价产物必须渲染后亲自看

读源码只能知道意图，不能知道效果。`draw_whale()` 可能画出一条丑鱼，
`ease_back` 可能只作用在一根横条上。渲完用 `ViewVideo` 抽帧亲自看，再下判断。

## 配套：素材下载

需要图片/视频素材时用 `media-downloader` skill（已装在 `~/.claude/skills/media-downloader`）：
- Pexels / Pixabay / Unsplash 图库搜索下载（需免费 API key，环境变量配）
- YouTube 视频下载（yt-dlp，已装）
- ffmpeg 裁剪/转码
