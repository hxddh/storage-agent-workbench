import type { Table } from '@shared/contract'
import { generateFix, impactPreview } from '../estate/fixes'
import { ACCOUNT_SCOPE, BY_CODE, ruleTitle } from '../estate/rules'
import { redact } from '../security/redact'
import { agentTool, assertInScope, providerParam, type ToolDeps, Type } from './policy'

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
        'Read what the agent remembers: recorded bucket posture, open and accepted Issues, notes, and — with history — what happened to those Issues and the posture over time. Use it before asking the user to repeat anything.',
      parameters: Type.Object({
        provider_id: providerParam,
        bucket: Type.Optional(
          Type.String({ description: 'Narrow Issues, history and notes to one bucket.' }),
        ),
        code: Type.Optional(
          Type.String({ description: 'Narrow Issues and history to one rule code.' }),
        ),
        history: Type.Optional(
          Type.Boolean({
            description:
              'Include Issue life-cycle events (opened, resolved, recurred, gone, accepted, reopened) and posture changes.',
          }),
        ),
        since: Type.Optional(
          Type.String({
            description: 'Only history at or after this ISO date or timestamp, e.g. 2026-10-01.',
          }),
        ),
        notes: Type.Optional(Type.Boolean({ description: 'Include notes (default true).' })),
      }),
      timeoutMs: 20_000,
      target: (args) => args.bucket ?? 'memory',
      run: async (args, run) => {
        if (args.since && Number.isNaN(Date.parse(args.since)))
          throw new Error('since must be an ISO date or timestamp, e.g. 2026-10-01.')
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
          (issue) =>
            (!args.bucket || issue.bucket === args.bucket) &&
            (!args.code || issue.code === args.code),
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
        let historyTable: Table | undefined
        if (args.history) {
          const eventRows = await deps.db.listIssueEvents({
            providerId: config.id,
            bucket: args.bucket,
            code: args.code,
            since: args.since,
            limit: 80,
          })
          const changeRows = (await deps.db.listChanges(config.id, args.since)).filter(
            (change) => !args.bucket || change.bucket === args.bucket,
          )
          const titleOf = (code: string) => {
            const rule = BY_CODE.get(code)
            return rule ? ruleTitle(rule, lang) : code
          }
          const rows: Table['rows'] = [
            ...eventRows.map((event) => [
              event.at.slice(0, 10),
              event.kind,
              event.bucket,
              `${titleOf(event.code)}${event.detail ? ` — ${event.detail}` : ''}`,
            ]),
            ...changeRows.map((change) => [
              change.at.slice(0, 10),
              'changed',
              change.bucket,
              `${change.field} — ${change.before} → ${change.after}`,
            ]),
          ]
          rows.sort((a, b) => String(b[0]).localeCompare(String(a[0])))
          historyTable = {
            columns: ['When', 'Event', 'Bucket', 'Evidence'],
            rows: rows.slice(0, 60),
          }
        }
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
          ...(historyTable
            ? [
                historyTable.rows.length
                  ? `History (newest first, ${historyTable.rows.length} row(s)):`
                  : 'History: no matching Issue event or posture change is remembered.',
                ...historyTable.rows
                  .slice(0, 10)
                  .map((row) => `${row[0]} ${row[1]} ${row[2]} — ${row[3]}`),
              ]
            : []),
          ...notes.slice(0, 6).map((note) => `note: ${note.text.slice(0, 160)}`),
        ]
        return {
          model: lines.join('\n'),
          target: config.name,
          note: `${buckets.length} bucket${buckets.length === 1 ? '' : 's'} · ${issues.length} issue${issues.length === 1 ? '' : 's'}${
            historyTable ? ` · ${historyTable.rows.length} history row(s)` : ''
          }`,
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
            ...(historyTable ? { history: historyTable } : {}),
          },
        }
      },
    }),

    agentTool(deps, {
      name: 'fix',
      description:
        'Generate the fix text for Open Issues: an AWS CLI command, a Terraform resource and the API document, plus an impact preview from what the estate already knows. Omit bucket and code for every open issue, or set either to narrow the batch. Read-only; the user applies it.',
      parameters: Type.Object({
        provider_id: providerParam,
        bucket: Type.Optional(
          Type.String({ description: 'Bucket name; omit for every open issue.' }),
        ),
        code: Type.Optional(
          Type.String({
            description: `Issue code, one of: ${[...BY_CODE.keys()].join(', ')}. Omit for every open issue.`,
          }),
        ),
      }),
      timeoutMs: 30_000,
      target: (args) => args.bucket ?? args.code ?? 'all issues',
      run: async (args, _run) => {
        const config = await deps.providers.resolve(args.provider_id)
        const issues = (
          await deps.db.listIssues({ providerId: config.id, status: 'open', limit: 500 })
        )
          .filter((issue) => !args.bucket || issue.bucket === args.bucket)
          .filter((issue) => !args.code || issue.code === args.code)
        if (!issues.length)
          throw new Error(
            `No open Issue${args.code ? ` '${args.code}'` : ''}${args.bucket ? ` on ${args.bucket}` : ''}. Survey or review it first.`,
          )
        const generated: {
          bucket: string
          code: string
          formats: import('@shared/contract').FixFormat[]
          impact: import('@shared/contract').Impact
          notes: string[]
          severity: string
          title: string
        }[] = []
        for (const issue of issues.slice(0, 20)) {
          if (
            issue.code !== 'account_public_access_block_missing' ||
            issue.bucket !== ACCOUNT_SCOPE
          )
            assertInScope(config, issue.bucket)
          const rule = BY_CODE.get(issue.code)
          if (!rule) continue
          const fix = generateFix(
            rule,
            issue.bucket,
            config.endpoint || null,
            config.region || null,
          )
          if (!fix) continue
          const posture = await deps.estate.postureOf(config.id, issue.bucket)
          generated.push({
            bucket: issue.bucket,
            code: issue.code,
            formats: fix.formats,
            impact: impactPreview(rule, posture, posture?.lifecycle_status === 'available'),
            notes: fix.notes,
            severity: issue.severity,
            title: ruleTitle(rule, deps.lang()),
          })
        }
        if (!generated.length)
          throw new Error(
            'No safe generated fix exists for these issues; they depend on intent the rule cannot know.',
          )
        const first = generated[0]!
        const lines = generated.flatMap((item) => [
          `${item.severity} ${item.title} on ${item.bucket || 'the account'}.`,
          item.formats[0]?.text ?? '',
          ...item.notes.map((note) => `note: ${note}`),
          `Impact: ${item.impact.verdict}. ${item.impact.reasons.join(' ')}`,
        ])
        return {
          model: lines.join('\n'),
          note: generated.length === 1 ? first.impact.verdict : `${generated.length} fixes`,
          view: {
            kind: 'fix' as const,
            providerId: config.id,
            bucket: first.bucket,
            code: first.code,
            formats: first.formats,
            impact: first.impact,
            ...(generated.length > 1
              ? {
                  batch: generated.slice(1).map((item) => ({
                    bucket: item.bucket,
                    code: item.code,
                    formats: item.formats,
                    impact: item.impact,
                  })),
                }
              : {}),
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
