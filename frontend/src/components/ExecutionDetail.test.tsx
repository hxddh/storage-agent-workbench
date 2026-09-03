/**
 * v1.12 — Execution detail on the durable log.
 *
 * The document is built from `GET /agent-tasks/{id}/executions/{eid}` (the
 * header), `GET /agent-tasks/{id}/events` (the rows, filtered to this
 * execution), and `GET /sessions/{id}` (the Work Result text). It opens no
 * EventSource, calls nothing under `/runs`, and folds the events through the
 * same reducers as the live transcript.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { I18nProvider } from "../i18n";
import { ExecutionDetail } from "./ExecutionDetail";
import { replayExecutionEvents } from "./ExecutionDetailImplementation";
import type { TaskEvent } from "../api";

const api = vi.hoisted(() => ({
  getTaskExecution: vi.fn(),
  listExecutionEventsPage: vi.fn(),
  getSession: vi.fn(),
  getSessionCall: vi.fn(),
  getSessionOverview: vi.fn(),
  followExecutionEvents: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, ...api };
});

const wrapper = ({ children }: { children: ReactNode }) => createElement(I18nProvider, null, children);

const at = (s: number) => `2026-09-01T00:00:${String(s).padStart(2, "0")}Z`;

function log(): TaskEvent[] {
  let seq = 0;
  const ev = (execution_id: string, event_type: string, payload: Record<string, unknown>, created_at: string): TaskEvent =>
    ({ seq: ++seq, execution_id, task_id: "t1", event_type, payload, created_at });
  return [
    ev("exec-0", "tool.started", { id: "old", tool: "head_bucket", target: "other" }, at(0)),
    ev("exec-0", "tool.completed", { id: "old", tool: "head_bucket", target: "other", result: "200", ok: true }, at(1)),
    ev("exec-1", "execution.status", { status: "running" }, at(2)),
    ev("exec-1", "context.compacted", { before_tokens: 48_000, after_tokens: 9_000, summary_chars: 900 }, at(2)),
    ev("exec-1", "plan.updated", { steps: [{ text: "Survey the account", status: "in_progress" }, { text: "Check policies", status: "pending" }] }, at(3)),
    ev("exec-1", "message.completed", { text: "Surveying first.", final: false }, at(3)),
    ev("exec-1", "tool.started", { id: "c1", tool: "survey_account", target: "acme" }, at(4)),
    ev("exec-1", "tool.started", { id: "c2", tool: "head_bucket", target: "acme-logs" }, at(5)),
    ev("exec-1", "tool.completed", { id: "c2", tool: "head_bucket", target: "acme-logs", result: "200", ok: true, duration_ms: 300 }, at(6)),
    ev("exec-1", "approval.opened", { decision_id: "d1", action_type: "import_access_log", title: "Import 3 files", reason: null, impact: null }, at(7)),
    ev("exec-1", "execution.status", { status: "waiting", reason: "approval", decision_id: "d1" }, at(7)),
    ev("exec-1", "decision.resolved", { decision_id: "d1", resolution: "approved", action_type: "import_access_log", scope: "once" }, at(8)),
    ev("exec-1", "execution.status", { status: "running", reason: "approval_resolved" }, at(8)),
    ev("exec-1", "tool.completed", { id: "c1", tool: "survey_account", target: "acme", result: "3 buckets", ok: true, duration_ms: 12_000 }, at(16)),
    ev("exec-1", "plan.updated", { steps: [{ text: "Survey the account", status: "completed" }, { text: "Check policies", status: "completed" }] }, at(17)),
    ev("exec-1", "message.completed", { text: "Three buckets; one policy is public.", final: true }, at(18)),
    ev("exec-1", "work_result.recorded", { work_result_id: "wr1", message_id: "m-answer", stopped: false }, at(18)),
    ev("exec-1", "execution.status", { status: "completed", stopped: false, message_id: "m-answer", work_result_id: "wr1", metrics: { duration_ms: 16_000 } }, at(18)),
    ev("exec-2", "tool.started", { id: "later", tool: "list_objects", target: "acme-logs" }, at(30)),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getTaskExecution.mockResolvedValue({
    id: "exec-1", task_id: "t1", turn_id: null, direction: "Survey the acme account and check bucket policies.",
    kind: "direction", status: "completed", error: null, resumed_from: null, steer_count: 0, work_result_id: "wr1",
    created_at: at(2), started_at: at(2), finished_at: at(18),
  });
  api.listExecutionEventsPage.mockResolvedValue({ task_id: "t1", execution_id: "exec-1", events: log(), last_seq: 19 });
  api.getSession.mockResolvedValue({
    id: "t1", title: "Survey", goal: null, provider_id: null, primary_bucket: null, status: "active",
    created_at: at(0), updated_at: at(18), runs: [], summary: null,
    findings: [{ id: "f1", source_run_id: "run-9", category: "security", severity: "warning", confidence: "high", kind: "policy", title: "acme-logs policy is public", interpretation: "s3:GetObject to *", status: "open", created_at: at(18) }],
    messages: [
      { id: "m-dir", role: "user", content: "Survey the acme account", referenced_run_ids: [], referenced_evidence_ids: [], created_at: at(2) },
      { id: "m-answer", role: "assistant", content: "# Result\n\nThree buckets; one policy is public.", referenced_run_ids: ["run-9"], referenced_evidence_ids: [],
        grounding: { evidence_used: ["survey"], evidence_gaps: ["no access logs"], skills_used: ["storageops-security"] }, created_at: at(18) },
    ],
  });
  api.getSessionCall.mockResolvedValue({ id: "c2", tool_name: "head_bucket", input: { bucket: "acme-logs" }, output: { status: 200 }, status: "success", duration_ms: 300, created_at: at(6) });
  api.getSessionOverview.mockResolvedValue({
    session_id: "t1", tool_calls: 3, tool_errors: 0, tool_ms: 12300, audit_events: 0, approvals: 0,
    usage: {
      available: true, turns: 1, turns_measured: 1, partial: false,
      input_tokens: 12_400, output_tokens: 800, total_tokens: 13_200, requests: 4,
      cached_input_tokens: 9_000, reasoning_tokens: null,
    },
    turns: [{
      turn_id: "turn-1", message_id: "m-answer", model: "fake", requests: 4,
      input_tokens: 12_400, output_tokens: 800, total_tokens: 13_200,
      cached_input_tokens: 9_000, reasoning_tokens: null,
      budget_tokens: null, repeat_calls_avoided: null, duration_ms: 16_000,
      tool_calls: 2, created_at: at(18),
    }],
  });
});

describe("replayExecutionEvents", () => {
  it("filters the task log to one execution and reduces it through the turn model", () => {
    const replay = replayExecutionEvents(log(), "exec-1");
    expect(replay.status).toBe("completed");
    expect(replay.messageId).toBe("m-answer");
    expect(replay.lastSeq).toBe(19);
    expect(replay.turn.answer).toBe("Three buckets; one policy is public.");
    expect(replay.turn.waiting).toBe(false);
    expect(replay.turn.items.map((item) => item.kind)).toEqual(["compacted", "plan", "message", "tool", "tool", "approval"]);
    const tools = replay.turn.items.filter((item): item is { kind: "tool"; record: import("../types").ToolActivity } => item.kind === "tool");
    expect(tools.map((item) => item.record.tool)).toEqual(["survey_account", "head_bucket"]);
    // Rows without Sidecar stamps take the log's own timestamps, so the
    // group's wall-clock is first start → last finish (4s → 16s), not a sum.
    expect(tools[0].record.started_at).toBe(at(4));
    expect(tools[0].record.finished_at).toBe(at(16));
    const plan = replay.turn.items.find((item) => item.kind === "plan") as { kind: "plan"; steps: { status: string }[] };
    expect(plan.steps.every((step) => step.status === "completed")).toBe(true);
    const approval = replay.turn.items.find((item) => item.kind === "approval") as { status: string };
    expect(approval.status).toBe("approved");
    expect(replay.turn.items.some((item) => item.kind === "tool" && item.record.tool === "list_objects")).toBe(false);
  });

  it("keeps a failed execution's error and a stopped one's marker", () => {
    const failed = replayExecutionEvents([
      { seq: 1, execution_id: "e", event_type: "execution.status", payload: { status: "failed", error: "model unreachable" }, created_at: at(1) },
    ], "e");
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("model unreachable");
    const stopped = replayExecutionEvents([
      { seq: 1, execution_id: "e", event_type: "work_result.recorded", payload: { work_result_id: "w", message_id: "m", stopped: true }, created_at: at(1) },
      { seq: 2, execution_id: "e", event_type: "execution.status", payload: { status: "cancelled", stopped: true, message_id: "m", work_result_id: "w" }, created_at: at(1) },
    ], "e");
    expect(stopped.stopped).toBe(true);
    expect(stopped.messageId).toBe("m");
  });
});

describe("ExecutionDetail", () => {
  it("renders header, rows, findings and the Work Result from the durable runtime only", async () => {
    render(createElement(ExecutionDetail, { taskId: "t1", executionId: "exec-1", onBack: () => undefined }), { wrapper });
    await waitFor(() => expect(screen.getByTestId("execution-status").textContent).toContain("complete"));
    expect(api.getTaskExecution).toHaveBeenCalledWith("t1", "exec-1");
    expect(api.listExecutionEventsPage).toHaveBeenCalledWith("t1", "exec-1", { after: 0, limit: 1000 });
    expect(api.followExecutionEvents).not.toHaveBeenCalled();
    // The document's own title; the Markdown answer below renders its own h1.
    expect(screen.getAllByRole("heading", { level: 1 })[0].textContent).toBe("Survey the acme account and check bucket policies.");
    expect(screen.getByTestId("plan-card")).toBeTruthy();
    expect(screen.getByTestId("context-compacted")).toBeTruthy();
    expect(screen.getByTestId("approval-card").getAttribute("data-status")).toBe("approved");
    const group = screen.getByTestId("worked-group");
    // Two rows, 4s → 16s of wall-clock — never 12.3s summed.
    expect(group.textContent).toMatch(/Worked for 12s · 2 tool calls/);
    await waitFor(() => expect(screen.getByTestId("execution-result").textContent).toContain("Three buckets; one policy is public."));
    expect(screen.getByText("acme-logs policy is public")).toBeTruthy();
    expect(screen.getByTestId("execution-gaps").textContent).toContain("no access logs");
    expect(screen.getByTestId("execution-span").textContent).toBe("16s");
    // v1.14 — reported usage renders; unreported fields never render as zero.
    await waitFor(() => expect(screen.getByTestId("execution-usage")).toBeTruthy());
    expect(screen.getByTestId("execution-usage").textContent).toContain("12k");
    expect(screen.getByTestId("execution-usage").textContent).toContain("9k");
    expect(screen.getByTestId("execution-usage").textContent).not.toMatch(/reasoning/);
  });

  it("opens one call's sanitized input and output in place", async () => {
    render(createElement(ExecutionDetail, { taskId: "t1", executionId: "exec-1", onBack: () => undefined }), { wrapper });
    await waitFor(() => expect(screen.getByTestId("worked-group")).toBeTruthy());
    fireEvent.click(screen.getByTestId("execution-head"));
    const rows = screen.getAllByTestId("trace-row-open");
    fireEvent.click(rows[rows.length - 1]);
    await waitFor(() => expect(api.getSessionCall).toHaveBeenCalledWith("t1", "c2"));
    await waitFor(() => expect(screen.getByTestId("call-detail")).toBeTruthy());
  });

  it("follows the same durable stream from the last replayed seq while the execution is still running", async () => {
    api.getTaskExecution.mockResolvedValueOnce({
      id: "exec-1", task_id: "t1", turn_id: null, direction: "Survey", kind: "direction", status: "running",
      error: null, resumed_from: null, steer_count: 0, work_result_id: null, created_at: at(2), started_at: at(2), finished_at: null,
    });
    api.listExecutionEventsPage.mockResolvedValueOnce({ task_id: "t1", execution_id: "exec-1", events: log().slice(0, 9), last_seq: 9 });
    api.followExecutionEvents.mockImplementation(async (_t: string, _e: string, on: import("../api").LiveEventHandlers) => {
      on.onTool({ id: "c1", tool: "survey_account", target: "acme", result: "3 buckets", ok: true, status: "completed" });
      on.onMessageCompleted?.({ text: "Done.", final: true });
      on.onStatus?.({ status: "completed" });
      return { status: "completed", stopped: false, last_seq: 12 };
    });
    render(createElement(ExecutionDetail, { taskId: "t1", executionId: "exec-1", onBack: () => undefined }), { wrapper });
    await waitFor(() => expect(api.followExecutionEvents).toHaveBeenCalled());
    const [, executionId, , opts] = api.followExecutionEvents.mock.calls[0];
    expect(executionId).toBe("exec-1");
    expect(opts.after).toBe(9);
    await waitFor(() => expect(screen.getByTestId("execution-status").textContent).toContain("complete"));
  });

  it("says so when the execution cannot be loaded, without a second vocabulary", async () => {
    api.getTaskExecution.mockRejectedValueOnce(new Error("execution not found"));
    render(createElement(ExecutionDetail, { taskId: "t1", executionId: "nope", onBack: () => undefined }), { wrapper });
    await waitFor(() => expect(screen.getByText(/execution not found/)).toBeTruthy());
    expect(api.listExecutionEventsPage).not.toHaveBeenCalled();
  });
});
