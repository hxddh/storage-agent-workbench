import type { EntryRecord } from '@earendil-works/pi-durable'
import type { ToolDetails, ToolView } from '@shared/contract'
import { describe, expect, it } from 'vitest'
import { blockReason, maxRounds, runView, tierFor } from './agent'

let seq = 0
const at = () => 1_700_000_000_000 + seq++

function request(text = 'Which buckets are public?'): EntryRecord {
  return {
    id: `r${seq}`,
    kind: 'sa.run',
    data: { trigger: 'user', text, attachments: [] },
    model: [{ role: 'user', content: text, timestamp: at() }],
  } as unknown as EntryRecord
}

function call(id: string, name: string, args: Record<string, unknown>): EntryRecord {
  return {
    id: `a${id}`,
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id, name, arguments: args }],
        timestamp: at(),
      },
    ],
  } as unknown as EntryRecord
}

function result(
  id: string,
  name: string,
  args: Record<string, unknown>,
  view: ToolView | null,
  status: ToolDetails['status'] = 'done',
): EntryRecord {
  const details: ToolDetails = {
    target: String(args.bucket ?? 'Demo'),
    note: null,
    view,
    ms: 5,
    status,
    evidenceId: id,
  }
  return {
    id: `t${id}`,
    kind: 'pi.tool-result',
    model: [
      {
        role: 'toolResult',
        toolCallId: id,
        toolName: name,
        content: [{ type: 'text', text: 'ok' }],
        isError: status !== 'done',
        details,
        timestamp: at(),
      },
    ],
  } as unknown as EntryRecord
}

const config = (bucket: string): ToolView => ({
  kind: 'config',
  bucket,
  providerId: 'p',
  aspect: 'security',
  exposure: 'public',
  findings: [],
})

describe('model tiers', () => {
  it('gives a small context model fewer rounds and a large one more', () => {
    expect(tierFor(32_000)).toBe('small')
    expect(tierFor(128_000)).toBe('mid')
    expect(tierFor(400_000)).toBe('large')
    expect(maxRounds('small')).toBe(14)
    expect(maxRounds('mid')).toBe(24)
    expect(maxRounds('large')).toBe(32)
  })
})

describe('the turn guard, from durable entries', () => {
  it('leaves repeating a call to the agent', () => {
    const args = { bucket: 'demo', aspect: 'security' }
    const view = runView([
      request(),
      call('c1', 'config', args),
      result('c1', 'config', args, config('demo')),
      call('c2', 'config', args),
      result('c2', 'config', args, null, 'failed'),
    ])
    expect(blockReason(view, 'mid')).toBeUndefined()
  })

  it('starts every turn with a fresh budget', () => {
    const args = { bucket: 'demo' }
    const view = runView([
      request(),
      call('c1', 'config', args),
      result('c1', 'config', args, config('demo')),
      request('Again'),
    ])
    expect(view.rounds).toBe(0)
  })

  it('tells the agent to answer past the round budget, counted from the entries', () => {
    const records: EntryRecord[] = [request()]
    for (let index = 0; index < 15; index += 1) {
      const args = { bucket: `b${index}` }
      records.push(call(`c${index}`, 'objects', args), result(`c${index}`, 'objects', args, null))
    }
    // The same entries give the same budget after a restart: nothing is in memory.
    expect(blockReason(runView(records), 'small')).toMatch(/Step budget/)
    expect(blockReason(runView(records), 'mid')).toBeUndefined()
  })
})
