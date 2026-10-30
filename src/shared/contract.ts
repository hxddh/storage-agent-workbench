/**
 * The contract between the main process and the window.
 *
 * One file, imported by both sides. The renderer never sees a model message,
 * a secret, or a raw S3 response; every value here is already redacted and
 * shaped for display.
 */
import type { ViewDoc } from './view'

export type {
  ChartSpec,
  TimelineEvent,
  TreeNode,
  ViewBlock,
  ViewCell,
  ViewColumn,
  ViewDoc,
  ViewTone,
} from './view'

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'
export type ModelProvider = 'anthropic' | 'openai' | 'compatible'
export type Lang = 'en' | 'zh'
export type Theme = 'light' | 'dark' | 'system'

export type ToolName =
  | 'call'
  | 'query'
  | 'probe'
  | 'more'
  | 'ask'
  | 'discover'
  | 'render'
  | 'memory'
  | 'tool'
  | 'delegate'

export type TaskState = 'ready' | 'working' | 'queued' | 'attention' | 'failed'

export interface Table {
  columns: string[]
  rows: (string | number | null)[][]
  truncated?: boolean
}

/** A method the agent wrote for itself. */
export interface AgentToolRow {
  id: string
  name: string
  description: string
  schema: unknown
  code: string
  scope: 'task' | 'user'
  conversationId: string | null
  createdAt: string
  updatedAt: string
}

/** A memory document, as Settings lists it. */
export interface MemoryRow {
  id: string
  text: string
  createdAt: string
  updatedAt: string
  /** The task that wrote it last, and its title; null when the task is gone or none did. */
  origin: string | null
  originTitle: string | null
  key: string
  scope: 'task' | 'user'
}

export interface Chart {
  type: 'bar'
  labels: string[]
  values: number[]
  unit?: string
}

export type ToolView =
  /** A read returned as the service returned it, shown as JSON. */
  | { kind: 'raw'; title: string; value: unknown }
  | { kind: 'note'; text: string }
  | {
      kind: 'query'
      providerId?: string
      title: string
      /** The script that produced the rows. */
      code: string
      rows: Table
      chart: Chart | null
      output: string | null
      calls: number
      /** Buckets the script read. */
      buckets?: string[]
    }
  | { kind: 'question'; question: string; options: string[]; note?: string }
  /** A view the agent composed with `render`; the window owns its rendering. */
  | { kind: 'render'; title: string; doc: ViewDoc }
  /** A child agent's answer and status. */
  | {
      kind: 'delegate'
      title: string
      /** What the parent asked the child. */
      task: string
      conversationId: string
      answer: string
      status: 'running' | 'done' | 'failed' | 'stopped' | 'asked'
      calls?: number
    }
  /** Rows from agent memory. */
  | { kind: 'memory'; title: string; table: Table; text?: string }

export type ToolStatus = 'running' | 'done' | 'failed' | 'refused' | 'stopped'

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
  /** The storage account this call used, when it used one. */
  provider?: string
}

/** App notices are codes; the window words them in the user's language. */
export type NoticeCode = 'stopped' | 'no_answer' | 'failed' | 'cut'

export interface LiveTool {
  callId: string
  name: string
  target: string
  note: string | null
  args?: string | null
  status: ToolStatus
  startedAt: string
  provider?: string
  /** A running call's view so far: a delegate's child conversation, open while it works. */
  view?: ToolView | null
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
  kind: 'account' | 'bucket'
  providerId: string
  label: string
  bucket?: string
}

/** One row in the composer's @ picker. */
export interface StorageRef extends ContextRef {
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
      /** The tool the model called; a name no tool has still shows as a failed step. */
      name: string
      target: string
      status: ToolStatus
      note: string | null
      args?: string | null
      ms: number | null
      view: ToolView | null
      callId?: string
      evidenceId?: string
      /** The storage account this call used, when it used one. */
      provider?: string
      /** Exactly what the model received for this call, enveloped and redacted. */
      output?: string
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
  usage: Usage | null
  /** A per-task model override; null means the model in Settings. */
  model?: TaskModel | null
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
  /** Notes older than this are hidden from Memory; 0 keeps every note. */
}

export type UpdateState =
  | { state: 'idle' }
  | { state: 'downloading'; version: string }
  | { state: 'ready'; version: string }
  /** This platform's release feed is missing; updates cannot be checked. */
  | { state: 'unavailable' }

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
  /** A delegated child agent's conversation, every step of it. */
  childEntries(conversationId: string): Promise<UiEntry[]>
  createTask(text: string, attachments: string[], context?: ContextRef[]): Promise<TaskView>
  send(taskId: string, text: string, attachments: string[], context?: ContextRef[]): Promise<void>
  /** Use a different model for this task's next run; null restores Settings. */
  setTaskModel(taskId: string, model: TaskModel | null): Promise<void>
  storageRefs(query: string): Promise<StorageRef[]>
  steer(taskId: string, text: string, attachments: string[], context?: ContextRef[]): Promise<void>
  stop(taskId: string): Promise<void>
  renameTask(taskId: string, title: string): Promise<void>
  pinTask(taskId: string, pinned: boolean): Promise<void>
  deleteTask(taskId: string): Promise<void>
  retryTask(taskId: string): Promise<void>
  continueTask(taskId: string): Promise<void>
  search(query: string): Promise<SearchHit[]>
  memory(): Promise<MemoryRow[]>
  deleteMemory(id: string): Promise<void>
  agentTools(): Promise<AgentToolRow[]>
  deleteAgentTool(id: string): Promise<void>
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
  awsProfiles(): Promise<string[]>
  /** Stage files dropped or pasted into the composer. */
  stageFiles(files: File[]): Promise<StagedFile[]>
  installUpdate(): Promise<void>
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
