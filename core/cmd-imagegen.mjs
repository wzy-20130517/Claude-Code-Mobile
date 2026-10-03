// 生图配置命令（handleCommand 拆分第六批）
//
// 这批的新难点：要注入**交互层**（runWizard 需要 rl + fsSession）。
// 前五批都是纯逻辑，这是第一个带向导的命令。
//
// 【机械替换的两个坑，踩过记下来】
//   1. 对象简写 { rl, fsSession, C } 不能直接正则替换成 ctx.rl ——
//      那会生成 { ctx.rl, ... } 这种非法语法。必须先展开成 key: value。
//   2. 模板字符串里的内容不能跟着改缩进，否则用户看到的输出格式就变了。
//      所以抽取时保持原缩进，只在最外层包函数。

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

/**
 * @param {object} ctx
 *   C, maskKey, PROJECT_CONFIG_PATH
 *   getImageGenConfig, setImageGenConfig   core/tools-imagegen.mjs
 *   runWizard                              core/wizard.mjs
 *   rl        () => readline 实例
 *   fsSession () => 全屏会话（可能 null）
 */
export function makeImageGenCommand(ctx) {
  return {
    async imagegen(args) {
        // /imagegen                    查看配置
        // /imagegen url <base|完整端点> 生图 API 地址（base 自动拼 /images/generations，完整端点直用）
        // /imagegen key <key|$ENV>     密钥（支持 ${ENV} 占位符）
        // /imagegen model <名>         模型
        // /imagegen size <WxH|auto>    默认尺寸
        // /imagegen dir <目录>         保存目录
        // maskKey 由 ctx 注入，是（index.mjs 顶层），别在 case 内重新声明 —— switch 共享块作用域会撞 TDZ
        if (!args[0]) {
          const c = ctx.getImageGenConfig()
          const raw = (() => { try { return JSON.parse(readFileSync(ctx.PROJECT_CONFIG_PATH,'utf-8')).imageGen || {} } catch { return {} } })()
          if (!c || !raw.url && !raw.apiKey && !raw.model) return '生图未配置。\n用法:\n  /imagegen url <https://中转站/v1 或完整端点 .../v1/images/generations>\n  /imagegen key <密钥或${ENV}>\n  /imagegen model <模型名>\n  /imagegen size <宽x高|auto>\n  /imagegen dir <保存目录>'
          return `生图配置 (config.json imageGen):
  URL: ${c.url || '(未设置)'}
  Key: ${ctx.maskKey(raw.apiKey)}
  Model: ${c.model || '(未设置)'}
  Size: ${c.size}
  SaveDir: ${c.saveDir}

用法:
  /imagegen url <https://中转站/v1 或完整端点 .../v1/images/generations>
  /imagegen key <密钥或\${ENV}>
  /imagegen model <模型名>
  /imagegen size <宽x高|auto>
  /imagegen dir <保存目录>
  /imagegen clear   清空配置

${ctx.C.dim}生图有两种模式，都由 AI 调用 ImageGen 工具完成：
  文生图  说「画一张…」    → /images/generations
  图生图  说「改这张图…」+给出图片路径 → /images/edits（可加 mask 局部重绘）${ctx.C.reset}`
        }
        const [sub, ...rest] = args
        const val = rest.join(' ').trim()
        if (sub === 'clear') { ctx.setImageGenConfig({ url: '', apiKey: '', model: '' }); return '生图配置已清空' }
        if (sub === 'setup') {
          // 五项配置原来要敲五条命令，向导一次配完
          // 未配置时 ctx.getImageGenConfig() 返回 null，必须兜底成空对象
          const c0 = ctx.getImageGenConfig() || {}
          const a = await ctx.runWizard({
            rl: ctx.rl(), fsSession: ctx.fsSession(), C: ctx.C, title: '生图配置',
            steps: [
              { key: 'url', label: 'API 地址', required: true, default: c0.url || '',
                hint: 'https://中转站/v1',
                desc: 'base 会自动拼 /images/generations；填完整端点则直用',
                validate: v => /^https?:\/\//.test(v) ? null : '需以 http:// 开头' },
              { key: 'apiKey', label: 'API Key', secret: true, default: c0.apiKey || '',
                hint: 'sk-... 或 ${ENV}' },
              { key: 'model', label: '模型名', required: true, default: c0.model || '',
                hint: 'gpt-image-1' },
              { key: 'size', label: '默认尺寸', default: c0.size || '1024x1024',
                options: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
                validate: v => (v === 'auto' || /^\d{3,4}x\d{3,4}$/.test(v)) ? null : '格式应为 宽x高 或 auto' },
              // 字段名是 saveDir（ctx.setImageGenConfig 白名单里就这个），别写 dir 否则静默丢弃
              { key: 'saveDir', label: '保存目录', default: c0.saveDir || '', hint: '留空用默认' },
            ],
          })
          if (!a) return '已取消'
          const patch = { url: a.url.replace(/\/+$/, ''), model: a.model, size: a.size }
          if (a.apiKey) patch.apiKey = a.apiKey
          if (a.saveDir) patch.saveDir = a.saveDir
          ctx.setImageGenConfig(patch)
          return [
            `${ctx.C.green}✓${ctx.C.reset} 生图配置已保存`,
            `  URL:   ${patch.url}`,
            `  Model: ${patch.model}`,
            `  Size:  ${patch.size}`,
            `  Key:   ${a.apiKey ? ctx.maskKey(a.apiKey) : ctx.C.dim + '(未改)' + ctx.C.reset}`,
          ].join('\n')
        }
        if (!val) return `用法: /imagegen ${sub} <值>`
        switch (sub) {
          case 'url': {
            const u = val.replace(/\/+$/, '')
            ctx.setImageGenConfig({ url: u })
            const endpoint = /\/images\/generations$/i.test(u) ? u : `${u}/images/generations`
            return `生图 URL 已设置: ${u}\n(文生图: ${endpoint})\n(图生图: ${endpoint.replace(/\/images\/generations$/i, '/images/edits')})\n${ctx.C.dim}提示：也可填完整端点（以 /images/generations 结尾）；图生图时会自动换成 /images/edits${ctx.C.reset}`
          }
          case 'key':
            ctx.setImageGenConfig({ apiKey: val })
            return `生图 Key 已设置: ${ctx.maskKey(val)}${val.includes('${') ? ' (环境变量引用)' : ''}`
          case 'model':
            ctx.setImageGenConfig({ model: val })
            return `生图模型已设置: ${val}`
          case 'size': {
            if (val !== 'auto' && !/^\d{3,4}x\d{3,4}$/.test(val)) return '尺寸格式应为 宽x高（如 1024x1024）或 auto'
            ctx.setImageGenConfig({ size: val })
            return `生图默认尺寸已设置: ${val}`
          }
          case 'dir': {
            ctx.setImageGenConfig({ saveDir: val.startsWith('~') ? val.replace(/^~/, homedir()) : val })
            return `生图保存目录已设置: ${val}`
          }
          default:
            return `未知子命令: ${sub}\n用法: /imagegen setup|url|key|model|size|dir|clear`
        }
    },
  }
}
