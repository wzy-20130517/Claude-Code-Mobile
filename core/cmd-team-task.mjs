// 多 Agent 协作与任务命令（handleCommand 拆分第十五批）
//
// /team   团队全景（成员、任务数、未读消息）
// /tasks  持久化待办清单
// /away   离场报告（不在场时发生了什么）
//
// 这三个都是零外层 let 写回 —— 纯读取 + 打印，是最容易拆的一类。
// 相比之下 /resume 要写回 4 个外层 let（sessionId/sessionTitle/todos/incognitoMode），
// 拆出去要 4 个 setter 回调，ctx 比原码还长，所以留在 handleCommand 里。

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// formatTasks / TASK_DEFAULT_LIST 是纯函数与常量，直接 import 不走 ctx。
// （⚠ 预检第三次抓到这类漏改了：纯值引用和未 ctx 化的纯函数，
//   node --check 与单元测试都放过，只有预检的运行期标识符检查能发现。）
import { formatTasks, TASK_DEFAULT_LIST } from './tasks.mjs'

/**
 * @param {object} ctx
 *   C
 *   listTeams / teamOverview / formatTeamOverview / inboxCounts / deleteTeam   core/team.mjs
 *   listTasks / listTaskLists / resetTaskList                                 core/tasks.mjs
 */
export function makeTeamTaskCommands(ctx) {
  return {
    team(args) {
        // 多 Agent 协作的观察窗口。团队名 = 任务列表名，所以 /team X 和 /tasks X 看的是同一批活。
        const sub = (args[0] || '').toLowerCase()
        if (!sub || sub === 'list') {
          const all = ctx.listTeams()
          if (!all.length) return '(还没有任何团队)\n协作会由 AI 在需要分工时用 TeamCreate 建立'
          const counts = all.map(t => {
            const ov = ctx.teamOverview(t.name)
            const unread = Object.values(ctx.inboxCounts(t.name)).reduce((s, x) => s + x.unread, 0)
            return `[${t.name}] ${t.members.length} 成员 · 任务 ${ov.tasks.completed}/${ov.tasks.total}` +
              (unread ? ` · 未读 ${unread}` : '') + (t.description ? `\n  ${t.description}` : '')
          })
          return `协作团队（共 ${all.length}）\n${counts.join('\n')}\n\n用法: /team <名称> 看详情 · /team disband <名称> 解散`
        }
        if (sub === 'disband') {
          if (!args[1]) return '用法: /team disband <团队名>'
          const r = ctx.deleteTeam(args[1])
          return r.ok ? `已解散 [${args[1]}]${r.removedTasks ? `，清除 ${r.removedTasks} 条任务` : ''}` : `团队 [${args[1]}] 不存在`
        }
        const ov = ctx.teamOverview(sub)
        if (!ov) return `团队 [${sub}] 不存在。/team 看全部`
        return ctx.formatTeamOverview(ov) + `\n\n任务明细用 /tasks ${sub}`
    },

    tasks(args) {
        // 持久化 Task 的查看入口。跟 /bg-list 不是一回事：
        // bg-list 是「正在跑的进程」，tasks 是「要做的事」（跨重启存活）。
        const sub = (args[0] || '').toLowerCase()
        const listId = args[1] || TASK_DEFAULT_LIST
        if (sub === 'clear') {
          const n = ctx.resetTaskList(args[1] || TASK_DEFAULT_LIST)
          return `已清空任务列表 [${args[1] || TASK_DEFAULT_LIST}]，删除 ${n} 条`
        }
        if (sub === 'lists') {
          const ls = ctx.listTaskLists()
          return ls.length ? `任务列表:\n  ${ls.join('\n  ')}` : '(还没有任何任务列表)'
        }
        const target = sub && sub !== 'all' ? sub : TASK_DEFAULT_LIST
        const tasks = ctx.listTasks(target)
        const done = tasks.filter(t => t.status === 'completed').length
        const doing = tasks.filter(t => t.status === 'in_progress').length
        return `任务列表 [${target}] 共 ${tasks.length} 条（进行中 ${doing} · 已完成 ${done}）\n` +
          `${formatTasks(tasks)}\n\n` +
          `用法: /tasks [列表名] · /tasks lists 看所有列表 · /tasks clear [列表名] 清空`
    },

    away(args) {
        // /away  查看「你不在时」自动接续做了什么（离场成果报告）
        // /away clear  清空报告
        const awayPath = join(homedir(), '.claude-code-mobile', 'away-report.log')
        if (String(args[0] || '').toLowerCase() === 'clear') {
          try { if (existsSync(awayPath)) writeFileSync(awayPath, '', 'utf-8') } catch {}
          return '离场报告已清空'
        }
        if (!existsSync(awayPath)) return '暂无离场报告（重启后自动接续任务时才会生成）'
        let text = ''
        try { text = readFileSync(awayPath, 'utf-8').trim() } catch (e) { return `读取失败: ${e.message}` }
        if (!text) return '暂无离场报告'
        // 默认只显示最近 3 段，避免刷屏；/away all 看全部
        const blocks = text.split('='.repeat(60)).map(b => b.trim()).filter(Boolean)
        const showAll = String(args[0] || '').toLowerCase() === 'all'
        const picked = showAll ? blocks : blocks.slice(-3)
        const head = `离场报告（共 ${blocks.length} 段${showAll ? '' : '，显示最近 ' + picked.length + ' 段；/away all 看全部'}）\n`
        return head + picked.map(b => '─'.repeat(50) + '\n' + b).join('\n\n') + `\n\n（/away clear 清空）`
    },
  }
}
