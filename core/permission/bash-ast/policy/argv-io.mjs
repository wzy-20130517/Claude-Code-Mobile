/**
 * 移植自 ZCode（Apache-2.0）
 * 源文件：apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-argv-io.ts
 * 移植日期：2026-10-11
 */
const SAFE_ENV_ASSIGNMENTS = new Set([
  'ANTHROPIC_API_KEY',
  'BLOCK_SIZE',
  'BLOCKSIZE',
  'CGO_ENABLED',
  'CHARSET',
  'CI',
  'CLICOLOR',
  'CLICOLOR_FORCE',
  'COLORTERM',
  'COLUMNS',
  'DEBIAN_FRONTEND',
  'FORCE_COLOR',
  'GCC_COLORS',
  'GIT_TERMINAL_PROMPT',
  'GO111MODULE',
  'GOARCH',
  'GOEXPERIMENT',
  'GOOS',
  'GREP_COLOR',
  'GREP_COLORS',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_TIME',
  'LINES',
  'LSCOLORS',
  'LS_COLORS',
  'NO_COLOR',
  'NODE_ENV',
  'PYTEST_DEBUG',
  'PYTEST_DISABLE_PLUGIN_AUTOLOAD',
  'PYTHONDONTWRITEBYTECODE',
  'PYTHONUNBUFFERED',
  'RUST_BACKTRACE',
  'RUST_LOG',
  'TERM',
  'TIME_STYLE',
  'TZ',
])
export function areEnvAssignmentsAllowed(commandPart) {
  return commandPart.envAssignments.every((assignment) => {
    return assignment.name !== undefined && SAFE_ENV_ASSIGNMENTS.has(assignment.name)
  })
}
const SAFE_INPUT_REDIRECTS = new Set(['<', '<<', '<&', '<<<'])
export function areRedirectsAllowed(commandPart) {
  for (const redirect of commandPart.redirects) {
    if (isUnsafeDeviceRedirectTarget(redirect.target))
      return false
    if (redirect.operator === '>&' && /^\d+$/.test(redirect.target))
      continue
    if (redirect.target === '/dev/null')
      continue
    if (SAFE_INPUT_REDIRECTS.has(redirect.operator)) {
      if (isUnsafeWindowsUncPath(redirect.target))
        return false
      continue
    }
    return false
  }
  return true
}
function isUnsafeDeviceRedirectTarget(target) {
  return /^\/dev\/(?:tcp|udp)\//.test(target)
}
export function isUnsafeWindowsUncPath(value) {
  return /^(?:\/\/|\\\\)[^/\\]/.test(value)
}
export function stripSafeCommandWrappers(argv) {
  let stripped = [...argv]
  for (;;) {
    if (stripped[0] === 'command') {
      let index = 1
      while (stripped[index] !== undefined && /^-p+$/.test(stripped[index] ?? ''))
        index += 1
      if (stripped[index] === '--')
        index += 1
      if (index >= stripped.length || stripped[index]?.startsWith('-'))
        return stripped
      stripped = stripped.slice(index)
      continue
    }
    if (stripped[0] === 'builtin') {
      const index = stripped[1] === '--' ? 2 : 1
      if (index >= stripped.length)
        return stripped
      stripped = stripped.slice(index)
      continue
    }
    if (stripped[0] === 'noglob') {
      if (stripped.length <= 1)
        return stripped
      stripped = stripped.slice(1)
      continue
    }
    return stripped
  }
}
