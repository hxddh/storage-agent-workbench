/**
 * The contract between the main process and the window.
 *
 * One file, imported by both sides. The renderer never sees a model message,
 * a secret, or a raw S3 response; every value here is already redacted and
 * shaped for display.
 */

export type Severity = 'high' | 'medium' | 'low'
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
  status: 'open' | 'resolved'
  title: string
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

export interface ConfigFinding {
  severity: Severity | 'ok'
  title: string
  detail: string
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
      buckets: Table
      issues: IssueRow[]
      coverage: {
        visible: number
        processed: number
        truncated: boolean
        denied: string[]
        unknown: string[]
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
  | { kind: 'config'; bucket: string; findings: ConfigFinding[] }
  | { kind: 'probe'; endpoint: string; checks: ProbeCheck[] }
  | { kind: 'estate'; buckets: Table | null; issues: IssueRow[]; notes: NoteRow[] }
  | { kind: 'fix'; bucket: string; code: string; formats: FixFormat[]; impact: Impact }
  | { kind: 'analyze'; dataset: string; rows: Table; chart: Chart | null; note: string | null }
  | { kind: 'note'; text: string }

export type ToolStatus = 'running' | 'done' | 'failed' | 'refused' | 'stopped'

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
      text: string
      tone: 'info' | 'warn' | 'error'
      action?: 'retry' | 'continue'
    }
  | { id: string; kind: 'compaction'; at: string; text: string }

export interface TaskSummary {
  id: string
  title: string
  origin: 'user' | 'watch'
  state: TaskState
  createdAt: string
  updatedAt: string
}

export interface Live {
  phase: 'thinking' | 'tool' | 'writing'
  tools: LiveTool[]
  text: string | null
  startedAt: string
}

export interface SearchHit {
  taskId: string
  title: string
  kind: 'title' | 'user' | 'answer'
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
}

export interface Usage {
  requests: number
  inputTokens: number
  outputTokens: number
  ms: number
}

export interface Account {
  id: string
  name: string
  endpoint: string
  region: string
  forcePathStyle: boolean
  accessKeyMasked: string
  hasSessionToken: boolean
  scope: { buckets: string[] }
  watch: { enabled: boolean; intervalHours: number; lastRunAt: string | null }
}

export interface AccountInput {
  id?: string
  name: string
  endpoint: string
  region: string
  forcePathStyle: boolean
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  scope: { buckets: string[] }
}

export interface ModelSettings {
  provider: string
  modelId: string
  baseUrl: string | null
  contextWindow: number | null
  hasKey: boolean
}

export interface AppSettings {
  language: Lang
  theme: Theme
}

export interface Bootstrap {
  version: string
  platform: string
  tasks: TaskSummary[]
  accounts: Account[]
  model: ModelSettings | null
  settings: AppSettings
}

export type AppEvent =
  | { type: 'tasks'; tasks: TaskSummary[] }
  | { type: 'task'; task: TaskSummary }
  | { type: 'entry'; taskId: string; entry: UiEntry }
  | { type: 'patch'; taskId: string; entryId: string; patch: Partial<UiEntry> }
  | { type: 'live'; taskId: string; live: Live | null }
  | { type: 'bootstrap' }

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
  saveText(input: { name: string; content: string; kind: 'markdown' | 'csv' }): Promise<boolean>
  pickFiles(): Promise<StagedFile[]>
  saveAccount(input: AccountInput): Promise<Account>
  deleteAccount(id: string): Promise<void>
  testAccount(id: string): Promise<{ ok: boolean; detail: string }>
  saveModel(input: {
    provider: string
    modelId: string
    apiKey?: string
    baseUrl?: string
    contextWindow?: number
  }): Promise<void>
  clearModel(): Promise<void>
  testModel(): Promise<{ ok: boolean; detail: string }>
  saveSettings(patch: Partial<AppSettings>): Promise<void>
  setWatch(providerId: string, patch: { enabled?: boolean; intervalHours?: number }): Promise<void>
  runWatch(providerId: string): Promise<void>
  openExternal(url: string): Promise<void>
  onEvent(listener: (event: AppEvent) => void): () => void
  onCommand(listener: (command: 'settings' | 'new-task') => void): () => void
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
}
