import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { createElement, createRef } from "react";
import { afterEach } from "vitest";
import { I18nProvider } from "../i18n";
import { meetsMinQuery, minQueryFor } from "../taskFind";
import { formatUsageLine, contextReading, fmtTokensUnified, isUsageFloor } from "../lib/usage";
import { Markdown } from "./Markdown";
import { Composer } from "./Composer";
import { ActiveTaskContext } from "../agent/activeTask";
import { pickStartGreeting, pickStartHint, START_GREETINGS } from "../agent/startGreeting";
import type { TFunc } from "../i18n";

afterEach(cleanup);

// Fake `t` with the same templates as the en dict for the keys under test.
const t = ((key: string, vars?: Record<string, string | number>) => {
  const v = (k: string) => (vars?.[k] ?? `{${k}}`);
  switch (key) {
    case "usage.in": return `${v("n")} in`;
    case "usage.out": return `${v("n")} out`;
    case "usage.total": return `${v("n")} total`;
    case "usage.cachedOf": return `incl. ${v("n")} cached`;
    case "usage.reasoning": return `${v("n")} reasoning`;
    case "usage.requests": return `${v("n")} calls`;
    case "usage.floor": return `~${v("text")} (floor)`;
    case "find.placeholder": return "Find in this task…";
    case "task.find": return "Find in this task";
    default: return key;
  }
}) as TFunc;
const draw = (node: React.ReactElement) => render(<I18nProvider>{node}</I18nProvider>);

describe("v1.15 search truth", () => {
  it("treats one CJK char as searchable, one Latin char as noise", () => {
    expect(minQueryFor("桶")).toBe(1);
    expect(minQueryFor("a")).toBe(2);
    expect(meetsMinQuery("桶")).toBe(true);
    expect(meetsMinQuery("a")).toBe(false);
    expect(meetsMinQuery("  ")).toBe(false);
  });

  it("paints a visible find entry on the document", () => {
    // The entry point is asserted structurally in architecture.test.ts
    // (titlebar-find + task-find-open); here the FindBar dictionary moved.
    expect(t("find.placeholder")).toBe("Find in this task…");
    expect(t("task.find")).toBe("Find in this task");
  });
});

describe("v1.15 usage truth", () => {
  it("formats with one formatter everywhere", () => {
    expect(fmtTokensUnified(12_400)).toBe("12k");
    expect(fmtTokensUnified(900)).toBe("900");
    expect(fmtTokensUnified(null)).toBe("—");
  });

  it("renders cached as a subset, never an additive sibling", () => {
    const line = formatUsageLine({ input_tokens: 10_000, output_tokens: 2_000, total_tokens: 12_000, cached_input_tokens: 9_000, requests: 3 }, t);
    expect(line).toContain("incl. 9k cached");
    expect(line).toContain("12k total");
    expect(line).toContain("3 calls");
  });

  it("marks a partial report as a floor with ~", () => {
    const usage = { input_tokens: 10_000, output_tokens: 1_000, requests: 4, reported_requests: 2 };
    expect(isUsageFloor(usage)).toBe(true);
    expect(formatUsageLine(usage, t)).toMatch(/^~/);
  });

  it("stays silent (not zero) when the endpoint reported nothing", () => {
    expect(formatUsageLine({ requests: 2, input_tokens: null, output_tokens: null, total_tokens: null }, t)).toBeNull();
  });

  it("names silence on the meter instead of vanishing", () => {
    expect(contextReading({ total_tokens: 12_000, context_window: null })).toEqual({ kind: "unreported" });
    expect(contextReading(null)).toEqual({ kind: "none" });
    const measured = contextReading({ usage: { total_tokens: 32_000 }, context_window: 128_000 });
    expect(measured).toMatchObject({ kind: "measured", pct: 25 });
  });

  it("marks post-compaction figures as estimates", () => {
    const reading = contextReading({ usage: { total_tokens: 96_000 }, context_window: 128_000 }, 9_000);
    expect(reading).toMatchObject({ kind: "measured", used: 9_000, estimated: true });
  });
});

describe("v1.15 tables fit first", () => {
  it("fits a narrow table with no scroll hint and paginates a long one", () => {
    draw(<Markdown text={"| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |"} />);
    expect(screen.getByTestId("table-size").textContent).toMatch(/2 rows/);
    expect(screen.queryByTestId("table-scroll-hint")).toBeNull();
    expect(screen.queryByTestId("table-expand")).toBeNull();
    cleanup();
    const rows = Array.from({ length: 35 }, (_, i) => `| ${i} | x |`).join("\n");
    draw(<Markdown text={`| a | b |\n|---|---|\n${rows}`} />);
    expect(screen.getByTestId("table-page").textContent).toMatch(/30/);
    fireEvent.click(screen.getByTestId("table-expand"));
    expect(screen.getByTestId("table-expand").getAttribute("data-expanded")).toBe("true");
  });

  it("hints before cutting a genuinely wide table", () => {
    const long = "x".repeat(80);
    draw(<Markdown text={`| a | b | c | d | e |\n|---|---|---|---|---|\n| ${long} | 2 | 3 | 4 | 5 |`} />);
    expect(screen.getByTestId("table-scroll-hint")).toBeTruthy();
  });
});

describe("v1.15 empty start and composer", () => {
  it("is one static greeting line, no hint", () => {
    expect(START_GREETINGS.en).toEqual(["What should the Agent work on?"]);
    expect(pickStartGreeting("en")).toBe("What should the Agent work on?");
    expect(pickStartHint("en")).toBe("");
  });

  it("delegates in work language, never chat language", () => {
    render(
      createElement(
        I18nProvider,
        null,
        createElement(
          ActiveTaskContext.Provider,
          { value: null },
          createElement(Composer, {
            text: "",
            setText: () => {},
            attached: null,
            onClearAttachment: () => {},
            onPickFile: () => {},
            onOpenFilePicker: () => {},
            fileRef: createRef<HTMLInputElement>(),
            taRef: createRef<HTMLTextAreaElement>(),
            busy: false,
            offline: false,
            uploading: false,
            onSend: () => {},
            onStop: () => {},
            onSteer: () => {},
          }),
        ),
      ),
    );
    const box = within(screen.getByTestId("agent-composer")).getByRole("textbox") as HTMLTextAreaElement;
    expect(box.placeholder).toBe("Describe the storage work to delegate…");
    expect(box.placeholder).not.toContain("Ask about");
  });
});
