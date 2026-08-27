import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { openExternal, tauriInvoke } from "../config";
import { useI18n } from "../i18n";
import { highlight, TOK_CLASS } from "../lib/highlight";
import { Chart, chartSpec } from "./Chart";

/**
 * Dependency-free markdown renderer for agent text.
 *
 * Block level: headings (h1–h6), paragraphs, fenced + inline code, blockquotes,
 * horizontal rules, pipe tables (with column alignment), and lists — ordered,
 * unordered, task, and NESTED, including block content inside an item.
 * Inline: **bold**, *italic*, `code`, ~~strike~~, [links](url) and bare URLs.
 *
 * No raw HTML is ever injected: `inline()` emits known elements only, and any
 * `<tag>` in the source stays text. That is a security property, not an
 * omission — agent text quotes S3 error bodies, which are XML.
 *
 * Memoized (component + parse): during a fast stream only the card whose text
 * actually changed re-parses; historical messages skip both parse and render.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text || ""), [text]);
  // A long diagnostic answer is this product's main output, and it had no way
  // to be navigated (v0.57.0). The outline appears only when there is genuinely
  // something to navigate — see outlineOf.
  const outline = useMemo(() => outlineOf(blocks), [blocks]);
  return (
    // `min-w-0` + `break-words`: this product's prose is FULL of tokens that
    // contain no break opportunity — object keys, `arn:aws:s3:::…/very/deep/
    // prefix/name.json.gz`, endpoint URLs, presigned URLs, checksums. Without an
    // explicit `overflow-wrap`, one of them sets the paragraph's minimum content
    // width and drags the whole thread sideways: measured at a 1280px viewport,
    // a single 300-character token pushed the thread's scrollWidth to 2881px in
    // a 1036px column, so every answer had to be read by scrolling right and
    // wide tables were carried off-screen with it.
    //
    // `min-w-0` matters as much as the wrap: a flex/grid child defaults to
    // `min-width: auto`, i.e. "never shrink below my content", which is what
    // lets an unbreakable token win against the column in the first place.
    //
    // This was masked until v0.73.0. `.thread-item` carried
    // `content-visibility: auto`, which implies `contain: paint` — the overflow
    // was being CLIPPED, not fixed, so the text was silently unreachable rather
    // than visibly misplaced. Removing that (on its own measurements) exposed
    // the real defect underneath. Re-adding the containment would only hide it
    // again, and hiding an answer is worse than wrapping it.
    <div className="min-w-0 space-y-3 break-words text-sm leading-[1.7] text-gray-200">
      {outline.length > 0 && <Outline entries={outline} />}
      <Blocks blocks={blocks} />
    </div>
  );
});

/** Section headings worth offering as an outline, or [] when there aren't any.
 *
 * Deliberately conservative: an outline above a three-paragraph answer is
 * clutter, and an outline that lists every h4 sub-point is a second copy of the
 * answer. Top two levels only, and only once there are enough of them that
 * scrolling is actually the problem. */
export function outlineOf(blocks: Block[]): Array<{ id: string; text: string; level: number }> {
  const heads = blocks.filter(
    (b): b is Extract<Block, { type: "heading" }> => b.type === "heading" && b.level <= 2,
  );
  if (heads.length < 3) return [];
  return heads.map((h) => ({ id: headingId(h.text), text: h.text, level: h.level }));
}

