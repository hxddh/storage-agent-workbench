import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketPolicyCommand,
  type S3Client,
} from '@aws-sdk/client-s3'
import type {
  ChangeFormat,
  ChangePlan,
  ChangePlanStep,
  Impact,
  Severity,
  Table,
} from '@shared/contract'
import {
  type ChangeKind,
  formatChange,
  generateChange,
  impactPreview,
  policyHasAccountId,
  TLS_STATEMENT,
} from '../estate/changes'
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function shellJson(value: unknown): string {
  return shellQuote(JSON.stringify(value, null, 0))
}

interface LifecycleRead {
  ok: boolean
  rules: Record<string, unknown>[]
  blocker?: string
}

interface PolicyRead {
  ok: boolean
  document: Record<string, unknown> | null
  blocker?: string
}

async function readLifecycle(
  client: S3Client,
  bucket: string,
  signal: AbortSignal,
): Promise<LifecycleRead> {
  try {
    const response = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
      { abortSignal: signal },
    )
    return { ok: true, rules: (response.Rules ?? []) as unknown as Record<string, unknown>[] }
  } catch (error) {
    if (signal.aborted) throw error
    const name = error instanceof Error ? error.name : ''
    if (name === 'NoSuchLifecycleConfiguration') return { ok: true, rules: [] }
    return {
      ok: false,
      rules: [],
      blocker:
        'The current lifecycle configuration could not be read; merge the new rules manually.',
    }
  }
}

async function readPolicy(
  client: S3Client,
  bucket: string,
  signal: AbortSignal,
): Promise<PolicyRead> {
  try {
    const response = await client.send(new GetBucketPolicyCommand({ Bucket: bucket }), {
      abortSignal: signal,
    })
    if (!response.Policy) return { ok: true, document: null }
    const parsed = JSON.parse(response.Policy) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {
        ok: false,
        document: null,
        blocker: 'The current bucket policy is not a JSON object.',
      }
    return { ok: true, document: parsed as Record<string, unknown> }
  } catch (error) {
    if (signal.aborted) throw error
    const name = error instanceof Error ? error.name : ''
    if (name === 'NoSuchBucketPolicy') return { ok: true, document: null }
    return {
      ok: false,
      document: null,
      blocker: 'The current bucket policy could not be read; merge the statement manually.',
    }
  }
}

function mergeImpacts(items: { impact: import('@shared/contract').Impact }[]) {
  const verdicts = items.map((item) => item.impact.verdict)
  const verdict = verdicts.includes('unknown')
    ? 'unknown'
    : verdicts.includes('caution')
      ? 'caution'
      : 'low'
  const reasons = [...new Set(items.flatMap((item) => item.impact.reasons))]
  const gaps = [...new Set(items.flatMap((item) => (item.impact.gap ? [item.impact.gap] : [])))]
  return { verdict, reasons, gap: gaps.length ? gaps.join(' ') : null } as const
}

function maxSeverity(a: Severity, b: Severity): Severity {
  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
  return order[a] <= order[b] ? a : b
}

