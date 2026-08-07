/**
 * v0.50.0 — what an answer is allowed to look like.
 *
 * The renderer is hand-written and dependency-free (no HTML is ever injected),
 * which is the right trade for a desktop app under a strict CSP but means every
 * piece of syntax it supports has to be pinned here. Before this release seven
 * common forms fell through to literal text — `##### heading`, `~~strike~~`,
 * `- [ ] task`, a bare URL, a nested list flattened to one level, a table's
 * `--:` alignment silently discarded, and ordered lists rendered as an
 * unordered list with typed-out numbers.
 *
 * These tests are written against the DOM, not the parser, because the failure
 * mode was always "it parses and then nobody renders it".
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { createElement } from "react";
import { I18nProvider } from "../i18n";
import { Markdown } from "./Markdown";
import { chartSpec, parseMeasure } from "./Chart";
import { highlight, normalizeLang } from "../lib/highlight";

const md = (text: string) => render(createElement(I18nProvider, null, createElement(Markdown, { text })));

describe("markdown blocks", () => {
  it("renders an ordered list as a real <ol> with its own numbering", () => {
    const { container } = md("3. three\n4. four\n5. five");
    const ol = container.querySelector("ol");
    expect(ol).toBeTruthy();
    // A markdown list that starts at 3 means 3 — renumbering from 1 rewrites
    // the author's step numbers.
    expect(ol!.getAttribute("start")).toBe("3");
    expect(ol!.querySelectorAll("li").length).toBe(3);
    expect(container.textContent).toContain("3.three");
  });

  it("nests a sub-list inside its parent item", () => {
    const { container } = md("- outer\n  - inner a\n  - inner b\n- outer 2");
    const top = container.querySelector("ul")!;
    const topItems = [...top.children];
    // Flattening this — the old behaviour — turned a two-level structure into
    // four peers and lost which finding belonged to which bucket.
    expect(topItems.length).toBe(2);
    const nested = within(topItems[0] as HTMLElement).getAllByRole("listitem");
    expect(nested.map((n) => n.textContent)).toEqual(["inner a", "inner b"]);
  });

  it("keeps a fenced block that lives inside a list item", () => {
    const { container } = md("1. run this:\n\n   ```bash\n   aws s3 ls\n   ```\n\n2. then check");
    expect(container.querySelector("ol li pre")).toBeTruthy();
    expect(container.querySelectorAll("ol > li").length).toBe(2);
  });

  it("renders task list markers as checkboxes, not literal brackets", () => {
    const { container } = md("- [ ] not done\n- [x] done");
    const boxes = screen.getAllByTestId("task-marker");
    expect(boxes.map((b) => b.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    expect(container.textContent).not.toContain("[ ]");
    expect(container.textContent).not.toContain("[x]");
  });

  it("honours table column alignment", () => {
    const { container } = md("| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |");
    const th = [...container.querySelectorAll("th")].map((e) => e.className);
    expect(th[0]).toContain("text-left");
    expect(th[1]).toContain("text-center");
    // The whole point of `--:`: a numeric column that a reader can compare down.
    expect(th[2]).toContain("text-right");
    const td = [...container.querySelectorAll("td")].map((e) => e.className);
    expect(td[2]).toContain("text-right");
  });

  it("renders h5 and h6 instead of printing their hashes", () => {
    const { container } = md("##### five\n\n###### six");
    expect(container.textContent).toBe("fivesix");
  });

  it("still escapes HTML rather than injecting it", () => {
    const { container } = md("<script>alert(1)</script>");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });
});

describe("markdown inline", () => {
  it("strikes through ~~text~~", () => {
    const { container } = md("~~gone~~ kept");
    expect(container.querySelector("del")?.textContent).toBe("gone");
    expect(container.textContent).toContain("kept");
  });

  it("linkifies a bare URL without swallowing the sentence's punctuation", () => {
    const { container } = md("see https://example.com/x, then stop.");
    const a = container.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://example.com/x");
    expect(container.textContent).toContain(", then stop.");
  });

  it("does not linkify twice inside a markdown link", () => {
    const { container } = md("[docs](https://example.com/d)");
    const links = container.querySelectorAll("a");
    expect(links.length).toBe(1);
    expect(links[0].textContent).toBe("docs");
  });

  it("leaves a URL inside inline code alone", () => {
    const { container } = md("`https://example.com`");
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("code")).toBeTruthy();
  });

  it("refuses to make a javascript: URL clickable", () => {
    const { container } = md("[click](javascript:alert(1))");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("click");
  });
});

describe("syntax highlighting", () => {
  it("colours a bucket policy's keys, strings and literals", () => {
    const { container } = md('```json\n{"Effect": "Allow", "n": 3, "ok": true}\n```');
    const pre = container.querySelector("pre")!;
    expect(pre.getAttribute("data-highlighted")).toBe("true");
    const cls = (sel: string) => [...pre.querySelectorAll(sel)].map((e) => e.textContent);
    expect(cls(".text-syn-name")).toContain('"Effect"');
    expect(cls(".text-syn-str")).toContain('"Allow"');
    expect(cls(".text-syn-num")).toContain("3");
    expect(cls(".text-syn-kw")).toContain("true");
  });

  it("never loses or reorders a character", () => {
    const src = '{"a": [1, 2], "b": null}\n';
    const toks = highlight(src, "json")!;
    // The tokenizer walks the source; a rule that matched ahead of the cursor
    // would silently drop the text in between.
    expect(toks.map((t) => t.text).join("")).toBe(src);
  });

  it("finds the command in a shell line, whatever it is", () => {
    const toks = highlight("aws s3api head-bucket --bucket $B\ncurl -I https://x", "bash")!;
    const names = toks.filter((t) => t.c === "name").map((t) => t.text);
    // `aws` and `curl` are not in any keyword list — they are found by position,
    // which is the only honest way to do it.
    expect(names).toContain("aws");
    expect(names).toContain("curl");
    expect(toks.filter((t) => t.c === "tag").map((t) => t.text)).toContain("$B");
    expect(toks.filter((t) => t.c === "num").map((t) => t.text)).toContain("--bucket");
  });

  it("marks up an S3 error body", () => {
    const toks = highlight('<Error><Code>AccessDenied</Code></Error>', "xml")!;
    expect(toks.filter((t) => t.c === "tag").map((t) => t.text)).toContain("<Code");
    expect(toks.map((t) => t.text).join("")).toContain("AccessDenied");
  });

  it("keeps SQL keywords case-insensitive and comments whole", () => {
    const toks = highlight("-- note\nselect COUNT(*) from t where x = 1", "sql")!;
    expect(toks.filter((t) => t.c === "com").map((t) => t.text)).toEqual(["-- note"]);
    const kw = toks.filter((t) => t.c === "kw").map((t) => t.text.toLowerCase());
    expect(kw).toContain("select");
    expect(kw).toContain("where");
  });

  it("leaves an unknown language, and an enormous block, as plain text", () => {
    expect(highlight("x = 1", "brainfuck")).toBeNull();
    expect(normalizeLang("SH")).toBe("bash");
    expect(highlight("{}".repeat(20_000), "json")).toBeNull();
  });
});

describe("charts derived from a table", () => {
  it("draws bars for a measure-by-category table and keeps the numbers", () => {
    const { container } = md(
      "| prefix | objects |\n| --- | ---: |\n| logs/ | 900 |\n| data/ | 120 |\n| tmp/ | 15 |",
    );
    expect(screen.getByTestId("table-chart").getAttribute("data-chart-kind")).toBe("bar");
    expect(screen.getAllByTestId("chart-bar").length).toBe(3);
    // The table is never replaced: a bar shows ratio, not value.
    expect(container.querySelectorAll("tbody tr").length).toBe(3);
    expect(container.textContent).toContain("120");
  });

  it("scales bars against the largest value", () => {
    md("| p | n |\n| --- | --- |\n| a | 100 |\n| b | 50 |");
    const widths = screen.getAllByTestId("chart-bar").map((b) => (b as HTMLElement).style.width);
    expect(widths[0]).toBe("100%");
    expect(widths[1]).toBe("50%");
  });

  it("switches to a column chart when the categories are a time series", () => {
    md(
      "| hour | errors |\n| --- | --- |\n| 00:00 | 3 |\n| 01:00 | 9 |\n| 02:00 | 4 |\n| 03:00 | 7 |",
    );
    expect(screen.getByTestId("table-chart").getAttribute("data-chart-kind")).toBe("column");
  });

  it("can be dismissed without taking the table with it", () => {
    const { container } = md("| p | n |\n| --- | --- |\n| a | 2 |\n| b | 1 |");
    fireEvent.click(screen.getByTestId("chart-toggle"));
    expect(screen.queryByTestId("table-chart")).toBeNull();
    expect(container.querySelectorAll("tbody tr").length).toBe(2);
  });

  it("draws nothing for a table that is not a measure", () => {
    // A status matrix. Bars over "Enabled"/"Not set" would be meaningless.
    md("| bucket | versioning |\n| --- | --- |\n| a | Enabled |\n| b | Not set |");
    expect(screen.queryByTestId("table-chart")).toBeNull();
  });

  it("refuses a column with one unmeasurable cell", () => {
    // `Provider unsupported` is a first-class result in this product; charting
    // the rest of the column would quietly drop it.
    expect(
      chartSpec(["bucket", "objects"], [["a", "10"], ["b", "Provider unsupported"], ["c", "4"]]),
    ).toBeNull();
  });

  it("refuses negative measures and all-zero columns", () => {
    expect(chartSpec(["k", "v"], [["a", "-1"], ["b", "2"]])).toBeNull();
    expect(chartSpec(["k", "v"], [["a", "0"], ["b", "0"]])).toBeNull();
  });

  it("reads comma-grouped numbers and percentages, but not units", () => {
    expect(parseMeasure("1,204")).toBe(1204);
    expect(parseMeasure("12.5%")).toBe(12.5);
    // "4 GB" next to "900 MB" would draw bars that lie about the ratio.
    expect(parseMeasure("4 GB")).toBeNull();
  });

  it("stops charting once a table is a data dump", () => {
    const rows = Array.from({ length: 60 }, (_, i) => [`k${i}`, String(i + 1)]);
    expect(chartSpec(["key", "n"], rows)).toBeNull();
  });
});

/**
 * v0.57.0 — the answer got a document structure.
 *
 * Headings rendered as `<div>`, so a long diagnostic report — this product's
 * main output — had no heading levels for a screen reader, no anchors to link
 * to, and nothing for a browser's "jump to heading" to find.
 */
