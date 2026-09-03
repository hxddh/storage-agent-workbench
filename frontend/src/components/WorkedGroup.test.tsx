/**
 * "Worked for …" is the group's wall-clock (v1.12): first start → last finish
 * when the rows carry stamps, the longest call otherwise — never a sum, because
 * calls run in parallel. Live it counts from the group's first row.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import type { ToolActivity } from "../types";
import { WorkedGroup, groupSpanMs, groupStartMs } from "./WorkedGroup";

const call = (over: Partial<ToolActivity> = {}): ToolActivity => ({
  id: "c1", tool: "head_bucket", target: "acme-logs", result: "200", ok: true, status: "completed", ...over,
});

const draw = (node: React.ReactElement) => render(<I18nProvider>{node}</I18nProvider>);

describe("the worked group clock", () => {
  it("spans the rows' stamps when every row carries them", () => {
    const records = [
      call({ id: "a", started_at: "2026-09-01T10:00:00.000Z", finished_at: "2026-09-01T10:00:02.000Z", duration_ms: 2000 }),
      call({ id: "b", started_at: "2026-09-01T10:00:01.000Z", finished_at: "2026-09-01T10:00:05.000Z", duration_ms: 4000 }),
    ];
    expect(groupSpanMs(records)).toBe(5000);
    expect(groupStartMs(records)).toBe(Date.parse("2026-09-01T10:00:00.000Z"));
    draw(<WorkedGroup records={records} />);
    expect(screen.getByTestId("execution-head").textContent).toBe("Worked for 5.0s · 2 tool calls");
  });

  it("falls back to the longest call, not the sum, when stamps are missing", () => {
    const records = [call({ id: "a", duration_ms: 4000 }), call({ id: "b", duration_ms: 3000 })];
    expect(groupSpanMs(records)).toBe(4000);
    draw(<WorkedGroup records={records} />);
    expect(screen.getByTestId("execution-head").textContent).toBe("Worked for 4.0s · 2 tool calls");
  });

  it("says nothing about time when no row measured any", () => {
    draw(<WorkedGroup records={[call({ duration_ms: null })]} />);
    expect(screen.getByTestId("execution-head").textContent).toBe("Worked · 1 tool calls");
    expect(groupSpanMs([])).toBeNull();
  });

  it("counts live from the group's first row, not from the turn's start", () => {
    const start = new Date(Date.now() - 12_000).toISOString();
    draw(<WorkedGroup records={[call({ status: "started", started_at: start })]} live startedAt={Date.now() - 60_000} />);
    expect(screen.getByTestId("worked-elapsed").textContent).toMatch(/^Working · 1[12]s$/);
  });

  it("uses the turn's start only until a row carries its own", () => {
    draw(<WorkedGroup records={[call({ status: "started" })]} live startedAt={Date.now() - 8_000} />);
    expect(screen.getByTestId("worked-elapsed").textContent).toMatch(/^Working · 8\.\ds$/);
  });
});
