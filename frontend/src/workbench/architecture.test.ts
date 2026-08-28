import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

describe("v0.92 Agent OS ownership boundaries", () => {
  it("has no legacy SessionInspector implementation left to reopen as an overlay", () => {
    expect(existsSync(new URL("../components/SessionInspector.tsx", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../components/SessionInspectorImplementation.tsx", import.meta.url))).toBe(false);
  });

  it("keeps persisted session and viewport ownership out of the Timeline implementation", () => {
    const thread = source("../components/ThreadImplementation.tsx");
    expect(thread).not.toContain("getSessionTurnState");
    expect(thread).not.toContain("getSessionMessages");
    expect(thread).not.toContain("AUTOSCROLL_FRAME_BUDGET");
    expect(thread).not.toContain("SessionInspector");
    expect(thread).not.toContain("getSessionReport");
    expect(thread).not.toContain("function Overlay");
  });

  it("has exactly one semantic j/k owner without capture-phase suppression", () => {
    const boundary = source("../components/Thread.tsx");
    const implementation = source("../components/ThreadImplementation.tsx");
    expect(boundary).toContain('matches(event, "nextTurn")');
    expect(boundary).not.toContain("stopImmediatePropagation");
    expect(implementation).not.toContain('matches(event, "nextTurn")');
    expect(implementation).not.toContain("stepTurn");
  });

  it("does not embed RunDetail in conversation content", () => {
    const cards = source("../components/ThreadCardsImplementation.tsx");
    expect(cards).not.toContain('import { RunDetail } from "./RunDetail"');
    expect(cards).not.toContain("export function RunCard");
    expect(cards).not.toContain("<RunDetail");
  });

  it("contains no modal-stretch compatibility CSS for deep work surfaces", () => {
    const workspace = source("../workspace-overhaul.css");
    const run = source("../run-workspace.css");
    expect(workspace).not.toContain('data-testid="session-inspector"');
    expect(workspace).not.toContain(".fixed.inset-0.z-floating");
    expect(run).not.toContain(".thread-item div:has");
    expect(run).not.toContain("position: fixed");
  });
});
