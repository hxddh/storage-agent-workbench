import type { Table } from '@shared/contract'
import { generateFix, impactPreview } from '../estate/fixes'
import { BY_CODE, ruleTitle } from '../estate/rules'
import { redact } from '../security/redact'
import { agentTool, assertInScope, bucketParam, providerParam, type ToolDeps, Type } from './policy'

function dim(value: unknown): string {
  return value === 'available'
    ? 'on'
    : value === 'not_configured'
      ? 'off'
      : value === 'partial'
        ? 'partial'
        : '?'
}

function age(iso: string | null): string {
  if (!iso) return 'never'
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)
  return days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`
}

export function estateTools(deps: ToolDeps) {
  return [
    agentTool(deps, {
      name: 'estate',
      description:
        'Read what the agent remembers: recorded bucket posture, open Issues with their history, and notes. Use it before asking the user to repeat anything.',
      parameters: Type.Object({
        provider_id: providerParam,
        bucket: Type.Optional(
          Type.String({ description: 'Narrow Issues and notes to one bucket.' }),
        ),
        notes: Type.Optional(Type.Boolean({ description: 'Include notes (default true).' })),
      }),
      timeoutMs: 20_000,
      target: (args) => args.bucket ?? 'memory',
      run: async (args, run) => {
        const config = await deps.providers.resolve(args.provider_id)
        await run.setTarget(config.name)
        const lang = deps.lang()
        const buckets = await deps.db.listBuckets(config.id)
        const table: Table = {
          columns: ['Bucket', 'Public', 'Encryption', 'Access block', 'Lifecycle', 'Checked'],
          rows: buckets.map((row) => {
            let posture: Record<string, unknown> = {}
            try {
              posture = row.posture_json
                ? (JSON.parse(row.posture_json) as Record<string, unknown>)
                : {}
            } catch {
              posture = {}
            }
            return [
              row.name,
              posture.publicly_exposed === true
                ? 'public'
                : posture.publicly_exposed === false
                  ? 'no'
                  : 'unknown',
              dim(posture.encryption_status),
              dim(posture.public_access_block_status),
              dim(posture.lifecycle_status),
              row.posture_at ? row.posture_at.slice(0, 10) : '—',
            ]
          }),
        }
        const issues = (await deps.estate.issueRows(config.id, lang, 100)).filter(
          (issue) => !args.bucket || issue.bucket === args.bucket,
        )
        const notes =
          args.notes === false
            ? []
            : await deps.db.listNotes({
                scope: args.bucket ? 'bucket' : undefined,
                ref: args.bucket ? `${config.id}/${args.bucket}` : undefined,
                limit: 20,
              })
        const newest = buckets.reduce<string | null>(
          (at, row) => (row.posture_at && (!at || row.posture_at > at) ? row.posture_at : at),
          null,
        )
        const oldest = buckets.reduce<string | null>(
          (at, row) => (row.posture_at && (!at || row.posture_at < at) ? row.posture_at : at),
          null,
        )
        const open = issues.filter((issue) => issue.status === 'open')
        const accepted = issues.length - open.length
        const lines = [
          `${config.name}: ${buckets.length} bucket(s) remembered, read ${age(oldest)}${
            oldest !== newest ? ` to ${age(newest)}` : ''
          }. ${open.length} open Issue(s)${accepted ? `, ${accepted} accepted by the user` : ''}.`,
          'This is memory, not a fresh read: survey when the question is about the current state.',
          ...open
            .slice(0, 8)
            .map(
              (issue) =>
                `[${issue.severity}] ${issue.title} — ${issue.bucket}${issue.detail ? ` (${issue.detail})` : ''}`,
            ),
          ...notes.slice(0, 6).map((note) => `note: ${note.text.slice(0, 160)}`),
        ]
        return {
          model: lines.join('\n'),
          target: config.name,
          note: `${buckets.length} bucket${buckets.length === 1 ? '' : 's'} · ${issues.length} issue${issues.length === 1 ? '' : 's'}`,
          view: {
            kind: 'estate' as const,
            providerId: config.id,
            bucket: args.bucket ?? null,
            readAt: oldest,
            buckets: table,
            issues,
            notes: notes.map((note) => ({
              id: note.id,
              scope: note.scope,
              ref: note.ref,
              text: note.text,
              author: note.author,
              createdAt: note.created_at,
            })),
          },
        }
      },
    }),

    agentTool(deps, {
      name: 'fix',
      description:
        'Generate the fix text for one Open Issue: an AWS CLI command, a Terraform resource and the API document, plus an impact preview from what the estate already knows. Read-only; the user applies it.',
      parameters: Type.Object({
        provider_id: providerParam,
        bucket: bucketParam,
        code: Type.String({
          description: `Issue code, one of: ${[...BY_CODE.keys()].join(', ')}.`,
        }),
      }),
      timeoutMs: 20_000,
      target: (args) => args.bucket,
      run: async (args, _run) => {
        const config = await deps.providers.resolve(args.provider_id)
        assertInScope(config, args.bucket)
        const issue = await deps.db.findIssue(config.id, args.bucket, args.code)
        if (!issue || issue.status === 'resolved')
          throw new Error(
            `No open Issue '${args.code}' on ${args.bucket}. Survey or review it first.`,
          )
        const rule = BY_CODE.get(args.code)
        if (!rule) throw new Error(`Unknown Issue code: ${args.code}`)
        const fix = generateFix(rule, args.bucket, config.endpoint || null, config.region || null)
        if (!fix) {
          throw new Error(
            `No safe generated fix exists for '${args.code}' — it depends on intent (policy principals or CORS origins) the rule cannot know.`,
          )
        }
        const posture = await deps.estate.postureOf(config.id, args.bucket)
        const impact = impactPreview(rule, posture, posture?.lifecycle_status === 'available')
        return {
          model: [
            `${issue.severity} ${ruleTitle(rule, deps.lang())} on ${args.bucket}.`,
            fix.formats[0]?.text ?? '',
            ...fix.notes.map((note) => `note: ${note}`),
            `Impact: ${impact.verdict}. ${impact.reasons.join(' ')}`,
            ...(impact.gap ? [`Cannot tell: ${impact.gap}`] : []),
          ].join('\n'),
          note: impact.verdict,
          view: {
            kind: 'fix' as const,
            providerId: config.id,
            bucket: args.bucket,
            code: args.code,
            formats: fix.formats,
            impact,
          },
        }
      },
    }),

    agentTool(deps, {
      name: 'note',
      description:
        'Remember one short fact about the estate, an account or a bucket — a deliberate setting, an owner, an accepted risk. Do not use it for transient observations.',
      parameters: Type.Object({
        text: Type.String({ description: 'The note, at most 1000 characters.' }),
        scope: Type.Optional(
          Type.Union([Type.Literal('estate'), Type.Literal('provider'), Type.Literal('bucket')], {
            description: 'Where the note belongs; default estate.',
          }),
        ),
        bucket: Type.Optional(Type.String({ description: 'Bucket name when scope is bucket.' })),
        provider_id: providerParam,
      }),
      timeoutMs: 10_000,
      target: () => 'note',
      run: async (args) => {
        const text = redact(args.text).trim().slice(0, 1000)
        if (text.length < 3) throw new Error('The note is empty.')
        const scope = args.scope ?? 'estate'
        let ref: string | null = null
        if (scope !== 'estate') {
          const config = await deps.providers.resolve(args.provider_id)
          ref = scope === 'bucket' ? `${config.id}/${args.bucket ?? ''}` : config.id
          if (scope === 'bucket' && !args.bucket)
            throw new Error('A bucket note needs a bucket name.')
        }
        const total = await deps.db.countNotes()
        if (total >= 500)
          throw new Error('Memory is full (500 notes). Remove a note before adding another.')
        const note = await deps.db.insertNote({ scope, ref, text, author: 'agent' })
        return {
          model: `Remembered (${scope}): ${text}`,
          note: 'saved',
          view: { kind: 'note' as const, text: note.text },
        }
      },
    }),
  ]
}
