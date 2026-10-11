/**
 * 移植自 ZCode（Apache-2.0）
 * 源文件：apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-argv-git.ts
 * 移植日期：2026-10-11
 */
import { GIT_GLOBAL_DANGEROUS_FLAGS, GIT_GLOBAL_NO_VALUE_FLAGS, GIT_GLOBAL_VALUE_FLAGS, GIT_READONLY_SUBCOMMAND_POLICIES } from './commands.mjs'
import { isArgvAllowedByPolicy } from './argv-flags.mjs'
const GIT_ATTACHED_DANGEROUS_SHORT_FLAGS = ['-c', '-C']
export function isGitReadOnlyCommand(argv) {
  const normalized = normalizeGitArgv(argv)
  if (!normalized)
    return false
  for (const [commandPrefix, policy] of sortedGitPolicies()) {
    const prefixWords = commandPrefix.split(' ')
    if (!prefixWords.every((word, index) => normalized[index] === word))
      continue
    if (policy.additionalCommandIsDangerousCallback?.(commandPrefix, normalized.slice(prefixWords.length)))
      return false
    return isArgvAllowedByPolicy(normalized, policy, 'git', prefixWords.length)
  }
  return false
}
function normalizeGitArgv(argv) {
  const normalized = ['git']
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index]
    if (!word)
      continue
    if (GIT_GLOBAL_NO_VALUE_FLAGS.has(word))
      continue
    if (hasDangerousGitGlobalOptionWord(word))
      return undefined
    if (GIT_GLOBAL_VALUE_FLAGS.has(word)) {
      index += 1
      if (!argv[index])
        return undefined
      continue
    }
    if (word.startsWith('-'))
      return undefined
    normalized.push(...argv.slice(index))
    return normalized
  }
  return undefined
}
export function hasDangerousGitGlobalOption(argv) {
  return argv.some(hasDangerousGitGlobalOptionWord)
}
function hasDangerousGitGlobalOptionWord(word) {
  if (hasDangerousAttachedGitShortOptionWord(word))
    return true
  if (GIT_GLOBAL_DANGEROUS_FLAGS.has(word))
    return true
  return [...GIT_GLOBAL_DANGEROUS_FLAGS].some((flag) => word.startsWith(`${flag}=`))
}
function hasDangerousAttachedGitShortOptionWord(word) {
  return GIT_ATTACHED_DANGEROUS_SHORT_FLAGS.some((flag) => {
    return (word.length > flag.length &&
      word.startsWith(flag) &&
      (flag === '-C' || word[flag.length] !== '-'))
  })
}
let gitPoliciesByLength
function sortedGitPolicies() {
  gitPoliciesByLength ??= [...GIT_READONLY_SUBCOMMAND_POLICIES.entries()].sort((left, right) => {
    return right[0].split(' ').length - left[0].split(' ').length
  })
  return gitPoliciesByLength
}
