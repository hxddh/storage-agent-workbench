import { describe, expect, it } from "vitest";
import {
  isCurrentPersistedDirection,
  pendingMatchesPersistedDirection,
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
