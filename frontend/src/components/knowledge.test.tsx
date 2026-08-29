/**
 * What the Agent knows, and what survives a reload.
 *
 * These tests protect two durable product contracts that remain independent of
 * the active Work Surface:
 *
 *  - the Agent's memory/evidence context stays visible and correctable;
 *  - draft steering text survives investigation switches and reloads.
 *
 * Turn-local Inspector anchoring was intentionally removed in v0.92: Evidence is
 * now a global investigation surface and navigation to it is tested at the
 * Workbench boundary instead of by timestamp-window helper functions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { I18nProvider } from "../i18n";
import { AgentMemoryPanel } from "./AgentMemory";
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

  it("keeps only the most recently touched sessions", () => {
    for (let i = 0; i < 60; i++) saveDraft(`s${i}`, `draft ${i}`);
    expect(loadDraft("s0")).toBe("");
    expect(loadDraft("s59")).toBe("draft 59");
  });
});
