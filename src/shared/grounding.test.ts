import { describe, expect, it } from 'vitest'
import type { UiEntry } from './contract'
import { contradicted, knownExposure, knownNames, ungrounded } from './grounding'

const entries: UiEntry[] = [
  { id: 'u', kind: 'user', at: '', text: 'q', attachments: [{ name: 'access.log', bytes: 1 }] },
  {
    id: 't',
    kind: 'tool',
    at: '',
    name: 'objects',
    target: 'logs-bucket',
    status: 'done',
    note: null,
    ms: 1,
    view: { kind: 'objects', rows: { columns: ['Key'], rows: [['reports/a.csv']] } },
  },
  {
    id: 'f',
    kind: 'tool',
    at: '',
    name: 'config',
    target: 'never-read',
    status: 'failed',
    note: null,
    ms: 1,
    view: null,
  },
]

describe('grounding', () => {
  it('knows targets, table keys and attachments of finished checks only', () => {
    const known = knownNames(entries)
    expect([...known].sort()).toEqual(['access.log', 'logs-bucket', 'reports/a.csv'])
  })

  it('does not ground a name the model wrote as a query title', () => {
    const known = knownNames([
      {
        id: 'q',
        kind: 'tool',
        at: '',
        name: 'query',
        target: 'ghost-bucket',
        status: 'done',
        note: null,
        ms: 1,
        view: {
          kind: 'query',
          title: 'ghost-bucket',
          code: 'return []',
          rows: { columns: ['v'], rows: [[1]] },
          chart: null,
          output: null,
          calls: 1,
          listed: 0,
          buckets: [],
        },
      },
    ])
    expect(known.has('ghost-bucket')).toBe(false)
  })

  it('grounds every bucket in a change plan and its residual list', () => {
    const plan: UiEntry = {
      id: 'change',
      kind: 'tool',
      at: '',
      name: 'change_plan',
      target: 'all issues',
      status: 'done',
      note: null,
      ms: 1,
      view: {
        kind: 'change',
        providerId: 'p1',
        bucket: 'first',
        code: 'public_exposure',
        formats: [],
        impact: { verdict: 'low', reasons: [], gap: null },
        plan: {
          summary: '',
          baseline: null,
          residual: [{ bucket: 'residual', code: 'no_encryption', title: 'No default encryption' }],
          steps: [
            {
              id: 'policy:first',
              bucket: 'first',
              codes: ['public_exposure'],
              title: 'Public',
              severity: 'high',
              formats: [],
              impact: { verdict: 'low', reasons: [], gap: null },
              notes: [],
              status: 'ready',
              blockers: [],
            },
            {
              id: 'policy:second',
              bucket: 'second',
              codes: ['insecure_transport'],
              title: 'TLS',
              severity: 'medium',
              formats: [],
              impact: { verdict: 'low', reasons: [], gap: null },
              notes: [],
              status: 'ready',
              blockers: [],
            },
          ],
        },
      },
    }
    const names = knownNames([plan])
    expect(['first', 'second', 'residual'].every((name) => names.has(name))).toBe(true)
  })

  it('flags backticked names no check shows', () => {
    const known = knownNames(entries)
    expect(ungrounded('`logs-bucket` holds `reports/a.csv`; `never-read` too.', known)).toEqual([
      'never-read',
    ])
  })

  it('accepts a key under a known bucket and ignores code that is not a name', () => {
    const known = knownNames(entries)
    expect(ungrounded('`logs-bucket/2026/x.gz` and `aws s3api put-x --bucket y`', known)).toEqual(
      [],
    )
  })
})

describe('exposure claims', () => {
  const exposure = new Map([
    ['open-bucket', true],
    ['closed-bucket', false],
  ])

  it('flags a bucket called public that a reading proved private, and the reverse', () => {
    expect(contradicted('`closed-bucket` is publicly accessible.', exposure)).toEqual([
      'closed-bucket',
    ])
    expect(contradicted('`open-bucket` is not public.', exposure)).toEqual(['open-bucket'])
    expect(contradicted('`closed-bucket` 是公开的。', exposure)).toEqual(['closed-bucket'])
  })

  it('does not read the word public inside a bucket name as the claim', () => {
    const named = new Map([
      ['demo-public', false],
      ['public-assets', false],
    ])
    expect(contradicted('`demo-public` is no longer public; the fix took.', named)).toEqual([])
    expect(contradicted('`demo-public` is not public.', named)).toEqual([])
    expect(contradicted('`public-assets` 不是公开的。', named)).toEqual([])
    expect(contradicted('`demo-public` is public.', named)).toEqual(['demo-public'])
  })

  it('accepts true claims, including negation elsewhere in the sentence', () => {
    expect(
      contradicted(
        '`open-bucket` has no default encryption and is publicly accessible. `closed-bucket` is not public.',
        exposure,
      ),
    ).toEqual([])
    expect(contradicted('`closed-bucket` 不是公开的。', exposure)).toEqual([])
  })

  it('lets a security review that proves the bucket clean update the reading', () => {
    const entries: UiEntry[] = [
      {
        id: 's',
        kind: 'tool',
        at: '',
        name: 'survey',
        target: 'acme',
        status: 'done',
        note: null,
        ms: 1,
        view: {
          kind: 'survey',
          provider: 'acme',
          buckets: { columns: ['Bucket', 'Public'], rows: [['demo-public', 'public']] },
          issues: [],
          coverage: { visible: 1, processed: 1, truncated: false, denied: [], unknown: [] },
          changed: { opened: 0, resolved: 0, recurred: 0 },
        },
      },
      {
        id: 'c',
        kind: 'tool',
        at: '',
        name: 'config',
        target: 'demo-public',
        status: 'done',
        note: null,
        ms: 1,
        view: {
          kind: 'config',
          bucket: 'demo-public',
          aspect: 'security',
          exposure: 'not public',
          findings: [],
        },
      },
    ]
    expect(knownExposure(entries).get('demo-public')).toBe(false)
  })

  it('leaves sentences naming several buckets or unknown ones alone', () => {
    expect(contradicted('`open-bucket` and `closed-bucket` are public.', exposure)).toEqual([])
    expect(contradicted('`elsewhere` is public.', exposure)).toEqual([])
  })
})
