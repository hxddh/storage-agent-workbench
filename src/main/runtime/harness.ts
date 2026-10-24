/**
 * The task lifecycle on pi-durable.
 *
 * pi owns the durable loop — storage, resume, steering, abort, compaction and
 * tool tasks. This class creates a conversation per task, points it at the
 * configured model before every run, watches the open task, and turns a settled
 * run into notices, search rows and a refreshed estate digest. Projection lives
 * in `project.ts`, search in `search.ts`.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { NodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { createModels } from '@earendil-works/pi-ai'
import {
  type Conversation,
  type ConversationView,
  configure,
  createRegistry,
  Harness,
  type TaskGraph,
  type WatchHandle,
} from '@earendil-works/pi-durable'
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite'
import { auditVerdict } from '@shared/audit'
import type {
  AppEvent,
  AttachmentRef,
  AuditCheck,
  AuditReport,
  ContextRef,
  EstateRef,
  IssueRow,
  NoteRow,
  NoticeCode,
  ReverifyChange,
  ReverifyReport,
  SearchHit,
  TaskSummary,
  TaskView,
  ToolDetails,
  ToolView,
  UiEntry,
} from '@shared/contract'
import { knownExposure, knownNames } from '@shared/grounding'
import type { AppDb } from '../db'
import type { Estate } from '../estate/estate'
import { aspectsOf, BY_CODE, decide, ruleTitle } from '../estate/rules'
import type { ProviderConfig, Providers } from '../providers'
import { type AccessSession, readAccess } from '../s3/access'
import { readAccount, UNREAD_ACCOUNT } from '../s3/account'
import { readBucket } from '../s3/facts'
import { accessPermissionGaps, permissionGaps } from '../s3/permissions'
import { escapeTags, redact } from '../security/redact'
import type { Vault } from '../security/vault'
import type { Settings } from '../settings'
import { assertInScope, type ToolDeps } from '../tools/policy'
import { surveyTool } from '../tools/survey'
import { type AgentState, createAgent, freshRun, maxRounds, refreshDigest, tierFor } from './agent'
import { installModel, type ModelRef } from './model'
import { deriveTitle, LiveTracker, mapEntries, usageOf } from './project'
import { searchDocsFor, searchTasks } from './search'

const CONTEXT = BACKGROUND_CONTEXT
const INITIAL_ENTRIES = 200
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const

export interface HarnessDirs {
  task: (conversationId: string) => string
  datasets: (conversationId: string) => string
  uploads: (conversationId: string) => string
}

export type RunOutcome = 'answered' | 'failed' | 'stopped'

export interface HarnessDeps {
  db: AppDb
  providers: Providers
  estate: Estate
  settings: Settings
  vault: Vault
  models: ReturnType<typeof createModels>
  dirs: HarnessDirs
  emit: (event: AppEvent) => void
  /** A run settled; the shell decides whether to notify. */
  settled?: (task: TaskSummary, outcome: RunOutcome) => void
  /** How many tasks are running, for the dock and taskbar. */
  working?: (count: number) => void
}

interface ActiveWatch {
  id: string
  watch: WatchHandle<ConversationView>
  seen: Set<string>
  entries: UiEntry[]
}

export class AgentHarness {
  private readonly live = new LiveTracker()
  private active: ActiveWatch | null = null
  private graphWatch: WatchHandle<TaskGraph> | null = null
  private graphTasks: Record<string, { conversationId?: string; status?: string }> = {}
  private failed = new Set<string>()
  private modelRef: ModelRef | null = null

  private constructor(
    private readonly deps: HarnessDeps,
    private readonly harness: Harness,
    private readonly state: AgentState,
    private readonly tools: ToolDeps,
  ) {}

  static async open(database: NodeSqliteDatabase, deps: HarnessDeps): Promise<AgentHarness> {
    const storage = await SqliteStorage.open(database, { prefix: 'pi_' })
    const state: AgentState = {
      digest: '',
      language: deps.settings.get().language,
      tier: 'mid',
      runs: new Map(),
    }
    const tools: ToolDeps = {
      db: deps.db,
      providers: deps.providers,
      estate: deps.estate,
      datasetsDir: deps.dirs.datasets,
      uploadsDir: deps.dirs.uploads,
      lang: () => deps.settings.get().language,
    }
    const registry = createRegistry()
    registry.install(createAgent(tools, state))
    const harness = await Harness.open(
      storage,
      {
        models: () => deps.models,
        registry,
        // Cache the stable prompt prefix where the provider supports it.
        settings: { stream: { cacheRetention: 'short' } },
      },
      CONTEXT,
    )
    const instance = new AgentHarness(deps, harness, state, tools)
    instance.applyModel()
    // A run may start immediately after the window appears; the digest must be
    // in the prompt, not still loading. It is one small query.
    await refreshDigest(tools, state)
    instance.watchGraph()
    void instance.backfillSearch()
    return instance
  }

