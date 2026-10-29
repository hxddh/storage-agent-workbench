/**
 * The contract between the main process and the window.
 *
 * One file, imported by both sides. The renderer never sees a model message,
 * a secret, or a raw S3 response; every value here is already redacted and
 * shaped for display.
 */

export type Severity = 'high' | 'medium' | 'low'
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'
export type ModelProvider = 'anthropic' | 'openai' | 'compatible'
export type Lang = 'en' | 'zh'
export type Theme = 'light' | 'dark' | 'system'

export type ToolName =
  | 'survey'
  | 'buckets'
  | 'objects'
  | 'object'
  | 'config'
  | 'probe'
  | 'estate'
  | 'change_plan'
  | 'note'
  | 'query'
  | 'skill'
  | 'plan'
  | 'ask'
  | 'accept_risk'

export type TaskState = 'ready' | 'working' | 'queued' | 'attention' | 'failed'
export type CheckSchedule = 'off' | 'daily' | 'weekly'

export interface Table {
  columns: string[]
  rows: (string | number | null)[][]
  truncated?: boolean
}

export interface IssueRow {
  id: string
  provider: string
  bucket: string
  code: string
  severity: Severity
  /** `accepted` is the user's decision; the model can never set it. */
  status: 'open' | 'resolved' | 'accepted'
  title: string
  detail: string | null
  /** The AWS Security Hub control the rule matches, when one does. */
  control?: string
  openedAt: string
  lastSeenAt: string
  recurred: number
}

export interface NoteRow {
  id: string
  scope: 'estate' | 'provider' | 'bucket'
  ref: string | null
  text: string
  author: 'agent' | 'user'
  createdAt: string
}

/**
 * One line of a review. `blind` is a read that could not see: it is shown, and
 * it never counts as clean. Codes are rule codes, `advice:*` or `blind:*`.
 */
export interface ConfigFinding {
  severity: Severity | 'ok' | 'blind'
  title: string
  detail: string
  code?: string
}

/** What one reading decided about one rule on one bucket. */
export interface Observation {
  provider: string
  bucket: string
  code: string
  verdict: boolean
}

export interface ProbeCheck {
  name: string
  ok: boolean
  detail: string
  ms: number
}

export interface PermissionGap {
  bucket: string
  item: string
  action: string
}

export interface PostureChange {
  bucket: string
  field: string
  before: string
  after: string
  at: string
}

export interface AccessPath {
  source: 'policy' | 'acl' | 'iam' | 'trust' | 'kms' | 'access-analyzer'
  principal: string
  actions: string[]
  condition: string | null
  public: boolean
  note: string | null
}

/** How much of the effective-access question a reading actually covered. */
export interface AccessCoverage {
  principals: number
  evaluated: number
  undecided: number
  truncated: boolean
  sources: string[]
  /** Present on a principal-first reverse query. */
  bucketsExamined?: number
  bucketsTotal?: number
}

export interface ChangeFormat {
  label: string
  language: 'bash' | 'hcl' | 'json'
  text: string
}

export interface Impact {
  verdict: 'low' | 'caution' | 'unknown'
  reasons: string[]
  gap: string | null
}

export interface ChangePlanStep {
  id: string
  bucket: string
  codes: string[]
  title: string
  severity: Severity
  formats: ChangeFormat[]
  impact: Impact
  notes: string[]
  status: 'ready' | 'manual'
  blockers: string[]
}

export interface ChangePlan {
  steps: ChangePlanStep[]
  baseline: {
    at: string
    complete: boolean
    visible: number
    processed: number
    openHigh: number
    openTotal: number
  } | null
  residual: { bucket: string; code: string; title: string }[]
  summary: string
}

export interface Chart {
  type: 'bar'
  labels: string[]
  values: number[]
  unit?: string
}

/** One step of the agent's own investigation plan. */
export interface PlanStep {
  title: string
  status: 'pending' | 'active' | 'done' | 'blocked'
  detail?: string
}

