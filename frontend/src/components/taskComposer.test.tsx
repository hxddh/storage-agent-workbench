/**
 * Attachments are per-task (v1.17): a file attached to one Task stays with
 * that Task across switches and never rides onto another.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTaskComposer } from "./TaskComposerHost";

describe("useTaskComposer attachments", () => {
  beforeEach(() => localStorage.clear());

  it("keeps a file with its task across a switch and back", () => {
    const { result, rerender } = renderHook(({ id }) => useTaskComposer(id), {
      initialProps: { id: "t1" as string | null },
    });
    const file = new File(["k,v"], "inventory.csv", { type: "text/csv" });
    act(() => result.current.onPickFile(file));
    expect(result.current.attached).toBe(file);

    rerender({ id: "t2" });
    expect(result.current.attached).toBeNull();

    rerender({ id: "t1" });
    expect(result.current.attached).toBe(file);
    expect(result.current.attachType).toBe("inventory");
  });

  it("forgets a cleared file after the switch", () => {
    const { result, rerender } = renderHook(({ id }) => useTaskComposer(id), {
      initialProps: { id: "t1" as string | null },
    });
    act(() => result.current.onPickFile(new File(["x"], "access.log")));
    act(() => result.current.clearAttachment());
    rerender({ id: "t2" });
    rerender({ id: "t1" });
    expect(result.current.attached).toBeNull();
  });
});
