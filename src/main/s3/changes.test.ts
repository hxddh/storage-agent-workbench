import type { CloudTrailClient } from '@aws-sdk/client-cloudtrail'
import { describe, expect, it } from 'vitest'
import { attribute, diffPosture } from './changes'

describe('posture changes', () => {
  it('reports a real difference and ignores an unchanged field', () => {
    const changes = diffPosture(
      'demo',
      { publicly_exposed: false, encryption_status: 'not_configured' },
      { publicly_exposed: true, encryption_status: 'not_configured' },
      '2026-01-01T00:00:00Z',
    )
    expect(changes).toEqual([
      {
        bucket: 'demo',
        field: 'public exposure',
        before: 'off',
        after: 'on',
        at: '2026-01-01T00:00:00Z',
      },
    ])
  })

  it('does not call the first reading a change', () => {
    expect(diffPosture('demo', null, { publicly_exposed: true }, 'now')).toEqual([])
  })

  it('shows a blind value as not read, not as off', () => {
    const changes = diffPosture(
      'demo',
      { encryption_status: 'available' },
      { encryption_status: 'access_denied' },
      'now',
    )
    expect(changes[0]).toMatchObject({
      field: 'encryption',
      before: 'available',
      after: 'access_denied',
    })
  })

  it('pages through CloudTrail and records the 90-day window', async () => {
    const inputs: Record<string, unknown>[] = []
    let page = 0
    const client = {
      send: async (command: { input: Record<string, unknown> }) => {
        inputs.push(command.input)
        page += 1
        return page === 1
          ? {
              Events: [
                {
                  EventName: 'PutBucketPolicy',
                  EventTime: new Date('2026-10-20T10:00:00Z'),
                  Username: 'alice',
                },
              ],
              NextToken: 'next',
            }
          : {
              Events: [
                {
                  EventName: 'PutBucketAcl',
                  EventTime: new Date('2026-10-19T10:00:00Z'),
                  Username: 'bob',
                },
              ],
            }
      },
    } as unknown as CloudTrailClient
    const result = await attribute(client, 'demo')
    expect(inputs).toHaveLength(2)
    expect(inputs[0]?.StartTime).toBeInstanceOf(Date)
    expect(result.events).toHaveLength(2)
    expect(result.days).toBe(90)
    expect(result.truncated).toBe(false)
  })
})