function Outline({ entries }: { entries: Array<{ id: string; text: string; level: number }> }) {
  const { t } = useI18n();
  return (
    <nav aria-label={t("answer.outline")} data-testid="answer-outline"
         className="rounded-lg border border-edge bg-panel px-3 py-2">
      <div className="mb-1 text-3xs font-medium uppercase tracking-wider text-gray-700">
        {t("answer.outline")}
      </div>
      <ul className="space-y-0.5">
        {entries.map((e) => (
          <li key={e.id} className={e.level === 2 ? "pl-3" : ""}>
            <a href={`#${e.id}`}
               className="text-xs text-gray-500 transition-colors hover:text-accent-soft">
              {e.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Block renderer, shared by the top level and by nested list content. */
function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.type) {
          case "code":
            return <CodeBlock key={i} lang={b.lang} content={b.content} />;
          case "heading": {
            const cls = HEADING_CLASS[b.level] ?? HEADING_CLASS[6];
            // A REAL heading element with a stable id (v0.57.0). These were
            // `<div>`s: a long diagnostic answer — the thing this product exists
            // to produce — had no document structure at all. A screen reader got
            // one undifferentiated wall of text with no heading level to navigate
            // by, browser "jump to heading" did nothing, and nothing could link
            // to a section. The id is derived from the text so it survives
            // re-renders and can be deep-linked.
            const Tag = `h${Math.min(Math.max(b.level, 1), 6)}` as
              "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
            return (
              <Tag
                key={i}
                id={headingId(b.text)}
                data-heading-level={b.level}
                className={`scroll-mt-4 font-semibold text-gray-100 first:mt-0 ${cls}`}
              >
                {inline(b.text)}
              </Tag>
            );
          }
          case "table":
            return <TableBlock key={i} headers={b.headers} aligns={b.aligns} rows={b.rows} />;
          case "hr":
            return <hr key={i} className="border-0 border-t border-edge" />;
          case "quote":
            return (
              <blockquote
                key={i}
                className="border-l-2 border-accent/40 bg-elevated/40 py-1.5 pl-3.5 pr-3 text-sm text-gray-400"
              >
                {/* Parse the quoted body as blocks rather than as a run of
                    bare paragraphs: a quote can contain a table, a list or a
                    code fence, and rendering each line as a <p> turned a quoted
                    table into literal `| a | b |` text. `Blocks` is already the
                    shared recursive renderer — list items use it the same way. */}
                <div className="space-y-1.5">
                  <Blocks blocks={parseBlocks(b.lines.join("\n"))} />
                </div>
              </blockquote>
            );
          case "list":
            return <ListBlock key={i} block={b} />;
          default:
            return <p key={i}>{inline(b.content)}</p>;
        }
      })}
    </>
  );
}

/** A stable, URL-safe id for a heading, derived from its own text.
 *
 * Derived rather than positional so it survives a re-render and an edit
 * elsewhere in the answer: `#why-is-acme-logs-large` keeps pointing at the same
 * section, which is what makes a deep link worth having. */
export function headingId(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  // A heading of only punctuation would otherwise produce an empty id, which is
  // invalid as a fragment target.
  return slug ? `sec-${slug}` : "sec";
}

/** h5/h6 exist so a deep answer does not print `##### text` at the reader. They
 * share h4's treatment — below h4 the distinction is emphasis, not scale. */
const HEADING_CLASS: Record<number, string> = {
  1: "mt-3 text-lg",
  2: "mt-3 text-base",
  3: "mt-2 text-sm",
  4: "mt-2 text-xs uppercase tracking-wide text-gray-400",
  5: "mt-2 text-xs uppercase tracking-wide text-gray-400",
  6: "mt-2 text-2xs uppercase tracking-wide text-gray-500",
};

