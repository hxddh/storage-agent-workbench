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
  | 'fix'
  | 'analyze'
  | 'note'
  | 'query'

export type TaskState = 'ready' | 'working' | 'queued' | 'attention' | 'failed'

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

export interface FixFormat {
  label: string
  language: 'bash' | 'hcl' | 'json'
  text: string
}

export interface Impact {
  verdict: 'low' | 'caution' | 'unknown'
  reasons: string[]
  gap: string | null
}

export interface Chart {
  type: 'bar'
  labels: string[]
  values: number[]
  unit?: string
}

export type ToolView =
  | {
      kind: 'survey'
      provider: string
      providerId?: string
      buckets: Table
      issues: IssueRow[]
      /** Open Issues of the account in the estate; `issues` may hold fewer. */
      issueTotal?: number
      observations?: Observation[]
      /** Account-wide posture: the S3 Control public access block. */
      account?: { pab: 'on' | 'partial' | 'off' | 'unknown' | 'n/a' }
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
      aspect?: 'security' | 'lifecycle' | 'observability'
      findings: ConfigFinding[]
      observations?: Observation[]
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
    }
  | {
      kind: 'fix'
      providerId?: string
      bucket: string
      code: string
      formats: FixFormat[]
      impact: Impact
    }
  | { kind: 'analyze'; dataset: string; rows: Table; chart: Chart | null; note: string | null }
  | { kind: 'note'; text: string }
  | {
      kind: 'query'
      title: string
      /** The script that produced the rows: the evidence for them. */
      code: string
      rows: Table
      chart: Chart | null
      output: string | null
      calls: number
      listed: number
    }

export type ToolStatus = 'running' | 'done' | 'failed' | 'refused' | 'stopped' | 'timeout'

/** What `agentTool()` attaches to every result; the status is never parsed from text. */
export interface ToolDetails {
  target: string
  note: string | null
  view: ToolView | null
  ms: number | null
  status: ToolStatus
}

/** App notices are codes; the window words them in the user's language. */
export type NoticeCode = 'stopped' | 'no_answer' | 'failed' | 'budget' | 'model_missing'

export interface LiveTool {
  callId: string
  name: ToolName
  target: string
  note: string | null
  startedAt: string
}

export interface AttachmentRef {
  name: string
  bytes: number
}

/** A file chosen in the open dialog, staged until the message is sent. */
export interface StagedFile extends AttachmentRef {
  token: string
}

export type UiEntry =
  | {
      id: string
      kind: 'user'
      at: string
      text: string
      attachments: AttachmentRef[]
    }
  | { id: string; kind: 'answer'; at: string; text: string; streaming?: boolean }
  | {
      id: string
      kind: 'tool'
      at: string
      name: ToolName
      target: string
      status: ToolStatus
      note: string | null
      ms: number | null
      view: ToolView | null
      callId?: string
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
  /** The user asked a stopped run to continue: a boundary, not a question. */
  | { id: string; kind: 'resume'; at: string }

export interface TaskSummary {
  id: string
  title: string
  state: TaskState
  createdAt: string
  updatedAt: string
}

export interface Live {
  phase: 'thinking' | 'reasoning' | 'tool' | 'writing'
  tools: LiveTool[]
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

export interface Account {
  id: string
  name: string
  endpoint: string
  region: string
  forcePathStyle: boolean
  /** Static keys sealed in the vault, or a named profile the AWS SDK resolves (SSO, process, role). */
  auth: 'keys' | 'profile'
  profile: string | null
  accessKeyMasked: string
  hasSessionToken: boolean
  scope: { buckets: string[] }
}

export interface AccountInput {
  id?: string
  name: string
  endpoint: string
  region: string
  forcePathStyle: boolean
  auth: 'keys' | 'profile'
  profile?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  scope: { buckets: string[] }
}

export interface ModelSettings {
  provider: ModelProvider
  modelId: string
  baseUrl: string | null
  contextWindow: number | null
  thinking: ThinkingLevel
  hasKey: boolean
}

export interface ModelInput {
  provider: ModelProvider
  modelId: string
  apiKey?: string
  baseUrl?: string
  contextWindow?: number
  thinking?: ThinkingLevel
}

export interface AppSettings {
  language: Lang
  theme: Theme
  /** A system notification when a run finishes while the window is in the background. */
  notify: boolean
}

export type UpdateState =
  | { state: 'idle' }
  | { state: 'downloading'; version: string }
  | { state: 'ready'; version: string }

export interface Bootstrap {
  version: string
  platform: string
  tasks: TaskSummary[]
  accounts: Account[]
  model: ModelSettings | null
  settings: AppSettings
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
  createTask(text: string, attachments: string[]): Promise<TaskView>
  send(taskId: string, text: string, attachments: string[]): Promise<void>
  steer(taskId: string, text: string): Promise<void>
  stop(taskId: string): Promise<void>
  renameTask(taskId: string, title: string): Promise<void>
  deleteTask(taskId: string): Promise<void>
  retryTask(taskId: string): Promise<void>
  continueTask(taskId: string): Promise<void>
  search(query: string): Promise<SearchHit[]>
  notes(): Promise<NoteRow[]>
  deleteNote(id: string): Promise<void>
  saveText(input: { name: string; content: string; kind: 'markdown' | 'csv' }): Promise<boolean>
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
  clearModel(): Promise<void>
  testModel(): Promise<{ ok: boolean; detail: string }>
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
  fix: 'Prepared fix',
  analyze: 'Analyzed file',
  note: 'Remembered',
  query: 'Ran a read-only query',
}
