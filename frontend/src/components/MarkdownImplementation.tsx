import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { openExternal, tauriInvoke } from "../config";
import { useI18n } from "../i18n";
import { highlight, TOK_CLASS } from "../lib/highlight";
import { Chart, chartSpec } from "./Chart";

/** Dependency-free, safe markdown renderer for Agent Work Results and artifacts. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text || ""), [text]);
  const outline = useMemo(() => outlineOf(blocks), [blocks]);
  return (
    <div className="agent-result-prose min-w-0 break-words text-prose text-gray-200">
      {outline.length > 0 && <Outline entries={outline} />}
      <Blocks blocks={blocks} />
    </div>
  );
});

/** Section headings worth offering as an outline, or [] when navigation adds no value. */
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
    <nav aria-label={t("result.outline")} data-testid="result-outline" className="rounded-lg border border-edge bg-panel px-3 py-2">
      <div className="mb-1 text-2xs font-medium uppercase tracking-wider text-gray-500">{t("result.outline")}</div>
      <ul className="space-y-0.5">
        {entries.map((e) => (
          <li key={e.id} className={e.level === 2 ? "pl-3" : ""}>
            <a href={`#${e.id}`} className="text-xs text-gray-500 transition-colors hover:text-accent-soft">{e.text}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.type) {
          case "code":
            return <CodeBlock key={i} lang={b.lang} content={b.content} />;
          case "heading": {
            const cls = HEADING_CLASS[b.level] ?? HEADING_CLASS[6];
            const Tag = `h${Math.min(Math.max(b.level, 1), 6)}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
            return (
              <Tag key={i} id={headingId(b.text)} data-heading-level={b.level} className={`scroll-mt-4 font-semibold text-gray-100 first:mt-0 ${cls}`}>
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
              <blockquote key={i} className="border-l-2 border-edge-strong pl-4 text-prose text-gray-300">
                <div className="space-y-1.5"><Blocks blocks={parseBlocks(b.lines.join("\n"))} /></div>
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

export function headingId(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug ? `sec-${slug}` : "sec";
}

const HEADING_CLASS: Record<number, string> = {
  1: "mt-5 mb-0.5 text-xl leading-tight",
  2: "mt-5 mb-0.5 text-lg leading-snug",
  3: "mt-4 mb-0 text-prose leading-snug",
  4: "mt-4 mb-0 text-sm",
  5: "mt-3 mb-0 text-sm text-gray-300",
  6: "mt-3 mb-0 text-xs uppercase tracking-[0.06em] text-gray-400",
};

function ListBlock({ block }: { block: ListBlockT }) {
  const Tag = block.ordered ? "ol" : "ul";
  return (
    <Tag className="space-y-1" start={block.ordered ? block.start : undefined}>
      {block.items.map((it, j) => (
        <li key={j} className="flex gap-1.5">
          {it.task !== null ? (
            <span
              role="checkbox"
              aria-checked={it.task}
              aria-disabled
              data-testid="task-marker"
              className={`mt-1 flex h-[11px] w-[11px] shrink-0 items-center justify-center rounded-sm border ${it.task ? "border-accent bg-accent/25 text-accent-soft" : "border-edge-strong"}`}
            >
              {it.task && (
                <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" aria-hidden>
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </span>
          ) : (
            <span
              className={`select-none leading-[1.75] ${block.ordered ? "min-w-[1.35rem] shrink-0 text-right font-medium tabular-nums text-gray-400" : "w-[0.7rem] shrink-0 text-center text-gray-400 marker-dot"}`}
              aria-hidden
            >
              {block.ordered ? `${block.start + j}.` : ""}
            </span>
          )}
          <div className="min-w-0 flex-1">
            {inline(it.text)}
            {it.children.length > 0 && <div className="mt-1.5 space-y-2"><Blocks blocks={it.children} /></div>}
          </div>
        </li>
      ))}
    </Tag>
  );
}

function CodeBlock({ lang, content }: { lang: string; content: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const toks = useMemo(() => highlight(content, lang), [content, lang]);
  const copy = () => {
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    };
    const fallback = () => {
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
        /* no remaining clipboard path */
      }
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(content).then(done).catch(fallback);
    else fallback();
  };
  return (
    <div className="agent-result-wide group/code overflow-hidden rounded-lg border border-edge bg-code">
      <div className="flex items-center gap-2 border-b border-edge/70 px-3 py-1.5">
        <span className="font-mono text-2xs uppercase tracking-wide text-gray-500">{lang || "code"}</span>
        <button onClick={copy} className="ml-auto flex items-center gap-1 text-2xs text-gray-500 transition-colors hover:text-gray-200">
          {copied ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
          )}
          {copied ? t("common.copied") : t("common.copy")}
        </button>
      </div>
      <pre data-testid="code-block" data-highlighted={toks ? "true" : "false"} className="overflow-auto px-3.5 py-3 font-mono text-xs leading-relaxed text-gray-300">
        {toks
          ? toks.map((tok, i) => tok.c === "plain" ? <Fragment key={i}>{tok.text}</Fragment> : <span key={i} className={TOK_CLASS[tok.c]}>{tok.text}</span>)
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

export const TALL_TABLE_ROWS = 12;

function TableBlock({ headers, aligns, rows }: { headers: string[]; aligns: (Align | null)[]; rows: string[][] }) {
  const { t } = useI18n();
  const spec = useMemo(() => chartSpec(headers, rows), [headers, rows]);
  const [chartOverride, setChartOverride] = useState<boolean | null>(null);
  const columns = useMemo(() => {
    return headers.map((_, i) => {
      const declared = aligns[i] ?? null;
      const inferred = declared === null ? inferAlign(rows.map((r) => r[i] ?? "")) : null;
      const align = declared ?? inferred ?? "left";
      return { align, numeric: align === "right" };
    });
  }, [headers, aligns, rows]);
  const tall = rows.length > TALL_TABLE_ROWS;
  const showChart = chartOverride ?? !tall;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const el = boxRef.current;
    setMore(!!el && el.scrollHeight - el.scrollTop - el.clientHeight > 1);
  }, []);
  useEffect(measure, [measure, rows.length, tall, showChart]);

  return (
    <div className="agent-result-wide my-1 overflow-hidden">
      {spec && showChart && <Chart spec={spec} />}
      <div
        ref={boxRef}
        onScroll={measure}
        className={`overflow-auto ${tall ? "max-h-[22rem]" : ""} ${tall && more ? "[mask-image:linear-gradient(to_bottom,black_calc(100%-2.5rem),transparent)]" : ""}`}
      >
        <table className="w-max border-collapse text-xs">
          <thead>
            <tr className={`bg-canvas ${tall ? "sticky top-0 z-sticky" : ""}`}>
              {headers.map((h, i) => (
                <th key={i} className={`border-b border-edge-strong px-3 pb-1.5 pt-0.5 text-2xs font-semibold uppercase tracking-[0.08em] text-gray-400 ${ALIGN_CLASS[columns[i]?.align ?? "left"]}`}>
                  {inline(h)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} className="border-b border-edge/50 last:border-0">
                {r.map((c, ci) => (
                  <td key={ci} className={`px-3 py-1 align-top text-gray-300 ${ALIGN_CLASS[columns[ci]?.align ?? "left"]} ${columns[ci]?.numeric ? "whitespace-nowrap tabular-nums" : ""}`}>
                    {inline(c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {spec && (
        <button type="button" onClick={() => setChartOverride(!showChart)} data-testid="chart-toggle" className="mt-1 rounded px-1 py-0.5 text-left text-2xs text-gray-500 transition-colors hover:text-gray-300">
          {showChart ? t("chart.hide") : t("chart.show")}
        </button>
      )}
    </div>
  );
}

type Align = "left" | "center" | "right";
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

const cells = (line: string) => line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
const isHr = (line: string) => /^\s*([-*_])(\s*\1){2,}\s*$/.test(line);

const isTableSep = (line: string) => {
  const t = line.trim();
  if (!t.includes("-") || !t.includes("|")) return false;
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(t);
};

const ITEM_RE = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;
const TASK_RE = /^\[([ xX])\]\s+/;
const indentOf = (line: string) => line.length - line.trimStart().length;
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
          let j = i + 1;
          while (j < lines.length && lines[j].trim() === "") j++;
          const resumes = j < lines.length && (indentOf(lines[j]) > base || (ITEM_RE.test(lines[j]) && indentOf(lines[j]) >= base));
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

function alignOf(cell: string): Align | null {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

const NUMERIC_CELL = /^[+-]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?\s*(%|[KMGTPE]i?B|B|ms|s|m|h|d|bytes?|objects?|reqs?)?$/i;

export function inferAlign(cells: string[]): Align | null {
  const values = cells.map((c) => c.trim()).filter((c) => c !== "");
  if (values.length < 2) return null;
  const numeric = values.filter((c) => NUMERIC_CELL.test(c)).length;
  return numeric / values.length >= 0.8 ? "right" : null;
}

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

function dedent(lines: string[]): string {
  const filled = lines.filter((l) => l.trim() !== "");
  const min = filled.length ? Math.min(...filled.map(indentOf)) : 0;
  return lines.map((l) => (l.trim() === "" ? "" : l.slice(min))).join("\n");
}

const INLINE_RE = /(`[^`]+`)|(\*\*\*[^*]+\*\*\*)|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)]+\))|(<https?:\/\/[^>\s]+>)|(https?:\/\/[^\s<>()[\]]+)/g;
const WORDISH = /[\p{L}\p{N}]/u;
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
      nodes.push(<code key={k++} className="rounded border border-edge/70 bg-elevated px-[0.3em] py-[0.1em] font-mono text-gray-200">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("***")) {
      nodes.push(<em key={k++} className="italic"><strong className="font-semibold text-gray-100">{tok.slice(3, -3)}</strong></em>);
    } else if (tok.startsWith("**")) {
      nodes.push(<strong key={k++} className="font-semibold text-gray-100">{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("~~")) {
      nodes.push(<del key={k++} className="text-gray-500 line-through">{tok.slice(2, -2)}</del>);
    } else if (tok.startsWith("[")) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      if (mm) nodes.push(link(mm[2], mm[1], k++));
      else nodes.push(<Fragment key={k++}>{tok}</Fragment>);
    } else if (/^<?https?:\/\//.test(tok)) {
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
    } else if (tok.startsWith("_") && (WORDISH.test(text[m.index - 1] ?? "") || WORDISH.test(text[m.index + tok.length] ?? ""))) {
      nodes.push(<Fragment key={k++}>{tok}</Fragment>);
    } else {
      nodes.push(<em key={k++} className="italic text-gray-200">{tok.slice(1, -1)}</em>);
    }
    if (trailing) nodes.push(<Fragment key={k++}>{trailing}</Fragment>);
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(<Fragment key={k++}>{text.slice(last)}</Fragment>);
  return nodes;
}

function link(href: string, label: string, key: number): ReactNode {
  if (!/^(https?:|mailto:)/i.test(href)) return <Fragment key={key}>{label}</Fragment>;
  return (
    <a
      key={key}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => {
        void openExternal(href).then((handled) => void handled);
        if (tauriInvoke()) e.preventDefault();
      }}
      className="text-accent-soft underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {label}
    </a>
  );
}
