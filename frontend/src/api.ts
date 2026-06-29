import { sidecarBaseUrl } from "./config";
import type {
  AccountProfile,
  EvidenceImport,
  EvidenceImportRunResult,
  ErrorInputKind,
  NextAction,
  SessionDetail,
  SessionMessage,
  SessionSummaryData,
  SessionSummaryRow,
  ToolActivity,
  TriageCase,
  CloudProvider,
  CredentialsTestResult,
  Dataset,
  HeadBucketResult,
  ListObjectsResult,
  ModelProvider,
  ModelProviderTestResult,
  ReportOut,
  RunDetail,
  RunSummary,
  RunType,
} from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${sidecarBaseUrl()}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// --- Model providers ---

export interface ModelProviderInput {
  name: string;
  provider_type: string;
  base_url?: string;
  model?: string;
  api_key?: string; // sent only when set/rotated; never persisted client-side
}

export const listModelProviders = () =>
  request<ModelProvider[]>("/model-providers");

export const createModelProvider = (body: ModelProviderInput) =>
  request<ModelProvider>("/model-providers", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const updateModelProvider = (id: string, body: Partial<ModelProviderInput>) =>
  request<ModelProvider>(`/model-providers/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });

export const deleteModelProvider = (id: string) =>
  request<void>(`/model-providers/${id}`, { method: "DELETE" });

export const testModelProvider = (id: string) =>
  request<ModelProviderTestResult>(`/model-providers/${id}/test`, {
    method: "POST",
  });

// --- Cloud providers ---

export interface CloudProviderInput {
  name: string;
  provider_type: string;
  endpoint_url?: string;
  region?: string;
  addressing_style?: string;
  signature_version?: string;
  access_key?: string;
  secret_key?: string;
  session_token?: string;
  mode?: "readonly" | "test-write";
  allowed_buckets?: string[];
  allowed_prefixes?: string[];
}

export const listCloudProviders = () =>
  request<CloudProvider[]>("/cloud-providers");

export const createCloudProvider = (body: CloudProviderInput) =>
  request<CloudProvider>("/cloud-providers", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const updateCloudProvider = (id: string, body: Partial<CloudProviderInput>) =>
  request<CloudProvider>(`/cloud-providers/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });

export const deleteCloudProvider = (id: string) =>
  request<void>(`/cloud-providers/${id}`, { method: "DELETE" });

// --- Read-only S3 tools (Phase 03) ---

export const testCloudProvider = (id: string) =>
  request<CredentialsTestResult>(`/cloud-providers/${id}/test`, { method: "POST" });

export const toolHeadBucket = (provider_id: string, bucket: string) =>
  request<HeadBucketResult>("/tools/head-bucket", {
    method: "POST",
    body: JSON.stringify({ provider_id, bucket }),
  });

export const toolListObjectsV2 = (
  provider_id: string,
  bucket: string,
  max_keys: number,
  prefix?: string,
) =>
  request<ListObjectsResult>("/tools/list-objects-v2", {
    method: "POST",
    body: JSON.stringify({ provider_id, bucket, max_keys, prefix: prefix || undefined }),
  });

// --- Analysis runs (Phase 04) ---

export interface RunCreateInput {
  run_type: RunType;
  title?: string;
  provider_id?: string;
  bucket?: string;
  prefix?: string;
  user_prompt?: string;
  planner_mode?: "deterministic" | "agent";
  // account_discovery options
  max_buckets?: number;
  include_pattern?: string;
  exclude_pattern?: string;
  // session linkage (Phase 16)
  session_id?: string;
}

export const listRuns = () => request<RunSummary[]>("/runs");

export const createRun = (body: RunCreateInput) =>
  request<{ run_id: string; status: string; title: string | null; created_at: string }>("/runs", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const getRun = (id: string) => request<RunDetail>(`/runs/${id}`);

export const postRunMessage = (id: string, content: string) =>
  request<{ run_id: string; status: string }>(`/runs/${id}/message`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });

