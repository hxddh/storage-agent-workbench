/**
 * Composer drafts must survive task switches and reloads.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { loadDraft, saveDraft, clearDraft } from "../drafts";

describe("composer drafts", () => {
  beforeEach(() => localStorage.clear());

  it("survives a task switch and a reload", () => {
    saveDraft("s1", "why is my bucket public");
    saveDraft("s2", "analyze these logs");
    expect(loadDraft("s1")).toBe("why is my bucket public");
    expect(loadDraft("s2")).toBe("analyze these logs");
  });

  it("clears when the Direction is sent", () => {
    saveDraft("s1", "half a question");
    clearDraft("s1");
    expect(loadDraft("s1")).toBe("");
  });

  it("has no draft for a task that never had one", () => {
    expect(loadDraft("nope")).toBe("");
  });

  it("keeps a draft typed before a task exists", () => {
    saveDraft(null, "why can I not delete this object");
    expect(loadDraft(null)).toBe("why can I not delete this object");
    expect(loadDraft("s1")).toBe("");
  });

  it("bounds a pathological paste", () => {
    saveDraft("s1", "x".repeat(50_000));
    expect(loadDraft("s1").length).toBe(20_000);
  });

  it("survives corrupt storage rather than breaking the composer", () => {
    localStorage.setItem("saw.drafts", "{not json");
    expect(loadDraft("s1")).toBe("");
    saveDraft("s1", "recovered");
    expect(loadDraft("s1")).toBe("recovered");
  });

  it("keeps only the most recently touched tasks", () => {
    for (let i = 0; i < 60; i++) saveDraft(`s${i}`, `draft ${i}`);
    expect(loadDraft("s0")).toBe("");
    expect(loadDraft("s59")).toBe("draft 59");
  });
});