  // -- configuration ----------------------------------------------------------

  async refreshEstateDigest(): Promise<void> {
    await refreshDigest(this.tools, this.state)
  }

  setLanguage(language: string): void {
    this.state.language = language
    void this.refreshEstateDigest()
  }

  /** Install the stored model. Every run is pointed at it, so a change reaches old tasks too. */
  applyModel(): void {
    const stored = this.deps.settings.get().model
    if (!stored) {
      this.modelRef = null
      return
    }
    try {
      this.modelRef = installModel(this.deps.models, stored, this.deps.vault)
      this.state.tier = tierFor(stored.contextWindow)
    } catch {
      this.modelRef = null
    }
  }

  hasModel(): boolean {
    return this.modelRef !== null
  }

  // -- tasks ------------------------------------------------------------------

  async newTask(text: string): Promise<string> {
    const conversation = await this.harness.createConversation(
      { ownership: { kind: 'ownerless' } } as never,
      CONTEXT,
    )
    const id = String(conversation.id)
    await this.deps.db.upsertTaskMeta({ conversationId: id, title: deriveTitle(text) })
    await this.refreshTaskList()
    return id
  }

  async waitForIdle(taskId: string): Promise<void> {
    const conversation = await this.conversation(taskId)
    await conversation?.waitForIdle(CONTEXT)
  }

  async submit(
    taskId: string,
    text: string,
    attachments: AttachmentRef[],
    context: ContextRef[] = [],
  ): Promise<void> {
    const conversation = await this.require(taskId)
    const focus = await this.sanitizeContext(context)
    await this.deps.db.touchTask(taskId)
    await this.run(conversation, {
      content: withAttachments(text, attachments, focus),
      entry: {
        kind: 'sa.user',
        data: { text, attachments, ...(focus.length ? { context: focus } : {}) },
      },
    })
  }

  /** Names the user pointed at, checked against the estate and the account scope. */
  async sanitizeContext(context: ContextRef[]): Promise<ContextRef[]> {
    if (!Array.isArray(context) || context.length === 0) return []
    const accounts = await this.deps.providers.list()
    const out: ContextRef[] = []
    for (const raw of context.slice(0, 8)) {
      if (!raw || typeof raw !== 'object') continue
      const account = accounts.find((item) => item.id === raw.providerId)
      if (!account) continue
      if (raw.kind === 'account') {
        out.push({ kind: 'account', providerId: account.id, label: account.name })
        continue
      }
      const bucket = typeof raw.bucket === 'string' ? raw.bucket : ''
      if (!bucket || (account.scope.buckets.length && !account.scope.buckets.includes(bucket)))
        continue
      const known = (await this.deps.db.listBuckets(account.id)).some((row) => row.name === bucket)
      if (!known) continue
      if (raw.kind === 'issue') {
        const issueId = typeof raw.issueId === 'string' ? raw.issueId : ''
        const issue = issueId ? await this.deps.db.getIssue(issueId) : undefined
        if (!issue || issue.provider_id !== account.id) continue
        out.push({
          kind: 'issue',
          providerId: account.id,
          label: `${issue.bucket || account.name} · ${issue.code.replace(/_/g, ' ')}`.slice(0, 120),
          bucket,
          issueId,
        })
      } else {
        out.push({ kind: 'bucket', providerId: account.id, label: bucket, bucket })
      }
    }
    return out
  }

  async estateRefs(query: string): Promise<EstateRef[]> {
    const accounts = await this.deps.providers.list()
    const term = query.trim().toLowerCase()
    const refs: EstateRef[] = []
    for (const account of accounts) {
      if (!term || account.name.toLowerCase().includes(term))
        refs.push({
          id: `a:${account.id}`,
          kind: 'account',
          providerId: account.id,
          label: account.name,
          detail: account.endpoint || 'AWS',
        })
      const buckets = (await this.deps.db.listBuckets(account.id))
        .filter((row) => !term || row.name.toLowerCase().includes(term))
        .slice(0, 12)
      for (const bucket of buckets)
        refs.push({
          id: `b:${account.id}:${bucket.name}`,
          kind: 'bucket',
          providerId: account.id,
          label: bucket.name,
          bucket: bucket.name,
          detail: account.name,
        })
      const issues = (
        await this.deps.db.listIssues({
          providerId: account.id,
          status: 'open',
          limit: 40,
        })
      ).filter(
        (issue) =>
          !term ||
          issue.bucket.toLowerCase().includes(term) ||
          issue.code.toLowerCase().includes(term),
      )
      for (const issue of issues.slice(0, 6))
        refs.push({
          id: `i:${issue.id}`,
          kind: 'issue',
          providerId: account.id,
          label: `${issue.bucket || account.name} · ${issue.code.replace(/_/g, ' ')}`,
          bucket: issue.bucket,
          issueId: issue.id,
          detail: issue.severity,
        })
      if (refs.length >= 24) break
    }
    return refs.slice(0, 24)
  }

