/**
 * 移植自 ZCode（Apache-2.0）
 * 源文件：apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-argv-flags.ts
 * 移植日期：2026-10-11
 */
import { XARGS_TARGET_COMMANDS } from './callbacks.mjs'
import { OPTION_PATTERN } from './flags.mjs'
export function isArgvAllowedByPolicy(argv, policy, commandName, startIndex = 1) {
  if (argv.length === 0)
    return false
  if (policy.allowAnyArgs)
    return true
  if (policy.commandOnly)
    return argv.length === startIndex
  if (policy.safeFlags)
    return flagsAndPositionalsAllowed(argv, policy, commandName, startIndex)
  return false
}
function flagsAndPositionalsAllowed(argv, policy, commandName, startIndex) {
  const safeFlags = policy.safeFlags ?? {}
  let index = startIndex
  while (index < argv.length) {
    const word = argv[index]
    if (!word) {
      index += 1
      continue
    }
    if (commandName === 'xargs' && (!word.startsWith('-') || word === '--')) {
      const targetCommand = word === '--' ? argv[index + 1] : word
      if (!targetCommand || !XARGS_TARGET_COMMANDS.has(targetCommand))
        return false
      break
    }
    if (word === '--') {
      if (policy.respectsDoubleDash === false) {
        index += 1
        continue
      }
      break
    }
    if (isHeadTailCompactCountFlag(commandName, word)) {
      index += 1
      continue
    }
    if (policy.allowCompactNumericCountFlag && isCompactNumericCountFlag(word)) {
      index += 1
      continue
    }
    if (word.startsWith('-') && word.length > 1 && OPTION_PATTERN.test(word)) {
      const parsed = parseOptionWord(word)
      const flagValue = safeFlags[parsed.flag]
      if (!flagValue) {
        const shortAttached = parseShortFlagWithAttachedValue(word, safeFlags)
        if (shortAttached) {
          if (!isOptionLikeStringValueAllowed(shortAttached.value, commandName, shortAttached.flag))
            return false
          if (!matchesFlagValueKind(shortAttached.value, shortAttached.kind))
            return false
          index += 1
          continue
        }
        if (isShortFlagClusterAllowed(parsed.flag, safeFlags)) {
          index += 1
          continue
        }
        return false
      }
      if (flagValue === 'none') {
        if (parsed.hasInlineValue)
          return false
        index += 1
        continue
      }
      if (flagValue === 'optionalString') {
        // 只拦截独立 argv 里看起来像 option 的字符串，避免误吞下一段参数。
        index += 1
        continue
      }
      const value = parsed.hasInlineValue ? parsed.inlineValue : argv[index + 1]
      if (!isUsableFlagValue(value))
        return false
      if (flagValue === 'string' &&
        !parsed.hasInlineValue &&
        !isOptionLikeStringValueAllowed(value, commandName, parsed.flag))
        return false
      if (!matchesFlagValueKind(value, flagValue))
        return false
      index += parsed.hasInlineValue ? 1 : 2
      continue
    }
    index += 1
  }
  return true
}
function parseShortFlagWithAttachedValue(word, safeFlags) {
  if (!word.startsWith('-') || word.startsWith('--') || word.length <= 2)
    return undefined
  const flag = word.slice(0, 2)
  const kind = safeFlags[flag]
  if (!kind || kind === 'none')
    return undefined
  return { flag, kind, value: word.slice(2) }
}
function isHeadTailCompactCountFlag(commandName, word) {
  return (commandName === 'head' || commandName === 'tail') && /^-\d+$/.test(word)
}
function isCompactNumericCountFlag(word) {
  return /^-\d+$/.test(word)
}
function parseOptionWord(word) {
  const equalsIndex = word.indexOf('=')
  if (equalsIndex < 0)
    return { flag: word, hasInlineValue: false, inlineValue: '' }
  return {
    flag: word.slice(0, equalsIndex),
    hasInlineValue: true,
    inlineValue: word.slice(equalsIndex + 1) }
}
function isShortFlagClusterAllowed(flag, safeFlags) {
  if (!flag.startsWith('-') || flag.startsWith('--') || flag.length <= 2)
    return false
  for (const flagName of flag
    .slice(1)
    .split('')
    .map((name) => `-${name}`)) {
    if (safeFlags[flagName] !== 'none')
      return false
  }
  return true
}
function isUsableFlagValue(value) {
  return value !== undefined
}
function isOptionLikeStringValueAllowed(value, commandName, flag) {
  if (!value.startsWith('-') || value.length <= 1 || !OPTION_PATTERN.test(value))
    return true
  return commandName === 'git' && flag === '--sort' && /^-[a-zA-Z]/.test(value)
}
function matchesFlagValueKind(value, kind) {
  switch (kind) {
    case 'none':
      return false
    case 'number':
      return /^\d+$/.test(value)
    case 'optionalString':
      return true
    case 'string':
      return true
    case 'char':
      return value.length === 1
    case '{}':
      return value === '{}'
    case 'EOF':
      return value === 'EOF'
  }
}
