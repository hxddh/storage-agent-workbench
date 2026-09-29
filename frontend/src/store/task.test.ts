import { beforeEach, describe, expect, it } from "vitest";
import { item, resetSeq, snapshot, turn } from "../test/fixtures";
import { initial, reduce } from "./task";

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

  it("ignores items of another branch but still advances the cursor", () => {
    let m = reduce(initial("task-1"), { type: "snapshot", snapshot: snapshot([turn("t1")], []) });
    const other = item("t9", "agent_message", { text: "elsewhere" });
    m = reduce(m, { type: "item", item: other });
    expect(m.items).toHaveLength(0);
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
});
