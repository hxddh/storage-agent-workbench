/**
 * A column of quantities has to line up, or it cannot be read as quantities.
 *
 * The renderer has always honoured a DECLARED column alignment — `---:` — and
 * says so in its own comment: "a right-aligned numeric column is how a reader
 * compares magnitudes down a column at all." What nothing did was decide an
 * alignment when the markdown declared none, and that is every table the product
 * actually produces: the agent writes the answer and the report generator writes
 * the artefact, and neither has a reason to remember `---:` for a column of byte
 * counts.
 *
 * Measured on a seeded investigation at 1440×900, the effect is a 24-row table
 * whose `1233 / 2877 / 943` column starts each value at the same left edge, so
 * the digits that decide the magnitude sit at a different x on every row.
 *
 * Right alignment alone is not enough either: the UI face is proportional, so
 * `1` and `8` have different widths and a right-aligned column still ripples.
 * The two go together, which is why both are asserted here.
 */
import { describe, it, expect } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { createElement } from "react";
import { Markdown } from "./Markdown";
import { inferAlign, TALL_TABLE_ROWS } from "./Markdown";
import { I18nProvider } from "../i18n";

function draw(md: string) {
  return render(createElement(I18nProvider, null, createElement(Markdown, { text: md })));
}

const table = (sep: string, rows: string[]) =>
  ["| bucket | objects | size |", sep, ...rows].join("\n");

const ROWS = [
  "| bucket-003-09 | 1233 | 369 GiB |",
  "| bucket-003-21 | 2877 | 861 GiB |",
  "| bucket-003-23 | 3151 | 943 GiB |",
];

describe("inferAlign", () => {
  it("reads a column of plain integers as quantities", () => {
    expect(inferAlign(["1233", "2877", "3151"])).toBe("right");
  });

  it("reads quantities that carry a unit", () => {
    expect(inferAlign(["369 GiB", "861 GiB", "943 GiB"])).toBe("right");
    expect(inferAlign(["12ms", "9ms", "1103ms"])).toBe("right");
    expect(inferAlign(["99.9%", "100%", "97.5%"])).toBe("right");
  });

  it("does NOT read identifiers or dates as quantities", () => {
    // These contain digits and must stay left — the whole risk of inferring.
    expect(inferAlign(["bucket-003-09", "bucket-003-21", "bucket-003-23"])).toBeNull();
    expect(inferAlign(["2026-08-26", "2026-08-27", "2026-08-28"])).toBeNull();
    expect(inferAlign(["v0.86.0", "v0.85.0", "v0.84.0"])).toBeNull();
  });

  it("tolerates a gap in an otherwise numeric column", () => {
    expect(inferAlign(["1233", "n/a", "3151", "4020", "5100"])).toBe("right");
  });

  it("refuses to infer from a single value", () => {
    // One sample is a coincidence, not a column.
    expect(inferAlign(["1233"])).toBeNull();
    expect(inferAlign(["1233", ""])).toBeNull();
  });
});

describe("a rendered table", () => {
  // Query the cells directly rather than by text: a numeric table also renders a
  // chart above it, so the same value appears more than once on screen.
  const cellsOf = (c: HTMLElement) => Array.from(c.querySelectorAll("tbody tr:first-child td"));
  const headsOf = (c: HTMLElement) => Array.from(c.querySelectorAll("thead th"));

  it("right-aligns and tabularises the quantity columns the author left undeclared", () => {
    const { container } = draw(table("| --- | --- | --- |", ROWS));
    const [, count, size] = cellsOf(container);
    expect(count.className).toContain("text-right");
    expect(count.className).toContain("tabular-nums");
    expect(size.className).toContain("text-right");
    expect(size.className).toContain("tabular-nums");
  });

  it("leaves the identifier column alone", () => {
    const { container } = draw(table("| --- | --- | --- |", ROWS));
    const [key] = cellsOf(container);
    expect(key.className).toContain("text-left");
    expect(key.className).not.toContain("tabular-nums");
  });

  it("aligns the header with its column, so the label sits over the values", () => {
    const { container } = draw(table("| --- | --- | --- |", ROWS));
    const [bucket, , size] = headsOf(container);
    expect(bucket.className).toContain("text-left");
    expect(size.className).toContain("text-right");
  });

  it("still obeys an EXPLICIT alignment over its own inference", () => {
    // `:---` on a numeric column is a choice; inference must not overrule it.
    const { container } = draw(table("| --- | :--- | --- |", ROWS));
    const [, count, size] = cellsOf(container);
    expect(count.className).toContain("text-left");
    expect(count.className).not.toContain("tabular-nums");
    // …and the neighbouring undeclared column is still inferred.
    expect(size.className).toContain("text-right");
  });
});

describe("a long table", () => {
  const rowsOf = (n: number) =>
    Array.from({ length: n }, (_, i) => `| bucket-${i} | ${i * 137} | ${i * 41} GiB |`);
  const scroller = (c: HTMLElement) => c.querySelector("table")?.parentElement as HTMLElement;
  const headRow = (c: HTMLElement) => c.querySelector("thead tr") as HTMLElement;

  it("renders whole in the page flow: no inner scroller, no sticky header", () => {
    // Tables never fold and never slide: a trapped wheel and a hidden row
    // are both worse than a long page, at any row count.
    for (const n of [4, TALL_TABLE_ROWS + 12]) {
      const { container } = draw(table("| --- | --- | --- |", rowsOf(n)));
      expect(container.querySelectorAll("tbody tr")).toHaveLength(n);
      expect(scroller(container).className).not.toContain("max-h-");
      expect(headRow(container).className).not.toContain("sticky");
      cleanup();
    }
  });
});
