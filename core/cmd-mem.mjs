// 结构化记忆命令 /mem（handleCommand 拆分第九批）
//
// 跟 /memory（管 CLAUDE.md）不是一回事 —— /mem 管的是
// ~/.claude-code-mobile/memories/ 下的结构化记忆条目。
// 历史上曾把 mem 误映射成 memory 的别名，直接把这个命令覆盖没了，
// 所以两者必须各自独立（见 index.mjs 的 COMMAND_ALIASES 注释）。

// MEMORY_TYPES 是常量，直接 import 而不走 ctx —— 它不会变，
// 走注入只是让 ctx 变胖。（⚠ 第一版漏了它：依赖扫描只找「后跟 ( 或 . 的
// 标识符」，纯值引用的常量扫不出来，运行时才报 ReferenceError。）
import { MEMORY_TYPES } from './memdir.mjs'

/**
 * @param {object} ctx
 *   C                     颜色表
 *   incognito             () => 是否隐身会话（隐身下禁用，不往磁盘写记忆）
 *   getMemoryDir          () => 记忆目录
 *   listMemories / formatMemoryList / findRelevantMemories
 *   saveMemory / deleteMemory
 */
export function makeMemCommand(ctx) {
  return {
    mem(args) {
        if (ctx.incognito()) return 'Incognito 会话禁用 /mem'
        const sub = String(args[0] || 'list').toLowerCase()
        const dir = ctx.getMemoryDir()

        if (sub === 'list' || sub === 'ls') {
          return ctx.formatMemoryList(ctx.listMemories({ dir }), { dir })
        }
        if (sub === 'find' || sub === 'search') {
          const q = args.slice(1).join(' ').trim()
          if (!q) return '用法: /mem find <关键词>'
          const hits = ctx.findRelevantMemories(q, { dir })
          if (!hits.length) return `没有匹配「${q}」的记忆`
          return ctx.formatMemoryList(hits, { dir })
        }
        if (sub === 'show' || sub === 'cat') {
          const rel = args[1]
          if (!rel) return '用法: /mem show <相对路径>'
          const hit = ctx.listMemories({ dir }).find(m => m.rel === rel || m.rel === `${rel}.md`)
          if (!hit) return `找不到记忆: ${rel}`
          return `${hit.rel}\ntype: ${hit.type}\n${hit.description ? `${hit.description}\n` : ''}\n${hit.body}`
        }
        if (sub === 'save' || sub === 'add') {
          // /mem save <类型> <路径> <说明> :: <正文>
          const type = String(args[1] || '').toLowerCase()
          if (!MEMORY_TYPES.includes(type)) {
            return `用法: /mem save <${MEMORY_TYPES.join('|')}> <路径> <说明> :: <正文>\n例: /mem save feedback style/tone 用户要求直接 :: 不要客套话`
          }
          const rest = args.slice(2).join(' ')
          const [headPart, bodyPart = ''] = rest.split('::')
          const bits = headPart.trim().split(/\s+/)
          const rel = bits.shift()
          if (!rel) return '缺少路径'
          const description = bits.join(' ')
          if (!bodyPart.trim() && !description) return '至少要有说明或正文'
          try {
            const saved = ctx.saveMemory({ dir, rel, name: rel.split('/').pop(), description, type, body: bodyPart.trim() || description })
            return `已保存: ${saved.rel}\n${dir}`
          } catch (e) {
            return `保存失败: ${e.message}`
          }
        }
        if (sub === 'rm' || sub === 'delete') {
          const rel = args[1]
          if (!rel) return '用法: /mem rm <相对路径>'
          try {
            return ctx.deleteMemory({ dir, rel }) ? `已删除: ${rel}` : `找不到: ${rel}`
          } catch (e) {
            return `删除失败: ${e.message}`
          }
        }
        if (sub === 'dir') return dir
        return `结构化记忆（按需检索，不像 CLAUDE.md 每轮都注入）

/mem list                查看全部
/mem find <关键词>       按相关性检索
/mem show <路径>         看某一条
/mem save <类型> <路径> <说明> :: <正文>
/mem rm <路径>           删除
/mem dir                 记忆库位置

类型: ${MEMORY_TYPES.join(' / ')}
  user       关于你的长期事实
  feedback   你对做事方式的要求（同分时优先注入）
  project    项目结构与决策
  reference  查阅型资料

目录: ${dir}`
    },
  }
}
