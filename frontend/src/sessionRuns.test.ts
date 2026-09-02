/**
 * Tests for the per-session run store. This holds in-flight turn state OUTSIDE
 * the task renderer so a turn survives task switches; its drop/late-write
 * guard (F3) and the new failedText field (FE2) are exactly the state-machine
 * bits the v0.38 fixes leaned on, and were untested.
 *
 * The store is a module singleton, so each test uses a unique session id to stay
 * isolated (there is no reset hook in production code).
 */
import { describe, it, expect, vi } from "vitest";
import {
  getSessionRun,
  patchSessionRun,
  dropSessionRun,
  registerTurnAbort,
  registerTurnCancel,
} from "./sessionRuns";

let n = 0;
const sid = () => `s-${n++}`;

describe("patchSessionRun / getSessionRun", () => {
  it("returns a stable EMPTY default for an unknown session", () => {
    const r = getSessionRun("nope");
    expect(r.busy).toBe(false);
    expect(r.pending).toBeNull();
    expect(r.failedText).toBeNull();
    expect(r.items).toEqual([]);
    expect(r.answer).toBeNull();
    expect(r.waiting).toBe(false);
  });

  it("merges partial patches", () => {
    const id = sid();
    patchSessionRun(id, { busy: true, pending: "hi" });
    patchSessionRun(id, { pending: "bye" });
    const r = getSessionRun(id);
    expect(r.busy).toBe(true); // untouched by the second patch
    expect(r.pending).toBe("bye"); // overwritten
  });

  it("supports functional patches over the current value", () => {
    const id = sid();
    patchSessionRun(id, { answer: "a" });
    patchSessionRun(id, (s) => ({ answer: (s.answer ?? "") + "b" }));
    expect(getSessionRun(id).answer).toBe("ab");
  });

  it("round-trips failedText (FE2)", () => {
    const id = sid();
    patchSessionRun(id, { failedText: "lost message" });
    expect(getSessionRun(id).failedText).toBe("lost message");
    patchSessionRun(id, { failedText: null });
    expect(getSessionRun(id).failedText).toBeNull();
  });
});

describe("dropSessionRun (F3)", () => {
  it("ignores late writes after a session is dropped and fires abort+cancel", () => {
    const id = sid();
    const abort = vi.fn();
    const cancel = vi.fn();
    registerTurnAbort(id, abort);
    registerTurnCancel(id, cancel);
    patchSessionRun(id, { busy: true });

    dropSessionRun(id);
    expect(abort).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();

    // A late write from the still-unwinding turn must NOT resurrect the entry.
    patchSessionRun(id, { busy: false, stopped: true });
    const r = getSessionRun(id);
    expect(r.busy).toBe(false); // the EMPTY default, not a resurrected entry
    expect(r.stopped).toBe(false);
  });
});
