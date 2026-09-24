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
  getLiveTask,
  patchLiveTask,
  dropLiveTask,
  registerTurnAbort,
  registerTurnCancel,
} from "./liveTasks";

let n = 0;
const sid = () => `s-${n++}`;

describe("patchLiveTask / getLiveTask", () => {
  it("returns a stable EMPTY default for an unknown session", () => {
    const r = getLiveTask("nope");
    expect(r.busy).toBe(false);
    expect(r.pending).toBeNull();
    expect(r.failedText).toBeNull();
    expect(r.items).toEqual([]);
    expect(r.answer).toBeNull();
    expect(r.waiting).toBe(false);
  });

  it("merges partial patches", () => {
    const id = sid();
    patchLiveTask(id, { busy: true, pending: "hi" });
    patchLiveTask(id, { pending: "bye" });
    const r = getLiveTask(id);
    expect(r.busy).toBe(true); // untouched by the second patch
    expect(r.pending).toBe("bye"); // overwritten
  });

  it("supports functional patches over the current value", () => {
    const id = sid();
    patchLiveTask(id, { answer: "a" });
    patchLiveTask(id, (s) => ({ answer: (s.answer ?? "") + "b" }));
    expect(getLiveTask(id).answer).toBe("ab");
  });

  it("round-trips failedText (FE2)", () => {
    const id = sid();
    patchLiveTask(id, { failedText: "lost message" });
    expect(getLiveTask(id).failedText).toBe("lost message");
    patchLiveTask(id, { failedText: null });
    expect(getLiveTask(id).failedText).toBeNull();
  });
});

describe("dropLiveTask (F3)", () => {
  it("ignores late writes after a session is dropped and fires abort+cancel", () => {
    const id = sid();
    const abort = vi.fn();
    const cancel = vi.fn();
    registerTurnAbort(id, abort);
    registerTurnCancel(id, cancel);
    patchLiveTask(id, { busy: true });

    dropLiveTask(id);
    expect(abort).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();

    // A late write from the still-unwinding turn must NOT resurrect the entry.
    patchLiveTask(id, { busy: false, stopped: true });
    const r = getLiveTask(id);
    expect(r.busy).toBe(false); // the EMPTY default, not a resurrected entry
    expect(r.stopped).toBe(false);
  });
});
