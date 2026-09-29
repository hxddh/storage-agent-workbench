import { beforeEach, describe, expect, it } from "vitest";
import { item, resetSeq, turn } from "../test/fixtures";
import { findings, latestResult, sections, versions } from "./derive";

beforeEach(resetSeq);

const conclusion = {
  call_id: "c", answer: "Two buckets need care.", next_steps: ["Show the fix"],
  findings: [{ title: "No encryption", severity: "medium" as const }, { title: "Public bucket", severity: "high" as const }],
};

describe("sections", () => {
  it("splits commentary, work and the answer — the last message after the last tool call", () => {
    const t1 = turn("t1");
    const s = sections([t1], [
      item("t1", "user_message", { text: "Survey" }),
      item("t1", "agent_message", { text: "Looking." }),
      item("t1", "tool_call", { call_id: "a", name: "survey_account", args: {}, target: "prod" }),
      item("t1", "tool_progress", { call_id: "a", name: "survey_account", done: 3, total: 4, unit: "buckets" }),
      item("t1", "tool_output", { call_id: "a", name: "survey_account", ok: true, summary: "4 buckets" }),
      item("t1", "tool_call", { call_id: "b", name: "head_bucket", args: {}, target: "x" }),
      item("t1", "tool_output", { call_id: "b", name: "head_bucket", ok: false, refused: true, summary: "outside scope" }),
      item("t1", "conclusion", conclusion),
      item("t1", "agent_message", { text: "Full answer." }),
    ], null)[0];
    expect(s.direction).toBe("Survey");
    expect(s.answer).toBe("Full answer.");
    expect(s.blocks.map((b) => b.kind)).toEqual(["commentary", "work"]);
    const work = s.blocks[1];
    expect(work.kind === "work" && work.tools.map((r) => r.status)).toEqual(["ok", "refused"]);
    expect(s.toolCount).toBe(2);
    expect(s.conclusion?.answer).toBe("Two buckets need care.");
  });

  it("gives a live turn no answer yet, and marks unfinished calls failed once it settles", () => {
    const items = [
      item("t1", "tool_call", { call_id: "a", name: "survey_account", args: {}, target: "" }),
      item("t1", "agent_message", { text: "partial" }),
    ];
    const live = sections([turn("t1", { status: "running" })], items, null)[0];
    expect(live.answer).toBeNull();
    const settled = sections([turn("t1", { status: "cancelled" })], [...items, item("t1", "notice", { event: "cancelled" })], null)[0];
    expect(settled.stopped).toBe(true);
    const work = settled.blocks.find((b) => b.kind === "work");
    expect(work?.kind === "work" && work.tools[0].status).toBe("failed");
  });

  it("finds the latest result and unifies findings, most severe first, without duplicates", () => {
    const all = sections([turn("t1"), turn("t2"), turn("t3", { status: "running" })], [
      item("t1", "conclusion", conclusion),
      item("t2", "conclusion", { ...conclusion, findings: [{ title: "public  bucket", severity: "high" }, { title: "No logging", severity: "low" }] }),
      item("t2", "agent_message", { text: "Second." }),
    ], null);
    expect(latestResult(all)?.turn.id).toBe("t2");
    expect(findings(all).map((f) => `${f.severity}:${f.title}`)).toEqual(["high:public  bucket", "medium:No encryption", "low:No logging"]);
  });

  it("reads versions of a Direction from its siblings", () => {
    const forks = { t1: ["t2", "t2b"] };
    expect(versions(forks, turn("t2b", { parent_turn_id: "t1" }))).toEqual({ index: 1, ids: ["t2", "t2b"] });
    expect(versions(forks, turn("t1"))).toBeNull();
  });
});
