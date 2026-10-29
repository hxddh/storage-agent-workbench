import type { Bootstrap, LocalModel, TaskSummary } from '@shared/contract'
import { Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { dict, fill, kindName } from './i18n'

function ago(iso: string | null, lang: 'en' | 'zh'): string {
  if (!iso) return lang === 'zh' ? '尚未读取' : 'not read yet'
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)
  if (lang === 'zh') {
    if (days <= 0) return '今天'
    if (days === 1) return '昨天'
    return `${days} 天前`
  }
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

export function Home({
  boot,
  onSetup,
  onAddAccount,
  onUseLocal,
  tasks,
  onOpenTask,
}: {
  boot: Bootstrap
  onSetup: () => void
  onAddAccount: () => void
  onUseLocal: (model: LocalModel) => Promise<void>
  tasks: TaskSummary[]
  onOpenTask: (id: string) => void
}) {
  const lang = boot.settings.language
  const t = dict(lang)
  const hasModel = Boolean(boot.model)
  const hasAccount = boot.accounts.length > 0
  const [local, setLocal] = useState<LocalModel[]>([])
  const [starting, setStarting] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (hasModel) return
    // Let the first paint and the composer become usable before probing two
    // local ports; a slow local server must not compete with startup.
    let live = true
    const timer = setTimeout(() => {
      void window.agent
        .localModels()
        .then((models) => {
          if (live) setLocal(models)
        })
        .catch(() => undefined)
    }, 180)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [hasModel])

  const startLocal = async (model: LocalModel) => {
    setStarting(model.modelId)
    setLocalError(null)
    try {
      await onUseLocal(model)
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
    } finally {
      setStarting(null)
    }
  }

  return (
    <div className="home">
      <div className="home-inner">
        <h1>{t.homeTitle}</h1>
        {hasAccount ? (
          // The accounts the agent can read. What they hold is for the agent to read and say.
          <ul className="home-accounts" aria-label={t.homeAccounts}>
            {boot.accounts.map((account) => (
              <li className="home-account" key={account.id}>
                <span className="home-account-name">{account.name}</span>
                <span className="home-account-kind">{kindName(t, account.kind)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="home-lede">{hasModel ? t.homeNoEstate : t.homeNoModel}</p>
        )}
        <div className="home-actions">
          <button
            className={hasAccount ? 'home-link' : 'btn primary'}
            type="button"
            onClick={onAddAccount}
          >
            {t.addAccount}
          </button>
          {!hasModel && (
            <button className="home-link" type="button" onClick={onSetup}>
              {t.setModel}
            </button>
          )}
        </div>
        {!hasModel && local.length > 0 && (
          <div className="home-local">
            <span className="home-local-label">{t.localModels}</span>
            {local.map((model) => (
              <button
                className="home-prompt"
                key={`${model.source}:${model.modelId}`}
                type="button"
                disabled={starting !== null}
                onClick={() => void startLocal(model)}
              >
                <Sparkles size={12} strokeWidth={1.7} aria-hidden="true" />
                <span>{fill(t.useLocal, { model: model.modelId })}</span>
                <span className="hint">{model.source}</span>
              </button>
            ))}
          </div>
        )}
        {!hasModel && hasAccount && <p className="hint home-hint">{t.emptyNoModel}</p>}
        {localError && <p className="brief-error">{localError}</p>}
        {tasks.length > 0 && (
          <section className="home-recent" aria-label={t.homeRecent}>
            <div className="home-recent-head">
              <h2>{t.homeRecent}</h2>
              <span>{tasks.length}</span>
            </div>
            <div className="home-recent-list">
              {tasks.slice(0, 5).map((task) => (
                <button
                  className="home-recent-row"
                  type="button"
                  key={task.id}
                  onClick={() => onOpenTask(task.id)}
                >
                  <span className="home-recent-title">{task.title}</span>
                  <span className="home-recent-time">{ago(task.updatedAt, lang)}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
