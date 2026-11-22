/**
 * Proposals and decisions. The agent proposes through a tool; the user
 * decides through the window (IPC), never through the conversation, so
 * nothing the model writes or reads can approve. Each decision comes back to
 * the agent as the user's next message.
 */
import type { ChangeItem } from '@shared/contract'
import {
  applyChange,
  type ChangeCall,
  checkChange,
  inverseOf,
  newChangeId,
  normaliseInput,
  snapshotOf,
  WRITABLE,
} from '../changes'
import type { ChangeRecord } from '../db'
import { describeError } from '../s3/api'
import { redact } from '../security/redact'
import type { ProposedChange } from '../tools/policy'
import type { Engine } from './engine'
import type { Runtime } from './session'

function parse(text: string | null): unknown {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function titleOf(
  row: Pick<ChangeRecord, 'kind' | 'service' | 'operation' | 'input_json'>,
  account: string,
): string {
  const input = (parse(row.input_json) ?? {}) as Record<string, unknown>
  if (row.kind === 'settings') {
    const parts: string[] = []
    if (typeof input.allowChanges === 'boolean')
      parts.push(input.allowChanges ? 'allow approved changes' : 'stop approved changes')
    if (Array.isArray(input.scope))
      parts.push(input.scope.length ? `limit to ${input.scope.join(', ')}` : 'read every bucket')
    return `${account}: ${parts.join(' and ')}`
  }
  const bucket = typeof input.Bucket === 'string' ? ` on ${input.Bucket}` : ` on account ${account}`
  return `${row.kind === 'rollback' ? 'Roll back: ' : ''}${row.service} ${row.operation}${bucket}`
}

export class Approvals {
  private engine: Engine | null = null

  constructor(private readonly runtime: Runtime) {}

  bind(engine: Engine): void {
    this.engine = engine
  }

  private get db() {
    return this.runtime.deps.db
  }

  private get providers() {
    return this.runtime.deps.providers
  }

  async propose(input: {
    conversationId: string
    providerId?: string
    service: string
    operation: string
    input: Record<string, unknown>
    reason: string
  }): Promise<ProposedChange> {
    const config = await this.providers.resolve(input.providerId)
    if (!config.allowChanges)
      throw new Error(
        `Changes are not allowed on ${config.name}. The user turns them on in Settings → Storage accounts; you can propose it with self (propose, allow_changes).`,
      )
    const call: ChangeCall = {
      service: input.service.toLowerCase(),
      operation: input.operation,
      input: normaliseInput(input.input ?? {}),
    }
    checkChange(config, call)
    const snapshot = await snapshotOf(this.providers, config, call)
    const taskId = await this.db.rootConversation(input.conversationId)
    const row: ChangeRecord = {
      id: newChangeId(),
      conversation_id: taskId,
      provider_id: config.id,
      kind: 'change',
      service: call.service,
      operation: call.operation,
      input_json: redact(JSON.stringify(call.input)),
      reason: redact(input.reason.trim()),
      snapshot_json: JSON.stringify(snapshot),
      status: 'proposed',
      result_json: null,
      rollback_of: null,
      created_at: new Date().toISOString(),
      decided_at: null,
    }
    await this.db.insertChange(row)
    return {
      changeId: row.id,
      account: config.name,
      title: titleOf(row, config.name),
      reason: row.reason,
      before: snapshot,
      after: call.input,
    }
  }

  async proposeSetting(input: {
    conversationId: string
    providerId?: string
    allowChanges?: boolean
    scope?: string[]
    reason: string
  }): Promise<ProposedChange> {
    const config = await this.providers.resolve(input.providerId)
    const taskId = await this.db.rootConversation(input.conversationId)
    const after = {
      ...(input.allowChanges !== undefined ? { allowChanges: input.allowChanges } : {}),
      ...(input.scope !== undefined
        ? { scope: input.scope.map((name) => name.trim()).filter(Boolean) }
        : {}),
    }
    const before = {
      ...(input.allowChanges !== undefined ? { allowChanges: Boolean(config.allowChanges) } : {}),
      ...(input.scope !== undefined ? { scope: config.scope.buckets } : {}),
    }
    const row: ChangeRecord = {
      id: newChangeId(),
      conversation_id: taskId,
      provider_id: config.id,
      kind: 'settings',
      service: 'settings',
      operation: 'UpdateAccount',
      input_json: JSON.stringify(after),
      reason: redact(input.reason.trim()),
      snapshot_json: JSON.stringify(before),
      status: 'proposed',
      result_json: null,
      rollback_of: null,
      created_at: new Date().toISOString(),
      decided_at: null,
    }
    await this.db.insertChange(row)
    return {
      changeId: row.id,
      account: config.name,
      title: titleOf(row, config.name),
      reason: row.reason,
      before,
      after,
    }
  }

  async get(id: string): Promise<ChangeItem | null> {
    const row = await this.db.getChange(id)
    if (!row) return null
    const account =
      (await this.providers.list()).find((item) => item.id === row.provider_id)?.name ??
      row.provider_id
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      account,
      service: row.service,
      operation: row.operation,
      input: parse(row.input_json),
      before: parse(row.snapshot_json),
      reason: row.reason,
      result: parse(row.result_json),
      decidedAt: row.decided_at,
      rollbackOf: row.rollback_of,
    }
  }

  private async tell(taskId: string, text: string, id: string): Promise<void> {
    this.runtime.deps.emit({ type: 'change', id })
    await this.engine?.submit(taskId, text, []).catch(() => undefined)
  }

  /** The user approved: run exactly the stored call, then tell the agent what happened. */
  async approve(id: string): Promise<ChangeItem> {
    const row = await this.db.getChange(id)
    if (!row) throw new Error('No such change.')
    if (row.status !== 'proposed')
      throw new Error(`This change is already ${row.status.replace('_', ' ')}.`)
    const config = await this.providers.config(row.provider_id)
    const title = titleOf(row, config.name)
    if (row.kind === 'settings') {
      const patch = parse(row.input_json) as { allowChanges?: boolean; scope?: string[] }
      await this.providers.updateSettings(config.id, patch)
      await this.db.decideChange(id, 'applied', patch)
      await this.runtime.refreshDigest()
      await this.tell(row.conversation_id, `Approved: ${title}. It is set.`, id)
      return (await this.get(id))!
    }
    if (!config.allowChanges) throw new Error(`Changes are no longer allowed on ${config.name}.`)
    const call: ChangeCall = {
      service: row.service,
      operation: row.operation,
      input: parse(row.input_json) as Record<string, unknown>,
    }
    try {
      checkChange(config, call)
      const result = await applyChange(this.providers, config, call)
      await this.db.decideChange(id, 'applied', result)
      await this.tell(
        row.conversation_id,
        `Approved: ${title}. The app ran it (change ${id}). Read again to verify it took effect.`,
        id,
      )
    } catch (error) {
      const message = describeError(error)
      await this.db.decideChange(id, 'failed', { error: message })
      await this.tell(row.conversation_id, `Approved: ${title}. It failed: ${message}`, id)
    }
    return (await this.get(id))!
  }

  async reject(id: string): Promise<ChangeItem> {
    const row = await this.db.getChange(id)
    if (!row) throw new Error('No such change.')
    if (row.status !== 'proposed')
      throw new Error(`This change is already ${row.status.replace('_', ' ')}.`)
    const config = await this.providers.config(row.provider_id)
    await this.db.decideChange(id, 'rejected', null)
    await this.tell(row.conversation_id, `Rejected: ${titleOf(row, config.name)}.`, id)
    return (await this.get(id))!
  }

  /** Put back what an applied change replaced: the user's own decision, run at once. */
  async rollback(id: string): Promise<ChangeItem> {
    const row = await this.db.getChange(id)
    if (!row) throw new Error('No such change.')
    if (row.status !== 'applied' || row.kind === 'settings')
      throw new Error('Only an applied storage change can be rolled back.')
    const config = await this.providers.config(row.provider_id)
    if (!config.allowChanges) throw new Error(`Changes are no longer allowed on ${config.name}.`)
    const original: ChangeCall = {
      service: row.service,
      operation: row.operation,
      input: parse(row.input_json) as Record<string, unknown>,
    }
    const inverse = inverseOf(original, parse(row.snapshot_json) as Record<string, unknown> | null)
    checkChange(config, inverse, true)
    const current = WRITABLE[`${inverse.service}:${inverse.operation}`]
      ? await snapshotOf(this.providers, config, inverse).catch(() => null)
      : null
    const undo: ChangeRecord = {
      id: newChangeId(),
      conversation_id: row.conversation_id,
      provider_id: row.provider_id,
      kind: 'rollback',
      service: inverse.service,
      operation: inverse.operation,
      input_json: redact(JSON.stringify(inverse.input)),
      reason: `Roll back change ${row.id}.`,
      snapshot_json: JSON.stringify(current),
      status: 'proposed',
      result_json: null,
      rollback_of: row.id,
      created_at: new Date().toISOString(),
      decided_at: null,
    }
    await this.db.insertChange(undo)
    try {
      const result = await applyChange(this.providers, config, inverse)
      await this.db.decideChange(undo.id, 'applied', result)
      await this.db.decideChange(row.id, 'rolled_back', parse(row.result_json))
      await this.tell(
        row.conversation_id,
        `Rolled back: ${titleOf(row, config.name)} (now ${inverse.operation}). Read again to verify.`,
        id,
      )
    } catch (error) {
      const message = describeError(error)
      await this.db.decideChange(undo.id, 'failed', { error: message })
      await this.tell(
        row.conversation_id,
        `Roll back of ${titleOf(row, config.name)} failed: ${message}`,
        id,
      )
    }
    return (await this.get(id))!
  }
}