export type ToolView =
  | {
      kind: 'survey'
      provider: string
      providerId?: string
      /** The read was narrowed to named buckets; it does not prove the account's coverage. */
      scoped?: boolean
      buckets: Table
      issues: IssueRow[]
      /** Open Issues of the account in the estate; `issues` may hold fewer. */
      issueTotal?: number
      /** Rules this survey could not decide because an aspect was blind. */
      undecided?: { bucket: string; code: string; title: string }[]
      observations?: Observation[]
      /** Account-wide posture: the S3 Control public access block. */
      account?: { pab: 'on' | 'partial' | 'off' | 'unknown' | 'n/a' }
      /** The account block was decided by this survey, not just remembered. */
      accountRead?: boolean
      /** Storage totals from CloudWatch, when the account publishes them. */
      capacity?: { bytes: number; objects: number; monthlyUsd: number; buckets: number } | null
      coverage: {
        visible: number
        processed: number
        truncated: boolean
        pending?: number
        denied: string[]
        unknown: string[]
        gone?: string[]
      }
      changed: { opened: number; resolved: number; recurred: number }
      /** Access-denied reads and the IAM action each one needs. */
      permissions?: PermissionGap[]
      /** Differences from the last remembered posture, when this was not the first read. */
      postureChanges?: PostureChange[]
      /** CloudTrail attribution for a difference; absent when nothing changed. */
      attribution?: {
        status: 'ok' | 'denied' | 'unsupported' | 'error'
        events: { at: string; event: string; actor: string }[]
        from?: string
        to?: string
        days?: number
        truncated?: boolean
      }
    }
  | { kind: 'buckets'; rows: Table }
  | { kind: 'objects'; rows: Table }
  | {
      kind: 'object'
      facts: [string, string][]
      preview: { language: string; text: string } | null
    }
  | {
      kind: 'config'
      bucket: string
      providerId?: string
      aspect?: 'security' | 'lifecycle' | 'observability' | 'access'
      /** Who can reach the bucket, from policy, ACL, IAM, KMS and Access Analyzer. */
      access?: AccessPath[]
      accessBlind?: { source: string; status: string }[]
      accessCoverage?: AccessCoverage
      exposure?: 'public' | 'not public' | 'unknown'
      findings: ConfigFinding[]
      /** Issues this review opened or kept, so a finding can be accepted. */
      issues?: IssueRow[]
      observations?: Observation[]
      permissions?: PermissionGap[]
    }
  | { kind: 'probe'; endpoint: string; checks: ProbeCheck[] }
  | {
      kind: 'estate'
      providerId?: string
      /** The bucket the read was narrowed to; its Issue list covers only that bucket. */
      bucket?: string | null
      /** The oldest remembered reading in the table: memory is only as fresh as this. */
      readAt?: string | null
      buckets: Table | null
      issues: IssueRow[]
      notes: NoteRow[]
      /** Issue life-cycle events and posture changes, when history was requested. */
      history?: Table
    }
  | {
      kind: 'change'
      providerId?: string
      bucket: string
      code: string
      formats: ChangeFormat[]
      impact: Impact
      /** A merged, ordered change plan; its first step is also exposed above. */
      plan?: ChangePlan
      /** More buckets or rules generated by the same batch request; the first is above. */
      batch?: { bucket: string; code: string; formats: ChangeFormat[]; impact: Impact }[]
    }
  | { kind: 'note'; text: string }
  | {
      kind: 'query'
      providerId?: string
      title: string
      /** The script that produced the rows: the evidence for them. */
      code: string
      rows: Table
      chart: Chart | null
      output: string | null
      calls: number
      listed: number
      /** Buckets the script read. */
      buckets?: string[]
      /** Coverage of the access question when the script called principal(). */
      coverage?: AccessCoverage
      /** Sources the access question could not read. */
      blind?: { source: string; status: string }[]
    }
  | {
      kind: 'skill'
      name: string
      title: string
      description: string
      body: string
    }
  | { kind: 'plan'; steps: PlanStep[]; note?: string }
  | { kind: 'question'; question: string; options: string[]; note?: string }
  /** A request for the user to accept (or reopen) a risk; only the user's click changes it. */
  | { kind: 'accept'; issue: IssueRow; accept: boolean }

