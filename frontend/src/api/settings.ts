import { request } from "./client";

/**
 * Settings and the modern native-agent extensions: the local price-table
 * engine API, the instructions-file status (v1.12), the secret-vault status, user skills,
 * observability export, and the opt-in read-only MCP bridge.
 */

// --- v1.12: instructions file ---

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
export const getSkillsDirs = () =>
  request<{ data_dir: string; dirs: { path: string; exists: boolean; skill_count: number }[]; env_override: string }>("/skills/_dirs/info");

// --- Observability: the global trace export (bounded, sanitized) ---

export const getGlobalOtelExport = () =>
  request<{ export: string; tasks: { id: string; status: string; updated_at: string }[]; recent_executions: unknown[]; providers: unknown[]; active_provider_id: string | null }>("/observability/export");

// --- MCP bridge: opt-in read-only exposure (STORAGE_AGENT_ENABLE_MCP=1) ---

export interface McpStatus {
  enabled: boolean;
  allowed_tools: string[];
  note: string;
}
export const getMcpStatus = () => request<McpStatus>("/mcp/status");