function ListBlock({ block }: { block: ListBlockT }) {
  const Tag = block.ordered ? "ol" : "ul";
  return (
    // A real <ol>/<ul>: screen readers announce "list, 4 items" and copying the
    // text out keeps its structure. The visible marker is still drawn by hand so
    // it can be a checkbox for a task item.
    <Tag className={block.ordered ? "space-y-1.5" : "space-y-1"} start={block.ordered ? block.start : undefined}>
      {block.items.map((it, j) => (
        <li key={j} className="flex gap-2.5">
          {it.task !== null ? (
            <span
              role="checkbox"
              aria-checked={it.task}
              aria-disabled
              data-testid="task-marker"
              className={`mt-1 flex h-[11px] w-[11px] shrink-0 items-center justify-center rounded-sm border ${
                it.task ? "border-accent bg-accent/25 text-accent-soft" : "border-edge-strong"
              }`}
            >
              {it.task && (
                <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" aria-hidden>
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </span>
          ) : (
            <span
              className={`select-none ${
                block.ordered
                  ? "min-w-[1.1rem] text-right font-medium text-gray-500"
                  : "mt-2 h-[3px] w-[3px] shrink-0 rounded-full bg-gray-500"
              }`}
              aria-hidden
            >
              {block.ordered ? `${block.start + j}.` : ""}
            </span>
          )}
          <div className="min-w-0 flex-1">
            {inline(it.text)}
            {it.children.length > 0 && (
              <div className="mt-1.5 space-y-2">
                <Blocks blocks={it.children} />
              </div>
            )}
          </div>
        </li>
      ))}
    </Tag>
  );
}

function CodeBlock({ lang, content }: { lang: string; content: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  // Tokenizing is cheap but not free, and a streaming answer re-renders this
  // card on every chunk.
  const toks = useMemo(() => highlight(content, lang), [content, lang]);
  const copy = () => {
    // Hardened like ThreadCards.copyText: never an unhandled rejection, and a
    // temp-textarea fallback for webviews where the async Clipboard API is
    // blocked (code-block copy silently no-op'd there).
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    };
    const legacy = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = content;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        done();
      } catch {
        /* nothing left to try */
      }
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(content).then(done).catch(legacy);
    } else {
      legacy();
    }
  };
  return (
    <div className="group/code overflow-hidden rounded-lg border border-edge bg-code">
      <div className="flex items-center gap-2 border-b border-edge/70 px-3 py-1.5">
        <span className="font-mono text-3xs uppercase tracking-wide text-gray-500">{lang || "code"}</span>
        <button
          onClick={copy}
          className="ml-auto flex items-center gap-1 text-2xs text-gray-500 opacity-0 transition-[color,opacity] hover:text-gray-200 group-hover/code:opacity-100"
        >
          {copied ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
          )}
          {copied ? t("common.copied") : t("common.copy")}
        </button>
      </div>
      <pre
        data-testid="code-block"
        data-highlighted={toks ? "true" : "false"}
        className="overflow-auto px-3.5 py-3 font-mono text-xs leading-relaxed text-gray-300"
      >
        {toks
          ? toks.map((tok, i) =>
              tok.c === "plain" ? (
                <Fragment key={i}>{tok.text}</Fragment>
              ) : (
                <span key={i} className={TOK_CLASS[tok.c]}>
                  {tok.text}
                </span>
              ),
            )
          : content}
      </pre>
    </div>
  );
}

const ALIGN_CLASS: Record<Align, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

/** Rows past which a table scrolls inside itself and pins its header. */
export const TALL_TABLE_ROWS = 12;

