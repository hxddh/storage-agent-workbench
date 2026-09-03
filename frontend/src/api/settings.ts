import { request } from "./client";

/**
 * Settings and the modern native-agent extensions: the local price-table
 * engine API, the approval policy the runtime enforces (v1.12), the
 * instructions-file status (v1.12), the secret-vault status, user skills,
 * observability export, and the opt-in read-only MCP bridge.
 */

// --- Price table (engine API; the Settings UI does not edit it) ---

export interface PriceTable {
  id: string;
  confirmed: boolean;
  example: boolean;
  note: string;
  rates: {
    currency?: string;
    gb_divisor?: number;
    storage_gb_month?: Record<string, number>;
    request_per_1k?: Record<string, number>;
    retrieval_gb?: Record<string, number>;
  };
  updated_at: string | null;
}

export const getPriceTable = () => request<PriceTable>("/settings/price-table");

export const putPriceTable = (body: { confirmed?: boolean; rates?: PriceTable["rates"]; note?: string }) =>
  request<PriceTable>("/settings/price-table", { method: "PUT", body: JSON.stringify(body) });

// --- v1.12: approval policy · instructions file ---

/** How `runtime.request_approval` treats a gated tool. Enforced server-side only. */
export type ApprovalPolicy = "ask" | "allow_session" | "allow_always";

export interface ApprovalPolicyInfo {
  policy: ApprovalPolicy;
  gated_tools: { name: string; action_types: string[]; why: string }[];
}

export const getApprovalPolicy = () => request<ApprovalPolicyInfo>("/settings/approval-policy");

export const putApprovalPolicy = (policy: ApprovalPolicy) =>
  request<ApprovalPolicyInfo>("/settings/approval-policy", { method: "PUT", body: JSON.stringify({ policy }) });

/** The AGENTS.md-style instructions file in the data directory. */
export interface InstructionsStatus {
  loaded: boolean;
  path: string;
  chars: number;
  error: string | null;
}

export const getInstructionsStatus = () => request<InstructionsStatus>("/settings/instructions");

// --- Secret-vault status ---

export interface VaultStatus {
  unreadable: boolean;
  backup_present: boolean;
}

export const getVaultStatus = () => request<VaultStatus>("/settings/secret-vault");

// --- Skills: bundled + user SKILL.md (app-data/skills, STORAGE_AGENT_SKILLS_DIR) ---

export interface SkillMeta {
  name: string;
  description: string;
  maturity: string;
  mode: string;
  domains: string[];
  path: string;
}
export const listSkills = () => request<{ skills: SkillMeta[]; count: number }>("/skills");
export const getSkill = (name: string) =>
  request<{ name: string; description: string; body: string; truncated: boolean }>(`/skills/${encodeURIComponent(name)}`);
export const getSkillsDirs = () =>
  request<{ data_dir: string; dirs: { path: string; exists: boolean; skill_count: number }[]; env_override: string }>("/skills/_dirs/info");

// --- Observability: per-task OTel-inspired export (bounded, sanitized) ---

export interface OtelExport {
  task_id: string;
  export: string;
  task?: { status: string; active_execution_id: string | null; context_version: number; updated_at: string };
  events?: { seq: number; execution_id: string; type: string; payload: string; at: string }[];
  events_truncated?: boolean;
  tool_calls?: { id: string; tool: string; status: string; duration_ms: number | null; at: string }[];
  turn_metrics?: { id: string; turn_id: string; model: string | null; input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; duration_ms: number | null; tool_call_count: number | null }[];
  audit?: { id: string; event: string; at: string }[];
  artifacts?: { id: string; type: string; title: string | null; ref_kind: string | null; status: string | null; at: string }[];
}
export const getTaskOtelExport = (taskId: string, opts: { include_audit?: boolean; limit_events?: number } = {}) => {
  const q = new URLSearchParams();
  if (opts.include_audit) q.set("include_audit", "true");
  if (opts.limit_events) q.set("limit_events", String(opts.limit_events));
  const suffix = q.toString() ? `?${q}` : "";
  return request<OtelExport>(`/agent-tasks/${encodeURIComponent(taskId)}/export/otel${suffix}`);
};
export const getGlobalOtelExport = () =>
  request<{ export: string; tasks: { id: string; status: string; updated_at: string }[]; recent_executions: unknown[]; providers: unknown[]; active_provider_id: string | null }>("/observability/export");

// --- MCP bridge: opt-in read-only exposure (STORAGE_AGENT_ENABLE_MCP=1) ---

export interface McpStatus {
  enabled: boolean;
  allowed_tools: string[];
  note: string;
}
export const getMcpStatus = () => request<McpStatus>("/mcp/status");
export const listMcpTools = () => request<{ tools: { name: string; description: string; inputSchema: unknown }[]; count: number }>("/mcp/tools");
export const callMcpTool = (tool: string, args: Record<string, unknown>, provider_id?: string) =>
  request<{ tool: string; status: string; note: string; arguments_received: unknown; provider_id: string | null }>("/mcp/tools/call", {
    method: "POST",
    body: JSON.stringify({ tool, arguments: args, provider_id: provider_id ?? null }),
  });
