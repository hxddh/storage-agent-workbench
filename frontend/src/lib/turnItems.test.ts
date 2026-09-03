/**
 * The turn model (v1.11): live frames reduce into ordered items, and a
 * persisted message projects into the SAME list, so one renderer serves both.
 */
import { describe, expect, it } from "vitest";
import type { TaskDecision } from "../api";
import type { ToolActivity } from "../types";
import {
  EMPTY_TURN,
  applyCompacted,
  applyDelta,
  applyPlan,
  applyStatus,
  applyTool,
  completeMessage,
  grantApproval,
  mergeTool,
  openApproval,
  resolveApproval,
  segmentsOf,
  turnItemsOf,
  unplacedApprovals,
} from "./turnItems";

const call = (over: Partial<ToolActivity> = {}): ToolActivity => ({
  id: "c1", tool: "head_bucket", target: "acme-logs", result: "200", ok: true, status: "completed", ...over,
});

const decision = (over: Partial<TaskDecision> = {}): TaskDecision => ({
  id: "d1", task_id: "t", execution_id: "e1", work_result_id: null,
  action_type: "import_access_log", title: "Download access logs", reason: "needed for the analysis",
  kind: "approval", scope: null, proposal: null, status: "pending", resolution_note: null,
  created_at: "2026-09-01T00:00:00Z", resolved_at: null,
  impact: { gate: "cloud_download", why: null, bucket: "acme-logs", prefix: "logs/2026/", source_type: "access_log", file_count: 312, total_bytes: 1_900_000_000, scan_scope: null },
  ...over,
});

describe("live reduction", () => {
  it("streams commentary into an open segment, then closes it before a tool call", () => {
    let turn = applyDelta(EMPTY_TURN, "Checking the ");
    turn = applyDelta(turn, "bucket policy.");
    expect(turn.items).toEqual([{ kind: "message", text: "Checking the bucket policy.", live: true }]);
    turn = completeMessage(turn, { text: "Checking the bucket policy.", final: false });
    turn = applyTool(turn, call({ status: "started" }));
    turn = applyTool(turn, call());
    expect(turn.items.map((item) => item.kind)).toEqual(["message", "tool"]);
    expect((turn.items[0] as { live?: boolean }).live).toBe(false);
    expect((turn.items[1] as { record: ToolActivity }).record.status).toBe("completed");
    expect(turn.answer).toBeNull();
  });

  it("closes the final segment as the answer and removes its live item", () => {
    let turn = applyDelta(EMPTY_TURN, "The policy omits s3:ListBucket.");
    turn = completeMessage(turn, { text: "The policy omits s3:ListBucket.", final: true });
    expect(turn.items).toEqual([]);
    expect(turn.answer).toBe("The policy omits s3:ListBucket.");
  });

  it("keeps the streamed text when the closed segment was truncated", () => {
    let turn = applyDelta(EMPTY_TURN, "streamed text");
    turn = completeMessage(turn, { text: "", final: true, truncated: true });
    expect(turn.answer).toBe("streamed text");
  });

  it("takes a closed segment it never saw streaming (reconnect replay)", () => {
    const turn = completeMessage(EMPTY_TURN, { text: "I will check the policy.", final: false });
    expect(turn.items).toEqual([{ kind: "message", text: "I will check the policy.", live: false }]);
  });

  it("starts a NEW live item after a closed segment", () => {
    let turn = completeMessage(applyDelta(EMPTY_TURN, "one"), { text: "one", final: false });
    turn = applyTool(turn, call());
    turn = applyDelta(turn, "two");
    expect(turn.items.map((item) => item.kind)).toEqual(["message", "tool", "message"]);
  });

  it("opens an inline approval, marks the run waiting, and resolves it in place", () => {
    let turn = applyTool(EMPTY_TURN, call({ status: "started" }));
    turn = openApproval(turn, { decision_id: "d1", action_type: "import_access_log", title: "Download logs", reason: null, impact: null });
    expect(turn.waiting).toBe(true);
    expect(turn.items[1]).toMatchObject({ kind: "approval", decision_id: "d1", status: "pending" });
    turn = resolveApproval(turn, { decision_id: "d1", resolution: "approved", scope: "task" });
    expect(turn.waiting).toBe(false);
    expect(turn.items[1]).toMatchObject({ status: "approved", scope: "task" });
    turn = applyStatus(turn, "running");
    expect(turn.waiting).toBe(false);
  });

  it("does not duplicate an approval replayed twice", () => {
    const payload = { decision_id: "d1", action_type: "x", title: null, reason: null, impact: null };
    const turn = openApproval(openApproval(EMPTY_TURN, payload), payload);
    expect(turn.items).toHaveLength(1);
  });

  it("renders an auto-granted approval as a resolved row", () => {
    const turn = grantApproval(EMPTY_TURN, { decision_id: "d2", action_type: "x", title: "Download logs" });
    expect(turn.items[0]).toMatchObject({ kind: "approval", status: "granted", scope: "task" });
    expect(turn.waiting).toBe(false);
  });

  it("marks waiting from the execution status frame alone", () => {
    expect(applyStatus(EMPTY_TURN, "waiting").waiting).toBe(true);
  });
});

