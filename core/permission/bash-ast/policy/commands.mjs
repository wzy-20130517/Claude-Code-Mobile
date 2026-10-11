/**
 * 移植自 ZCode（Apache-2.0）
 * 源文件：apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-commands.ts
 * 移植日期：2026-10-11
 *
 * 聚合导出：把 simple-commands 的策略表与 git 子命令表 / 多词命令表合并成 Map。
 */
import { GIT_READONLY_SUBCOMMAND_POLICY_ENTRIES_CORE } from './git-subcommands-core.mjs'
import { GIT_READONLY_SUBCOMMAND_POLICY_ENTRIES_HISTORY } from './git-subcommands-history.mjs'
import { READONLY_MULTIWORD_POLICY_ENTRIES_CORE } from './multiword-core.mjs'
import { READONLY_MULTIWORD_POLICY_ENTRIES_GH } from './multiword-gh.mjs'
export { GIT_GLOBAL_DANGEROUS_FLAGS, GIT_GLOBAL_NO_VALUE_FLAGS, GIT_GLOBAL_VALUE_FLAGS, READONLY_ALLOW_ANY_ARG_COMMAND_PREFIXES, READONLY_ALLOW_ANY_ARG_COMMANDS, READONLY_COMMAND_POLICIES } from './simple-commands.mjs'
export const GIT_READONLY_SUBCOMMAND_POLICIES = new Map([
  ...GIT_READONLY_SUBCOMMAND_POLICY_ENTRIES_CORE,
  ...GIT_READONLY_SUBCOMMAND_POLICY_ENTRIES_HISTORY,
])
export const READONLY_MULTIWORD_COMMAND_POLICIES = new Map([
  ...READONLY_MULTIWORD_POLICY_ENTRIES_CORE,
  ...READONLY_MULTIWORD_POLICY_ENTRIES_GH,
])
