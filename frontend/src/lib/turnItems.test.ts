/**
 * The turn model (v1.11): live frames reduce into ordered items, and a
 * persisted message projects into the SAME list, so one renderer serves both.
 */
import { describe, expect, it } from "vitest";
import type { ToolActivity } from "../types";
import {
  EMPTY_TURN,
  applyCompacted,
  applyDelta,
  applyTool,
  completeMessage,
  mergeTool,
  segmentsOf,
  turnItemsOf,
} from "./turnItems";

const call = (over: Partial<ToolActivity> = {}): ToolActivity => ({
  id: "c1", tool: "head_bucket", target: "acme-logs", result: "200", ok: true, status: "completed", ...over,
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

});

describe("segments", () => {
  it("folds consecutive tool rows into ONE worked group between segments", () => {
    const segments = segmentsOf([
      { kind: "message", text: "a" },
      { kind: "tool", record: call({ id: "1" }) },
      { kind: "tool", record: call({ id: "2" }) },
      { kind: "steer", text: "check the ACL too" },
      { kind: "tool", record: call({ id: "3" }) },
    ]);
    expect(segments.map((segment) => segment.kind)).toEqual(["commentary", "worked", "steer", "worked"]);
    expect((segments[1] as { records: ToolActivity[] }).records).toHaveLength(2);
  });

  it("drops an empty closed segment but keeps an empty live one", () => {
    expect(segmentsOf([{ kind: "message", text: " " }])).toEqual([]);
    expect(segmentsOf([{ kind: "message", text: "", live: true }])).toHaveLength(1);
  });
});

describe("compaction and wall-clock (v1.12); no plan (v2.1)", () => {
  it("marks a compaction at the current position, at the top when it came first", () => {
    let turn = applyCompacted(EMPTY_TURN, { before_tokens: 48_000, after_tokens: 9_000 });
    turn = applyDelta(turn, "Continuing.");
    expect(turn.items[0]).toEqual({ kind: "compacted", before_tokens: 48_000, after_tokens: 9_000 });
    expect(turn.items[1]).toMatchObject({ kind: "message", live: true });
  });

  it("reproduces compaction from the durable turn_items and ignores a pre-2.1 plan item", () => {
    const items = turnItemsOf({
      turn_items: [
        { kind: "compacted", before_tokens: 48_000, after_tokens: 9_000 },
        { kind: "message", text: "Planning." },
        { kind: "plan", steps: [{ text: "old", status: "completed" }] } as never,
        { kind: "tool", id: "c1" },
      ],
      tool_activity: [call()],
    });
    expect(items.map((item) => item.kind)).toEqual(["compacted", "message", "tool"]);
    const segments = segmentsOf(items);
    expect(segments.map((segment) => segment.kind)).toEqual(["compacted", "commentary", "worked"]);
  });

  it("carries the started stamp across a resolve so the group keeps its span", () => {
    const started = call({ status: "started", started_at: "2026-09-01T10:00:00.000Z" });
    const merged = mergeTool([started], call({ finished_at: "2026-09-01T10:00:04.000Z" }));
    expect(merged[0].started_at).toBe("2026-09-01T10:00:00.000Z");
    expect(merged[0].finished_at).toBe("2026-09-01T10:00:04.000Z");
  });

});
