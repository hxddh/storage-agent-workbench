import type { ToolName } from '@shared/contract'

/**
 * The tools the extension registers, by name. What each one does is in its own
 * description, which pi sends with its schema; the prompt does not list them a
 * second time.
 */
export const TOOL_NAMES: readonly ToolName[] = [
  'buckets',
  'objects',
  'object',
  'config',
  'account',
  'probe',
  'query',
  'note',
  'ask',
]
