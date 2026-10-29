import type { EntryRecord } from '@earendil-works/pi-durable'
import type { ToolDetails, ToolView } from '@shared/contract'
import { describe, expect, it } from 'vitest'
import { blockReason, MAX_ROUNDS, runView } from './agent'

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
    target: String(args.bucket ?? 'Prod'),
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
  kind: 'raw',
  title: bucket,
  value: { policy: { status: 'not_configured' } },
})

describe('the turn guard, from durable entries', () => {
  it('leaves repeating a call to the agent', () => {
    const args = { bucket: 'logs', sections: ['policy'] }
    const view = runView([
      request(),
      call('c1', 'config', args),
      result('c1', 'config', args, config('logs')),
      call('c2', 'config', args),
      result('c2', 'config', args, null, 'failed'),
    ])
    expect(blockReason(view)).toBeUndefined()
  })

  it('starts every turn with a fresh budget', () => {
    const args = { bucket: 'logs' }
    const view = runView([
      request(),
      call('c1', 'config', args),
      result('c1', 'config', args, config('logs')),
      request('Again'),
    ])
    expect(view.rounds).toBe(0)
  })

  it('stops a runaway turn past the round ceiling, counted from the entries', () => {
    const records: EntryRecord[] = [request()]
    for (let index = 0; index <= MAX_ROUNDS; index += 1) {
      const args = { bucket: `b${index}` }
      records.push(call(`c${index}`, 'objects', args), result(`c${index}`, 'objects', args, null))
    }
    // The same entries give the same budget after a restart: nothing is in memory.
    expect(blockReason(runView(records))).toMatch(/did not run/)
    expect(blockReason(runView(records.slice(0, 41)))).toBeUndefined()
  })
})