  async steer(taskId: string, text: string): Promise<void> {
    const conversation = await this.require(taskId)
    const submission = await conversation.submit(
      {
        type: 'input',
        content: text,
        whenBusy: 'steer',
        entry: { kind: 'sa.user', data: { text, attachments: [] } },
      },
      CONTEXT,
    )
    // A steer joins the running submission, whose settlement does the bookkeeping.
    void submission.wait(CONTEXT).catch(() => undefined)
  }

  async stop(taskId: string): Promise<void> {
    const conversation = await this.conversation(taskId)
    if (!conversation) return
    await conversation.abort(CONTEXT)
    await this.notice(conversation, 'stopped', 'info', 'continue')
  }

  /** Ask the last request again, with the files it carried. */
  async retry(taskId: string): Promise<void> {
    const conversation = await this.require(taskId)
    const last = [...(await this.entries(conversation))]
      .reverse()
      .find((entry) => entry.kind === 'user')
    if (last?.kind !== 'user') throw new Error('There is nothing to retry.')
    await this.run(conversation, {
      content: withAttachments(last.text, last.attachments, last.context ?? []),
      entry: {
        kind: 'sa.user',
        data: { text: last.text, attachments: last.attachments, context: last.context ?? [] },
      },
    })
  }

  /** Resume a stopped run. The resume is a boundary on the page, not a new question. */
  async continueTask(taskId: string): Promise<void> {
    const conversation = await this.require(taskId)
    await this.run(conversation, {
      content: 'Continue from where you stopped. Do not repeat calls that already finished.',
      entry: { kind: 'sa.continue' },
    })
  }