export type ToolStatus = 'running' | 'done' | 'failed' | 'refused' | 'stopped' | 'timeout'

/** What `agentTool()` attaches to every result; the status is never parsed from text. */
export interface ToolDetails {
  target: string
  note: string | null
  /** A bounded, redacted progress line for the live work ledger. */
  progress?: string | null
  /** A bounded, redacted summary of the call's arguments. */
  args?: string | null
  view: ToolView | null
  ms: number | null
  status: ToolStatus
  /** Stable id the model cites from its answer. */
  evidenceId?: string
  /** Hash of the exact arguments: the run ledger blocks a repeated read by it. */
  key?: string
  /** What the rules did with this reading, applied by `estate/assess.ts`. */
  assessed?: Assessed
}

/** The Issue transitions one reading caused. The model never causes one. */
export interface Assessed {
  opened: number
  resolved: number
  recurred: number
}

/** App notices are codes; the window words them in the user's language. */
export type NoticeCode = 'stopped' | 'no_answer' | 'failed' | 'budget' | 'model_missing'

export interface LiveTool {
  callId: string
  name: ToolName
  target: string
  note: string | null
  args?: string | null
  status: ToolStatus
  startedAt: string
}

/**
 * A provider-supplied reasoning summary, never a fabricated chain of thought.
 * Some models return text; others return an empty block (`summary: null`).
 */
export interface LiveReasoning {
  summary: string | null
  startedAt: string
}

export interface AttachmentRef {
  name: string
  bytes: number
}

/** A name the user pointed at. Focus only: scope is still the security boundary. */
export interface ContextRef {
  kind: 'account' | 'bucket' | 'issue'
  providerId: string
  label: string
  bucket?: string
  issueId?: string
}

/** One row in the composer's @ picker. */
export interface EstateRef extends ContextRef {
  id: string
  detail: string
}

/** A file chosen in the open dialog, staged until the message is sent. */
export interface StagedFile extends AttachmentRef {
  token: string
}

export type UiEntry =
  /** A user message: it starts a turn. */
  | {
      id: string
      kind: 'user'
      at: string
      text: string
      attachments: AttachmentRef[]
      context?: ContextRef[]
    }
  /** A message sent while the agent works; it joins the running turn. */
  | {
      id: string
      kind: 'steer'
      at: string
      text: string
      attachments: AttachmentRef[]
      context?: ContextRef[]
    }
  /** The model's text. A turn can hold several, between tool calls. */
  | { id: string; kind: 'answer'; at: string; text: string; streaming?: boolean }
  /** A provider-supplied reasoning summary. It is not a tool result. */
  | { id: string; kind: 'reasoning'; at: string; text: string }
  | {
      id: string
      kind: 'tool'
      at: string
      name: ToolName
      target: string
      status: ToolStatus
      note: string | null
      args?: string | null
      ms: number | null
      view: ToolView | null
      callId?: string
      evidenceId?: string
      key?: string
      assessed?: Assessed
    }
  | {
      id: string
      kind: 'notice'
      at: string
      /** A code the window translates; absent for provider errors, which are shown as text. */
      code?: NoticeCode
      text: string
      tone: 'info' | 'warn' | 'error'
      action?: 'retry' | 'continue'
    }
  | { id: string; kind: 'compaction'; at: string; text: string }
  /** The user asked a stopped turn to continue. */
  | { id: string; kind: 'resume'; at: string }

export interface TaskSummary {
  id: string
  title: string
  state: TaskState
  createdAt: string
  updatedAt: string
  pinned: boolean
}

export interface Live {
  phase: 'thinking' | 'reasoning' | 'tool' | 'writing'
  tools: LiveTool[]
  reasoning: LiveReasoning | null
  text: string | null
  startedAt: string
}

export interface SearchHit {
  taskId: string
  title: string
  kind: 'title' | 'user' | 'answer' | 'finding'
  snippet: string
  matchStart: number
  matchLength: number
  entryId: string | null
}

