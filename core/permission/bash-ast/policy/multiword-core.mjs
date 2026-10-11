/**
 * 移植自 ZCode（Apache-2.0）
 * 源文件：apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-multiword-core.ts
 * 移植日期：2026-10-11
 */
import { dockerCommandIsDangerous, ghCommandIsDangerous } from './callbacks.mjs'
import { DOCKER_INSPECT_SAFE_FLAGS, DOCKER_LOGS_SAFE_FLAGS } from './flags.mjs'
export const READONLY_MULTIWORD_POLICY_ENTRIES_CORE = [
  [
    'docker inspect',
    {
      safeFlags: DOCKER_INSPECT_SAFE_FLAGS,
      additionalCommandIsDangerousCallback: dockerCommandIsDangerous },
  ],
  [
    'docker logs',
    {
      safeFlags: DOCKER_LOGS_SAFE_FLAGS,
      additionalCommandIsDangerousCallback: dockerCommandIsDangerous },
  ],
  [
    'gh auth status',
    {
      safeFlags: {
        '-a': 'none',
        '-h': 'string',
        '--active': 'none',
        '--hostname': 'string',
        '--json': 'string' },
      additionalCommandIsDangerousCallback: ghCommandIsDangerous,
    },
  ],
]
