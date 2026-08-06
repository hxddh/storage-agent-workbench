import { describe, it, expect } from "vitest";
import {
  MIN_QUERY,
  countOccurrences,
  findInThread,
  highlightSegments,
  stepHit,
  totalMatches,
  type FindableItem,
} from "./threadFind";

const msg = (id: string, content: string | null, role = "assistant"): FindableItem => ({
  kind: "message",
  id,
  role,
  content,
});

const THREAD: FindableItem[] = [
  msg("m1", "Why is acme-logs growing so fast?", "user"),
  msg("m2", "acme-logs has versioning enabled and no expiration rule. acme-logs is 4.2 TiB."),
  { kind: "run", id: "r1" } as FindableItem,
  msg("m3", "What about the lifecycle policy?", "user"),
  msg("m4", "There is no lifecycle policy on that bucket."),
];

describe("countOccurrences", () => {
  it("counts every occurrence, case-insensitively", () => {
    expect(countOccurrences("acme ACME Acme", "acme")).toBe(3);
  });

  it("does not overlap matches", () => {
    expect(countOccurrences("aaaa", "aa")).toBe(2);
  });

  it("treats the query as literal text, not a pattern", () => {
    // An object key or an ARN routinely contains regex metacharacters. Compiling
    // the query would either throw or match something else entirely.
    expect(countOccurrences("logs/2026-08-06/*.gz", "*.gz")).toBe(1);
    expect(countOccurrences("a(b)c", "(b)")).toBe(1);
    expect(countOccurrences("plain text", "[")).toBe(0);
  });

  it("returns 0 for an empty needle rather than looping forever", () => {
    expect(countOccurrences("anything", "")).toBe(0);
  });
});

describe("findInThread", () => {
  it("finds every message containing the query, in reading order", () => {
    const hits = findInThread(THREAD, "acme-logs");
    expect(hits.map((h) => h.id)).toEqual(["m1", "m2"]);
    expect(hits.map((h) => h.index)).toEqual([0, 1]);
  });

  it("counts repeats within one message", () => {
    const hits = findInThread(THREAD, "acme-logs");
    expect(hits.find((h) => h.id === "m2")?.count).toBe(2);
    expect(totalMatches(hits)).toBe(3);
  });

  it("is case-insensitive", () => {
    expect(findInThread(THREAD, "ACME-LOGS").map((h) => h.id)).toEqual(["m1", "m2"]);
  });

  it("searches user turns as well as answers", () => {
    const hits = findInThread(THREAD, "lifecycle");
    expect(hits.map((h) => h.role)).toEqual(["user", "assistant"]);
  });

  it("ignores non-message cards", () => {
    // A run card renders structured data the inspector exposes properly.
    // Pretending to search it would promise more than the result delivers.
    expect(findInThread(THREAD, "r1")).toEqual([]);
  });

  it("survives a message with no content", () => {
    expect(() => findInThread([msg("m9", null)], "anything")).not.toThrow();
    expect(findInThread([msg("m9", null)], "anything")).toEqual([]);
  });

  it("does not run below the minimum query length", () => {
    expect(findInThread(THREAD, "a")).toEqual([]);
    expect(findInThread(THREAD, "  ")).toEqual([]);
    expect(MIN_QUERY).toBe(2);
  });

  it("returns nothing rather than everything for an empty query", () => {
    expect(findInThread(THREAD, "")).toEqual([]);
  });
});

describe("stepHit", () => {
  it("advances and wraps at the end", () => {
    expect(stepHit(0, 3, 1)).toBe(1);
    expect(stepHit(2, 3, 1)).toBe(0);
  });

  it("wraps backwards past zero", () => {
    // The earliest mention is usually the one being looked for; forcing a page
    // down through eighty turns to reach it would defeat the feature.
    expect(stepHit(0, 3, -1)).toBe(2);
  });

  it("never indexes into an empty hit list", () => {
    expect(stepHit(0, 0, 1)).toBe(0);
    expect(stepHit(5, 0, -1)).toBe(0);
  });
});

describe("highlightSegments", () => {
  it("splits into alternating plain and matched runs", () => {
    expect(highlightSegments("a big bucket", "big")).toEqual([
      { text: "a ", hit: false },
      { text: "big", hit: true },
      { text: " bucket", hit: false },
    ]);
  });

  it("preserves the ORIGINAL casing of a case-insensitive match", () => {
    // Echoing the query's casing back would quietly rewrite the transcript.
    const segs = highlightSegments("Bucket ACME", "acme");
    expect(segs.find((s) => s.hit)?.text).toBe("ACME");
  });

  it("reassembles to exactly the input", () => {
    const text = "acme-logs and acme-backups and acme";
    expect(highlightSegments(text, "acme").map((s) => s.text).join("")).toBe(text);
  });

  it("handles a match at both ends without emitting empty segments", () => {
    const segs = highlightSegments("acme", "acme");
    expect(segs).toEqual([{ text: "acme", hit: true }]);
  });

  it("returns the text untouched below the minimum query", () => {
    expect(highlightSegments("acme", "a")).toEqual([{ text: "acme", hit: false }]);
    expect(highlightSegments("", "acme")).toEqual([{ text: "", hit: false }]);
  });
});
