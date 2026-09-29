import { beforeEach, describe, expect, it } from "vitest";
import { item, resetSeq, snapshot, turn } from "../test/fixtures";
import { initial, reduce, stale } from "./task";

beforeEach(resetSeq);

describe("the task reducer", () => {
  it("replays a snapshot, then appends items once each, in seq order", () => {
    const t1 = turn("t1", { status: "running" });
    const a = item("t1", "user_message", { text: "Survey" });
    let m = reduce(initial("task-1"), { type: "snapshot", snapshot: snapshot([t1], [a]) });
    const b = item("t1", "agent_message", { text: "Looking." });
    m = reduce(m, { type: "item", item: b });
    m = reduce(m, { type: "item", item: b }); // a reconnect replays it
    expect(m.items.map((x) => x.seq)).toEqual([a.seq, b.seq]);
    expect(m.lastSeq).toBe(b.seq);
  });

  it("keeps items of another branch out of the branch being read", () => {
    let m = reduce(initial("task-1"), { type: "snapshot", snapshot: snapshot([turn("t1")], []) });
    const other = item("t9", "agent_message", { text: "elsewhere" });
    m = reduce(m, { type: "item", item: other });
    expect(m.turns.map((t) => t.id)).toEqual(["t1"]);
    expect(m.lastSeq).toBe(other.seq);
  });

  it("derives a turn's status from its lifecycle notices", () => {
    let m = reduce(initial("task-1"), { type: "snapshot", snapshot: snapshot([turn("t1", { status: "queued" })], []) });
    m = reduce(m, { type: "item", item: item("t1", "notice", { event: "started" }) });
    expect(m.turns[0].status).toBe("running");
    m = reduce(m, { type: "item", item: item("t1", "notice", { event: "cancelled" }) });
    expect(m.turns[0].status).toBe("cancelled");
  });

  it("streams deltas into one live segment and drops it when the message lands", () => {
    let m = reduce(initial("task-1"), { type: "snapshot", snapshot: snapshot([turn("t1", { status: "running" })], []) });
    m = reduce(m, { type: "delta", turn_id: "t1", segment_id: "seg", text: "Hel" });
    m = reduce(m, { type: "delta", turn_id: "t1", segment_id: "seg", text: "lo" });
    expect(m.live?.text).toBe("Hello");
    m = reduce(m, { type: "item", item: item("t1", "agent_message", { text: "Hello" }, { id: "seg" }) });
    expect(m.live).toBeNull();
  });

  it("takes the agent's title from the titled notice", () => {
    let m = reduce(initial("task-1"), { type: "snapshot", snapshot: snapshot([turn("t1")], []) });
    m = reduce(m, { type: "item", item: item("t1", "notice", { event: "titled", title: "Account survey" }) });
    expect(m.snapshot?.task.title).toBe("Account survey");
  });

  it("never lets a late snapshot of another task replace the one being read", () => {
    const m = reduce(initial("task-2"), { type: "snapshot", snapshot: snapshot([turn("t1")], []) });
    expect(m.snapshot).toBeNull();
  });

  it("a follow-up appears the moment its turn event lands, then streams without a reload", () => {
    const t1 = turn("t1");
    let m = reduce(initial("task-1"), { type: "snapshot", snapshot: snapshot([t1], [item("t1", "user_message", { text: "One" })]) });
    m = reduce(m, { type: "turn", turn: turn("t2", { parent_turn_id: "t1", status: "queued", direction: "Two" }) });
    expect(m.turns.map((t) => t.id)).toEqual(["t1", "t2"]);
    m = reduce(m, { type: "item", item: item("t2", "user_message", { text: "Two" }) });
    m = reduce(m, { type: "item", item: item("t2", "notice", { event: "started" }) });
    m = reduce(m, { type: "delta", turn_id: "t2", segment_id: "s2", text: "Ans" });
    expect(m.turns[1].status).toBe("running");
    expect(m.turns[1].started_at).not.toBeNull();
    expect(m.live?.text).toBe("Ans");
  });

  it("a snapshot that lands late keeps everything that arrived after it was built", () => {
    const t1 = turn("t1"); const t2 = turn("t2", { parent_turn_id: "t1", status: "running" });
    const a = item("t1", "user_message", { text: "One" });
    const b = item("t2", "user_message", { text: "Two" });
    const built = snapshot([t1, t2], [a, b], { head_turn_id: "t2" });
    let m = reduce(initial("task-1"), { type: "snapshot", snapshot: built });
    const out = item("t2", "tool_output", { call_id: "x", name: "head_bucket", ok: true, summary: "ok" });
    const done = item("t2", "notice", { event: "completed" });
    m = reduce(m, { type: "item", item: out });
    m = reduce(m, { type: "item", item: done });
    m = reduce(m, { type: "snapshot", snapshot: built }); // the reload answers late
    expect(m.items.map((x) => x.seq)).toEqual([a.seq, b.seq, out.seq, done.seq]);
    expect(m.turns[1].status).toBe("completed");
  });

  it("never re-opens a stored segment from a stale live event or a late delta", () => {
    let m = reduce(initial("task-1"), { type: "snapshot", snapshot: snapshot([turn("t1", { status: "running" })], []) });
    m = reduce(m, { type: "item", item: item("t1", "agent_message", { text: "Done." }, { id: "seg1" }) });
    m = reduce(m, { type: "live", live: { turn_id: "t1", segment_id: "seg1", text: "Done." } });
    expect(m.live).toBeNull();
    m = reduce(m, { type: "delta", turn_id: "t1", segment_id: "seg1", text: "!" });
    expect(m.live).toBeNull();
  });

  it("a live snapshot never shortens text that already streamed", () => {
    let m = reduce(initial("task-1"), { type: "snapshot", snapshot: snapshot([turn("t1", { status: "running" })], []) });
    m = reduce(m, { type: "delta", turn_id: "t1", segment_id: "s", text: "Hello wor" });
    m = reduce(m, { type: "live", live: { turn_id: "t1", segment_id: "s", text: "Hello" } });
    expect(m.live?.text).toBe("Hello wor");
  });

  it("moves to a new version when the state names a new head, and flags a stale running turn", () => {
    let m = reduce(initial("task-1"), { type: "snapshot", snapshot: snapshot([turn("t1", { status: "running" })], []) });
    m = reduce(m, { type: "turn", turn: turn("t1b", { parent_turn_id: null, status: "queued" }) });
    expect(m.turns.map((t) => t.id)).toEqual(["t1"]); // an edit forks; the head moves only with the state
    m = reduce(m, { type: "state", state: { state: "queued", running_turn_id: null, queued_turn_ids: ["t1b"], head_turn_id: "t1b" } });
    expect(m.turns.map((t) => t.id)).toEqual(["t1b"]);
    const back = reduce(m, { type: "state", state: { state: "ready", running_turn_id: null, queued_turn_ids: [], head_turn_id: "t1" } });
    expect(stale(back)).toBe(true);
  });
});
