/**
 * 移植自 ZCode（Apache-2.0）
 * 源文件：apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy.ts
 * 移植日期：2026-10-11
 *
 * 公开入口：对外暴露 evaluateBashReadonlyPolicy / hasKnownBashWriteOption /
 * isSedInPlaceOption 三个 API，其余均为内部实现。
 */
export { evaluateBashReadonlyPolicy, hasKnownBashWriteOption } from './argv.mjs'
export { isSedInPlaceOption } from './callbacks.mjs'