  /**
   * Re-read the buckets this task touched, without a model. It replays the
   * read-only configuration reading, not the model's prose: the report says
   * which conclusions changed and which stayed blind.
   */
  async reverify(taskId: string): Promise<ReverifyReport> {
    const conversation = await this.require(taskId)
    const entries = await this.entries(conversation)
    type ReplayAspect = 'security' | 'lifecycle' | 'observability' | 'access'
    const wanted = new Map<string, Map<string, Set<ReplayAspect>>>()
    const add = (providerId: string, names: Iterable<string>, aspects: Iterable<ReplayAspect>) => {
      const buckets = wanted.get(providerId) ?? new Map<string, Set<ReplayAspect>>()
      for (const name of names) {
        if (!name) continue
        const set = buckets.get(name) ?? new Set<ReplayAspect>()
        for (const aspect of aspects) set.add(aspect)
        buckets.set(name, set)
      }
      wanted.set(providerId, buckets)
    }
    for (const entry of entries) {
      if (entry.kind !== 'tool' || !entry.view) continue
      const view = entry.view
      if (view.kind === 'survey' && view.providerId)
        add(
          view.providerId,
          view.buckets.rows.map((row) => String(row[0] ?? '')),
          ['security', 'lifecycle'],
        )
      else if (view.kind === 'config' && view.providerId)
        add(view.providerId, [view.bucket], [view.aspect ?? 'security'])
      else if (view.kind === 'estate' && view.providerId && view.buckets)
        add(
          view.providerId,
          view.buckets.rows.map((row) => String(row[0] ?? '')),
          ['security', 'lifecycle'],
        )
      else if (view.kind === 'query' && view.providerId && view.buckets)
        add(view.providerId, view.buckets, ['security', 'lifecycle'])
    }
    if (!wanted.size) throw new Error('This task has no storage reading to re-verify.')
    const at = new Date().toISOString()
    const signal = AbortSignal.timeout(120_000)
    const changes: ReverifyChange[] = []
    let checked = 0
    let skipped = 0
    let opened = 0
    let resolved = 0
    let undecided = 0
    let truncated = false
    const sessions = new Map<string, AccessSession>()
    for (const [providerId, buckets] of wanted) {
      const accessSession = sessions.get(providerId) ?? {}
      sessions.set(providerId, accessSession)
      const config = await this.deps.providers.config(providerId).catch(() => null)
      if (!config) {
        skipped += buckets.size
        continue
      }
      const aws = this.deps.providers.isAws(config)
      const account = aws
        ? await readAccount(
            this.deps.providers.sts(config),
            this.deps.providers.control(config),
            signal,
          )
        : UNREAD_ACCOUNT
      const entriesForProvider = [...buckets.entries()]
      if (entriesForProvider.length > 50) {
        truncated = true
        skipped += entriesForProvider.length - 50
      }
      for (const [bucket, aspects] of entriesForProvider.slice(0, 50)) {
        if (config.scope.buckets.length && !config.scope.buckets.includes(bucket)) {
          skipped += 1
          continue
        }
        const readAspects = new Set(
          [...aspects].filter(
            (aspect): aspect is 'security' | 'lifecycle' | 'observability' => aspect !== 'access',
          ),
        )
        // `access` needs the security facts (policy/ACL/PAB) even when the task
        // only asked who can reach the bucket.
        if (readAspects.size === 0) readAspects.add('security')
        let facts: Awaited<ReturnType<typeof readBucket>>
        try {
          facts = await readBucket(this.deps.providers.client(config), bucket, {
            aspects: readAspects,
            signal,
            regional: this.deps.providers.regional(config),
            defaultRegion: config.region,
            aws,
            account,
          })
        } catch {
          skipped += 1
          continue
        }
        const wantedCodes = new Set(
          [...aspects].flatMap((aspect) => (aspect === 'access' ? [] : aspectsOf(aspect))),
        )
        const decisions = Object.fromEntries(
          Object.entries(decide(facts, this.deps.settings.get().language)).filter(([code]) =>
            wantedCodes.has(code),
          ),
        )
        const beforeIssues = new Map<string, Awaited<ReturnType<AppDb['findIssue']>>>()
        for (const code of Object.keys(decisions))
          beforeIssues.set(code, await this.deps.db.findIssue(config.id, bucket, code))
        const applied = await this.deps.estate.apply(config.id, bucket, decisions, taskId)
        opened += applied.delta.opened
        resolved += applied.delta.resolved
        if (aspects.has('access')) {
          try {
            await readAccess({
              bucket,
              facts,
              aws,
              iam: aws && config.caps.iam ? this.deps.providers.iam(config) : undefined,
              kms:
                aws && config.caps.kms && facts.encryption.value?.keyArn
                  ? this.deps.providers.kms(config, facts.region)
                  : undefined,
              analyzer:
                aws && config.caps.accessAnalyzer
                  ? this.deps.providers.accessAnalyzer(config, facts.region)
                  : undefined,
              organizations: aws ? this.deps.providers.organizations(config) : undefined,
              signal,
              session: accessSession,
            })
          } catch {
            skipped += 1
          }
        }
        checked += 1
        for (const [code, decision] of Object.entries(decisions)) {
          const rule = BY_CODE.get(code)
          if (!rule) continue
          const before = beforeIssues.get(code)
          const previous: ReverifyChange['before'] =
            before?.status === 'open'
              ? 'open'
              : before?.status === 'accepted'
                ? 'accepted'
                : 'clear'
          const after: ReverifyChange['after'] =
            decision.verdict === null
              ? 'undecided'
              : decision.verdict
                ? before?.status === 'accepted'
                  ? 'accepted'
                  : 'open'
                : 'clear'
          if (after === 'undecided') undecided += 1
          if (previous !== after)
            changes.push({
              bucket,
              code,
              title: ruleTitle(rule, this.deps.settings.get().language),
              before: previous,
              after,
            })
        }
      }
    }
    const report: ReverifyReport = {
      at,
      checked,
      skipped,
      ...(truncated ? { truncated } : {}),
      changes,
      opened,
      resolved,
      undecided,
    }
    await conversation
      .submit({ type: 'write', entry: { kind: 'sa.reverify', data: report as never } }, CONTEXT)
      .catch(() => undefined)
    return report
  }

