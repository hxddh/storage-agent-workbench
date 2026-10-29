import type { ToolName } from '@shared/contract'

export type ToolGroup = 'read' | 'query' | 'memory' | 'change_plan' | 'ask'
export type ToolCost = 'cheap' | 'moderate' | 'expensive'
export type ToolCoverage = 'account' | 'bucket' | 'object' | 'memory' | 'none'

/**
 * The one capability manifest. The prompt, the entry projection and the window
 * all read this list; adding a tool must not require editing three copies of
 * the same names.
 */
export interface ToolManifestEntry {
  name: ToolName
  group: ToolGroup
  /** Short line for the generated capability section. */
  description: string
  cost: ToolCost
  coverage: ToolCoverage
  readOnly: boolean
  /** A read-only code primitive that composes the other reads. */
  composition?: boolean
}

export const TOOL_MANIFEST: readonly ToolManifestEntry[] = [
  {
    name: 'survey',
    group: 'read',
    description: 'Account breadth: list buckets, read their posture and capacity, apply the rules.',
    cost: 'expensive',
    coverage: 'account',
    readOnly: true,
  },
  {
    name: 'buckets',
    group: 'read',
    description: 'Cheap bucket names and creation dates, before a deeper read.',
    cost: 'cheap',
    coverage: 'account',
    readOnly: true,
  },
  {
    name: 'objects',
    group: 'read',
    description: 'One bounded page of object keys, versions or incomplete uploads.',
    cost: 'moderate',
    coverage: 'bucket',
    readOnly: true,
  },
  {
    name: 'object',
    group: 'read',
    description:
      'One object: head, tags, ACL and a bounded text preview. Metadata names only, never values.',
    cost: 'cheap',
    coverage: 'object',
    readOnly: true,
  },
  {
    name: 'config',
    group: 'read',
    description: 'Bucket depth: exposure, lifecycle, observability or access evidence.',
    cost: 'expensive',
    coverage: 'bucket',
    readOnly: true,
  },
  {
    name: 'probe',
    group: 'read',
    description: 'Endpoint diagnostics: reachability, TLS, latency, region and addressing.',
    cost: 'cheap',
    coverage: 'bucket',
    readOnly: true,
  },
  {
    name: 'estate',
    group: 'memory',
    description: 'Remembered posture, open findings, notes and history.',
    cost: 'cheap',
    coverage: 'memory',
    readOnly: true,
  },
  {
    name: 'change_plan',
    group: 'change_plan',
    description: 'One deterministic, user-applied change text. Never applied by the app.',
    cost: 'cheap',
    coverage: 'bucket',
    readOnly: true,
  },
  {
    name: 'note',
    group: 'memory',
    description: 'Remember one short note for the estate or a bucket.',
    cost: 'cheap',
    coverage: 'memory',
    readOnly: true,
  },
  {
    name: 'accept_risk',
    group: 'memory',
    description:
      'Ask the user to confirm accepting a risk they asked to accept. Changes nothing itself.',
    cost: 'cheap',
    coverage: 'memory',
    readOnly: true,
  },
  {
    name: 'query',
    group: 'query',
    description: 'Read-only code over buckets, objects, capacity, access and datasets.',
    cost: 'expensive',
    coverage: 'account',
    readOnly: true,
    composition: true,
  },
  {
    name: 'ask',
    group: 'ask',
    description: 'Ask the user a question and end the turn until they answer.',
    cost: 'cheap',
    coverage: 'none',
    readOnly: true,
  },
]

export const TOOL_NAMES: readonly ToolName[] = TOOL_MANIFEST.map((tool) => tool.name)

export function toolEntry(name: ToolName): ToolManifestEntry | undefined {
  return TOOL_MANIFEST.find((tool) => tool.name === name)
}

/** The capability section is generated, not hand-maintained. */
export function manifestPrompt(): string {
  const rows = TOOL_MANIFEST.map(
    (tool) =>
      `- \`${tool.name}\` (${tool.group}, ${tool.cost}, ${tool.coverage}): ${tool.description}`,
  )
  return `Your tools (the window shows every call you make and what it returned):
${rows.join('\n')}

Each tool result carries an \`evidence\` id in its \`<untrusted-data>\` opening tag.`
}