export interface TaskView {
  task: TaskSummary
  entries: UiEntry[]
  live: Live | null
  hasOlder: boolean
  cursor: string | null
  usage: Usage | null
  /** A per-task model override; null means the model in Settings. */
  model?: TaskModel | null
  /** Current estate status of every Issue the task's results mention; the user may have accepted one since. */
  issueStatus: Record<string, IssueRow['status']>
}

/** A task's model spend, from pi's usage ledger. Cost is zero when the price is unknown. */
export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  cost: number
}

export type ProviderKind = 'aws' | 'r2' | 'minio' | 'aliyun' | 'gcs' | 'other'

export interface Account {
  id: string
  name: string
  kind: ProviderKind
  endpoint: string
  region: string
  forcePathStyle: boolean
  /** Static keys sealed in the vault, or a named profile the AWS SDK resolves (SSO, process, role). */
  auth: 'keys' | 'profile'
  profile: string | null
  accessKeyMasked: string
  hasSessionToken: boolean
  scope: { buckets: string[] }
  /** Opt-in read-only checks while the app is open. */
  schedule?: CheckSchedule
}

export interface AccountInput {
  id?: string
  name: string
  kind?: ProviderKind | 'auto'
  endpoint: string
  region: string
  forcePathStyle: boolean
  auth: 'keys' | 'profile'
  profile?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  scope: { buckets: string[] }
  schedule?: CheckSchedule
}

export interface ModelSettings {
  provider: ModelProvider
  modelId: string
  baseUrl: string | null
  contextWindow: number | null
  thinking: ThinkingLevel
  hasKey: boolean
}

/** A model choice for one task. The provider key stays in the saved model. */
export interface TaskModel {
  provider: ModelProvider
  modelId: string
  baseUrl: string | null
  thinking: ThinkingLevel
}

export interface ModelInput {
  provider: ModelProvider
  modelId: string
  apiKey?: string
  baseUrl?: string
  contextWindow?: number
  thinking?: ThinkingLevel
}

export interface CatalogModel {
  id: string
  contextWindow: number | null
}

export interface ModelListInput {
  provider: ModelProvider
  baseUrl: string
  apiKey?: string
}

export interface AppSettings {
  language: Lang
  theme: Theme
  /** A system notification when a run finishes while the window is in the background. */
  notify: boolean
  /** A remembered finding older than this is marked possibly stale. */
  staleDays: number
  /** Notes older than this are hidden from Memory; 0 keeps every note. */
  noteTtlDays: number
}

export type UpdateState =
  | { state: 'idle' }
  | { state: 'downloading'; version: string }
  | { state: 'ready'; version: string }
  /** This platform's release feed is missing; updates cannot be checked. */
  | { state: 'unavailable' }

export interface AccountOverview {
  id: string
  name: string
  kind: ProviderKind
  buckets: number
  /** The latest complete Reading for this account; null means none is proven. */
  lastCompleteRead: string | null
  openHigh: number
  openTotal: number
}

export interface EstateOverview {
  accounts: AccountOverview[]
  /** The latest complete Reading across accounts. */
  lastCompleteRead: string | null
  /** Open Issues opened since the latest complete Reading. */
  changesSince: number
}

export interface Bootstrap {
  version: string
  platform: string
  tasks: TaskSummary[]
  accounts: Account[]
  model: ModelSettings | null
  settings: AppSettings
  overview: EstateOverview
  update: UpdateState
  /** The task open when the window last closed. */
  lastTaskId: string | null
}

export type AppEvent =
  | { type: 'tasks'; tasks: TaskSummary[] }
  | { type: 'task'; task: TaskSummary }
  | { type: 'entry'; taskId: string; entry: UiEntry }
  | { type: 'patch'; taskId: string; entryId: string; patch: Partial<UiEntry> }
  | { type: 'live'; taskId: string; live: Live | null }
  | { type: 'usage'; taskId: string; usage: Usage | null }
  | { type: 'issues'; statuses: Record<string, IssueRow['status']> }
  | { type: 'update'; update: UpdateState }
  /** The user clicked a notification for this task. */
  | { type: 'open'; taskId: string }
  | { type: 'bootstrap' }

export type AppCommand = 'settings' | 'new-task' | 'stop' | 'search'

