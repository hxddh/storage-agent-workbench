import { describe, expect, it } from 'vitest'
import { diffPosture } from './changes'

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
})