describe("answer structure", () => {
  it("renders real heading elements, not divs", () => {
    const { container } = md("## Why it is large\n\ntext");
    const h2 = container.querySelector("h2");
    expect(h2).toBeTruthy();
    expect(h2?.textContent).toBe("Why it is large");
  });

  it("gives each heading a stable id derived from its text", () => {
    const { container } = md("## Why it is large");
    // Derived, not positional: editing elsewhere in the answer must not move
    // where an existing deep link points.
    expect(container.querySelector("h2")?.id).toBe("sec-why-it-is-large");
  });

  it("keeps ids valid for a heading of only punctuation", () => {
    const { container } = md("## ---");
    expect(container.querySelector("h2")?.id).toBe("sec");
  });

  it("offers an outline once an answer has enough sections to navigate", () => {
    const text = "## Cause\n\na\n\n## Evidence\n\nb\n\n## Fix\n\nc";
    md(text);
    const nav = screen.getByTestId("answer-outline");
    expect(nav.textContent).toContain("Cause");
    expect(nav.querySelectorAll("a").length).toBe(3);
    expect(nav.querySelector("a")?.getAttribute("href")).toBe("#sec-cause");
  });

  it("does not clutter a short answer with an outline", () => {
    md("## Only one\n\ntext");
    // An outline above three paragraphs is noise, not navigation.
    expect(screen.queryByTestId("answer-outline")).toBeNull();
  });

  it("does not list every sub-heading in the outline", () => {
    const text = "## A\n\n### a1\n\n### a2\n\n## B\n\n### b1\n\n## C";
    md(text);
    // Listing h3s would make the outline a second copy of the answer.
    expect(screen.getByTestId("answer-outline").querySelectorAll("a").length).toBe(3);
  });
});