  /**
   * A deterministic account check. It runs the same survey and access readers
   * as the tools, without a model, and stores one durable audit entry that the
   * window projects into the ordinary brief.
   */
  async audit(taskId: string): Promise<void> {
    const conversation = await this.require(taskId)
    const accounts = await this.deps.providers.list()
    if (accounts.length === 0) throw new Error('Add a storage account first.')
    const lang = this.deps.settings.get().language
    const signal = AbortSignal.timeout(300_000)
    const checks: AuditCheck[] = []
    const surveys: Extract<ToolView, { kind: 'survey' }>[] = []
    let failedAccounts = 0
    let accessExamined = 0
    let accessTotal = 0
    try {
      for (const account of accounts) {
        const config = await this.deps.providers.config(account.id)
        const session: AccessSession = {}
        const aws = this.deps.providers.isAws(config)
        const accountFacts = aws
          ? await readAccount(
              this.deps.providers.sts(config),
              this.deps.providers.control(config),
              signal,
            )
          : UNREAD_ACCOUNT
        const surveyDetails = await this.runAuditTool(
          surveyTool(this.tools),
          { provider_id: config.id },
          taskId,
          signal,
        )
        const surveyView = surveyDetails.view?.kind === 'survey' ? surveyDetails.view : null
        if (surveyView) surveys.push(surveyView)
        else failedAccounts += 1
        if (surveyView) {
          const bucketNames = surveyView.buckets.rows
            .map((row) => String(row[0] ?? ''))
            .filter(Boolean)
          const issueBuckets = surveyView.issues
            .filter((issue) => issue.bucket && issue.status === 'open')
            .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
            .map((issue) => issue.bucket)
          const selected = [...new Set([...issueBuckets, ...bucketNames])].slice(0, 24)
          accessTotal += surveyView.coverage.visible
          for (const bucket of selected) {
            try {
              const view = await this.auditAccess(config, bucket, accountFacts, session, signal)
              checks.push({
                name: 'config',
                target: bucket,
                status: 'done',
                note: view.accessCoverage
                  ? `${view.access?.length ?? 0} access path${(view.access?.length ?? 0) === 1 ? '' : 's'}`
                  : null,
                ms: null,
                at: new Date().toISOString(),
                view,
              })
              accessExamined += 1
            } catch (error) {
              checks.push({
                name: 'config',
                target: bucket,
                status: 'failed',
                note:
                  error instanceof Error
                    ? redact(error.message).slice(0, 160)
                    : 'Access read failed',
                ms: null,
                at: new Date().toISOString(),
                view: null,
              })
            }
          }
        }
        checks.push({
          name: 'survey',
          target: surveyDetails.target || config.name,
          status: surveyDetails.status,
          note: surveyDetails.note,
          ms: surveyDetails.ms,
          at: new Date().toISOString(),
          view: surveyDetails.view,
        })
      }
      const base = surveys.length
        ? auditVerdict(surveys, { examined: accessExamined, total: accessTotal }, lang)
        : lang === 'zh'
          ? '这次检查没有读到任何存储桶。'
          : 'The account check could not read any bucket.'
      const failed = failedAccounts
        ? lang === 'zh'
          ? `${failedAccounts} 个账号未能读取。`
          : `${failedAccounts} account${failedAccounts === 1 ? '' : 's'} could not be read.`
        : ''
      const report: AuditReport = {
        at: new Date().toISOString(),
        verdict: [base, failed].filter(Boolean).join(' '),
        checks,
        ...(accessTotal > accessExamined
          ? { accessBuckets: { examined: accessExamined, total: accessTotal } }
          : {}),
      }
      await conversation.submit(
        { type: 'write', entry: { kind: 'sa.audit', data: report as never } },
        CONTEXT,
      )
      await this.deps.db.touchTask(taskId)
      await this.index(taskId).catch(() => undefined)
      await this.refreshTaskList()
      await this.refreshEstateDigest()
      this.emitTask(taskId)
    } catch (error) {
      await this.notice(
        conversation,
        'failed',
        'error',
        undefined,
        error instanceof Error ? redact(error.message).slice(0, 200) : undefined,
      )
      throw error
    }
  }

  private async runAuditTool(
    tool: ReturnType<typeof surveyTool>,
    args: Record<string, unknown>,
    taskId: string,
    signal: AbortSignal,
  ): Promise<ToolDetails> {
    const result = await tool.execute(
      args as never,
      {
        conversationId: taskId,
        output: () => undefined,
        details: async () => undefined,
      } as never,
      { conversationId: taskId, abortSignal: signal } as never,
    )
    return result.details as unknown as ToolDetails
  }

  private async auditAccess(
    config: ProviderConfig,
    bucket: string,
    account: Awaited<ReturnType<typeof readAccount>>,
    session: AccessSession,
    signal: AbortSignal,
  ): Promise<Extract<ToolView, { kind: 'config' }>> {
    assertInScope(config, bucket)
    const aws = this.deps.providers.isAws(config)
    const facts = await readBucket(this.deps.providers.client(config), bucket, {
      aspects: new Set(['security']),
      signal,
      regional: this.deps.providers.regional(config),
      defaultRegion: config.region,
      aws,
      account,
    })
    if (facts.head === 'missing') throw new Error(`Bucket '${bucket}' does not exist.`)
    const access = await readAccess({
      bucket,
      facts,
      aws,
      iam: aws && config.caps.iam ? this.deps.providers.iam(config) : undefined,
      kms:
        aws && config.caps.kms && facts.encryption.value?.keyArn
          ? this.deps.providers.kms(config, facts.region)
          : undefined,
      analyzer:
        aws && config.caps.accessAnalyzer
          ? this.deps.providers.accessAnalyzer(config, facts.region)
          : undefined,
      organizations: aws ? this.deps.providers.organizations(config) : undefined,
      signal,
      session,
    })
    return {
      kind: 'config',
      bucket,
      providerId: config.id,
      aspect: 'access',
      findings: [],
      access: access.paths,
      accessBlind: access.blind,
      accessCoverage: access.coverage,
      permissions: [...permissionGaps(facts), ...accessPermissionGaps(bucket, access.blind)],
      observations: [],
    }
  }

