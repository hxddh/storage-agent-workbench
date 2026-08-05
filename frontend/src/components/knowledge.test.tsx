/**
 * v0.51.0 — what the agent knows, and what survives a reload.
 *
 * Three separate silences this pins shut:
 *
 *  - the agent's own memory was invisible, so a wrong fact it recorded steered
 *    every later turn with no way to see or fix it;
 *  - a half-written question was destroyed by switching sessions and by
 *    reloading, because the composer was one piece of component state;
 *  - "inspect" from a turn's footer dropped the reader at the top of a whole
 *    session's timeline with no marker for which rows were that turn's.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { I18nProvider } from "../i18n";
import { AgentMemoryPanel } from "./AgentMemory";
import { inAnchor } from "./SessionInspector";
import { loadDraft, saveDraft, clearDraft } from "../drafts";
import type { AgentMemoryItem } from "../types";

const wrap = (node: React.ReactNode) => render(createElement(I18nProvider, null, node));

const mem = (kind: AgentMemoryItem["kind"], text: string, extra: Partial<AgentMemoryItem> = {}): AgentMemoryItem => ({
  id: `${kind}-${text.slice(0, 6)}`,
  kind,
  text,
  ...extra,
});

describe("what the agent knows", () => {
  const items = [
    mem("fact", "acme-logs is path-style only", { confidence: "high" }),
    mem("finding", "no lifecycle rule on logs/", { severity: "high" }),
    mem("open_question", "is replication intentional?"),
  ];

  it("shows all three kinds, not just findings", () => {
    wrap(createElement(AgentMemoryPanel, { memory: items, onCorrect: vi.fn(), onResolve: vi.fn() }));
    // The report used to render findings alone; the premises the agent reasoned
    // FROM, and what it left open, existed nowhere a person could look.
    expect(screen.getByText(/path-style only/)).toBeTruthy();
    expect(screen.getByText(/no lifecycle rule/)).toBeTruthy();
    expect(screen.getByText(/replication intentional/)).toBeTruthy();
    expect(screen.getAllByTestId("memory-row").length).toBe(3);
  });

  it("hands the corrected text back, not the original", async () => {
    const onCorrect = vi.fn().mockResolvedValue(undefined);
    wrap(createElement(AgentMemoryPanel, { memory: [items[0]], onCorrect, onResolve: vi.fn() }));
    fireEvent.click(screen.getByTestId("memory-correct"));
    const box = screen.getByTestId("memory-edit-input");
    fireEvent.change(box, { target: { value: "acme-logs supports virtual-host addressing" } });
    fireEvent.click(screen.getByTestId("memory-save"));
    await waitFor(() =>
      expect(onCorrect).toHaveBeenCalledWith(items[0].id, "acme-logs supports virtual-host addressing"),
    );
  });

  it("does not fire a correction that changed nothing", async () => {
    const onCorrect = vi.fn().mockResolvedValue(undefined);
    wrap(createElement(AgentMemoryPanel, { memory: [items[0]], onCorrect, onResolve: vi.fn() }));
    fireEvent.click(screen.getByTestId("memory-correct"));
    fireEvent.click(screen.getByTestId("memory-save"));
    expect(onCorrect).not.toHaveBeenCalled();
  });

  it("abandons an edit on Escape", () => {
    wrap(createElement(AgentMemoryPanel, { memory: [items[0]], onCorrect: vi.fn(), onResolve: vi.fn() }));
    fireEvent.click(screen.getByTestId("memory-correct"));
    const box = screen.getByTestId("memory-edit-input");
    fireEvent.change(box, { target: { value: "wrong" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByTestId("memory-edit-input")).toBeNull();
    expect(screen.getByText(/path-style only/)).toBeTruthy();
  });

  it("resolves an item by id", () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    wrap(createElement(AgentMemoryPanel, { memory: [items[2]], onCorrect: vi.fn(), onResolve }));
    fireEvent.click(screen.getByTestId("memory-resolve"));
    expect(onResolve).toHaveBeenCalledWith(items[2].id);
  });

  it("says when the conversation has rolled out of the agent's context", () => {
    wrap(createElement(AgentMemoryPanel, {
      memory: items, contextMessages: 24, messageTotal: 90,
      onCorrect: vi.fn(), onResolve: vi.fn(),
    }));
    // Without this the reader assumes the agent still sees the whole thread and
    // misjudges what its later answers rest on.
    expect(screen.getByTestId("context-rolled").textContent).toMatch(/24/);
  });

  it("stays quiet when the whole thread still fits", () => {
    wrap(createElement(AgentMemoryPanel, {
      memory: items, contextMessages: 24, messageTotal: 12,
      onCorrect: vi.fn(), onResolve: vi.fn(),
    }));
    expect(screen.queryByTestId("context-rolled")).toBeNull();
  });

  it("lists the evidence attached to the session", () => {
    wrap(createElement(AgentMemoryPanel, {
      memory: [],
      files: [{ id: "d1", dataset_type: "inventory", source_filename: "acme.csv", row_count: 41022 }],
      onCorrect: vi.fn(), onResolve: vi.fn(),
    }));
    // After the composer chip cleared there was no way to tell what the agent
    // had in hand.
    expect(screen.getByTestId("attached-files").textContent).toContain("acme.csv");
    expect(screen.getByTestId("attached-files").textContent).toContain("41,022");
  });

  it("renders nothing at all when there is nothing to say", () => {
    const { container } = wrap(
      createElement(AgentMemoryPanel, { memory: [], files: [], onCorrect: vi.fn(), onResolve: vi.fn() }),
    );
    expect(container.textContent).toBe("");
  });
});

describe("composer drafts", () => {
  beforeEach(() => localStorage.clear());

  it("survives a session switch and a reload", () => {
    saveDraft("s1", "why is my bucket public");
    saveDraft("s2", "analyze these logs");
    // Two investigations, two drafts — switching between them must not mix or
    // destroy either.
    expect(loadDraft("s1")).toBe("why is my bucket public");
    expect(loadDraft("s2")).toBe("analyze these logs");
  });

  it("clears when the message is sent", () => {
    saveDraft("s1", "half a question");
    clearDraft("s1");
    expect(loadDraft("s1")).toBe("");
  });

  it("has no draft for a session that never had one", () => {
    expect(loadDraft("nope")).toBe("");
  });

  it("keeps a draft typed into a chat that does not exist yet", () => {
    // The most common place a draft was lost: a fresh chat has no session id
    // until the first message is sent, so `null` needs a key of its own rather
    // than being silently dropped.
    saveDraft(null, "why can I not delete this object");
    expect(loadDraft(null)).toBe("why can I not delete this object");
    // And it does not leak into a real session.
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

  it("keeps only the most recently touched sessions", () => {
    for (let i = 0; i < 60; i++) saveDraft(`s${i}`, `draft ${i}`);
    expect(loadDraft("s0")).toBe("");
    expect(loadDraft("s59")).toBe("draft 59");
  });
});

describe("inspector anchoring", () => {
  const anchor = { from: "2026-08-05T10:00:00Z", to: "2026-08-05T10:02:00Z" };

  it("matches the entries that happened inside the turn", () => {
    // Timestamps are fixed-width ISO-8601 Z, so string order IS chronological.
    expect(inAnchor("2026-08-05T10:01:30Z", anchor)).toBe(true);
    expect(inAnchor("2026-08-05T10:00:00Z", anchor)).toBe(true);
    expect(inAnchor("2026-08-05T10:02:00Z", anchor)).toBe(true);
  });

  it("excludes everything outside it", () => {
    expect(inAnchor("2026-08-05T09:59:59Z", anchor)).toBe(false);
    expect(inAnchor("2026-08-05T10:02:01Z", anchor)).toBe(false);
  });

  it("marks nothing when the inspector was not opened from a turn", () => {
    expect(inAnchor("2026-08-05T10:01:00Z", null)).toBe(false);
    expect(inAnchor("2026-08-05T10:01:00Z")).toBe(false);
  });
});
