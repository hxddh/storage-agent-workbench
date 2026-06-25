import { sidecarBaseUrl } from "./config";
import type {
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