function TableBlock({
  headers,
  aligns,
  rows,
}: {
  headers: string[];
  aligns: (Align | null)[];
  rows: string[][];
}) {
  const { t } = useI18n();
  const spec = useMemo(() => chartSpec(headers, rows), [headers, rows]);
  // Shown by default only when it ADDS something. A 24-bar chart stacked above
  // the same 24 rows is the same information twice, and it is what pushes the
  // table it belongs to off the screen. Past the point where the table is long
  // enough to need its own scroll, the chart becomes opt-in.
  //
  // Derived, not stored. A streamed table mounts as soon as its header and
  // separator arrive — two rows, maybe none — and grows on later deltas without
  // remounting, because the block keeps its index. A `useState` initialiser runs
  // once, so the default was decided while the table was still short and a long
  // live answer kept a chart it should not have had until the next reload.
  // What IS state is the user overruling the default, and only that.
  const [chartOverride, setChartOverride] = useState<boolean | null>(null);
  // Per column: the alignment actually used, and whether it holds quantities.
  // A right-aligned column of PROPORTIONAL digits still does not line up — `1`
  // is narrower than `8` in the UI face — so the two go together or neither is
  // worth doing.
  const columns = useMemo(() => {
    return headers.map((_, i) => {
      const declared = aligns[i] ?? null;
      const inferred = declared === null ? inferAlign(rows.map((r) => r[i] ?? "")) : null;
      const align = declared ?? inferred ?? "left";
      return { align, numeric: align === "right" };
    });
  }, [headers, aligns, rows]);
  // Past this many rows a table has lost its own header by the time you reach
  // the bottom of it, at any window height this app is usable in.
  const tall = rows.length > TALL_TABLE_ROWS;
  const showChart = chartOverride ?? !tall;

  // The fade at the foot of a capped table says "there is more below". At the
  // END of the scroll there is not, and a permanent fade would leave the last
  // row permanently dimmed with no way to bring it clear — the one row a reader
  // scrolled all the way down for. So it tracks the scroll instead of being a
  // fixed decoration, and is re-measured when the table grows under a stream.
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const el = boxRef.current;
    setMore(!!el && el.scrollHeight - el.scrollTop - el.clientHeight > 1);
  }, []);
  useEffect(measure, [measure, rows.length, tall, showChart]);

  return (
    <div className="overflow-hidden rounded-lg border border-edge">
      {spec && showChart && <Chart spec={spec} />}
      {/* A long table scrolls INSIDE itself instead of owning three screens of
        * the thread, and its header stays put while it does.
        *
        * Observed on a seeded investigation: 24 rows put the header off-screen
        * well before the last row, leaving a full viewport of bare numbers with
        * no column labels — the reader has to scroll back up to learn which
        * column is bytes and which is object count.
        *
        * The cap is conditional because it is not free: a short table that
        * scrolls internally is worse than one that simply sits in the flow, and
        * a nested scroll region is a real cost to trap a wheel in. Only tables
        * long enough to lose their own header get one. `sticky` needs the
        * scroll container to be this element, which is also why the header can
        * only stick once the cap applies. */}
      {/* A capped table used to end on whatever pixel row 14 happened to reach:
        * a row sliced through the middle with nothing to say why, which reads as
        * a rendering fault rather than as "there is more below". The mask fades
        * the last few pixels out, so a partial row is legibly a partial row. */}
      <div
        ref={boxRef}
        onScroll={measure}
        className={`overflow-auto ${tall ? "max-h-[60vh]" : ""} ${
          tall && more ? "[mask-image:linear-gradient(to_bottom,black_calc(100%-2.5rem),transparent)]" : ""
        }`}
      >
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className={`bg-elevated ${tall ? "sticky top-0 z-sticky" : ""}`}>
              {headers.map((h, i) => (
                <th
                  key={i}
                  // Alignment is information: a right-aligned numeric column is
                  // how a reader compares magnitudes down a column at all.
                  className={`border-b border-edge px-3.5 py-2 text-2xs font-semibold uppercase tracking-wide text-gray-400 ${
                    ALIGN_CLASS[columns[i]?.align ?? "left"]
                  }`}
                >
                  {inline(h)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} className="border-b border-edge/30 last:border-0">
                {r.map((c, ci) => (
                  <td
                    key={ci}
                    className={`px-3.5 py-2 align-top text-gray-300 ${
                      ALIGN_CLASS[columns[ci]?.align ?? "left"]
                    } ${columns[ci]?.numeric ? "tabular-nums" : ""}`}
                  >
                    {inline(c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {spec && (
        <button
          type="button"
          onClick={() => setChartOverride(!showChart)}
          data-testid="chart-toggle"
          className="w-full border-t border-edge px-3.5 py-1.5 text-left text-2xs text-gray-500 transition-colors hover:text-gray-300"
        >
          {showChart ? t("chart.hide") : t("chart.show")}
        </button>
      )}
    </div>
  );
}

type Align = "left" | "center" | "right";
/** `task` is null for an ordinary item, true/false for `- [x]` / `- [ ]`. */
type ListItem = { text: string; task: boolean | null; children: Block[] };
type ListBlockT = { type: "list"; ordered: boolean; start: number; items: ListItem[] };

type Block =
  | { type: "p"; content: string }
  | { type: "heading"; level: number; text: string }
  | { type: "code"; lang: string; content: string }
  | ListBlockT
  | { type: "quote"; lines: string[] }
  | { type: "hr" }
  | { type: "table"; headers: string[]; aligns: (Align | null)[]; rows: string[][] };

const cells = (line: string) =>
  line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());

const isHr = (line: string) => /^\s*([-*_])(\s*\1){2,}\s*$/.test(line);

/** The `| --- | ---: |` row under a table's header.
 *
 * The old test was `/^\s*\|?[\s:|-]+\|[\s:|-]+$/`, which requires a cell on BOTH
 * sides of a pipe and so could never match a ONE-column separator: `| --- |`
 * ends at the closing pipe with nothing after it. A single-column table — the
 * shape an agent produces for "which buckets are public?" — therefore failed to
 * parse, and its rows fell through to paragraph text as literal `| acme-logs |`
 * lines. Written out as a cell sequence instead, so column count is not part of
 * the question. */
const isTableSep = (line: string) => {
  const t = line.trim();
  // `-` rules out `| a | b |`; `|` rules out a plain `---` horizontal rule.
  if (!t.includes("-") || !t.includes("|")) return false;
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(t);
};

/** `1.` / `1)` / `-` / `*` / `+`, with the leading indent captured — the indent
 * is what decides nesting. */
const ITEM_RE = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;
const TASK_RE = /^\[([ xX])\]\s+/;

const indentOf = (line: string) => line.length - line.trimStart().length;

/** Nesting deeper than this is a runaway input, not a document. */
const MAX_DEPTH = 5;

function parseBlocks(text: string, depth = 0): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      blocks.push({ type: "p", content: para.join(" ").trim() });
      para = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.trimStart().startsWith("```")) {
      flush();
      const lang = line.trim().replace(/^```/, "").trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) buf.push(lines[i++]);
      i++;
      blocks.push({ type: "code", lang, content: buf.join("\n") });
      continue;
    }
    if (isHr(line)) {
      flush();
      blocks.push({ type: "hr" });
      i++;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      blocks.push({ type: "heading", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    // blockquote: one or more consecutive "> " lines
    if (/^\s*>\s?/.test(line)) {
      flush();
      const qlines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        qlines.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", lines: qlines });
      continue;
    }
    // table: a pipe row followed by a separator row
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush();
      const headers = cells(line);
      const aligns = cells(lines[i + 1]).map(alignOf);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(cells(lines[i]));
        i++;
      }
      blocks.push({ type: "table", headers, aligns, rows });
      continue;
    }
    if (ITEM_RE.test(line)) {
      flush();
      const region: string[] = [];
      const base = indentOf(line);
      while (i < lines.length) {
        const ln = lines[i];
        if (ln.trim() === "") {
          // A blank line only stays inside the list if the list resumes after
          // it; otherwise it ends the list.
          let j = i + 1;
          while (j < lines.length && lines[j].trim() === "") j++;
          const resumes =
            j < lines.length && (indentOf(lines[j]) > base || (ITEM_RE.test(lines[j]) && indentOf(lines[j]) >= base));
          if (!resumes) break;
          region.push("");
          i++;
          continue;
        }
        if (ITEM_RE.test(ln) && indentOf(ln) >= base) {
          region.push(ln);
          i++;
          continue;
        }
        // An indented non-item line is this item's continuation: a wrapped
        // sentence, a nested code fence, a sub-table.
        if (indentOf(ln) > base) {
          region.push(ln);
          i++;
          continue;
        }
        break;
      }
      blocks.push(buildList(region, base, depth));
      continue;
    }
    if (line.trim() === "") {
      flush();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return blocks;
}

/** The declared alignment of one column, or `null` when the author declared none.
 *
 * `---` and `:---` used to collapse to the same `"left"`, which threw away the
 * only signal that says whether a choice was MADE. It matters because the tables
 * here are written by the agent and by the report generator, and neither has any
 * reason to remember `---:` for a column of byte counts — so "undeclared" is the
 * common case, and it is the case worth inferring from (see `inferAlign`). An
 * explicit `:---` still means left and is left alone. */
function alignOf(cell: string): Align | null {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

/** A number, optionally signed, grouped, fractional, and carrying a unit.
 *
 * Anchored at both ends on purpose: `bucket-003-09` and `2026-08-26` contain
 * digits and must not be read as quantities. */
const NUMERIC_CELL =
  /^[+-]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?\s*(%|[KMGTPE]i?B|B|ms|s|m|h|d|bytes?|objects?|reqs?)?$/i;

/** Right-align a column the author did not align, when it reads as quantities.
 *
 * Alignment is not decoration: a left-aligned column of `1233 / 2877 / 943` has
 * its digits at different x positions on every row, so comparing magnitudes down
 * the column means reading each value instead of seeing the shape. The renderer
 * has always honoured a DECLARED alignment; nothing decided one when the markdown
 * omitted it, which is every table the agent writes.
 *
 * Requires a clear majority rather than unanimity, so one `n/a` or `—` in an
 * otherwise numeric column does not flip it back, and requires at least two
 * values so a single-row table is not "inferred" from one sample. */
export function inferAlign(cells: string[]): Align | null {
  const values = cells.map((c) => c.trim()).filter((c) => c !== "");
  if (values.length < 2) return null;
  const numeric = values.filter((c) => NUMERIC_CELL.test(c)).length;
  return numeric / values.length >= 0.8 ? "right" : null;
}

/**
 * Turn a captured list region into items, recursing into everything indented
 * beneath each marker. Sub-content is dedented and re-parsed as blocks, so a
 * nested list, a fenced snippet and a wrapped paragraph inside an item all work
 * through the same path.
 */
function buildList(region: string[], base: number, depth: number): ListBlockT {
  const first = ITEM_RE.exec(region[0])!;
  const ordered = first[3] !== undefined;
  const start = ordered ? Math.max(parseInt(first[3], 10), 0) : 1;
  const items: ListItem[] = [];
  let text: string | null = null;
  let sub: string[] = [];

  const commit = () => {
    if (text === null) return;
    const tm = TASK_RE.exec(text);
    items.push({
      text: tm ? text.slice(tm[0].length) : text,
      task: tm ? tm[1].toLowerCase() === "x" : null,
      children: sub.length && depth < MAX_DEPTH ? parseBlocks(dedent(sub), depth + 1) : [],
    });
    text = null;
    sub = [];
  };

  for (const ln of region) {
    const m = ITEM_RE.exec(ln);
    if (m && m[1].length <= base) {
      commit();
      text = m[4];
    } else if (text !== null) {
      sub.push(ln);
    }
  }
  commit();
  return { type: "list", ordered, start, items };
}

/** Strip the common leading indent so nested content parses at column zero. */
function dedent(lines: string[]): string {
  const filled = lines.filter((l) => l.trim() !== "");
  const min = filled.length ? Math.min(...filled.map(indentOf)) : 0;
  return lines.map((l) => (l.trim() === "" ? "" : l.slice(min))).join("\n");
}

// Inline spans, matched left-to-right; only known elements are emitted (no raw
// HTML). Order matters: the link form is tried before a bare URL so the URL
// inside `[text](url)` is never linkified twice, and `***` before `**` before
// `*` — without the triple form, `***REDACTED***` (the redaction marker this
// app stamps everywhere) matched `**REDACTED**` one character in and rendered
// with a stray asterisk on each side.
const INLINE_RE =
  /(`[^`]+`)|(\*\*\*[^*]+\*\*\*)|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)]+\))|(<https?:\/\/[^>\s]+>)|(https?:\/\/[^\s<>()[\]]+)/g;

/**
 * A character that makes a `_` INTRAWORD, per CommonMark's flanking rules.
 *
 * CommonMark deliberately forbids `_` emphasis inside a word — precisely so
 * that snake_case survives. This renderer did not implement that, and the
 * consequence was constant, silent corruption of the product's own vocabulary:
 * `total_bytes_scanned` rendered as `totalbytesscanned`, `list_objects_v2` as
 * `listobjectsv2`, `AWS_SECRET_ACCESS_KEY` as `AWSSECRETACCESS_KEY`, and the
 * report's own action types as `runaccountdiscovery`. Column names, object
 * keys, tool names and env-var labels are what this app talks about, so the
 * mangling hit answers, run summaries and the exported report alike.
 */
const WORDISH = /[\p{L}\p{N}]/u;

/** Trailing sentence punctuation is prose, not part of the URL. */
const URL_TAIL = /[.,;:!?]+$/;

function inline(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(<Fragment key={k++}>{text.slice(last, m.index)}</Fragment>);
    let tok = m[0];
    let trailing = "";
    if (tok.startsWith("`")) {
      nodes.push(
        <code key={k++} className="rounded bg-elevated px-1.5 py-0.5 font-mono text-xs text-accent-soft">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("***")) {
      nodes.push(
        <em key={k++} className="italic">
          <strong className="font-semibold text-gray-100">{tok.slice(3, -3)}</strong>
        </em>,
      );
    } else if (tok.startsWith("**")) {
      nodes.push(<strong key={k++} className="font-semibold text-gray-100">{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("~~")) {
      nodes.push(<del key={k++} className="text-gray-500 line-through">{tok.slice(2, -2)}</del>);
    } else if (tok.startsWith("[")) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      if (mm) {
        nodes.push(link(mm[2], mm[1], k++));
      } else {
        nodes.push(<Fragment key={k++}>{tok}</Fragment>);
      }
    } else if (/^<?https?:\/\//.test(tok)) {
      // A bare URL is a link the agent forgot to mark up — endpoints, docs and
      // console URLs are pasted constantly, and an unclickable one is friction.
      const bracketed = tok.startsWith("<");
      let href = bracketed ? tok.slice(1, -1) : tok;
      if (!bracketed) {
        const cut = URL_TAIL.exec(href);
        if (cut) {
          trailing = cut[0];
          href = href.slice(0, -cut[0].length);
        }
      }
      nodes.push(link(href, href, k++));
    } else if (tok.startsWith("_") && (WORDISH.test(text[m.index - 1] ?? "") ||
                                       WORDISH.test(text[m.index + tok.length] ?? ""))) {
      // Intraword `_` is not emphasis: this is the middle of an identifier.
      // Emitted verbatim, so `total_bytes_scanned` stays what it is. Scanning
      // continues after the token, so a genuine `_emphasis_` later on the same
      // line is still found.
      nodes.push(<Fragment key={k++}>{tok}</Fragment>);
    } else {
      // *italic* or _italic_
      nodes.push(<em key={k++} className="italic text-gray-200">{tok.slice(1, -1)}</em>);
    }
    if (trailing) nodes.push(<Fragment key={k++}>{trailing}</Fragment>);
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(<Fragment key={k++}>{text.slice(last)}</Fragment>);
  return nodes;
}

function link(href: string, label: string, key: number): ReactNode {
  // Only http(s)/mailto are ever made clickable — `javascript:` and friends
  // render as plain text.
  if (!/^(https?:|mailto:)/i.test(href)) return <Fragment key={key}>{label}</Fragment>;
  return (
    <a
      key={key}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => {
        // Tauri v2 swallows target="_blank" without the opener plugin — route
        // through the shell's open_external command; in dev/browser
        // openExternal returns false and the anchor works normally.
        void openExternal(href).then((handled) => void handled);
        if (tauriInvoke()) e.preventDefault();
      }}
      className="text-accent-soft underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {label}
    </a>
  );
}
