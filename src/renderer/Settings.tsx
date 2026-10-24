import type { Account, AccountInput, Bootstrap, Lang, NoteRow, Theme } from '@shared/contract'
import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { dict } from './i18n'
import { useFocusTrap } from './lib/focus'

type Provider = 'openai' | 'anthropic' | 'compatible'

const EMPTY_ACCOUNT: AccountInput = {
  name: '',
  endpoint: '',
  region: 'us-east-1',
  forcePathStyle: false,
  accessKeyId: '',
  secretAccessKey: '',
  sessionToken: '',
  scope: { buckets: [] },
}

export function Settings({
  boot,
  onClose,
  onChanged,
}: {
  boot: Bootstrap
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const lang = boot.settings.language
  const t = dict(lang)
  const [provider, setProvider] = useState<Provider>(
    (boot.model?.provider as Provider) ?? 'compatible',
  )
  const [modelId, setModelId] = useState(boot.model?.modelId ?? '')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(boot.model?.baseUrl ?? '')
  const [contextWindow, setContextWindow] = useState(boot.model?.contextWindow ?? 32_768)
  const [modelStatus, setModelStatus] = useState<{ ok: boolean; detail: string } | null>(null)
  const [modelBusy, setModelBusy] = useState(false)

  const [accounts, setAccounts] = useState<Account[]>(boot.accounts)
  const [form, setForm] = useState<AccountInput>(EMPTY_ACCOUNT)
  const [showForm, setShowForm] = useState(boot.accounts.length === 0)
  const [accountStatus, setAccountStatus] = useState<{ ok: boolean; detail: string } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [notes, setNotes] = useState<NoteRow[]>([])
  const trap = useFocusTrap<HTMLDivElement>(onClose)

  useEffect(() => {
    void window.agent.notes().then(setNotes)
  }, [])

  const forget = async (id: string) => {
    await window.agent.deleteNote(id)
    setNotes(await window.agent.notes())
  }

  const saveModel = async () => {
    setModelBusy(true)
    setModelStatus(null)
    try {
      await window.agent.saveModel({
        provider,
        modelId,
        apiKey: apiKey || undefined,
        baseUrl,
        contextWindow,
      })
      setApiKey('')
      setModelStatus({ ok: true, detail: 'Saved' })
      await onChanged()
    } catch (error) {
      setModelStatus({ ok: false, detail: error instanceof Error ? error.message : String(error) })
    } finally {
      setModelBusy(false)
    }
  }

  const testModel = async () => {
    setModelBusy(true)
    setModelStatus(null)
    try {
      const result = await window.agent.testModel()
      setModelStatus(result)
    } finally {
      setModelBusy(false)
    }
  }

  const saveAccount = async () => {
    setAccountStatus(null)
    try {
      await window.agent.saveAccount(form)
      setForm(EMPTY_ACCOUNT)
      setShowForm(false)
      await onChanged()
      const fresh = await window.agent.bootstrap()
      setAccounts(fresh.accounts)
      setAccountStatus({ ok: true, detail: 'Saved' })
    } catch (error) {
      setAccountStatus({
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const removeAccount = async (id: string) => {
    await window.agent.deleteAccount(id)
    await onChanged()
    const fresh = await window.agent.bootstrap()
    setAccounts(fresh.accounts)
  }

  const editAccount = (account: Account) => {
    setConfirmRemove(null)
    setForm({
      id: account.id,
      name: account.name,
      endpoint: account.endpoint,
      region: account.region,
      forcePathStyle: account.forcePathStyle,
      accessKeyId: '',
      secretAccessKey: '',
      sessionToken: '',
      scope: { buckets: account.scope.buckets },
    })
    setShowForm(true)
    setAccountStatus(null)
  }

  const setLang = async (language: Lang) => {
    await window.agent.saveSettings({ language })
    await onChanged()
  }

  const setTheme = async (theme: Theme) => {
    await window.agent.saveSettings({ theme })
    await onChanged()
  }

  return (
    <div className="sheet" role="dialog" aria-modal="true" ref={trap}>
      <div className="sheet-head">
        <div className="sheet-head-inner">
          <h2>{t.settings}</h2>
          <div className="actions">
            <button className="icon-btn" type="button" aria-label={t.close} onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </div>
      </div>
      <div className="sheet-body">
        <div className="sheet-inner">
          <section className="section">
            <h3>{t.model}</h3>
            <p className="hint">
              Works with OpenAI, Anthropic, and any OpenAI-compatible endpoint (Ollama, LM Studio,
              vLLM, OpenRouter).
            </p>
            <div className="field">
              <label htmlFor="provider">{t.provider}</label>
              <select
                id="provider"
                value={provider}
                onChange={(event) => setProvider(event.target.value as Provider)}
              >
                <option value="openai">{t.providerOpenAI}</option>
                <option value="anthropic">{t.providerAnthropic}</option>
                <option value="compatible">{t.providerCompatible}</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="modelId">{t.modelId}</label>
              <input
                id="modelId"
                value={modelId}
                placeholder={provider === 'anthropic' ? 'claude-sonnet-5' : 'gpt-6-sol'}
                onChange={(event) => setModelId(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="baseUrl">
                {t.baseUrl}
                {provider === 'compatible' ? '' : ' (optional)'}
              </label>
              <input
                id="baseUrl"
                value={baseUrl}
                placeholder={
                  provider === 'openai'
                    ? 'https://api.openai.com/v1'
                    : provider === 'anthropic'
                      ? 'https://api.anthropic.com'
                      : 'http://localhost:11434/v1'
                }
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="apiKey">{t.apiKey}</label>
              <input
                id="apiKey"
                type="password"
                value={apiKey}
                placeholder=""
                onChange={(event) => setApiKey(event.target.value)}
              />
              <span className="hint">{t.keySaved}</span>
            </div>
            <div className="field">
              <label htmlFor="contextWindow">{t.contextWindow}</label>
              <input
                id="contextWindow"
                type="number"
                min={4096}
                step={1024}
                value={contextWindow}
                onChange={(event) => setContextWindow(Number(event.target.value))}
              />
            </div>
            <div className="account-actions">
              <button
                className="btn primary"
                type="button"
                disabled={modelBusy || !modelId}
                onClick={() => void saveModel()}
              >
                {t.save}
              </button>
              <button
                className="btn"
                type="button"
                disabled={modelBusy}
                onClick={() => void testModel()}
              >
                {t.test}
              </button>
              {modelStatus && (
                <span className={modelStatus.ok ? 'ok-text' : 'error-text'}>
                  {modelStatus.detail}
                </span>
              )}
            </div>
          </section>

          <section className="section">
            <h3>{t.accounts}</h3>
            {accounts.length === 0 && !showForm && <p className="hint">{t.noAccounts}</p>}
            {accounts.map((account) => (
              <div className="account" key={account.id}>
                <div className="account-head">
                  <div>
                    <div className="account-name">{account.name}</div>
                    <div className="account-meta">{account.endpoint || 'AWS'}</div>
                  </div>
                  <div className="account-actions">
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={() => editAccount(account)}
                    >
                      {t.edit}
                    </button>
                    <button
                      className="btn ghost danger"
                      type="button"
                      onClick={() => {
                        if (confirmRemove !== account.id) {
                          setConfirmRemove(account.id)
                          setTimeout(() => setConfirmRemove(null), 3000)
                          return
                        }
                        setConfirmRemove(null)
                        void removeAccount(account.id)
                      }}
                    >
                      {confirmRemove === account.id ? `${t.remove}?` : t.remove}
                    </button>
                  </div>
                </div>
                <div className="account-meta">
                  {account.scope.buckets.length
                    ? `${t.scope}: ${account.scope.buckets.join(', ')}`
                    : t.allBuckets}
                </div>
              </div>
            ))}

            {showForm ? (
              <div className="account" style={{ marginTop: 10 }}>
                <div className="field">
                  <label htmlFor="accName">{t.name}</label>
                  <input
                    id="accName"
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="accEndpoint">{t.endpoint}</label>
                  <input
                    id="accEndpoint"
                    value={form.endpoint}
                    placeholder="https://s3.example.com"
                    onChange={(event) => setForm({ ...form, endpoint: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="accRegion">{t.region}</label>
                  <input
                    id="accRegion"
                    value={form.region}
                    onChange={(event) => setForm({ ...form, region: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="accKey">{t.accessKey}</label>
                  <input
                    id="accKey"
                    value={form.accessKeyId}
                    onChange={(event) => setForm({ ...form, accessKeyId: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="accSecret">{t.secretKey}</label>
                  <input
                    id="accSecret"
                    type="password"
                    value={form.secretAccessKey}
                    onChange={(event) => setForm({ ...form, secretAccessKey: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="accToken">{t.sessionToken}</label>
                  <input
                    id="accToken"
                    type="password"
                    value={form.sessionToken ?? ''}
                    onChange={(event) => setForm({ ...form, sessionToken: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="accScope">{t.scope}</label>
                  <input
                    id="accScope"
                    value={form.scope.buckets.join(', ')}
                    placeholder="bucket-a, bucket-b"
                    onChange={(event) =>
                      setForm({
                        ...form,
                        scope: {
                          buckets: event.target.value
                            .split(',')
                            .map((value) => value.trim())
                            .filter(Boolean),
                        },
                      })
                    }
                  />
                  <span className="hint">{t.scopeHint}</span>
                </div>
                <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={form.forcePathStyle}
                    onChange={(event) => setForm({ ...form, forcePathStyle: event.target.checked })}
                  />
                  {t.pathStyle}
                </label>
                <div className="account-actions">
                  <button className="btn primary" type="button" onClick={() => void saveAccount()}>
                    {t.save}
                  </button>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      setShowForm(false)
                      setForm(EMPTY_ACCOUNT)
                    }}
                  >
                    {t.cancel}
                  </button>
                  {accountStatus && (
                    <span className={accountStatus.ok ? 'ok-text' : 'error-text'}>
                      {accountStatus.detail}
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <button className="btn" type="button" onClick={() => setShowForm(true)}>
                {t.addAccount}
              </button>
            )}
          </section>

          <section className="section">
            <h3>{t.memory}</h3>
            <p className="hint">{t.memoryHint}</p>
            {notes.length === 0 ? (
              <p className="hint">{t.noMemory}</p>
            ) : (
              <div className="memory-list">
                {notes.map((note) => (
                  <div className="memory-row" key={note.id}>
                    <span className="memory-text">{note.text}</span>
                    <button
                      className="text-action"
                      type="button"
                      onClick={() => void forget(note.id)}
                    >
                      {t.forget}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="section">
            <h3>{t.appearance}</h3>
            <div className="field">
              <span className="field-label">{t.language}</span>
              <div className="segmented">
                <button
                  className={lang === 'en' ? 'active' : ''}
                  type="button"
                  onClick={() => void setLang('en')}
                >
                  English
                </button>
                <button
                  className={lang === 'zh' ? 'active' : ''}
                  type="button"
                  onClick={() => void setLang('zh')}
                >
                  简体中文
                </button>
              </div>
            </div>
            <div className="field">
              <span className="field-label">{t.theme}</span>
              <div className="segmented">
                {(['system', 'light', 'dark'] as Theme[]).map((theme) => (
                  <button
                    key={theme}
                    className={boot.settings.theme === theme ? 'active' : ''}
                    type="button"
                    onClick={() => void setTheme(theme)}
                  >
                    {t[theme]}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <p className="hint" style={{ paddingTop: 8 }}>
            Storage Agent {boot.version}
          </p>
        </div>
      </div>
    </div>
  )
}
