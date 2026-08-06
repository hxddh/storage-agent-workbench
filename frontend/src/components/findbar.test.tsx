import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createElement, useState } from "react";
import { I18nProvider } from "../i18n";
import { FindBar } from "./FindBar";
import type { FindHit } from "../threadFind";

const wrap = (ui: React.ReactNode) => render(createElement(I18nProvider, null, ui));

const hits = (counts: number[]): FindHit[] =>
  counts.map((count, i) => ({ id: `m${i}`, count, index: i }));

function bar(overrides: Partial<React.ComponentProps<typeof FindBar>> = {}) {
  const props: React.ComponentProps<typeof FindBar> = {
    query: "acme",
    onQuery: vi.fn(),
    hits: hits([2, 1]),
    index: 0,
    onStep: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  wrap(createElement(FindBar, props));
  return props;
}

describe("the find bar", () => {
  it("takes focus so the user can type immediately", () => {
    bar();
    expect(document.activeElement).toBe(screen.getByTestId("find-input"));
  });

  it("counts every match, not just every matching message", () => {
    // Two messages, three occurrences. Showing "1 / 2" would undercount.
    bar();
    expect(screen.getByTestId("find-status").textContent).toContain("3");
  });

  it("distinguishes 'too short to run' from 'ran and found nothing'", () => {
    // Collapsing these would tell the user their search failed when it never ran.
    bar({ query: "a", hits: [] });
    const short = screen.getByTestId("find-status").textContent ?? "";
    expect(short).not.toMatch(/no match/i);
    expect(short.length).toBeGreaterThan(0);
  });

  it("says so plainly when a real query matches nothing", () => {
    bar({ query: "zzzz", hits: [] });
    expect(screen.getByTestId("find-status").textContent).toMatch(/no match/i);
  });

  it("shows no status at all before anything is typed", () => {
    bar({ query: "", hits: [] });
    expect(screen.getByTestId("find-status").textContent).toBe("");
  });

  it("steps forward on Enter and backward on Shift+Enter", () => {
    const props = bar();
    const input = screen.getByTestId("find-input");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onStep).toHaveBeenCalledWith(1);
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(props.onStep).toHaveBeenCalledWith(-1);
  });

  it("closes on Escape", () => {
    const props = bar();
    fireEvent.keyDown(screen.getByTestId("find-input"), { key: "Escape" });
    expect(props.onClose).toHaveBeenCalled();
  });

  it("disables the step buttons when there is nothing to step through", () => {
    bar({ query: "zzzz", hits: [] });
    expect(screen.getByTestId("find-next")).toBeDisabled();
    expect(screen.getByTestId("find-prev")).toBeDisabled();
  });

  it("reports the query upward as it is typed", () => {
    function Harness() {
      const [q, setQ] = useState("");
      return createElement(FindBar, {
        query: q, onQuery: setQ, hits: [], index: 0,
        onStep: () => {}, onClose: () => {},
      });
    }
    wrap(createElement(Harness));
    const input = screen.getAllByTestId("find-input")[0] as HTMLInputElement;
    fireEvent.change(input, { target: { value: "retention" } });
    expect(input.value).toBe("retention");
  });

  it("announces the counter to assistive tech as it changes", () => {
    bar();
    expect(screen.getByTestId("find-status")).toHaveAttribute("aria-live", "polite");
  });
});