  async acceptIssue(id: string, accepted: boolean): Promise<void> {
    const issue = await this.deps.db.setAccepted(id, accepted)
    if (!issue) return
    this.deps.emit({ type: 'issues', statuses: { [issue.id]: issue.status } })
    await this.refreshEstateDigest()
  }

  search(query: string): Promise<SearchHit[]> {
    return searchTasks(this.deps.db, query)
  }

  async notes(): Promise<NoteRow[]> {
    const rows = await this.deps.db.listNotes({ limit: 100 })
    return rows.map((note) => ({
      id: note.id,
      scope: note.scope,
      ref: note.ref,
      text: note.text,
      author: note.author,
      createdAt: note.created_at,
    }))
  }

  async deleteNote(id: string): Promise<void> {
    await this.deps.db.deleteNote(id)
    await this.refreshEstateDigest()
  }

  async pin(taskId: string, pinned: boolean): Promise<void> {
    await this.deps.db.setPinned(taskId, Boolean(pinned))
    await this.refreshTaskList()
  }

  async rename(taskId: string, title: string): Promise<void> {
    const clean = title.trim().slice(0, 120)
    if (!clean) return
    const meta = await this.deps.db.getTaskMeta(taskId)
    if (!meta) return
    await this.deps.db.upsertTaskMeta({
      conversationId: taskId,
      title: clean,
      createdAt: meta.created_at,
    })
    await this.refreshTaskList()
  }

  async deleteTask(taskId: string): Promise<void> {
    if (this.active?.id === taskId) {
      await this.active.watch.stop()
      this.active = null
    }
    const conversation = await this.conversation(taskId)
    if (conversation) await conversation.abort(CONTEXT).catch(() => undefined)
    this.state.runs.delete(taskId)
    this.failed.delete(taskId)
    await this.deps.db.deleteTaskMeta(taskId)
    await this.deps.db.deleteSearchDocs(taskId)
    await this.deps.db.purgeTask(taskId)
    await rm(this.deps.dirs.task(taskId), { recursive: true, force: true }).catch(() => undefined)
    if (this.deps.settings.get().lastTaskId === taskId) this.deps.settings.setLastTask(null)
    await this.refreshTaskList()
  }

