import { describe, expect, it } from 'vitest'
import { viewDoc, viewText } from './view'

describe('an agent view', () => {
  it('accepts nested blocks and keeps the agent order', () => {
    const doc = viewDoc({
      version: 1,
      blocks: [
        {
          type: 'section',
          title: 'Access',
          blocks: [
            {
              type: 'table',
              columns: [{ key: 'bucket', label: 'Bucket' }],
              rows: [{ bucket: 'logs' }],
            },
            { type: 'callout', tone: 'warn', text: 'policy unread' },
          ],
        },
      ],
    })
    expect(doc?.blocks).toHaveLength(1)
    expect(viewText(doc!)).toContain('logs')
    expect(viewText(doc!)).toContain('policy unread')
  })

  it('refuses HTML, external links and invalid rows', () => {
    expect(viewDoc({ version: 1, blocks: [{ type: 'html', text: '<script />' }] })).toBeNull()
    expect(
      viewDoc({ version: 1, blocks: [{ type: 'link', href: 'javascript:alert(1)', text: 'x' }] }),
    ).toBeNull()
    expect(viewDoc({ version: 1, blocks: [{ type: 'table', columns: [], rows: [] }] })).toBeNull()
  })

  it('bounds a hostile document', () => {
    const blocks = Array.from({ length: 3000 }, () => ({ type: 'markdown', text: 'x' }))
    expect(viewDoc({ version: 1, blocks })).toBeNull()
  })
})