describe("mergeTool", () => {
  it("resolves the row whose id matches, not merely the first lookalike", () => {
    const list = [call({ id: "a", status: "started" }), call({ id: "b", status: "started" })];
    const out = mergeTool(list, call({ id: "b", result: "2 rules" }));
    expect(out[0].status).toBe("started");
    expect(out[1].result).toBe("2 rules");
  });

  it("still resolves pre-v0.55.0 records, which carry no id", () => {
    const out = mergeTool([call({ id: undefined, status: "started" })], call({ id: undefined }));
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("completed");
  });
});

describe("durable projection", () => {
  it("reproduces the live order from turn_items + tool_activity + content", () => {
    const items = turnItemsOf({
      turn_items: [{ kind: "message", text: "Checking." }, { kind: "tool", id: "c1" }, { kind: "message", text: "Now the ACL." }, { kind: "tool", id: "c2" }],
      tool_activity: [call({ id: "c1" }), call({ id: "c2", tool: "get_bucket_acl" })],
    });
    expect(items.map((item) => item.kind)).toEqual(["message", "tool", "message", "tool"]);
  });

  it("renders a pre-1.11 row as one worked group before the answer", () => {
    const items = turnItemsOf({ turn_items: [], tool_activity: [call({ id: undefined }), call({ id: "c2" })] });
    expect(items.map((item) => item.kind)).toEqual(["tool", "tool"]);
    expect(segmentsOf(items).map((segment) => segment.kind)).toEqual(["worked"]);
  });

  it("places a pending approval at the tool row that raised it", () => {
    const items = turnItemsOf(
      { turn_items: [{ kind: "tool", id: "c1" }], tool_activity: [call({ id: "c1", decision_id: "d1", status: "started" })] },
      [decision()],
    );
    expect(items.map((item) => item.kind)).toEqual(["tool", "approval"]);
    expect(items[1]).toMatchObject({ decision_id: "d1", status: "pending", impact: { bucket: "acme-logs" } });
    expect(unplacedApprovals([items], [decision()])).toEqual([]);
  });

  it("reports a pending approval no tool row carries, for the end of the document", () => {
    const placed = turnItemsOf({ turn_items: [], tool_activity: [call()] }, [decision()]);
    expect(unplacedApprovals([placed], [decision()])).toHaveLength(1);
    expect(unplacedApprovals([placed], [decision({ status: "approved" })])).toEqual([]);
  });
});

describe("segments", () => {
  it("folds consecutive tool rows into ONE worked group between segments", () => {
    const segments = segmentsOf([
      { kind: "message", text: "a" },
      { kind: "tool", record: call({ id: "1" }) },
      { kind: "tool", record: call({ id: "2" }) },
      { kind: "approval", decision_id: "d", action_type: "x", title: null, reason: null, impact: null, status: "pending" },
      { kind: "tool", record: call({ id: "3" }) },
    ]);
    expect(segments.map((segment) => segment.kind)).toEqual(["commentary", "worked", "approval", "worked"]);
    expect((segments[1] as { records: ToolActivity[] }).records).toHaveLength(2);
  });

  it("drops an empty closed segment but keeps an empty live one", () => {
    expect(segmentsOf([{ kind: "message", text: " " }])).toEqual([]);
    expect(segmentsOf([{ kind: "message", text: "", live: true }])).toHaveLength(1);
  });
});

