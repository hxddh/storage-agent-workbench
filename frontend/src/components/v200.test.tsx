import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { I18nProvider } from "../i18n";
import { asConclusion, topSeverity } from "../lib/conclusion";
import { dispatchDurableEvent } from "../api/runtime";
import { Markdown, TABLE_PREVIEW_ROWS, cellNumber } from "./Markdown";
import { ConclusionView, TaskResult } from "./TaskResult";
import { AgentTurn, answerGist } from "./TranscriptTurn";
import type { Conclusion, TaskMessage } from "../types";

afterEach(cleanup);

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const wrap = (node: ReturnType<typeof createElement>) => render(createElement(I18nProvider, null, node));

const conclusion: Conclusion = {
  answer: "acme-logs denies list because its policy omits s3:ListBucket.",
  findings: [
    { title: "Versioning is off", severity: "low" },
    { title: "Policy omits s3:ListBucket", severity: "high", detail: "Every ListObjectsV2 returns 403." },
  ],
  next_steps: ["Draft a remediation plan"],
};

const message = (over: Partial<TaskMessage> = {}): TaskMessage => ({
  id: "m1",
  role: "assistant",
  content: "## Why\nThe policy omits ListBucket.",
  referenced_run_ids: [],
  referenced_evidence_ids: [],
  created_at: "2026-01-01T00:00:00Z",
  ...over,
});

describe("v2.0 result-first Task", () => {
  it("accepts a conclusion only in the recorded shape, most severe first", () => {
    const parsed = asConclusion(conclusion);
    expect(parsed?.findings.map((f) => f.severity)).toEqual(["high", "low"]);
    expect(topSeverity(parsed)).toBe("high");
    expect(asConclusion({ answer: "  " })).toBeNull();
    expect(asConclusion("prose")).toBeNull();
    expect(asConclusion(null)).toBeNull();
    const odd = asConclusion({ answer: "a", findings: [{ title: "t", severity: "catastrophic" }, { title: "" }], next_steps: ["", 3, "x"] });
    expect(odd?.findings).toEqual([{ title: "t", severity: "info" }]);
    expect(odd?.next_steps).toEqual(["x"]);
  });

  it("dispatches conclusion.recorded to the live handler, and nothing malformed", () => {
    const onConclusionRecorded = vi.fn();
    const handlers = { onTool: vi.fn(), onDelta: vi.fn(), onConclusionRecorded };
    dispatchDurableEvent("conclusion.recorded", conclusion as unknown as Record<string, unknown>, handlers);
    dispatchDurableEvent("conclusion.recorded", { answer: "" }, handlers);
    expect(onConclusionRecorded).toHaveBeenCalledTimes(1);
    expect(onConclusionRecorded.mock.calls[0][0].answer).toBe(conclusion.answer);
  });

  it("renders the conclusion: answer, findings with severity, next steps into the Composer", () => {
    const onNextStep = vi.fn();
    wrap(createElement(ConclusionView, { conclusion: asConclusion(conclusion)!, onNextStep }));
    expect(screen.getByTestId("result-answer").textContent).toBe(conclusion.answer);
    const rows = screen.getAllByTestId("result-finding");
    expect(rows.map((row) => row.getAttribute("data-severity"))).toEqual(["high", "low"]);
    // A finding with detail expands in place; one without has nothing to open.
    expect(within(rows[1]).queryByRole("button")).toBeNull();
    fireEvent.click(within(rows[0]).getByRole("button"));
    expect(screen.getByText("Every ListObjectsV2 returns 403.")).toBeTruthy();
    fireEvent.click(screen.getByTestId("result-next-step"));
    expect(onNextStep).toHaveBeenCalledWith("Draft a remediation plan");
  });

  it("shows the answer alone when no conclusion was recorded — never a guessed head", () => {
    wrap(createElement(TaskResult, { message: message(), direction: "why?" }));
    expect(screen.queryByTestId("result-conclusion")).toBeNull();
    expect(screen.getByTestId("task-result").getAttribute("data-has-conclusion")).toBe("false");
    expect(screen.getByTestId("turn-answer").textContent).toContain("The policy omits ListBucket.");
  });

  it("puts the conclusion above the full answer and derives the grounding line from the trace", () => {
    wrap(createElement(TaskResult, {
      message: message({
        conclusion,
        grounding: { evidence_used: ["review_bucket_config:acme-logs"], evidence_gaps: ["who owns the policy"], skills_used: [] },
        tool_activity: [{ id: "c1", tool: "head_bucket", target: "acme-logs", result: "200", ok: true, status: "completed" }],
      }),
      direction: "why does acme-logs deny list?",
    }));
    const result = screen.getByTestId("task-result");
    const order = [...result.querySelectorAll("[data-testid]")].map((node) => node.getAttribute("data-testid"));
    expect(order.indexOf("result-conclusion")).toBeLessThan(order.indexOf("turn-answer"));
    expect(screen.getByTestId("result-grounding").textContent).toBe("Evidence 1 · Gaps 1 · Tool calls 1");
  });

  it("folds older answers in the Work log and points the latest one up to the Result", () => {
    const { rerender } = wrap(createElement(AgentTurn, { items: [], answer: "## Heading\nBody text.", answerMode: "folded" }));
    expect(screen.getByTestId("log-answer").querySelector("summary")?.textContent).toBe("Heading");
    // Folded, but in the DOM for ⌘F; the `turn-answer` id belongs to the Result.
    expect(screen.getByTestId("log-answer").textContent).toContain("Body text.");
    expect(screen.queryByTestId("turn-answer")).toBeNull();
    rerender(createElement(I18nProvider, null, createElement(AgentTurn, { items: [], answer: "Body", answerMode: "above" })));
    expect(screen.getByTestId("log-result-above")).toBeTruthy();
    expect(screen.queryByTestId("turn-answer")).toBeNull();
    expect(answerGist("| a | b |\n**Bold** start")).toBe("a | b |");
  });

  it("previews long tables, keeps every row in the DOM, sorts numerically by size", () => {
    const rows = Array.from({ length: 20 }, (_, i) => `| bucket-${String(i).padStart(2, "0")} | ${(i * 7) % 20} GiB |`).join("\n");
    wrap(createElement(Markdown, { text: `| bucket | size |\n| --- | --- |\n${rows}` }));
    const table = screen.getByTestId("table-grid").closest(".agent-table")!;
    expect(table.getAttribute("data-folded")).toBe("true");
    expect(table.querySelectorAll("tbody tr")).toHaveLength(20);
    expect(table.querySelectorAll('tbody tr[data-overflow="true"]')).toHaveLength(20 - TABLE_PREVIEW_ROWS);
    fireEvent.click(screen.getAllByTestId("table-sort")[1]);
    const first = table.querySelector("tbody tr td:nth-child(2)")?.textContent;
    expect(first).toBe("0 GiB");
    fireEvent.click(screen.getByTestId("table-more"));
    expect(table.getAttribute("data-folded")).toBe("false");
    expect(cellNumber("328 GiB")).toBe(328 * 1024 ** 3);
    expect(cellNumber("$1.10")).toBeCloseTo(1.1);
    expect(cellNumber("STANDARD")).toBeNull();
  });

  it("never paints a side panel or follows the end of the document", () => {
    expect(source("../agent/AgentShell.tsx")).not.toContain("ArtifactsPanel");
    expect(source("./TaskDocument.tsx")).not.toContain("followLatest");
    expect(source("./TaskDocument.tsx")).toContain("scrollTo({ top: 0 })");
  });
});
