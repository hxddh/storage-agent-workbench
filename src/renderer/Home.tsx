import type { Bootstrap, LocalModel, OverviewSuggestion } from '@shared/contract'
import { ArrowUpRight, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { dict, fill } from './i18n'

function ago(iso: string | null, lang: 'en' | 'zh'): string {
  if (!iso) return lang === 'zh' ? '尚未读取' : 'not read yet'
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)
  if (lang === 'zh') {
    if (days <= 0) return '今天读取'
    if (days === 1) return '昨天读取'
    return `${days} 天前读取`
  }
  if (days <= 0) return 'read today'
  if (days === 1) return 'read yesterday'
  return `read ${days} days ago`
}

function suggestionText(code: string, bucket: string, lang: 'en' | 'zh'): string {
  const t = dict(lang)
  if (code === 'changes') return t.followChanges
  if (code === 'permissions') return t.followPermissions
  if (code === 'survey') return t.homeSurvey
  if (code === 'public') return t.homePublic
  if (code === 'access') return t.followAccess(bucket)
  if (code === 'tls') return t.followTls(bucket)
  if (code === 'key') return t.followKey(bucket)
  if (code === 'cleanup') return t.followCleanup(bucket)
  return t.followPrincipals(bucket)
}

export function Home({
  boot,
  onSend,
  onSetup,
  onTryDemo,
  onUseLocal,
}: {
  boot: Bootstrap
  onSend: (text: string) => void
  onSetup: () => void
  onTryDemo: () => void
  onUseLocal: (model: LocalModel) => Promise<void>
}) {
  const lang = boot.settings.language
  const t = dict(lang)
  const overview = boot.overview
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
          <div className="home-estate">
            {overview.accounts.map((account) => (
              <p className="home-account" key={account.id}>
                <span className="home-account-name">{account.name}</span>
                <span className="home-account-meta">
                  {account.buckets} {account.buckets === 1 ? t.bucketsOne : t.bucketsShort} ·{' '}
                  {account.buckets === 0 ? t.homeUnsurveyed : ago(account.lastRead, lang)}
                  {account.buckets === 0
                    ? ''
                    : account.openHigh > 0
                      ? ` · ${account.openHigh} ${t.homeHigh}`
                      : account.openTotal > 0
                        ? ` · ${account.openTotal} ${t.homeOpen}`
                        : ` · ${t.homeClear}`}
                </span>
              </p>
            ))}
            {overview.changesSince > 0 && (
              <p className="home-change">
                {t.homeChanges.replace('{n}', String(overview.changesSince))}
              </p>
            )}
          </div>
        ) : (
          <p className="home-lede">{hasModel ? t.homeNoEstate : t.homeNoModel}</p>
        )}

        {!hasModel || !hasAccount ? (
          <div className="home-setup">
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
            <button className="btn primary" type="button" onClick={onSetup}>
              {!hasModel ? t.setModel : t.addAccount}
            </button>
            {hasModel && !hasAccount && (
              <button className="btn" type="button" onClick={onTryDemo}>
                {t.tryDemo}
              </button>
            )}
            {localError && <p className="brief-error">{localError}</p>}
            <span className="hint home-setup-hint">{hasModel ? t.demoHint : t.homeModelHint}</span>
          </div>
        ) : (
          <div className="home-prompts">
            {overview.suggestions.map((item: OverviewSuggestion) => (
              <button
                className="home-prompt"
                key={`${item.code}:${item.bucket}:${boot.accounts.length}`}
                type="button"
                onClick={() => onSend(suggestionText(item.code, item.bucket, lang))}
              >
                <Sparkles size={12} strokeWidth={1.7} aria-hidden="true" />
                <span>{suggestionText(item.code, item.bucket, lang)}</span>
                <ArrowUpRight size={12} strokeWidth={1.7} aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