describe("the plan the model owns (v1.12)", () => {
  const steps = (...statuses: Array<"pending" | "in_progress" | "completed">) =>
    statuses.map((status, i) => ({ text: `step ${i + 1}`, status }));

  it("inserts ONE plan item at the current position on the first update", () => {
    let turn = applyDelta(EMPTY_TURN, "Let me plan this.");
    turn = completeMessage(turn, { text: "Let me plan this.", final: false });
    turn = applyPlan(turn, steps("in_progress", "pending"));
    expect(turn.items.map((item) => item.kind)).toEqual(["message", "plan"]);
    turn = applyTool(turn, call({ status: "started" }));
    expect(turn.items.map((item) => item.kind)).toEqual(["message", "plan", "tool"]);
  });

  it("updates the same item in place on later calls — never a second card", () => {
    let turn = applyPlan(EMPTY_TURN, steps("in_progress", "pending"));
    turn = applyTool(turn, call());
    turn = applyPlan(turn, steps("completed", "in_progress"));
    turn = applyPlan(turn, steps("completed", "completed"));
    const plans = turn.items.filter((item) => item.kind === "plan");
    expect(plans).toHaveLength(1);
    expect(turn.items[0]).toEqual({ kind: "plan", steps: steps("completed", "completed") });
    expect(turn.items.map((item) => item.kind)).toEqual(["plan", "tool"]);
  });

  it("bounds the list to 12 steps and unknown statuses to pending", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ text: `s${i}`, status: "later" as unknown as "pending" }));
    const turn = applyPlan(EMPTY_TURN, many);
    const plan = turn.items[0] as { kind: "plan"; steps: { status: string }[] };
    expect(plan.steps).toHaveLength(12);
    expect(plan.steps.every((step) => step.status === "pending")).toBe(true);
  });

  it("marks a compaction at the current position, at the top when it came first", () => {
    let turn = applyCompacted(EMPTY_TURN, { before_tokens: 48_000, after_tokens: 9_000 });
    turn = applyDelta(turn, "Continuing.");
    expect(turn.items[0]).toEqual({ kind: "compacted", before_tokens: 48_000, after_tokens: 9_000 });
    expect(turn.items[1]).toMatchObject({ kind: "message", live: true });
  });

  it("reproduces plan and compaction items from the durable turn_items", () => {
    const items = turnItemsOf({
      turn_items: [
        { kind: "compacted", before_tokens: 48_000, after_tokens: 9_000 },
        { kind: "message", text: "Planning." },
        { kind: "plan", steps: steps("completed", "completed") },
        { kind: "tool", id: "c1" },
      ],
      tool_activity: [call()],
    });
    expect(items.map((item) => item.kind)).toEqual(["compacted", "message", "plan", "tool"]);
    const segments = segmentsOf(items);
    expect(segments.map((segment) => segment.kind)).toEqual(["compacted", "commentary", "plan", "worked"]);
  });

  it("carries the started stamp across a resolve so the group keeps its span", () => {
    const started = call({ status: "started", started_at: "2026-09-01T10:00:00.000Z" });
    const merged = mergeTool([started], call({ finished_at: "2026-09-01T10:00:04.000Z" }));
    expect(merged[0].started_at).toBe("2026-09-01T10:00:00.000Z");
    expect(merged[0].finished_at).toBe("2026-09-01T10:00:04.000Z");
  });

  it("records why an auto-granted approval never asked", () => {
    const turn = grantApproval(EMPTY_TURN, { decision_id: "d9", action_type: "import_access_log", title: null, policy: "session" });
    expect(turn.items[0]).toMatchObject({ kind: "approval", status: "granted", policy: "session", scope: null });
  });
});
