import type { ChangeItem } from '@shared/contract'
import { useCallback, useEffect, useState } from 'react'
import type { Dict } from './i18n'

function json(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  return JSON.stringify(value, null, 2)
}

/**
 * A change the agent proposed. Approving runs exactly this call; the app read
 * what it replaces first, so an applied change can be rolled back. Nothing in
 * the conversation can approve it: only these buttons.
 */
export function ChangeCard({
  id,
  title,
  reason,
  before,
  after,
  t,
}: {
  id: string
  title: string
  reason: string
  before: unknown
  after: unknown
  t: Dict
}) {
  const [item, setItem] = useState<ChangeItem | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<'approve' | 'rollback' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    void window.agent
      .change(id)
      .then(setItem)
      .catch(() => undefined)
  }, [id])

  useEffect(() => {
    load()
    return window.agent.onEvent((event) => {
      if (event.type === 'change' && event.id === id) load()
    })
  }, [id, load])

  const act = async (action: 'approve' | 'reject' | 'rollback') => {
    if ((action === 'approve' || action === 'rollback') && confirm !== action) {
      setConfirm(action)
      setTimeout(() => setConfirm(null), 4000)
      return
    }
    setConfirm(null)
    setBusy(true)
    setError(null)
    try {
      const next =
        action === 'approve'
          ? await window.agent.approveChange(id)
          : action === 'reject'
            ? await window.agent.rejectChange(id)
            : await window.agent.rollbackChange(id)
      setItem(next)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const status = item?.status ?? 'proposed'
  const failure =
    status === 'failed' && item?.result && typeof item.result === 'object'
      ? String((item.result as { error?: unknown }).error ?? '')
      : ''

  return (
    <div className={`change-card ${status}`}>
      <div className="change-head">
        <span className="change-title">{title}</span>
        <span className="change-status">{t[`change_${status}` as keyof Dict] as string}</span>
      </div>
      {reason && <p className="change-reason">{reason}</p>}
      <div className="change-sides">
        <div>
          <div className="view-sub">{t.changeNow}</div>
          <pre className="code">{json(before)}</pre>
        </div>
        <div>
          <div className="view-sub">{t.changeAfter}</div>
          <pre className="code">{json(after)}</pre>
        </div>
      </div>
      {failure && <p className="brief-error">{failure}</p>}
      {error && <p className="brief-error">{error}</p>}
      <div className="change-actions">
        {status === 'proposed' && (
          <>
            <button
              className="btn primary"
              type="button"
              disabled={busy}
              onClick={() => void act('approve')}
            >
              {confirm === 'approve' ? t.changeApproveConfirm : t.changeApprove}
            </button>
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={() => void act('reject')}
            >
              {t.changeReject}
            </button>
          </>
        )}
        {status === 'applied' && item?.kind !== 'settings' && (
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => void act('rollback')}
          >
            {confirm === 'rollback' ? t.changeRollbackConfirm : t.changeRollback}
          </button>
        )}
      </div>
    </div>
  )
}
