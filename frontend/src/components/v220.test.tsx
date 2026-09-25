/**
 * v2.2.0 — native agent depth and the v2.1 review fixes, at the component
 * boundary: live tool progress, the durable Direction, reveal without moving
 * the window, and sections that exist only when something is behind them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { I18nProvider } from "../i18n";
import type { TaskMessage, ToolActivity } from "../types";
import { WorkedGroup, progressLabel } from "./WorkedGroup";
import { applyTool, applyToolProgress, EMPTY_TURN } from "../lib/turnItems";
import { dispatchDurableEvent } from "../api/runtime";
import { lastWorkResult, liveDirectionRow, type TaskItem } from "./TaskDocument";
import { revealInScroller } from "../lib/scroll";

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const draw = (node: React.ReactElement) => render(<I18nProvider>{node}</I18nProvider>);

afterEach(() => cleanup());

const running = (over: Partial<ToolActivity> = {}): ToolActivity => ({
  id: "c1", tool: "survey_account", target: "prod", result: "", status: "started", ...over,
});

describe("live tool progress (tool.progress)", () => {
  it("dispatches a bounded progress payload to the running row", () => {
    const seen: Array<{ id: string; progress: { done: number; total: number; unit: string } }> = [];
    dispatchDurableEvent("tool.progress", { id: "c1", tool: "survey_account", done: 120, total: 500, unit: "buckets" },
      { onDelta: () => undefined, onTool: () => undefined, onToolProgress: (p) => seen.push(p) });
    dispatchDurableEvent("tool.progress", { id: "c1", done: 900, total: 500, unit: "buckets" },
      { onDelta: () => undefined, onTool: () => undefined, onToolProgress: (p) => seen.push(p) });
    // Malformed frames are ignored, never painted as 0 of 0.
    dispatchDurableEvent("tool.progress", { id: "", done: 1, total: 2 },
      { onDelta: () => undefined, onTool: () => undefined, onToolProgress: (p) => seen.push(p) });
    dispatchDurableEvent("tool.progress", { id: "c1", done: 1, total: 0 },
      { onDelta: () => undefined, onTool: () => undefined, onToolProgress: (p) => seen.push(p) });
    expect(seen).toEqual([
      { id: "c1", progress: { done: 120, total: 500, unit: "buckets" } },
      { id: "c1", progress: { done: 500, total: 500, unit: "buckets" } },
    ]);
  });

  it("updates only the running row with that call id", () => {
    let turn = applyTool(EMPTY_TURN, running());
    turn = applyTool(turn, running({ id: "c2", tool: "head_bucket" }));
    turn = applyToolProgress(turn, "c1", { done: 3, total: 9, unit: "buckets" });
    const records = turn.items.flatMap((item) => (item.kind === "tool" ? [item.record] : []));
    expect(records[0].progress).toEqual({ done: 3, total: 9, unit: "buckets" });
    expect(records[1].progress).toBeUndefined();
    // Unknown id: the same turn object comes back.
    expect(applyToolProgress(turn, "nope", { done: 1, total: 2, unit: "files" })).toBe(turn);
    // The completed record replaces the row, progress and all.
    turn = applyTool(turn, { id: "c1", tool: "survey_account", target: "prod", result: "completed", ok: true, status: "completed" });
    const done = turn.items.flatMap((item) => (item.kind === "tool" ? [item.record] : []))[0];
    expect(done.status).toBe("completed");
    expect(done.progress).toBeUndefined();
  });

  it("paints counts and a meter on a running row, localized", () => {
    draw(<WorkedGroup records={[running({ progress: { done: 120, total: 500, unit: "buckets" } })]} live />);
    expect(screen.getByTestId("tool-progress").textContent).toBe("120 of 500 buckets");
    const meter = screen.getByRole("progressbar");
    expect(meter.getAttribute("aria-valuenow")).toBe("120");
    expect(meter.getAttribute("aria-valuemax")).toBe("500");
    const zh = (key: string, vars?: Record<string, string | number>) =>
      ({ "tool.progress": "{done} / {total} {unit}", "tool.unit.files": "个文件" } as Record<string, string>)[key]
        ?.replace("{done}", String(vars?.done)).replace("{total}", String(vars?.total)).replace("{unit}", String(vars?.unit)) ?? key;
    expect(progressLabel({ done: 3, total: 9, unit: "files" }, zh)).toBe("3 / 9 个文件");
    // An unknown unit is shown as the engine named it, never as a key.
    expect(progressLabel({ done: 1, total: 2, unit: "parts" }, (k, v) => (k === "tool.progress" ? `${v?.done} of ${v?.total} ${v?.unit}` : k)))
      .toBe("1 of 2 parts");
  });

  it("keeps the plain running note when no progress arrived", () => {
    draw(<WorkedGroup records={[running()]} live />);
    expect(screen.queryByTestId("tool-progress")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

const message = (id: string, role: "user" | "assistant", content: string): TaskItem => ({
  kind: "message", id, role, content,
  message: { id, role, content, referenced_run_ids: [], referenced_evidence_ids: [], created_at: "2026-09-25T00:00:00Z" } as unknown as TaskMessage,
} as unknown as TaskItem);
const idOf = (item: TaskItem | undefined) => (item as { id?: string } | undefined)?.id;

describe("the Direction is durable from the start", () => {
  it("keeps the latest Result while a newer Direction is at work", () => {
    const items = [message("u1", "user", "first"), message("a1", "assistant", "answer"), message("u2", "user", "second")];
    expect(lastWorkResult(items)?.id).toBe("a1");
    expect(idOf(liveDirectionRow(items, "second"))).toBe("u2");
    // Only the trailing row, and only when it is the live Direction.
    expect(liveDirectionRow(items, "first")).toBeUndefined();
    expect(liveDirectionRow(items.slice(0, 2), "first")).toBeUndefined();
    expect(liveDirectionRow(items, null)).toBeUndefined();
  });
});

describe("reveal without moving the window", () => {
  it("scrolls only the nearest scroller, never an overflow-hidden ancestor", () => {
    const outer = document.createElement("div");
    outer.style.overflow = "hidden";
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    const target = document.createElement("div");
    scroller.appendChild(target);
    outer.appendChild(scroller);
    document.body.appendChild(outer);
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) });
    scroller.getBoundingClientRect = () => rect(0, 400) as DOMRect;
    target.getBoundingClientRect = () => rect(700, 100) as DOMRect;
    const scrollBy = vi.fn();
    scroller.scrollBy = scrollBy as unknown as typeof scroller.scrollBy;
    const outerBy = vi.fn();
    outer.scrollBy = outerBy as unknown as typeof outer.scrollBy;
    revealInScroller(target, "nearest", false);
    expect(scrollBy).toHaveBeenCalledWith({ top: 400, behavior: "auto" });
    revealInScroller(target, "start", false);
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 700, behavior: "auto" });
    expect(outerBy).not.toHaveBeenCalled();
    expect(outer.scrollTop).toBe(0);
    outer.remove();
  });

  it("no production module calls scrollIntoView", () => {
    for (const file of ["./TaskDetails.tsx", "./TranscriptTurn.tsx", "./Markdown.tsx", "../agent/EvidenceReview.tsx", "./TaskDocument.tsx"]) {
      expect(source(file)).not.toMatch(/\.scrollIntoView\(/);
    }
  });
});

describe("the v2.1 review, fixed", () => {
  it("Execution detail paints no empty findings and no default kind", () => {
    const detail = source("./ExecutionDetail.tsx");
    expect(detail).not.toContain("noFindings");
    expect(detail).toContain('execution.kind !== "direction"');
    expect(source("./TaskDetails.tsx")).toContain('execution.kind !== "direction"');
  });

  it("the Resume banner is a quiet note with Settings beside Resume", () => {
    const banners = source("./TaskBanners.tsx");
    expect(banners).toMatch(/data-testid="task-resume"[^>]*data-quiet="true"/);
    expect(banners).toContain('data-testid="task-resume-settings"');
    expect(banners).toMatch(/task-resume-action" variant="default"/);
    const css = source("../agent/native-document.css");
    expect(css).toMatch(/\.native-banner\[data-quiet="true"\] \{[^}]*background: transparent/);
  });

  it("a one-Direction Task reads as its Result, and Find still reaches the log", () => {
    const doc = source("./TaskDocument.tsx");
    expect(doc).toContain("directionCount === 1");
    expect(doc).toMatch(/showLog = [^;]*\(!singleTurn \|\| findOpen\)/);
    // The user's words never leave the page: the single turn keeps its Direction.
    expect(doc).toMatch(/task-result-work[\s\S]{0,400}<UserTurn content=\{resultDirection\} \/>/);
  });

  it("the progress meter honours reduced motion", () => {
    const css = source("../agent/native-document.css");
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.native-tool-meter > span \{ transition: none; \}/);
  });
});