/** A model already running on this machine (Ollama, LM Studio). */
export interface LocalModel {
  source: 'Ollama' | 'LM Studio'
  baseUrl: string
  modelId: string
}

/** The link that opens a task from anywhere: `storage-agent://task/<id>`. */
export const TASK_LINK_PREFIX = 'storage-agent://task/'

/** The preload surface. Nothing else is exposed to the renderer. */
export interface AgentApi {
  bootstrap(): Promise<Bootstrap>
  openTask(id: string, focus?: string): Promise<TaskView>
  older(
    taskId: string,
    before: string,
  ): Promise<{ entries: UiEntry[]; hasOlder: boolean; cursor: string | null }>
  createTask(text: string, attachments: string[], context?: ContextRef[]): Promise<TaskView>
  send(taskId: string, text: string, attachments: string[], context?: ContextRef[]): Promise<void>
  /** Use a different model for this task's next run; null restores Settings. */
  setTaskModel(taskId: string, model: TaskModel | null): Promise<void>
  estateRefs(query: string): Promise<EstateRef[]>
  steer(taskId: string, text: string, attachments: string[], context?: ContextRef[]): Promise<void>
  stop(taskId: string): Promise<void>
  renameTask(taskId: string, title: string): Promise<void>
  pinTask(taskId: string, pinned: boolean): Promise<void>
  deleteTask(taskId: string): Promise<void>
  retryTask(taskId: string): Promise<void>
  continueTask(taskId: string): Promise<void>
  search(query: string): Promise<SearchHit[]>
  notes(): Promise<NoteRow[]>
  deleteNote(id: string): Promise<void>
  saveText(input: {
    name: string
    content: string
    kind: 'markdown' | 'csv' | 'json'
  }): Promise<boolean>
  exportPdf(): Promise<boolean>
  pickFiles(): Promise<StagedFile[]>
  saveAccount(input: AccountInput): Promise<Account>
  deleteAccount(id: string): Promise<void>
  testAccount(id: string): Promise<{ ok: boolean; detail: string }>
  acceptIssue(id: string, accepted: boolean): Promise<void>
  awsProfiles(): Promise<string[]>
  /** Stage files dropped or pasted into the composer. */
  stageFiles(files: File[]): Promise<StagedFile[]>
  installUpdate(): Promise<void>
  /** Add the in-process demo account: a sample estate, no network. */
  addDemoAccount(): Promise<Account>
  localModels(): Promise<LocalModel[]>
  saveModel(input: ModelInput): Promise<void>
  listModels(input: ModelListInput): Promise<{ models: CatalogModel[]; detail: string }>
  clearModel(): Promise<void>
  /** Test the saved model, or the form values when an input is supplied. */
  testModel(input?: ModelInput): Promise<{ ok: boolean; detail: string }>
  saveSettings(patch: Partial<AppSettings>): Promise<void>
  openExternal(url: string): Promise<void>
  onEvent(listener: (event: AppEvent) => void): () => void
  onCommand(listener: (command: AppCommand) => void): () => void
}

export const TOOL_LABEL: Record<ToolName, string> = {
  survey: 'Surveyed account',
  buckets: 'Listed buckets',
  objects: 'Listed objects',
  object: 'Inspected object',
  config: 'Reviewed configuration',
  probe: 'Probed endpoint',
  estate: 'Checked memory',
  change_plan: 'Prepared a change plan',
  note: 'Remembered',
  query: 'Ran a read-only query',
  skill: 'Read a method',
  plan: 'Published a plan',
  ask: 'Asked a question',
  accept_risk: 'Asked to accept a risk',
}

/** Capability groups used by the prompt and documentation, not another tool. */
export const TOOL_GROUP: Record<
  ToolName,
  'read' | 'query' | 'memory' | 'change_plan' | 'plan' | 'skill' | 'ask'
> = {
  survey: 'read',
  buckets: 'read',
  objects: 'read',
  object: 'read',
  config: 'read',
  probe: 'read',
  estate: 'memory',
  change_plan: 'change_plan',
  note: 'memory',
  query: 'query',
  skill: 'skill',
  plan: 'plan',
  ask: 'ask',
  accept_risk: 'memory',
}
