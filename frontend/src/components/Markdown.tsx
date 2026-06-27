import { Fragment, type ReactNode } from "react";

/**
 * Tiny, dependency-free markdown renderer for agent text. Handles the subset
 * the agent actually emits: paragraphs, fenced + inline code, **bold**, and
 * bullet lists. No raw HTML is ever injected (no dangerouslySetInnerHTML).
 */
export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text || "");
  return (
    <div className="space-y-2 text-[13.5px] leading-relaxed text-gray-200">
      {blocks.map((b, i) => {
        if (b.type === "code") {
          return (
            <pre
              key={i}
              className="overflow-auto rounded-lg border border-edge bg-canvas px-3 py-2 font-mono text-xs text-gray-300"
            >
              {b.content}
            </pre>
          );
        }
        if (b.type === "list") {
          return (
            <ul key={i} className="ml-1 space-y-1">
              {b.items.map((it, j) => (
                <li key={j} className="flex gap-2">
                  <span className="mt-[2px] text-accent-soft">•</span>
                  <span>{inline(it)}</span>
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

type Block =
  | { type: "p"; content: string }
  | { type: "code"; content: string }
  | { type: "list"; items: string[] };

function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: "p", content: para.join(" ").trim() });
      para = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.trimStart().startsWith("```")) {
      flushPara();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ type: "code", content: buf.join("\n") });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push({ type: "list", items });
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return blocks;
}

/** Inline tokens: `code` and **bold**. */
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
        <code key={k++} className="rounded bg-canvas px-1 py-0.5 font-mono text-[12px] text-accent-soft">
          {tok.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(
        <strong key={k++} className="font-semibold text-gray-100">
          {tok.slice(2, -2)}
        </strong>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(<Fragment key={k++}>{text.slice(last)}</Fragment>);
  return nodes;
}
