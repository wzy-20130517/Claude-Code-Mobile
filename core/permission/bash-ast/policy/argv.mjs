/**
 * 移植自 ZCode（Apache-2.0）
 * 源文件：apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-argv.ts
 * 移植日期：2026-10-11
 */
import { READONLY_ALLOW_ANY_ARG_COMMANDS, READONLY_COMMAND_POLICIES, READONLY_MULTIWORD_COMMAND_POLICIES } from './commands.mjs'
import { isSedInPlaceOption } from './callbacks.mjs'
import { evaluateDirectReadonlyArgv, isFindWriteOption } from './argv-direct.mjs'
import { isArgvAllowedByPolicy } from './argv-flags.mjs'
import { hasDangerousGitGlobalOption, isGitReadOnlyCommand } from './argv-git.mjs'
import { areEnvAssignmentsAllowed, areRedirectsAllowed, isUnsafeWindowsUncPath, stripSafeCommandWrappers } from './argv-io.mjs'
export function evaluateBashReadonlyPolicy(commandPart) {
  if (!areEnvAssignmentsAllowed(commandPart))
    return false
  if (!areRedirectsAllowed(commandPart))
    return false
  const argv = stripSafeCommandWrappers(commandPart.argv)
  if (argv.length === 0)
    return false
  if (argv.some(isUnsafeWindowsUncPath))
    return false
  if (argv[0] === 'git')
    return isGitReadOnlyCommand(argv)
  const directArgvResult = evaluateDirectReadonlyArgv(argv)
  if (directArgvResult !== undefined)
    return directArgvResult
  const prefixPolicyResult = evaluateReadonlyPrefixPolicy(argv, commandPart.commandText)
  if (prefixPolicyResult !== undefined)
    return prefixPolicyResult
  if (READONLY_ALLOW_ANY_ARG_COMMANDS.has(argv[0] ?? ''))
    return true
  if (process.platform === 'win32' && argv[0] === 'xargs')
    return undefined
  const policy = READONLY_COMMAND_POLICIES.get(argv[0] ?? '')
  if (!policy)
    return undefined
  if (argv[0] === 'cd' && argv.length > 2)
    return false
  if (policy.additionalCommandIsDangerousCallback?.(commandPart.commandText, argv.slice(1)))
    return false
  if (!isArgvAllowedByPolicy(argv, policy, argv[0] ?? ''))
    return false
  if (policy.regex && !policy.regex.test(commandPart.commandText))
    return false
  return true
}
export function hasKnownBashWriteOption(commandPart) {
  const argv = stripSafeCommandWrappers(commandPart.argv)
  const commandName = argv[0]
  if (commandName === 'sed')
    return argv.some(isSedInPlaceOption)
  if (commandName === 'find')
    return argv.some(isFindWriteOption)
  if (commandName === 'tree')
    return treeArgvHasOutputOption(argv)
  if (commandName === 'git')
    return hasDangerousGitGlobalOption(argv)
  return false
}
function evaluateReadonlyPrefixPolicy(argv, commandText) {
  for (const [commandPrefix, policy] of sortedReadOnlyMultiwordPolicies()) {
    const prefixWords = commandPrefix.split(' ')
    if (!prefixWords.every((word, index) => argv[index] === word))
      continue
    const args = argv.slice(prefixWords.length)
    if (argsContainUnsafeSafeFlagText(args))
      return false
    if (policy.additionalCommandIsDangerousCallback?.(commandPrefix, args))
      return false
    if (!isArgvAllowedByPolicy(argv, policy, argv[0] ?? '', prefixWords.length))
      return false
    if (policy.regex && !policy.regex.test(commandText))
      return false
    return true
  }
  return undefined
}
let readOnlyMultiwordPoliciesByLength
function sortedReadOnlyMultiwordPolicies() {
  readOnlyMultiwordPoliciesByLength ??= [...READONLY_MULTIWORD_COMMAND_POLICIES.entries()].sort((left, right) => {
    return right[0].split(' ').length - left[0].split(' ').length
  })
  return readOnlyMultiwordPoliciesByLength
}
function argsContainUnsafeSafeFlagText(args) {
  return args.some((arg) => arg.includes('$') || (arg.includes('{') && (arg.includes(',') || arg.includes('..'))))
}
function treeArgvHasOutputOption(argv) {
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index]
    if (!word)
      continue
    if (word === '--')
      return false
    if (word === '-o' || word === '--output' || word.startsWith('--output='))
      return true
    if (word.startsWith('-') && !word.startsWith('--') && word.slice(1).includes('o'))
      return true
  }
  return false
}
