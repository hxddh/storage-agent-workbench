import type {
  Account,
  AccountInput,
  Bootstrap,
  CatalogModel,
  Lang,
  LocalModel,
  ModelProvider,
  NoteRow,
  Theme,
} from '@shared/contract'
import { Brain, Cloud, Cpu, Palette, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { type Dict, dict, fill, kindName } from './i18n'
import { useFocusTrap } from './lib/focus'

type Provider = ModelProvider
export type SettingsPane = 'model' | 'accounts' | 'memory' | 'appearance'

/** Map the provider layer's fixed test messages; pass other provider errors through. */
function testDetail(detail: string, t: Dict): string {
  switch (detail.trim()) {
    case 'Connection error.':
      return t.testConnectionError
    case 'The model is not available.':
      return t.testModelUnavailable
    case 'The model returned an error.':
      return t.testModelError
    case 'A model id is required.':
      return t.testModelRequired
    case 'Enter an API key first.':
      return t.testKeyRequired
    default:
      return detail
  }
}

const EMPTY_ACCOUNT: AccountInput = {
  name: '',
  kind: 'auto',
  endpoint: '',
  region: 'us-east-1',
  forcePathStyle: false,
  auth: 'keys',
  profile: '',
  accessKeyId: '',
  secretAccessKey: '',
  sessionToken: '',
  scope: { buckets: [] },
  schedule: 'off',
}

export function Settings({
  boot,
  initialPane = 'model',
  onClose,
  onChanged,
}: {
  boot: Bootstrap
  initialPane?: SettingsPane
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const lang = boot.settings.language
  const t = dict(lang)
  const [pane, setPane] = useState<SettingsPane>(initialPane)
  const content = useRef<HTMLDivElement>(null)
  const panes = [
    { id: 'model' as const, label: t.model, icon: Cpu },
    { id: 'accounts' as const, label: t.accounts, icon: Cloud },
    { id: 'memory' as const, label: t.memory, icon: Brain },
    { id: 'appearance' as const, label: t.appearance, icon: Palette },
  ]
  const active = panes.find((item) => item.id === pane) ?? panes[0]!
  const scheduleLabel = (schedule: Account['schedule']) =>
    schedule === 'daily'
      ? t.schedule_daily
      : schedule === 'weekly'
        ? t.schedule_weekly
        : t.schedule_off
  const kindLabel = (kind: Account['kind']) => kindName(t, kind)
  const [provider, setProvider] = useState<Provider>(
    (boot.model?.provider as Provider) ?? 'compatible',
  )
  const [modelId, setModelId] = useState(boot.model?.modelId ?? '')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(boot.model?.baseUrl ?? '')
  // null means "infer on save"; never keep a previous model's window when the
  // user changes the id by hand.
  const [contextWindow, setContextWindow] = useState<number | null>(
    boot.model?.contextWindow ?? null,
  )
  const [models, setModels] = useState<CatalogModel[]>([])
  const [modelsBusy, setModelsBusy] = useState(false)
  const [modelDetail, setModelDetail] = useState('')
  const [profiles, setProfiles] = useState<string[]>([])
  const [localModels, setLocalModels] = useState<LocalModel[]>([])
  const [modelStatus, setModelStatus] = useState<{ ok: boolean; detail: string } | null>(null)
  const [modelBusy, setModelBusy] = useState(false)

  const [accounts, setAccounts] = useState<Account[]>(boot.accounts)
  const [form, setForm] = useState<AccountInput>(EMPTY_ACCOUNT)
  const [showForm, setShowForm] = useState(boot.accounts.length === 0)
  const [accountStatus, setAccountStatus] = useState<{ ok: boolean; detail: string } | null>(null)
  const [testingAccount, setTestingAccount] = useState<string | null>(null)
  const [accountTest, setAccountTest] = useState<{
    id: string
    ok: boolean
    detail: string
  } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [notes, setNotes] = useState<NoteRow[]>([])
  const trap = useFocusTrap<HTMLDivElement>(onClose, '[data-active-tab="true"]')

  useEffect(() => {
    void window.agent.notes().then(setNotes)
    void window.agent.awsProfiles().then(setProfiles)
    void window.agent.localModels().then(setLocalModels)
  }, [])

  const chooseLocal = (model: LocalModel) => {
    setProvider('compatible')
    setModelId(model.modelId)
    setBaseUrl(model.baseUrl)
    setApiKey('local')
  }

  const addDemo = async () => {
    await window.agent.addDemoAccount()
    await onChanged()
    const fresh = await window.agent.bootstrap()
    setAccounts(fresh.accounts)
    setShowForm(false)
  }

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
        ...(contextWindow ? { contextWindow } : {}),
      })
      setApiKey('')
      setModelStatus({ ok: true, detail: t.saved })
      await onChanged()
      if (accounts.length === 0) {
        setPane('accounts')
        setShowForm(true)
      }
    } catch (error) {
      setModelStatus({ ok: false, detail: error instanceof Error ? error.message : String(error) })
    } finally {
      setModelBusy(false)
    }
  }

  const fetchModels = async () => {
    setModelsBusy(true)
    setModelDetail('')
    try {
      const result = await window.agent.listModels({ provider, baseUrl, apiKey })
      setModels(result.models)
      setModelDetail(
        result.models.length ? `${result.models.length} ${t.modelsFound}` : t.noModelsFound,
      )
      if (!modelId && result.models[0]) {
        setModelId(result.models[0].id)
        if (result.models[0].contextWindow) setContextWindow(result.models[0].contextWindow)
      }
    } catch (error) {
      setModelDetail(error instanceof Error ? error.message : String(error))
    } finally {
      setModelsBusy(false)
    }
  }

  // A pasted key is enough; the model list arrives without a second button
  // click. Debounced so typing or pasting does not fan out requests. The
  // request is inline so this effect does not depend on a function identity.
  useEffect(() => {
    const key = apiKey.trim()
    if (!key) return
    let live = true
    const timer = setTimeout(() => {
      setModelsBusy(true)
      setModelDetail('')
      void window.agent
        .listModels({ provider, baseUrl, apiKey: key })
        .then((result) => {
          if (!live) return
          setModels(result.models)
          setModelDetail(
            result.models.length ? `${result.models.length} ${t.modelsFound}` : t.noModelsFound,
          )
          const first = result.models[0]
          setModelId((current) => current || first?.id || current)
          if (first?.contextWindow) setContextWindow((current) => current ?? first.contextWindow)
        })
        .catch((error) => {
          if (live) setModelDetail(error instanceof Error ? error.message : String(error))
        })
        .finally(() => {
          if (live) setModelsBusy(false)
        })
    }, 650)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [apiKey, provider, baseUrl, t.modelsFound, t.noModelsFound])

  const testModel = async () => {
    setModelBusy(true)
    setModelStatus(null)
    try {
      const result = await window.agent.testModel({
        provider,
        modelId,
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(contextWindow ? { contextWindow } : {}),
      })
      setModelStatus(result)
    } finally {
      setModelBusy(false)
    }
  }

  const saveAccount = async () => {
    setAccountStatus(null)
    try {
      const saved = await window.agent.saveAccount(form)
      setForm(EMPTY_ACCOUNT)
      setShowForm(false)
      await onChanged()
      const fresh = await window.agent.bootstrap()
      setAccounts(fresh.accounts)
      setAccountStatus({ ok: true, detail: t.saved })
      await testAccount(saved.id)
    } catch (error) {
      setAccountStatus({
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const testAccount = async (id: string) => {
    setTestingAccount(id)
    setAccountTest(null)
    try {
      const result = await window.agent.testAccount(id)
      setAccountTest({ id, ...result })
    } catch (error) {
      setAccountTest({
        id,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setTestingAccount(null)
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
      kind: account.kind,
      endpoint: account.endpoint,
      region: account.region,
      forcePathStyle: account.forcePathStyle,
      auth: account.auth,
      profile: account.profile ?? '',
      accessKeyId: '',
      secretAccessKey: '',
      sessionToken: '',
      scope: { buckets: account.scope.buckets },
      schedule: account.schedule ?? 'off',
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

  const setNotify = async (notify: boolean) => {
    await window.agent.saveSettings({ notify })
    await onChanged()
  }

  const setNoteTtl = async (noteTtlDays: number) => {
    await window.agent.saveSettings({ noteTtlDays })
    await onChanged()
  }

  useEffect(() => {
    if (pane) content.current?.scrollTo({ top: 0 })
  }, [pane])

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={t.settings} ref={trap}>
      <div className="sheet-head">
        <div className="sheet-head-inner">
          <button
            className="sheet-close"
            type="button"
            aria-label={t.closeSettings}
            title={t.closeSettings}
            onClick={onClose}
          >
            <X size={16} strokeWidth={1.8} />
          </button>
          <h2>{active.label}</h2>
        </div>
      </div>
      <div className="sheet-body">
        <div className="settings-layout">
          <nav className="settings-nav" aria-label={t.settingsNav}>
            <div className="settings-nav-list">
              {panes.map((item) => {
                const Icon = item.icon
                return (
                  <button
                    key={item.id}
                    className={`settings-tab ${pane === item.id ? 'active' : ''}`}
                    type="button"
                    aria-current={pane === item.id ? 'page' : undefined}
                    data-active-tab={pane === item.id ? 'true' : undefined}
                    onClick={() => setPane(item.id)}
                  >
                    <Icon size={15} strokeWidth={1.7} aria-hidden="true" />
                    {item.label}
                  </button>
                )
              })}
            </div>
            <div className="settings-nav-foot">
              <span>Storage Agent {boot.version}</span>
              {boot.update.state === 'downloading' && (
                <span>{fill(t.updateDownloading, { v: boot.update.version })}</span>
              )}
              {boot.update.state === 'ready' && (
                <button
                  className="settings-update"
                  type="button"
                  onClick={() => void window.agent.installUpdate()}
                >
                  {fill(t.updateReady, { v: boot.update.version })} {t.restartToUpdate}
                </button>
              )}
              {boot.update.state === 'unavailable' && <span>{t.updateUnavailable}</span>}
            </div>
          </nav>
          <div className="settings-content" ref={content}>
            <div className="sheet-inner">
              <section className="section" hidden={pane !== 'model'}>
                <p className="settings-desc">{t.settingsModelDesc}</p>
                {localModels.length > 0 && (
                  <>
                    <span className="field-label">{t.localModels}</span>
                    <div className="local-models">
                      {localModels.map((model) => (
                        <button
                          key={`${model.source}:${model.modelId}`}
                          className="local-model"
                          type="button"
                          onClick={() => chooseLocal(model)}
                        >
                          {t.useModel} {model.modelId}
                          <span className="hint">{model.source}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
                <div className="field">
                  <label htmlFor="provider">{t.provider}</label>
                  <select
                    id="provider"
                    value={provider}
                    onChange={(event) => {
                      setProvider(event.target.value as Provider)
                      setModels([])
                      setContextWindow(null)
                    }}
                  >
                    <option value="openai">{t.providerOpenAI}</option>
                    <option value="anthropic">{t.providerAnthropic}</option>
                    <option value="compatible">{t.providerCompatible}</option>
                  </select>
                  <span className="hint">{t.modelHint}</span>
                </div>
                <div className="field">
                  <label htmlFor="modelId">{t.modelId}</label>
                  <div className="model-pick">
                    <input
                      id="modelId"
                      value={modelId}
                      placeholder={provider === 'anthropic' ? 'claude-sonnet-5' : 'gpt-6-sol'}
                      onChange={(event) => {
                        setModelId(event.target.value)
                        setContextWindow(null)
                      }}
                    />
                    {!apiKey.trim() && (
                      <button
                        className="btn"
                        type="button"
                        disabled={modelsBusy}
                        onClick={() => void fetchModels()}
                      >
                        {modelsBusy ? t.fetching : t.fetchModels}
                      </button>
                    )}
                  </div>
                  {apiKey.trim() && modelsBusy && <span className="hint">{t.fetching}</span>}
                  {models.length > 0 && (
                    <select
                      aria-label={t.models}
                      value={modelId}
                      onChange={(event) => {
                        const next = event.target.value
                        setModelId(next)
                        const found = models.find((model) => model.id === next)
                        setContextWindow(found?.contextWindow ?? null)
                      }}
                    >
                      {models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.id}
                        </option>
                      ))}
                    </select>
                  )}
                  {modelDetail && <span className="hint">{modelDetail}</span>}
                </div>
                <div className="field">
                  <label htmlFor="baseUrl">
                    {t.baseUrl}
                    {provider === 'compatible' ? '' : ` ${t.optional}`}
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
                  <span className="hint">{boot.model ? t.keySaved : t.keyHint}</span>
                  {boot.platform === 'darwin' && <span className="hint">{t.keychainHint}</span>}
                </div>
                <p className="hint">{t.thinkingAuto}</p>
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
                      {testDetail(modelStatus.detail, t)}
                    </span>
                  )}
                </div>
              </section>

              <section className="section" hidden={pane !== 'accounts'}>
                <p className="settings-desc">{t.settingsAccountsDesc}</p>
                {accounts.length === 0 && !showForm && <p className="hint">{t.noAccounts}</p>}
                {accounts.map((account) => (
                  <div className="account" key={account.id}>
                    <div className="account-head">
                      <div>
                        <div className="account-name">{account.name}</div>
                        <div className="account-meta">
                          {kindLabel(account.kind)} · {account.endpoint || 'AWS'}
                          {account.auth === 'profile' && account.profile
                            ? ` · ${t.profile} ${account.profile}`
                            : account.accessKeyMasked
                              ? ` · ${account.accessKeyMasked}`
                              : ''}
                        </div>
                      </div>
                      <div className="account-actions">
                        <button
                          className="btn ghost"
                          type="button"
                          disabled={testingAccount === account.id}
                          onClick={() => void testAccount(account.id)}
                        >
                          {t.test}
                        </button>
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
                      {' · '}
                      {t.schedule}: {scheduleLabel(account.schedule)}
                    </div>
                    {accountTest?.id === account.id && (
                      <div className={accountTest.ok ? 'ok-text' : 'error-text'}>
                        {testDetail(accountTest.detail, t)}
                      </div>
                    )}
                  </div>
                ))}

                {showForm ? (
                  <div className="account account-form">
                    <div className="account-form-title">{form.id ? t.edit : t.addAccount}</div>
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
                      <label htmlFor="accKind">{t.providerKind}</label>
                      <select
                        id="accKind"
                        value={form.kind ?? 'auto'}
                        onChange={(event) =>
                          setForm({ ...form, kind: event.target.value as AccountInput['kind'] })
                        }
                      >
                        <option value="auto">{t.kind_auto}</option>
                        <option value="aws">{t.kind_aws}</option>
                        <option value="r2">{t.kind_r2}</option>
                        <option value="minio">{t.kind_minio}</option>
                        <option value="aliyun">{t.kind_aliyun}</option>
                        <option value="gcs">{t.kind_gcs}</option>
                        <option value="other">{t.kind_other}</option>
                      </select>
                      <span className="hint">{t.providerKindHint}</span>
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
                      <span className="field-label">{t.auth}</span>
                      <div className="segmented">
                        <button
                          className={form.auth === 'keys' ? 'active' : ''}
                          type="button"
                          onClick={() => setForm({ ...form, auth: 'keys' })}
                        >
                          {t.authKeys}
                        </button>
                        <button
                          className={form.auth === 'profile' ? 'active' : ''}
                          type="button"
                          onClick={() =>
                            setForm({
                              ...form,
                              auth: 'profile',
                              profile: form.profile || profiles[0] || '',
                            })
                          }
                        >
                          {t.authProfile}
                        </button>
                      </div>
                    </div>
                    {form.auth === 'profile' ? (
                      <div className="field">
                        <label htmlFor="accProfile">{t.profile}</label>
                        {profiles.length ? (
                          <select
                            id="accProfile"
                            value={form.profile ?? ''}
                            onChange={(event) => setForm({ ...form, profile: event.target.value })}
                          >
                            {profiles.map((name) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            id="accProfile"
                            value={form.profile ?? ''}
                            placeholder="default"
                            onChange={(event) => setForm({ ...form, profile: event.target.value })}
                          />
                        )}
                        <span className="hint">
                          {profiles.length ? t.profileHint : t.noProfiles}
                        </span>
                      </div>
                    ) : (
                      <>
                        <div className="field">
                          <label htmlFor="accKey">{t.accessKey}</label>
                          <input
                            id="accKey"
                            value={form.accessKeyId ?? ''}
                            onChange={(event) =>
                              setForm({ ...form, accessKeyId: event.target.value })
                            }
                          />
                        </div>
                        <div className="field">
                          <label htmlFor="accSecret">{t.secretKey}</label>
                          <input
                            id="accSecret"
                            type="password"
                            value={form.secretAccessKey ?? ''}
                            onChange={(event) =>
                              setForm({ ...form, secretAccessKey: event.target.value })
                            }
                          />
                        </div>
                        <div className="field">
                          <label htmlFor="accToken">{t.sessionToken}</label>
                          <input
                            id="accToken"
                            type="password"
                            value={form.sessionToken ?? ''}
                            onChange={(event) =>
                              setForm({ ...form, sessionToken: event.target.value })
                            }
                          />
                        </div>
                      </>
                    )}
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
                    <div className="field">
                      <label htmlFor="accSchedule">{t.schedule}</label>
                      <select
                        id="accSchedule"
                        value={form.schedule ?? 'off'}
                        onChange={(event) =>
                          setForm({
                            ...form,
                            schedule: event.target.value as AccountInput['schedule'],
                          })
                        }
                      >
                        <option value="off">{t.schedule_off}</option>
                        <option value="daily">{t.schedule_daily}</option>
                        <option value="weekly">{t.schedule_weekly}</option>
                      </select>
                      <span className="hint">{t.scheduleHint}</span>
                    </div>
                    <label className="check-field">
                      <input
                        type="checkbox"
                        checked={form.forcePathStyle}
                        onChange={(event) =>
                          setForm({ ...form, forcePathStyle: event.target.checked })
                        }
                      />
                      <span className="check-box" aria-hidden="true" />
                      <span>{t.pathStyle}</span>
                    </label>
                    <div className="account-actions">
                      <button
                        className="btn primary"
                        type="button"
                        onClick={() => void saveAccount()}
                      >
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
                  <div className="account-actions">
                    <button className="btn" type="button" onClick={() => setShowForm(true)}>
                      <Plus size={13} strokeWidth={1.8} aria-hidden="true" />
                      {t.addAccount}
                    </button>
                    {!accounts.some((account) =>
                      account.endpoint.includes('demo.storage-agent'),
                    ) && (
                      <button className="btn ghost" type="button" onClick={() => void addDemo()}>
                        {t.tryDemo}
                      </button>
                    )}
                  </div>
                )}
              </section>

              <section className="section" hidden={pane !== 'memory'}>
                <p className="settings-desc">{t.settingsMemoryDesc}</p>
                <div className="field">
                  <label htmlFor="noteTtl">{t.noteTtl}</label>
                  <select
                    id="noteTtl"
                    value={boot.settings.noteTtlDays}
                    onChange={(event) => void setNoteTtl(Number(event.target.value))}
                  >
                    {[0, 30, 90, 365].map((days) => (
                      <option key={days} value={days}>
                        {days === 0 ? t.noteTtlNever : fill(t.noteTtlDays, { n: days })}
                      </option>
                    ))}
                  </select>
                  <span className="hint">{t.noteTtlHint}</span>
                </div>
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
                <p className="hint">{t.memoryLimit}</p>
              </section>

              <section className="section" hidden={pane !== 'appearance'}>
                <p className="settings-desc">{t.settingsAppearanceDesc}</p>
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
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={boot.settings.notify}
                    onChange={(event) => void setNotify(event.target.checked)}
                  />
                  <span className="check-box" aria-hidden="true" />
                  <span>{t.notify}</span>
                </label>
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
