import { Fragment, memo, useMemo, useState, type ReactNode } from "react";
import { openExternal, tauriInvoke } from "../config";
import { useI18n } from "../i18n";

/**
 * Dependency-free markdown renderer for agent text. Handles the subset the agent
 * emits: headings (h1–h4), paragraphs, fenced + inline code, **bold**, *italic*,
 * [links](url), bullet/numbered lists, blockquotes, horizontal rules, and pipe
 * tables. No raw HTML is ever injected (inline() only emits known elements).
 *
 * Memoized (component + parse): during a fast stream only the card whose text
 * actually changed re-parses; historical messages skip both parse and render.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text || ""), [text]);
  return (
    <div className="space-y-3 text-[13.5px] leading-[1.7] text-gray-200">
      {blocks.map((b, i) => {
        switch (b.type) {
          case "code":
            return <CodeBlock key={i} lang={b.lang} content={b.content} />;
          case "heading": {
            const cls =
              b.level === 1
                ? "mt-3 text-[16px]"
                : b.level === 2
                  ? "mt-3 text-[14.5px]"
                  : b.level === 3
                    ? "mt-2 text-[13.5px]"
                    : "mt-2 text-[12.5px] uppercase tracking-wide text-gray-400";
            return (
              <div key={i} className={`font-semibold text-gray-100 first:mt-0 ${cls}`}>
                {inline(b.text)}
              </div>
            );
          }
          case "table":
            return <TableBlock key={i} headers={b.headers} rows={b.rows} />;
          case "hr":
            return <hr key={i} className="border-0 border-t border-edge" />;
          case "quote":
            return (
              <blockquote
                key={i}
                className="border-l-2 border-accent/40 bg-elevated/40 py-1.5 pl-3.5 pr-3 text-[13px] text-gray-400"
              >
                <div className="space-y-1.5">
                  {b.lines.map((ln, j) => (
                    <p key={j}>{inline(ln)}</p>
                  ))}
                </div>
              </blockquote>
            );
          case "list":
            return (
              <ul key={i} className={b.ordered ? "space-y-1.5" : "space-y-1"}>
                {b.items.map((it, j) => (
                  <li key={j} className="flex gap-2.5">
                    <span
                      className={`select-none ${
                        b.ordered
                          ? "min-w-[1.1rem] text-right font-medium text-gray-500"
                          : "mt-[9px] h-[3px] w-[3px] shrink-0 rounded-full bg-gray-500"
                      }`}
                    >
                      {b.ordered ? `${j + 1}.` : ""}
                    </span>
                    <span className="min-w-0 flex-1">{inline(it)}</span>
                  </li>
                ))}
              </ul>
            );
          default:
            return <p key={i}>{inline(b.content)}</p>;
        }
      })}
    </div>
  );
});

function CodeBlock({ lang, content }: { lang: string; content: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
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
    <div className="group/code overflow-hidden rounded-lg border border-edge bg-[#0a0a0c]">
      <div className="flex items-center gap-2 border-b border-edge/70 px-3 py-1.5">
        <span className="font-mono text-[10.5px] uppercase tracking-wide text-gray-500">{lang || "code"}</span>
        <button
          onClick={copy}
          className="ml-auto flex items-center gap-1 text-[11px] text-gray-500 opacity-0 transition-all hover:text-gray-200 group-hover/code:opacity-100"
        >
          {copied ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
          )}
          {copied ? t("common.copied") : t("common.copy")}
        </button>
      </div>
      <pre className="overflow-auto px-3.5 py-3 font-mono text-[12px] leading-relaxed text-gray-300">{content}</pre>
    </div>
  );
}

function TableBlock({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="overflow-auto rounded-lg border border-edge">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="bg-elevated">
            {headers.map((h, i) => (
              <th
                key={i}
                className="border-b border-edge px-3.5 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400"
              >
                {inline(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b border-edge/40 last:border-0 odd:bg-white/[0.015]">
              {r.map((c, ci) => (
                <td key={ci} className="px-3.5 py-2 align-top text-gray-300">
                  {inline(c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Block =
  | { type: "p"; content: string }
  | { type: "heading"; level: number; text: string }
  | { type: "code"; lang: string; content: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; lines: string[] }
  | { type: "hr" }
  | { type: "table"; headers: string[]; rows: string[][] };

const cells = (line: string) =>
  line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());

const isHr = (line: string) => /^\s*([-*_])(\s*\1){2,}\s*$/.test(line);

function parseBlocks(text: string): Block[] {
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
    const h = line.match(/^(#{1,4})\s+(.*)$/);
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
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]+$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      flush();
      const headers = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(cells(lines[i]));
        i++;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }
    const ordered = /^\s*\d+\.\s+/.test(line);
    if (ordered || /^\s*[-*]\s+/.test(line)) {
      flush();
      const items: string[] = [];
      const re = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
      while (i < lines.length) {
        if (re.test(lines[i])) {
          items.push(lines[i].replace(re, ""));
          i++;
        } else if (lines[i].trim() === "" && i + 1 < lines.length && re.test(lines[i + 1])) {
          // tolerate a single blank line between loose list items
          i++;
        } else {
          break;
        }
      }
      blocks.push({ type: "list", ordered, items });
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

// Inline spans: `code`, **bold**, *italic* / _italic_, and [text](url). Tokens
// are matched left-to-right; only known elements are emitted (no raw HTML).
const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)]+\))/g;

function inline(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(<Fragment key={k++}>{text.slice(last, m.index)}</Fragment>);
    const tok = m[0];
    if (tok.startsWith("`")) {
      nodes.push(
        <code key={k++} className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[12px] text-accent-soft">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("**")) {
      nodes.push(<strong key={k++} className="font-semibold text-gray-100">{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("[")) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      if (mm) {
        const href = mm[2];
        const safe = /^(https?:|mailto:)/i.test(href);
        nodes.push(
          safe ? (
            <a
              key={k++}
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(e) => {
                // Tauri v2 swallows target="_blank" without the opener plugin —
                // route through the shell's open_external command; in dev/browser
                // openExternal returns false and the anchor works normally.
                void openExternal(href).then((handled) => void handled);
                if (tauriInvoke()) e.preventDefault();
              }}
              className="text-accent-soft underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
            >
              {mm[1]}
            </a>
          ) : (
            <Fragment key={k++}>{mm[1]}</Fragment>
          ),
        );
      } else {
        nodes.push(<Fragment key={k++}>{tok}</Fragment>);
      }
    } else {
      // *italic* or _italic_
      nodes.push(<em key={k++} className="italic text-gray-200">{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(<Fragment key={k++}>{text.slice(last)}</Fragment>);
  return nodes;
}
