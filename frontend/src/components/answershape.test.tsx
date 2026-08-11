/**
 * v0.75.0 — the answer kept its shape.
 *
 * Reported from the shipped app: *"输出格式不优雅了…表格没有了，内容很杂乱"* — the
 * output stopped being tidy, a session's tables were gone and the content was a
 * mess.
 *
 * Two separate causes, both measured by rendering a corpus of real agent-answer
 * shapes and asking the DOM what came out. 27 of 32 shapes rendered a table
 * before; 30 do now, and the two that still do not are the two that are not
 * tables at all (a `===` separator, a header row with no pipes).
 *
 * The layout half of the report lives in `e2e/layout.spec.ts` — it needs a real
 * browser, because jsdom has no layout and cannot see an element overflow.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { createElement } from "react";
import { I18nProvider } from "../i18n";
import { Markdown } from "./Markdown";

const md = (text: string) => render(createElement(I18nProvider, null, createElement(Markdown, { text })));

describe("tables an agent actually writes", () => {
  it("renders a SINGLE-column table", () => {
    // "Which buckets are public?" is a one-column answer, and the separator test
    // required a cell on both sides of a pipe — `| --- |` ends at the closing
    // pipe with nothing after it, so it never matched. The rows then fell
    // through to paragraph text as literal `| acme-logs |`.
    const { container } = md("| bucket |\n| --- |\n| acme-logs |\n| acme-data |");
    expect(container.querySelector("table")).toBeTruthy();
    expect(container.querySelectorAll("tbody tr").length).toBe(2);
    expect(container.querySelectorAll("th").length).toBe(1);
    // …and not as literal pipe text.
    expect(container.textContent).not.toContain("| acme-logs |");
  });

  it("renders a table inside a blockquote", () => {
    // A quote's body was rendered as one <p> per line, so a quoted table came
    // out as literal `| a | b |`.
    const { container } = md("> | bucket | public |\n> | --- | --- |\n> | acme-logs | no |");
    expect(container.querySelector("blockquote table")).toBeTruthy();
    expect(container.querySelectorAll("blockquote tbody tr").length).toBe(1);
  });

  it("still renders other blocks inside a blockquote", () => {
    const { container } = md("> - one\n> - two");
    expect(container.querySelectorAll("blockquote li").length).toBe(2);
  });

  it("keeps quoted prose as prose", () => {
    const { container } = md("> just a quoted sentence");
    expect(container.querySelector("blockquote")?.textContent).toContain("just a quoted sentence");
    expect(container.querySelector("blockquote table")).toBeNull();
  });

  it.each([
    ["two columns", "| a | b |\n| --- | --- |\n| 1 | 2 |", 2],
    ["no outer pipes", "a | b\n--- | ---\n1 | 2", 2],
    ["tight separator", "| a | b |\n|---|---|\n| 1 | 2 |", 2],
    ["left/right alignment", "| a | b |\n| :--- | ---: |\n| 1 | 2 |", 2],
    ["centre alignment", "| a | b |\n| :---: | :---: |\n| 1 | 2 |", 2],
    ["three columns", "| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |", 3],
  ])("still renders %s", (_label, text, cols) => {
    const { container } = md(text);
    expect(container.querySelector("table")).toBeTruthy();
    expect(container.querySelectorAll("th").length).toBe(cols);
  });

  it("does not mistake a horizontal rule for a table separator", () => {
    const { container } = md("some text\n\n---\n\nmore text");
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("hr")).toBeTruthy();
  });

  it("does not turn a pipe-free line pair into a table", () => {
    const { container } = md("bucket objects\n--- ---\nacme 1200");
    expect(container.querySelector("table")).toBeNull();
  });

  it("does not accept a separator with no dashes", () => {
    const { container } = md("| a | b |\n| === | === |\n| 1 | 2 |");
    expect(container.querySelector("table")).toBeNull();
  });

  it("does not swallow a following heading into the table", () => {
    const { container } = md("| a | b |\n| --- | --- |\n| 1 | 2 |\n## Next");
    expect(container.querySelector("table")).toBeTruthy();
    expect(container.querySelector("h2")?.textContent).toContain("Next");
  });
});

describe("prose that cannot be broken", () => {
  it("lets an unbreakable token wrap instead of setting the column width", () => {
    // jsdom has no layout, so this pins the CONTRACT that the browser test
    // measures: the prose container must declare a wrap rule. This product's
    // answers are full of object keys, ARNs, endpoint URLs and presigned URLs,
    // none of which contain a break opportunity.
    const { container } = md("The object is at arn:aws:s3:::acme/very/deep/prefix/name.json.gz");
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("break-words");
    expect(root.className).toContain("min-w-0");
  });
});
