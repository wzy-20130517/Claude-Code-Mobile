// 会话操作命令批（handleCommand 拆分第十四批 · 2026-09-23）
//
// 这些命令原来只存在于 index.mjs 的 switch 里，Web（APK）够不着。
// APK 里 index.mjs 根本不启动（ccm-start.mjs 直接拉 web/server.mjs），
// 所以「只写在 index.mjs 的命令」= APK 上不存在。
//
// 本批把已经模块化好的（实现就在 cmd-extensions.mjs，只是没进注册表）搬上来：
//   /branch   从当前会话分叉出新会话
//   /rewind   单文件改动回滚（multiUndo）
//   /copy     复制会话全文到剪贴板
//   /add-dir  把目录加入上下文白名单
//   /review   代码审查（给出 diff 视角的审查提示）
//   /plugins  插件列表
//   /x11      X11 图形环境配置
//
// 【为什么单独一个文件而不是塞进 cmd-misc】cmd-misc 管的是保活/回收站/字体，
// 这批管的是会话操作，混在一起下次找命令要翻两个语义域。

import { cmdBranch, cmdRewind, cmdCopy, cmdAddDir, cmdReview, cmdPlugins, cmdX11 } from './cmd-extensions.mjs'

/**
 * @param {object} ctx
 *   multiUndo          MultiUndoStore（/rewind 用）
 *   agent
 *   sessionStore
 *   sessionId          () => string
 *   todos              () => array
 *   copyToClipboard    (text) => Promise<void> | void  可选，缺省退化为「其实我复制不了」
 */
export function makeSessionExtraCommands(ctx) {
  return {
    /**
     * /branch — 从当前会话分叉出新会话，便于「保留主线、试另一条路」。
     *
     * 【为什么要先保存】分叉点必须在当前会话的最新状态上，
     * 不然新分支会从「上次自动保存时的旧内容」长出来，丢掉最近几轮。
     */
    branch(args) {
      try { ctx.saveSession() } catch { /* 存不下仍允许分叉，只是分叉点可能偏旧 */ }
      return cmdBranch(ctx.sessionStore, ctx.sessionId(), ctx.agent, ctx.todos(), args)
    },

    /**
     * /rewind — 回滚文件改动（多步撤销）。
     *
     * ⚠ Incognito 会话禁用：隐私模式的历史不落盘，回滚会去读不存在的快照。
     * CLI 侧原来在 switch 里判 incognito，搬到模块后同样要判。
     */
    rewind(args) {
      if (ctx.incognito?.()) return 'Incognito 会话禁用 /rewind'
      return cmdRewind(ctx.multiUndo, ctx.agent, ctx.sessionStore, ctx.sessionId(), args)
    },

    /** /copy — 把当前会话全文复制到剪贴板 */
    copy() {
      return cmdCopy(ctx.agent)
    },

    /**
     * /add-dir <路径> — 加进上下文可读目录白名单。
     *
     * ⚠ Incognito 下禁止添加本项目目录：隐私模式的意义是「不进历史文件」，
     * 而把 claude-code-mobile 整个目录加进上下文等于把它自己（含会话存档、
     * 回收站、可能还有 key）读进来。CLI 侧原来在 switch 里判，搬过来同样要判。
     */
    'add-dir'(args) {
      if (ctx.incognito?.() && args.some(ctx.isProtectedPath || (() => false))) {
        return 'Incognito 禁止添加 claude-code-mobile'
      }
      return cmdAddDir(args)
    },

    /** /review — 代码审查（把改动喂给 agent 做 review 视角的分析） */
    review(args) {
      if (ctx.incognito?.()) return 'Incognito 会话禁用 /review'
      return cmdReview(args)
    },

    /** /plugins — 列出已装插件 */
    plugins(args) {
      return cmdPlugins(args)
    },

    /** /x11 — X11 图形环境（mcp.json 里登记 x11 服务器） */
    x11(args) {
      return cmdX11(args, './mcp.json')
    },
  }
}
