// Present 工具：让 Agent 主动把可视内容"展示"到 Web 对话流里内联渲染。
// 区别于被动识别代码块 —— 由 Agent 自己决定"这个东西用户该看图，不该看源码/路径"。
// 典型用法：写了 SVG 动画直接放出来看；剪视频抽几帧发过来；生成图表直接出图。
// CLI 场景没有渲染能力，工具会返回文字提示（不报错），保持双端行为一致。
import { Tool } from './tools.mjs'
import { existsSync, statSync } from 'fs'
import { resolve, extname, basename } from 'path'

const KINDS = ['svg', 'html', 'mermaid', 'image', 'images', 'video']
// 图片/视频白名单后缀，避免把任意文件塞进 <img>
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.avif'])
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v'])
// 单次内联源码上限，超过就别塞进 SSE（前端也渲染不动）
const MAX_CONTENT = 200_000

export class PresentTool extends Tool {
  /**
   * 中断时保留调用记录。
   *
   * Present 的效果是「已渲染在对话里」这个不可撤销的用户可见结果；
   * agent 被中断时若把 tool_use 丢掉，SVG/HTML 就从历史里消失（刷新即没了）。
   * 标记后 agent 会给它补一条合成 tool_result 成对入历史，见 core/agent.mjs
   * 中断分支里的 persistableNames。
   */
  _persistOnInterrupt = true

  // onPresent(payload) 由宿主注入：Web 端推 SSE 事件，CLI 端不传（降级为文字提示）
  constructor({ onPresent = null, cwd = process.cwd() } = {}) {
    super({
      name: 'Present',
      description:
        '把可视内容主动展示到对话里（内联渲染，用户直接看到图/动画，而不是源码或文件路径）。' +
        '适用：写完 SVG/HTML 动画想让用户直接看效果；处理视频后抽几帧展示；生成图表/流程图。' +
        'kind=svg/html/mermaid 时用 content 传源码；kind=image/images/video 时用 paths 传本地文件路径。' +
        'params 可选：声明可调参数，前端生成滑块，用户拖动即时重渲染（content 里用 {{参数名}} 占位）。',
      input_schema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: KINDS, description: '展示类型：svg=SVG图形/动画, html=完整HTML(沙箱iframe), mermaid=流程图, image=单图, images=多图网格, video=视频' },
          title: { type: 'string', description: '可选标题，显示在展示块顶部' },
          content: { type: 'string', description: 'kind=svg/html/mermaid 时的源码内容' },
          paths: { type: 'array', items: { type: 'string' }, description: 'kind=image/images/video 时的本地文件路径（相对 cwd 或绝对路径）' },
          caption: { type: 'string', description: '可选说明文字，显示在展示块底部' },
          params: {
            type: 'array',
            description:
              '可选：可调参数列表，前端在画面下方生成滑块，拖动时【热更新、动画不重启】。' +
              '在 content 里用三种方式之一读取参数（推荐前两种，能保持动画连续）：' +
              '① CSS 变量 var(--参数名)，如 animation-duration: calc(var(--speed) * 1s)；' +
              '② JS 读 window.PARAMS.参数名，配合 window.onParamChange = (name, value) => {...} 响应变化；' +
              '③ {{参数名}} 占位符（会整体重渲染，动画从头开始，仅用于静态图）。',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '参数名，对应 content 里的 {{name}}' },
                label: { type: 'string', description: '显示名（可选，默认用 name）' },
                min: { type: 'number' },
                max: { type: 'number' },
                step: { type: 'number' },
                value: { type: 'number', description: '默认值' },
              },
              required: ['name', 'value'],
            },
          },
        },
        required: ['kind'],
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      maxResultSizeChars: 600,
    })
    this.onPresent = onPresent
    this.cwd = cwd
  }

  async execute(input) {
    const kind = String(input?.kind || '').toLowerCase()
    if (!KINDS.includes(kind)) return `kind 必须是: ${KINDS.join(' / ')}`

    const needsContent = kind === 'svg' || kind === 'html' || kind === 'mermaid'
    const needsPaths = kind === 'image' || kind === 'images' || kind === 'video'

    let content = ''
    let files = []

    if (needsContent) {
      content = String(input?.content || '')
      if (!content.trim()) return `kind=${kind} 需要 content（源码内容）`
      if (content.length > MAX_CONTENT) return `content 过大（${content.length} 字符，上限 ${MAX_CONTENT}），请精简或改为写文件后用 kind=image 展示`
      if (kind === 'svg' && !/<svg[\s>]/i.test(content)) return 'kind=svg 的 content 必须包含 <svg> 标签'
    }

    if (needsPaths) {
      const raw = Array.isArray(input?.paths) ? input.paths : (input?.paths ? [input.paths] : [])
      if (!raw.length) return `kind=${kind} 需要 paths（本地文件路径数组）`
      const allow = kind === 'video' ? VIDEO_EXT : IMAGE_EXT
      const problems = []
      for (const p of raw) {
        const abs = resolve(this.cwd, String(p))
        if (!existsSync(abs)) { problems.push(`${p} 不存在`); continue }
        const ext = extname(abs).toLowerCase()
        if (!allow.has(ext)) { problems.push(`${p} 后缀 ${ext || '(无)'} 不在 ${kind} 白名单`); continue }
        let size = 0
        try { size = statSync(abs).size } catch { }
        files.push({ path: abs, name: basename(abs), size, ext })
      }
      if (!files.length) return `没有可展示的文件：${problems.join('; ')}`
      if (kind === 'image' && files.length > 1) files = files.slice(0, 1)
    }

    // 参数声明清洗：只保留数值型滑块，避免前端拿到脏数据
    const params = (Array.isArray(input?.params) ? input.params : [])
      .filter(p => p && typeof p.name === 'string' && p.name.trim() && Number.isFinite(Number(p.value)))
      .slice(0, 8)
      .map(p => ({
        name: String(p.name).trim(),
        label: p.label ? String(p.label) : String(p.name).trim(),
        min: Number.isFinite(Number(p.min)) ? Number(p.min) : 0,
        max: Number.isFinite(Number(p.max)) ? Number(p.max) : Math.max(10, Number(p.value) * 2 || 10),
        step: Number.isFinite(Number(p.step)) && Number(p.step) > 0 ? Number(p.step) : 1,
        value: Number(p.value),
      }))

    const payload = {
      kind,
      title: input?.title ? String(input.title).slice(0, 120) : '',
      caption: input?.caption ? String(input.caption).slice(0, 500) : '',
      content,
      files,
      params,
      at: Date.now(),
    }

    if (typeof this.onPresent !== 'function') {
      // CLI 语境：没有渲染面板，说明情况即可，不当失败
      const what = needsContent ? `${content.length} 字符 ${kind} 源码` : `${files.length} 个文件`
      return `（当前终端无内联渲染能力，已跳过展示：${what}。Web 端会直接渲染。）`
    }

    try {
      this.onPresent(payload)
    } catch (e) {
      return `展示失败: ${e?.message || String(e)}`
    }

    const desc = needsContent
      ? `${kind} 内容（${content.length} 字符）`
      : `${files.length} 个${kind === 'video' ? '视频' : '图片'}：${files.map(f => f.name).join(', ')}`
    const extra = params.length ? `，附 ${params.length} 个可调参数` : ''
    return `已在对话中展示 ${desc}${extra}。用户现在能直接看到渲染结果。`
  }
}