/**
 * v0.67.0 — snake_case is this product's vocabulary, and the renderer ate it.
 *
 * CommonMark forbids `_` emphasis inside a word precisely so that identifiers
 * survive. This renderer matched `_..._` anywhere, so every answer, run summary
 * and exported report silently dropped the underscores out of the very names
 * the app exists to talk about: column names, tool names, object keys, env vars.
 *
 * Found by reading a generated report, where "Run account discovery
 * (run_account_discovery)" had rendered as "(runaccountdiscovery)" — a name the
 * reader cannot search for, copy, or type back.
 */
describe("identifiers survive the renderer", () => {
  const survives = (src: string, needle: string) => {
    const { container } = md(src);
    expect(container.textContent).toContain(needle);
  };

  it("keeps a column name whole", () => {
    survives("Group by storage_class and total_bytes.", "storage_class");
  });

  it("keeps a name with three underscores whole", () => {
    survives("The column is total_bytes_scanned.", "total_bytes_scanned");
  });

  it("keeps a tool name whole", () => {
    survives("The agent called list_objects_v2 on that prefix.", "list_objects_v2");
  });

  it("keeps an object key whole", () => {
    survives("why is logs/2026/part_0001_final.parquet missing?", "part_0001_final.parquet");
  });

  it("keeps an env-var label whole", () => {
    survives("Set AWS_SECRET_ACCESS_KEY in the environment.", "AWS_SECRET_ACCESS_KEY");
  });

  it("still renders real emphasis around a word", () => {
    const { container } = md("this is _emphasised_ text");
    expect(container.querySelector("em")?.textContent).toBe("emphasised");
  });

  it("still renders emphasis that follows an identifier on the same line", () => {
    // The rejected span must not stop the scan: a genuine emphasis later on the
    // line is still found.
    const { container } = md("total_bytes_scanned is _high_ today");
    expect(container.textContent).toContain("total_bytes_scanned");
    expect(container.querySelector("em")?.textContent).toBe("high");
  });

  it("renders the redaction marker without stray asterisks", () => {
    // `***REDACTED***` is stamped by the redactor into messages, audit rows and
    // the report. It matched `**REDACTED**` one character in, so the marker the
    // reader is meant to trust rendered as `*REDACTED*`.
    const { container } = md("X-Amz-Signature=***REDACTED***&x=1");
    expect(container.textContent).toBe("X-Amz-Signature=REDACTED&x=1");
    expect(container.querySelector("strong")?.textContent).toBe("REDACTED");
  });
});