function tlsPolicy(
  current: Record<string, unknown> | null,
  bucket: string,
): Record<string, unknown> {
  const document = current
    ? structuredClone(current)
    : { Version: '2012-10-17', Statement: [] as Record<string, unknown>[] }
  const statements = Array.isArray(document.Statement)
    ? (document.Statement as Record<string, unknown>[])
    : document.Statement
      ? [document.Statement as Record<string, unknown>]
      : []
  const hasTls = statements.some(
    (statement) =>
      statement.Sid === 'DenyInsecureTransport' ||
      (statement.Condition && JSON.stringify(statement.Condition).includes('aws:SecureTransport')),
  )
  if (!hasTls) statements.push(TLS_STATEMENT(bucket))
  document.Statement = statements
  return document
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
          // A reading is account-wide; it has no bucket or rule to match, so it
          // only belongs in an unfiltered history.
          const readingRows =
            args.bucket || args.code
              ? []
              : await deps.db.listReadings({
                  providerId: config.id,
                  since: args.since,
                  limit: 30,
                })
          const titleOf = (code: string) => {
            const rule = BY_CODE.get(code)
            return rule ? ruleTitle(rule, lang) : code
          }
          const rows: Table['rows'] = [
            ...readingRows.map((reading) => [
              reading.at.slice(0, 10),
              reading.trigger === 'reverify'
                ? 'rechecked'
                : reading.trigger === 'check'
                  ? 'checked'
                  : 'read',
              '—',
              `${reading.complete ? 'complete' : 'partial'} · ${reading.processed}/${reading.visible} buckets · ${reading.open_high} high`,
            ]),
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
                `[${issue.severity}] ${issue.title} — ${issue.bucket || 'account'} · rule ${issue.code}${issue.detail ? ` (${issue.detail})` : ''}`,
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
      name: 'change_plan',
      description:
        'Build one change plan for Open Issues: a baseline, merged steps with AWS CLI/Terraform/API text, impact from the remembered posture, manual blockers and residual findings. Omit bucket and code for every open issue, or set either to narrow the plan. Read-only; the user applies it and re-verification confirms it.',
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
      run: async (args, run) => {
        const { config, client } = await run.provider(args.provider_id)
        const issues = (
          await deps.db.listIssues({ providerId: config.id, status: 'open', limit: 500 })
        )
          .filter((issue) => !args.bucket || issue.bucket === args.bucket)
          .filter((issue) => !args.code || issue.code === args.code)
        if (!issues.length)
          throw new Error(
            `No open Issue${args.code ? ` '${args.code}'` : ''}${args.bucket ? ` on ${args.bucket}` : ''}. Survey or review it first.`,
          )
        type GeneratedItem = {
          bucket: string
          code: string
          formats: ChangeFormat[]
          impact: Impact
          notes: string[]
          severity: Severity
          title: string
          kind: ChangeKind
          document: Record<string, unknown>
          command: string
        }
        const generated: GeneratedItem[] = []
        for (const issue of issues) {
          if (
            issue.code !== 'account_public_access_block_missing' ||
            issue.bucket !== ACCOUNT_SCOPE
          )
            assertInScope(config, issue.bucket)
          const rule = BY_CODE.get(issue.code)
          if (!rule) continue
          const change = generateChange(
            rule,
            issue.bucket,
            config.endpoint || null,
            config.region || null,
          )
          if (!change) continue
          const posture = await deps.estate.postureOf(config.id, issue.bucket)
          generated.push({
            bucket: issue.bucket,
            code: issue.code,
            formats: change.formats,
            impact: impactPreview(rule, posture, posture?.lifecycle_status === 'available'),
            notes: change.notes,
            severity: issue.severity,
            title: ruleTitle(rule, deps.lang()),
            kind: change.kind,
            document: change.document,
            command: change.command,
          })
        }
        if (!generated.length)
          throw new Error(
            'No safe generated change exists for these issues; they depend on intent the rule cannot know.',
          )

        const steps: ChangePlanStep[] = []
        const lifecycle = new Map<string, GeneratedItem[]>()
        const policies = new Map<string, GeneratedItem[]>()
        for (const item of generated) {
          if (item.kind === 'lifecycle') {
            const group = lifecycle.get(item.bucket) ?? []
            group.push(item)
            lifecycle.set(item.bucket, group)
          } else if (item.kind === 'policy') {
            const group = policies.get(item.bucket) ?? []
            group.push(item)
            policies.set(item.bucket, group)
          } else {
            steps.push({
              id: `${item.kind}:${item.bucket}:${item.code}`,
              bucket: item.bucket,
              codes: [item.code],
              title: item.title,
              severity: item.severity,
              formats: item.formats,
              impact: item.impact,
              notes: item.notes,
              status: 'ready',
              blockers: [],
            })
          }
        }

        for (const [bucket, items] of lifecycle) {
          const codes = items.map((item) => item.code)
          const severity = items.reduce<Severity>(
            (value, item) => maxSeverity(value, item.severity),
            'low',
          )
          const impact = mergeImpacts(items)
          const newRules = items.flatMap((item) => {
            const rules = item.document.Rules
            return Array.isArray(rules) ? (rules as Record<string, unknown>[]) : []
          })
          const current = await readLifecycle(client, bucket, run.signal)
          const lifecycleTitle =
            codes.length > 1
              ? deps.lang().toLowerCase().startsWith('zh')
                ? '生命周期规则'
                : 'Lifecycle rules'
              : items[0]!.title
          if (!current.ok) {
            steps.push({
              id: `lifecycle:${bucket}`,
              bucket,
              codes,
              title: lifecycleTitle,
              severity,
              formats: [
                {
                  label: 'New rules',
                  language: 'json',
                  text: JSON.stringify({ Rules: newRules }, null, 2),
                },
              ],
              impact,
              notes: [
                ...new Set(items.flatMap((item) => item.notes)),
                current.blocker ?? 'Merge these rules into the current lifecycle configuration.',
              ],
              status: 'manual',
              blockers: [current.blocker ?? 'Current lifecycle configuration was not read.'],
            })
            continue
          }
          const known = new Set(current.rules.map((rule) => String(rule.ID ?? '')))
          const mergedRules = [
            ...current.rules,
            ...newRules.filter((rule) => !rule.ID || !known.has(String(rule.ID))),
          ]
          const document = { Rules: mergedRules }
          const command = `aws s3api put-bucket-lifecycle-configuration --bucket ${shellQuote(bucket)} --lifecycle-configuration ${shellJson(document)}`
          const existing = current.rules.length > 0
          const notes = [
            ...new Set(
              items.flatMap((item) => item.notes).filter((note) => !note.includes('REPLACES')),
            ),
            'Merged with the current lifecycle configuration; existing rules are preserved.',
          ]
          if (existing)
            notes.push(
              'Terraform is omitted for a merged lifecycle configuration: the current rules contain fields this renderer cannot reproduce. Apply the CLI or JSON, or update your full Terraform configuration.',
            )
          const formatted = formatChange(
            'lifecycle',
            document,
            bucket,
            config.endpoint || null,
            config.region || null,
            command,
            notes,
            { terraform: !existing },
          )
          steps.push({
            id: `lifecycle:${bucket}`,
            bucket,
            codes,
            title: lifecycleTitle,
            severity,
            formats: formatted.formats,
            impact,
            notes: formatted.notes,
            status: 'ready',
            blockers: [],
          })
        }

        for (const [bucket, items] of policies) {
          const codes = items.map((item) => item.code)
          const severity = items.reduce<Severity>(
            (value, item) => maxSeverity(value, item.severity),
            'low',
          )
          const impact = mergeImpacts(items)
          const current = await readPolicy(client, bucket, run.signal)
          const accountId = current.document ? policyHasAccountId(current.document) : false
          if (!current.ok || accountId) {
            const blocker = accountId
              ? 'The current policy names an AWS account id; Storage Agent will not reproduce that policy in the window. Add the statement manually.'
              : (current.blocker ?? 'Current bucket policy was not read.')
            steps.push({
              id: `policy:${bucket}`,
              bucket,
              codes,
              title: items[0]!.title,
              severity,
              formats: [
                {
                  label: 'New statement',
                  language: 'json',
                  text: JSON.stringify(TLS_STATEMENT(bucket), null, 2),
                },
              ],
              impact,
              notes: [...new Set(items.flatMap((item) => item.notes)), blocker],
              status: 'manual',
              blockers: [blocker],
            })
            continue
          }
          const document = tlsPolicy(current.document, bucket)
          const command = `aws s3api put-bucket-policy --bucket ${shellQuote(bucket)} --policy ${shellJson(document)}`
          const formatted = formatChange(
            'policy',
            document,
            bucket,
            config.endpoint || null,
            config.region || null,
            command,
            [
              ...new Set(
                items.flatMap((item) => item.notes).filter((note) => !note.includes('REPLACES')),
              ),
              'Merged with the current bucket policy; existing statements are preserved.',
            ],
          )
          steps.push({
            id: `policy:${bucket}`,
            bucket,
            codes,
            title: items[0]!.title,
            severity,
            formats: formatted.formats,
            impact,
            notes: formatted.notes,
            status: 'ready',
            blockers: [],
          })
        }

        steps.sort((a, b) => {
          if (!a.bucket && b.bucket) return -1
          if (a.bucket && !b.bucket) return 1
          return a.bucket.localeCompare(b.bucket) || a.id.localeCompare(b.id)
        })
        const covered = new Set(
          steps.flatMap((step) => step.codes.map((code) => `${step.bucket}|${code}`)),
        )
        const residual = issues
          .filter((issue) => !covered.has(`${issue.bucket}|${issue.code}`))
          .map((issue) => ({
            bucket: issue.bucket,
            code: issue.code,
            title: BY_CODE.has(issue.code)
              ? ruleTitle(BY_CODE.get(issue.code)!, deps.lang())
              : issue.code,
          }))
        const reading = await deps.db.latestCompleteReading(config.id)
        const baseline = reading
          ? {
              at: reading.at,
              complete: true,
              visible: reading.visible,
              processed: reading.processed,
              openHigh: reading.open_high,
              openTotal: reading.open_total,
            }
          : null
        const manual = steps.filter((step) => step.status === 'manual').length
        const summary = `${steps.length} step${steps.length === 1 ? '' : 's'} · ${new Set(steps.map((step) => step.bucket).filter(Boolean)).size} bucket${
          new Set(steps.map((step) => step.bucket).filter(Boolean)).size === 1 ? '' : 's'
        }${manual ? ` · ${manual} manual` : ''}${residual.length ? ` · ${residual.length} residual` : ''}`
        const first = steps[0]!
        const lines = [
          `Change plan: ${summary}.`,
          ...steps.map(
            (step, index) =>
              `${index + 1}. ${step.bucket || 'account'} — ${step.title} [${step.status}] (${step.codes.join(', ')}).${
                step.blockers.length ? ` ${step.blockers.join(' ')}` : ''
              }`,
          ),
          ...residual
            .slice(0, 10)
            .map((item) => `residual: ${item.bucket || 'account'} — ${item.title}`),
          baseline
            ? `Baseline: complete reading ${baseline.at.slice(0, 10)}.`
            : 'Baseline: no complete reading is recorded; this plan is based on remembered state.',
        ]
        const plan: ChangePlan = { steps, baseline, residual, summary }
        return {
          model: lines.join('\n'),
          note: summary,
          view: {
            kind: 'change' as const,
            providerId: config.id,
            bucket: first.bucket,
            code: first.codes[0] ?? first.id,
            formats: first.formats,
            impact: first.impact,
            plan,
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

    agentTool(deps, {
      name: 'accept_risk',
      description:
        'Ask the user to accept (or reopen) one risk they told you to accept. It changes nothing by itself: the window shows a confirmation, and only the user accepts. Name the risk by its bucket and rule code from `estate`.',
      parameters: Type.Object({
        provider_id: providerParam,
        bucket: Type.String({
          description: 'The bucket the risk is on; an empty string for the account-wide rule.',
        }),
        code: Type.String({ description: 'The rule code, as `estate` lists it.' }),
        accept: Type.Optional(
          Type.Boolean({
            description: 'true to accept (default), false to reopen an accepted one.',
          }),
        ),
      }),
      timeoutMs: 10_000,
      target: (args) => args.bucket || 'account',
      run: async (args) => {
        const config = await deps.providers.resolve(args.provider_id)
        const record = await deps.db.findIssue(config.id, args.bucket, args.code)
        if (!record || record.status === 'resolved')
          throw new Error(
            `No open or accepted risk '${args.code}' on ${args.bucket || 'the account'}.`,
          )
        const [issue] = deps.estate.toRows([record], deps.lang())
        const accept = args.accept ?? true
        return {
          model: `The window asks the user to ${accept ? 'accept' : 'reopen'} "${issue!.title}" on ${issue!.bucket || 'the account'}. It is not ${accept ? 'accepted' : 'reopened'} until the user confirms; do not say it is.`,
          target: issue!.bucket || 'account',
          note: 'waiting for the user',
          view: { kind: 'accept' as const, issue: issue!, accept },
        }
      },
    }),
  ]
}