  async listTasks(): Promise<TaskSummary[]> {
    const rows = await this.deps.db.listTaskMeta()
    return rows.map((row) => ({
      id: row.conversation_id,
      title: row.title,
      state: this.stateOf(row.conversation_id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      pinned: row.pinned === 1,
    }))
  }

  async openTask(taskId: string, focus?: string): Promise<TaskView> {
    const conversation = await this.require(taskId)
    const meta = await this.deps.db.getTaskMeta(taskId)
    if (!meta) throw new Error('Task not found.')
    await this.startWatch(conversation, taskId)
    this.deps.settings.setLastTask(taskId)
    const state = await conversation.viewState(CONTEXT)
    try {
      const entries = mapEntries(state.value.entries)
      if (this.active) this.active.entries = entries
      let start = Math.max(0, entries.length - INITIAL_ENTRIES)
      if (focus) {
        const source = focus.startsWith('f:') ? focus.slice(2).split(':')[0] : focus
        const index = entries.findIndex((entry) => entry.id === source || entry.id === focus)
        if (index >= 0) start = Math.max(0, index - 20)
      }
      const slice = entries.slice(start)
      return {
        task: {
          id: taskId,
          title: meta.title,
          state: this.stateOf(taskId),
          createdAt: meta.created_at,
          updatedAt: meta.updated_at,
          pinned: meta.pinned === 1,
        },
        entries: slice,
        live: this.live.map(state.value, taskId),
        hasOlder: start > 0,
        cursor: slice[0]?.id ?? null,
        usage: usageOf(state.value),
        issueStatus: await this.issueStatus(entries),
      }
    } finally {
      state.dispose()
    }
  }

  async older(
    taskId: string,
    before: string,
  ): Promise<{ entries: UiEntry[]; hasOlder: boolean; cursor: string | null }> {
    if (!this.active || this.active.id !== taskId)
      return { entries: [], hasOlder: false, cursor: null }
    const index = this.active.entries.findIndex((entry) => entry.id === before)
    if (index <= 0) return { entries: [], hasOlder: false, cursor: null }
    const start = Math.max(0, index - INITIAL_ENTRIES)
    const slice = this.active.entries.slice(start, index)
    return { entries: slice, hasOlder: start > 0, cursor: slice[0]?.id ?? null }
  }

  async close(): Promise<void> {
    if (this.active) await this.active.watch.stop().catch(() => undefined)
    await this.graphWatch?.stop().catch(() => undefined)
    await this.harness.close(CONTEXT)
  }

  // -- runs -------------------------------------------------------------------

  private async run(
    conversation: Conversation,
    input: { content: string; entry: { kind: string; data?: unknown } },
  ): Promise<void> {
    const taskId = String(conversation.id)
    if (!this.modelRef) throw new Error('Choose a model in Settings first.')
    const model = this.modelRef
    const thinking = this.deps.settings.get().model?.thinking ?? 'off'
    // The conversation follows the model in Settings, whichever was current when it began.
    await this.harness.commit(
      (tx) => configure(tx, conversation.id, { model, thinkingLevel: thinking }),
      CONTEXT,
    )
    const entries = await this.entries(conversation)
    this.state.runs.set(taskId, freshRun(knownNames(entries), knownExposure(entries)))
    this.failed.delete(taskId)
    const submission = await conversation.submit(
      { type: 'input', content: input.content, entry: input.entry as never },
      CONTEXT,
    )
    void this.settle(conversation, taskId, submission)
  }

  private async settle(
    conversation: Conversation,
    taskId: string,
    submission: { wait(context: typeof CONTEXT): Promise<{ status: string; reason?: string }> },
  ): Promise<void> {
    let outcome: RunOutcome = 'answered'
    try {
      const settled = await submission.wait(CONTEXT)
      if (settled.status === 'unanswered') {
        if (settled.reason === 'aborted') outcome = 'stopped'
        else {
          outcome = 'failed'
          await this.notice(conversation, 'no_answer', 'error', 'retry', settled.reason)
        }
      }
    } catch (error) {
      outcome = 'failed'
      await this.notice(
        conversation,
        'failed',
        'error',
        'retry',
        error instanceof Error ? error.message.slice(0, 200) : undefined,
      )
    } finally {
      if (outcome === 'failed') this.failed.add(taskId)
      if ((this.state.runs.get(taskId)?.rounds ?? 0) >= maxRounds(this.state.tier))
        await this.notice(conversation, 'budget', 'warn')
      this.state.runs.delete(taskId)
      await this.deps.db.touchTask(taskId)
      await this.refreshTaskList()
      await this.index(taskId).catch(() => undefined)
      await this.refreshEstateDigest()
      const meta = await this.deps.db.getTaskMeta(taskId)
      if (meta)
        this.deps.settled?.(
          {
            id: taskId,
            title: meta.title,
            state: this.stateOf(taskId),
            createdAt: meta.created_at,
            updatedAt: meta.updated_at,
            pinned: meta.pinned === 1,
          },
          outcome,
        )
    }
  }

  private async notice(
    conversation: Conversation,
    code: NoticeCode,
    tone: 'info' | 'warn' | 'error',
    action?: 'retry' | 'continue',
    detail?: string,
  ): Promise<void> {
    await conversation
      .submit(
        {
          type: 'write',
          entry: {
            kind: 'sa.notice',
            data: { code, text: detail ?? '', tone, ...(action ? { action } : {}) },
          },
        },
        CONTEXT,
      )
      .catch(() => undefined)
  }

  // -- internals --------------------------------------------------------------

  private async conversation(id: string): Promise<Conversation | null> {
    try {
      return (await this.harness.conversation(id as never, CONTEXT)) ?? null
    } catch {
      return null
    }
  }

  private async require(id: string): Promise<Conversation> {
    const conversation = await this.conversation(id)
    if (!conversation) throw new Error('Task not found.')
    return conversation
  }

  private async entries(conversation: Conversation): Promise<UiEntry[]> {
    const state = await conversation.viewState(CONTEXT)
    try {
      return mapEntries(state.value.entries)
    } finally {
      state.dispose()
    }
  }

  private async issueStatus(
    entries: readonly UiEntry[],
  ): Promise<Record<string, IssueRow['status']>> {
    const ids = new Set<string>()
    for (const entry of entries) {
      if (entry.kind !== 'tool' || !entry.view) continue
      if (entry.view.kind === 'survey' || entry.view.kind === 'estate')
        for (const issue of entry.view.issues) ids.add(issue.id)
    }
    return this.deps.db.issueStatuses([...ids])
  }

  private async startWatch(conversation: Conversation, taskId: string): Promise<void> {
    if (this.active?.id === taskId) return
    if (this.active) await this.active.watch.stop().catch(() => undefined)
    const watch = await conversation.watch(CONTEXT)
    const active: ActiveWatch = { id: taskId, watch, seen: new Set(), entries: [] }
    this.active = active
    for (const entry of mapEntries(watch.value.entries)) active.seen.add(entry.id)
    let lastUsage = JSON.stringify(usageOf(watch.value))
    await watch.start(async (value) => {
      if (this.active !== active) return
      const mapped = mapEntries(value.entries)
      active.entries = mapped
      for (const entry of mapped) {
        if (active.seen.has(entry.id)) continue
        active.seen.add(entry.id)
        this.deps.emit({ type: 'entry', taskId, entry })
      }
      this.deps.emit({ type: 'live', taskId, live: this.live.map(value, taskId) })
      const usage = usageOf(value)
      const serialized = JSON.stringify(usage)
      if (serialized !== lastUsage) {
        lastUsage = serialized
        this.deps.emit({ type: 'usage', taskId, usage })
      }
      this.emitTask(taskId)
    })
    this.deps.emit({ type: 'live', taskId, live: this.live.map(watch.value, taskId) })
  }

  private async index(taskId: string): Promise<void> {
    const conversation = await this.conversation(taskId)
    if (!conversation) return
    await this.deps.db.replaceSearchDocs(taskId, searchDocsFor(await this.entries(conversation)))
  }

  private async backfillSearch(): Promise<void> {
    for (const id of await this.deps.db.conversationsWithoutSearch()) {
      await this.index(id).catch(() => undefined)
    }
  }

  private stateOf(taskId: string): TaskSummary['state'] {
    const nodes = Object.values(this.graphTasks).filter((node) => node.conversationId === taskId)
    if (nodes.some((node) => node.status && node.status !== 'done')) return 'working'
    if (this.failed.has(taskId)) return 'attention'
    return 'ready'
  }

  private watchGraph(): void {
    void this.harness
      .watchTaskGraph(CONTEXT)
      .then((watch) => {
        this.graphWatch = watch
        const apply = (value: TaskGraph) => {
          this.graphTasks = (value.tasks ?? {}) as unknown as Record<
            string,
            { conversationId?: string; status?: string }
          >
          const working = new Set(
            Object.values(this.graphTasks)
              .filter((node) => node.status && node.status !== 'done' && node.conversationId)
              .map((node) => node.conversationId),
          )
          this.deps.working?.(working.size)
          void this.refreshTaskList()
        }
        apply(watch.value)
        watch.start(async (value) => {
          apply(value)
        })
      })
      .catch(() => undefined)
  }

  private emitTask(taskId: string): void {
    void this.deps.db.getTaskMeta(taskId).then((meta) => {
      if (!meta) return
      this.deps.emit({
        type: 'task',
        task: {
          id: taskId,
          title: meta.title,
          state: this.stateOf(taskId),
          createdAt: meta.created_at,
          updatedAt: meta.updated_at,
          pinned: meta.pinned === 1,
        },
      })
    })
  }

  private async refreshTaskList(): Promise<void> {
    this.deps.emit({ type: 'tasks', tasks: await this.listTasks() })
  }
}

function withAttachments(
  text: string,
  attachments: readonly AttachmentRef[],
  context: readonly ContextRef[] = [],
): string {
  const parts = [text]
  if (attachments.length)
    parts.push(`[attached files: ${attachments.map((file) => file.name).join(', ')}]`)
  if (context.length)
    parts.push(
      `<untrusted-data source="user-context">\n[Focused names; focus only, not authorization]\n${escapeTags(
        context
          .map(
            (item) =>
              `${item.kind}: ${item.label}${item.bucket && item.kind !== 'account' ? ` (${item.bucket})` : ''}`,
          )
          .join('\n'),
      )}\n</untrusted-data>`,
    )
  return parts.join('\n\n')
}

export function harnessDirs(dataDir: string): HarnessDirs {
  return {
    task: (conversationId) => join(dataDir, 'tasks', conversationId),
    datasets: (conversationId) => join(dataDir, 'tasks', conversationId, 'datasets'),
    uploads: (conversationId) => join(dataDir, 'tasks', conversationId, 'uploads'),
  }
}
