import type { Bootstrap, OverviewSuggestion } from '@shared/contract'
import { ArrowUpRight, Sparkles } from 'lucide-react'
import { dict } from './i18n'

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
}: {
  boot: Bootstrap
  onSend: (text: string) => void
  onSetup: () => void
  onTryDemo: () => void
}) {
  const lang = boot.settings.language
  const t = dict(lang)
  const overview = boot.overview
  const hasModel = Boolean(boot.model)
  const hasAccount = boot.accounts.length > 0

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
          <p className="home-lede">{t.homeNoEstate}</p>
        )}

        {!hasModel || !hasAccount ? (
          <div className="home-setup">
            <button className="btn primary" type="button" onClick={onSetup}>
              {!hasModel ? t.setModel : t.addAccount}
            </button>
            {hasModel && !hasAccount && (
              <button className="btn" type="button" onClick={onTryDemo}>
                {t.tryDemo}
              </button>
            )}
            <span className="hint">{hasModel ? t.demoHint : t.homeModelHint}</span>
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
