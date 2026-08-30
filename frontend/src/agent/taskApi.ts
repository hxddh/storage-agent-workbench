import { authHeaders } from "../api";
import { sidecarBaseUrl } from "../config";
import type { AgentTaskSummary } from "./navigationModel";

/** Product-level task list. Durable Agent state (for example a pending Decision)
 * is projected by the Sidecar so reload/restart and background tasks do not
 * depend on the browser's transient run store. */
export async function listAgentTasks(query?: string): Promise<AgentTaskSummary[]> {
  const q = query?.trim();
  const path = `/agent-tasks${q ? `?q=${encodeURIComponent(q)}` : ""}`;
  const response = await fetch(`${sidecarBaseUrl()}${path}`, { headers: authHeaders() });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      // Keep the status-only fallback.
    }
    throw new Error(detail);
  }
  return (await response.json()) as AgentTaskSummary[];
}
