import { describe, expect, it } from "vitest";
import {
  isCurrentPersistedDirection,
  isCurrentPersistedWorkResult,
  pendingMatchesPersistedDirection,
  visibleQueuedExecutions,
} from "./pendingDirection";

const user = (content: string) => ({ kind: "message", role: "user", content });
const assistant = (content: string) => ({ kind: "message", role: "assistant", content });
const run = { kind: "run" };
const triage = { kind: "triage" };

describe("isCurrentPersistedDirection", () => {
  it("is false when nothing is pending", () => {
    expect(isCurrentPersistedDirection([user("list the bucket")], null)).toBe(false);
  });

  it("is false when the latest message is still the previous Work Result", () => {
    expect(isCurrentPersistedDirection(
      [user("list the bucket"), assistant("3 objects")],
      "list the bucket",
    )).toBe(false);
  });

  it("is true only when the latest message is this Direction", () => {
    expect(isCurrentPersistedDirection(
      [user("list the bucket"), assistant("3 objects"), user("list the bucket")],
      "list the bucket",
    )).toBe(true);
  });

  it("skips trailing run and triage rows", () => {
    expect(isCurrentPersistedDirection(
      [user("scan logs"), run, triage],
      "scan logs",
    )).toBe(true);
    expect(isCurrentPersistedDirection(
      [user("scan logs"), assistant("done"), run],
      "scan logs",
    )).toBe(false);
  });
});

describe("pendingMatchesPersistedDirection", () => {
  it("matches any earlier user message for settled-race cleanup", () => {
    expect(pendingMatchesPersistedDirection(
      [user("list the bucket"), assistant("3 objects")],
      "list the bucket",
    )).toBe(true);
  });
});

describe("isCurrentPersistedWorkResult", () => {
  it("is false when nothing is pending", () => {
    expect(isCurrentPersistedWorkResult(
      [user("list the bucket"), assistant("3 objects")],
      null,
    )).toBe(false);
  });

  it("is false while the latest message is still this Direction", () => {
    expect(isCurrentPersistedWorkResult(
      [user("list the bucket")],
      "list the bucket",
    )).toBe(false);
  });

  it("is true when this Direction already has a persisted Work Result", () => {
    expect(isCurrentPersistedWorkResult(
      [user("list the bucket"), assistant("3 objects")],
      "list the bucket",
    )).toBe(true);
  });

  it("is false when the latest Work Result belongs to a previous Direction", () => {
    expect(isCurrentPersistedWorkResult(
      [user("list the bucket"), assistant("3 objects")],
      "now review the policy",
    )).toBe(false);
  });

  it("pairs a re-delegated Direction with its own Work Result, not the earlier one", () => {
    expect(isCurrentPersistedWorkResult(
      [user("list the bucket"), assistant("3 objects"), user("list the bucket")],
      "list the bucket",
    )).toBe(false);
    expect(isCurrentPersistedWorkResult(
      [user("list the bucket"), assistant("3 objects"), user("list the bucket"), assistant("still 3")],
      "list the bucket",
    )).toBe(true);
  });

  it("skips trailing run and triage rows", () => {
    expect(isCurrentPersistedWorkResult(
      [user("scan logs"), assistant("done"), run, triage],
      "scan logs",
    )).toBe(true);
    expect(isCurrentPersistedWorkResult(
      [user("scan logs"), run, triage],
      "scan logs",
    )).toBe(false);
  });
});

describe("visibleQueuedExecutions", () => {
  const row = (id: string, direction: string) => ({ id, direction });

  it("drops the execution the client is already following", () => {
    expect(visibleQueuedExecutions(
      [row("e1", "list the bucket"), row("e2", "then the ACL")],
      { activeExecutionId: "e1", livePending: "list the bucket" },
    )).toEqual([row("e2", "then the ACL")]);
  });

  it("drops a just-submitted row that matches the live Direction bubble", () => {
    expect(visibleQueuedExecutions(
      [row("e1", "list the bucket")],
      { livePending: "list the bucket", hideLiveDirection: false },
    )).toEqual([]);
  });

  it("keeps a later queued Direction that reuses the live wording", () => {
    expect(visibleQueuedExecutions(
      [row("e2", "list the bucket")],
      { activeExecutionId: "e1", livePending: "list the bucket", hideLiveDirection: false },
    )).toEqual([row("e2", "list the bucket")]);
  });
});
