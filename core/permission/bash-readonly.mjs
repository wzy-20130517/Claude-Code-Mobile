// Bash 命令只读判定 —— 集成层。
//
// 【架构】两层分离，这里把它们接起来：
//   parser.mjs（移植自 ZCode）  —— unbash AST 解析 → BashCommandAnalysis
//   policy/（移植自 ZCode）     —— 策略表 + 判定逻辑 → true / false / undefined
//
// 【为什么需要这个集成层】
// 两层各自都做了移植验证，但接口没对接过：policy 期望**单个命令**（含 .argv），
// 而 parser 返回的是**整个命令行的分析结果**（.commands 数组）。
// 这个文件负责「整体判定」的语义 —— 那是策略层不管的部分。
//
// 【三态语义（关键，来自 ZCode 源设计）】
// evaluateBashReadonlyPolicy 返回：
//   true      —— 确认只读
//   false     —— 确认非只读（或明确危险）
//   undefined —— **无法判定**（未知命令、命令在表里但参数没覆盖）
//
// undefined 必须保守当「非只读」处理。直接用 `if (result)` 会把 undefined 当假
// 而恰好"安全"，但如果将来改成 `if (result !== false)` 就会放行一切未知命令。
// 所以这里统一用 `=== true`，把三态收敛成布尔。
//
// 【移植来源】
// 解析层 + 策略层移植自 ZCode（https://github.com/zai-org/ZCode，Apache-2.0），
// 2026-10-11。本集成层为 CCM 新增。

import { analyzeBashCommand } from './bash-ast/parser.mjs'
import { evaluateBashReadonlyPolicy } from './bash-ast/policy/index.mjs'

/**
 * 判断一条完整命令行是否「纯只读」。
 *
 * 判定为只读的条件（全部满足）：
 *   1. 解析无错误（hasParseErrors === false）
 *   2. 无动态词（hasDynamicWords === false）—— $(...)、反引号、未加引号的 glob
 *      都可能藏副作用，一律保守
 *   3. 至少有一个命令
 *   4. 每个命令都 `=== true`（策略层确认只读）
 *
 * @param {string} commandText 完整命令行
 * @returns {boolean} true = 确认只读；false = 含写操作或无法确认
 */
export function isReadonlyCommand(commandText) {
  const text = String(commandText ?? '').trim()
  if (!text) return false

  let analysis
  try {
    analysis = analyzeBashCommand(text)
  } catch {
    // 解析器抛异常（极端畸形输入）→ 保守拒绝
    return false
  }

  if (analysis.hasParseErrors) return false
  if (analysis.hasDynamicWords) return false
  if (!analysis.commands.length) return false

  // 三态收敛：只有明确 true 才算只读
  return analysis.commands.every(c => evaluateBashReadonlyPolicy(c) === true)
}

/**
 * 带理由的判定（给权限系统用，方便写进拒绝消息）。
 *
 * @param {string} commandText
 * @returns {{ readonly: boolean, reason?: string }}
 */
export function classifyBashCommand(commandText) {
  const text = String(commandText ?? '').trim()
  if (!text) return { readonly: false, reason: '空命令' }

  let analysis
  try {
    analysis = analyzeBashCommand(text)
  } catch (e) {
    return { readonly: false, reason: `解析失败：${e.message}` }
  }

  if (analysis.hasParseErrors) {
    const types = analysis.unsupportedNodeTypes?.join(', ') || '未知'
    return { readonly: false, reason: `命令含无法解析的语法（${types}）` }
  }
  if (analysis.hasDynamicWords) {
    return { readonly: false, reason: '命令含动态内容（$(...)、反引号或 glob）' }
  }
  if (!analysis.commands.length) {
    return { readonly: false, reason: '未解析出任何命令' }
  }

  for (const c of analysis.commands) {
    const r = evaluateBashReadonlyPolicy(c)
    if (r !== true) {
      return {
        readonly: false,
        reason: `命令「${c.commandText || c.name}」${r === false ? '含写操作' : '无法确认是否只读'}`,
      }
    }
  }
  return { readonly: true }
}