export const getReport = (runId: string) => request<ReportOut>(`/reports/${runId}`);

export const getAccountProfile = (runId: string) =>
  request<AccountProfile>(`/runs/${runId}/account-profile`);

// --- Managed evidence import (Phase 15) ---

export interface EvidenceImportPlanInput {
  account_run_id: string;
  bucket_name: string;
  source_type: "inventory" | "access_log";
  max_files?: number;
  max_bytes?: number;
  time_range_start?: string;
  time_range_end?: string;
}

export const planEvidenceImport = (body: EvidenceImportPlanInput) =>
  request<EvidenceImport>("/evidence-imports/plan", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const getEvidenceImport = (id: string) =>
  request<EvidenceImport>(`/evidence-imports/${id}`);

export const confirmEvidenceImport = (id: string) =>
  request<EvidenceImport>(`/evidence-imports/${id}/confirm`, { method: "POST" });

export const runEvidenceImport = (id: string) =>
  request<EvidenceImportRunResult>(`/evidence-imports/${id}/run`, { method: "POST" });

// --- Sessions (Phase 16) ---

export interface SessionCreateInput {
  title: string;
  goal?: string;
  provider_id?: string;
  primary_bucket?: string;
}

export const listSessions = (q?: string) =>
  request<SessionSummaryRow[]>(`/sessions${q && q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`);

export const createSession = (body: SessionCreateInput) =>
  request<SessionDetail>("/sessions", { method: "POST", body: JSON.stringify(body) });

export const getSession = (id: string) => request<SessionDetail>(`/sessions/${id}`);

// Session management: rename / pin / archive (PATCH), fork, delete.
export const patchSession = (
  id: string,
  body: { title?: string; status?: "active" | "archived"; pinned?: boolean },
) => request<SessionDetail>(`/sessions/${id}`, { method: "PATCH", body: JSON.stringify(body) });

export const forkSession = (id: string) =>
  request<SessionDetail>(`/sessions/${id}/fork`, { method: "POST" });

export const deleteSession = (id: string) =>
  request<void>(`/sessions/${id}`, { method: "DELETE" });

export const refreshSessionSummary = (id: string) =>
  request<SessionSummaryData>(`/sessions/${id}/refresh-summary`, { method: "POST" });

export const getSessionReport = (id: string) =>
  request<{ session_id: string; format: string; content: string }>(`/sessions/${id}/report`);

export const postSessionMessage = (id: string, content: string, turnId?: string) =>
  request<{ session_id: string; messages: SessionMessage[]; proposed_actions: NextAction[] }>(
    `/sessions/${id}/messages`,
    { method: "POST", body: JSON.stringify({ content, turn_id: turnId }) },
  );

// Streaming variant (SSE): invokes onDelta/onTool as the agent works and
// resolves on the `done` event. Throws on a non-OK response (e.g. 422 no model)
// or a stream `error` event — the caller should then fall back to
// postSessionMessage with the SAME turnId. The server dedups by turn_id, so the
// fallback never duplicates the turn or any inline run, even if the stream had
// already done work server-side before the connection broke.
export async function streamSessionMessage(
  id: string,
  content: string,
  on: { onDelta: (text: string) => void; onTool: (a: ToolActivity) => void },
  signal?: AbortSignal,
  turnId?: string,
): Promise<{ proposed_actions: NextAction[] }> {
  const res = await fetch(`${sidecarBaseUrl()}/sessions/${id}/messages/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, turn_id: turnId }),
    signal,
  });
  if (!res.ok || !res.body) {
    let detail = `HTTP ${res.status}`;
    try {
      const b = await res.json();
      if (b?.detail) detail = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let proposed: NextAction[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const chunks = buf.split("\n\n");
    buf = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const lines = chunk.split("\n");
      const type = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
      const dataRaw = lines.find((l) => l.startsWith("data:"))?.slice(5).trim();
      if (!type || !dataRaw) continue;
      const data = JSON.parse(dataRaw);
      if (type === "delta") on.onDelta(data.text || "");
      else if (type === "tool") on.onTool(data as ToolActivity);
      else if (type === "done") proposed = data.proposed_actions || [];
      else if (type === "error") throw new Error(data.detail || "stream error");
    }
  }
  return { proposed_actions: proposed };
}

export const attachRunToSession = (sessionId: string, runId: string) =>
  request<SessionDetail>(`/sessions/${sessionId}/runs/${runId}`, { method: "POST" });

// Next-action handoff (Phase 17): validate + prefill only; never executes.
export interface ActionPrepareResult {
  proposal: NextAction & { id: string };
  action_type: string;
  status: string;
  open: string | null;
  missing_inputs: string[];
  candidates: Record<string, Array<{ account_run_id: string; bucket_name: string }>>;
  prefill: Record<string, string>;
  safety_notes: string[];
}

export interface ActionPreviewResult {
  proposal: NextAction & { id: string };
  action_type: string;
  ready: boolean;
  missing_inputs: string[];
  candidates: Record<string, unknown>;
  prefill: Record<string, string>;
  safety_notes: string[];
  will_create: Record<string, unknown> | null;
}

export const previewSessionAction = (id: string, proposal: NextAction) =>
  request<ActionPreviewResult>(`/sessions/${id}/actions/preview`, {
    method: "POST",
    body: JSON.stringify({ proposal }),
  });

export const prepareSessionAction = (id: string, proposal: NextAction) =>
  request<ActionPrepareResult>(`/sessions/${id}/actions/prepare`, {
    method: "POST",
    body: JSON.stringify({ proposal }),
  });

// Error triage (Phase 18): deterministic parse + playbooks (+ optional agent).
export interface ErrorTriageInput {
  content: string;
  input_kind: ErrorInputKind;
  session_id?: string;
  provider_id?: string;
  bucket?: string;
  planner_mode?: "deterministic" | "agent";
}

export const submitErrorTriage = (body: ErrorTriageInput) =>
  request<TriageCase>("/error-triage", { method: "POST", body: JSON.stringify(body) });

export const getSessionTriage = (sessionId: string) =>
  request<{ session_id: string; cases: TriageCase[] }>(`/sessions/${sessionId}/error-triage`);

export const runEventsUrl = (id: string) => `${sidecarBaseUrl()}/runs/${id}/events`;

// --- Datasets (Phase 05) ---

export async function uploadDataset(
  runId: string,
  file: File,
  datasetType: "access_log" | "inventory",
  name?: string,
): Promise<{ dataset_id: string; status: string }> {
  const form = new FormData();
  form.append("file", file);
  form.append("dataset_type", datasetType);
  if (name) form.append("name", name);
  const res = await fetch(`${sidecarBaseUrl()}/runs/${runId}/datasets/upload`, {
    method: "POST",
    body: form, // browser sets multipart boundary; no secrets involved
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const b = await res.json();
      if (b?.detail) detail = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json();
}

export const listDatasets = () => request<Dataset[]>("/datasets");

// --- Settings: agent autonomy policy ---

export type AutonomyPolicy = "advisory" | "assisted" | "autonomous_readonly";

export interface AutonomySetting {
  policy: AutonomyPolicy;
  policies: AutonomyPolicy[];
  default: AutonomyPolicy;
}

export const getAutonomy = () => request<AutonomySetting>("/settings/autonomy");

export interface VaultStatus {
  unreadable: boolean;
  backup_present: boolean;
}

export const getVaultStatus = () => request<VaultStatus>("/settings/secret-vault");

export const setAutonomy = (policy: AutonomyPolicy) =>
  request<AutonomySetting>("/settings/autonomy", {
    method: "PUT",
    body: JSON.stringify({ policy }),
  });
