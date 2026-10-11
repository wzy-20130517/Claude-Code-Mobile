/**
 * 移植自 ZCode（Apache-2.0）
 * 源文件：apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-types.ts
 * 移植日期：2026-10-11
 *
 * 原文件是纯 TypeScript 类型定义（编译后为空），此处转为 JSDoc 保留语义。
 * 运行时不导出任何值；import 本文件只为拿到类型提示。
 */

/**
 * 安全 flag 的取值形态。决定该 flag 后面跟什么才算合法：
 * - `"none"`          —— 纯开关，不接值
 * - `"string"`        —— 必须接一个字符串值
 * - `"optionalString"`—— 可接可不接
 * - `"number"`        —— 必须接数字
 * - `"char"`          —— 必须接单个字符
 * - `"{}"`            —— 值必须字面等于 `{}`
 * - `"EOF"`           —— 值必须字面等于 `EOF`
 *
 * @typedef {"{}" | "EOF" | "char" | "none" | "number" | "optionalString" | "string"} SafeFlagValue
 */

/**
 * 单条只读策略。
 *
 * @typedef {object} BashReadonlyCommandPolicy
 * @property {(commandText: string, argsAfterPrefix: readonly string[]) => boolean} [additionalCommandIsDangerousCallback]
 *   额外危险判定回调：返回 true 表示该命令危险（非只读），即使 flag 表通过了也拒绝。
 * @property {boolean} [allowAnyArgs]    允许任意参数（如 ls / cat）
 * @property {boolean} [allowCompactNumericCountFlag]
 *   允许紧凑数字计数 flag，如 `head -20` / `tail -5`（需策略显式声明）
 * @property {boolean} [commandOnly]     只允许裸命令、不允许任何参数（如 alias）
 * @property {RegExp}  [regex]           整条命令文本必须匹配此正则才算通过
 * @property {boolean} [respectsDoubleDash]
 *   默认 true；设 false 表示 `--` 之后的参数也继续按 flag 解析
 * @property {Readonly<Record<string, SafeFlagValue>>} [safeFlags]
 *   安全 flag 白名单表
 */

export {}
