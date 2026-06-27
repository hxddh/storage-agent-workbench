import { Fragment, useState, type ReactNode } from "react";

/**
 * Dependency-free markdown renderer for agent text. Handles the subset the agent
 * emits: headings, paragraphs, fenced + inline code, **bold**, bullet/numbered
 * lists, and simple pipe tables. No raw HTML is ever injected.
 */
export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text || "");
  return (
    <div className="space-y-2.5 text-[13.5px] leading-relaxed text-gray-200">
      {blocks.map((b, i) => {
        if (b.type === "code") return <CodeBlock key={i} lang={b.lang} content={b.content} />;
        if (b.type === "heading") {
          const Cls = b.level === 1 ? "text-[15px]" : b.level === 2 ? "text-[14px]" : "text-[13px]";
          return <div key={i} className={`mt-1 font-semibold text-gray-100 ${Cls}`}>{inline(b.text)}</div>;
        }
        if (b.type === "table") return <TableBlock key={i} headers={b.headers} rows={b.rows} />;
        if (b.type === "list") {
          return (
            <ul key={i} className="ml-1 space-y-1">
              {b.items.map((it, j) => (
                <li key={j} className="flex gap-2">
                  <span className="mt-[2px] select-none text-accent-soft">{b.ordered ? `${j + 1}.` : "•"}</span>
                  <span className="min-w-0">{inline(it)}</span>
                </li>
              ))}
            </ul>
          );
        }
        return <p key={i}>{inline(b.content)}</p>;
      })}
    </div>
  );
}

function CodeBlock({ lang, content }: { lang: string; content: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <div className="overflow-hidden rounded-lg border border-edge bg-canvas">
      <div className="flex items-center gap-2 border-b border-edge/70 px-3 py-1.5">
        <span className="font-mono text-[10.5px] uppercase tracking-wide text-gray-500">{lang || "code"}</span>
        <button
          onClick={copy}
          className="ml-auto flex items-center gap-1 text-[11px] text-gray-500 transition-colors hover:text-gray-200"
        >
          {copied ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-auto px-3 py-2.5 font-mono text-xs leading-relaxed text-gray-300">{content}</pre>
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
              <th key={i} className="border-b border-edge px-3 py-1.5 text-left font-medium text-gray-300">{inline(h)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b border-edge/50 last:border-0">
              {r.map((c, ci) => <td key={ci} className="px-3 py-1.5 text-gray-300">{inline(c)}</td>)}
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
  | { type: "table"; headers: string[]; rows: string[][] };

const cells = (line: string) =>
  line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());

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
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flush();
      blocks.push({ type: "heading", level: h[1].length, text: h[2] });
      i++;
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
      while (i < lines.length && re.test(lines[i])) {
        items.push(lines[i].replace(re, ""));
        i++;
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

function inline(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(<Fragment key={k++}>{text.slice(last, m.index)}</Fragment>);
    const tok = m[0];
    if (tok.startsWith("`")) {
      nodes.push(
        <code key={k++} className="rounded bg-canvas px-1 py-0.5 font-mono text-[12px] text-accent-soft">{tok.slice(1, -1)}</code>,
      );
    } else {
      nodes.push(<strong key={k++} className="font-semibold text-gray-100">{tok.slice(2, -2)}</strong>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(<Fragment key={k++}>{text.slice(last)}</Fragment>);
  return nodes;
}
