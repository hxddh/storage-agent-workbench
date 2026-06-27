import { useEffect, useState } from "react";
import type { NextAction, SessionRunLink, TriageCase } from "../types";
import { RunDetail } from "./RunDetail";
import { Markdown } from "./Markdown";

const RUN_STATUS: Record<string, { cls: string; label: string }> = {
  pending: { cls: "text-gray-400", label: "queued" },
  running: { cls: "text-amber-300", label: "running" },
  completed: { cls: "text-emerald-300", label: "done" },
  failed: { cls: "text-red-300", label: "failed" },
  not_implemented: { cls: "text-gray-500", label: "n/a" },
};

const CONF_PILL: Record<string, string> = {
  high: "bg-accent/15 text-accent-soft",
  medium: "bg-amber-500/12 text-amber-300/90",
  low: "bg-gray-700/40 text-gray-400",
};

const Spark = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2z" />
  </svg>
);

/** A user or agent turn. User = subtle bubble; agent = clean prose with a label. */
export function MessageCard({ role, content }: { role: string; content: string | null }) {
  if (role === "user") {
    return (
      <div className="flex justify-end animate-fade-in-up">
        <div className="max-w-[82%] whitespace-pre-wrap rounded-2xl border border-edge bg-elevated px-3.5 py-2.5 text-[13px] leading-relaxed text-gray-100">
          {content || ""}
        </div>
      </div>
    );
  }
  return (
    <div className="group animate-fade-in-up">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-accent-soft">
        {Spark}
        Storage Agent
        <CopyButton text={content || ""} />
      </div>
      <Markdown text={content || ""} />
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() =>
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        })
      }
      className="ml-1 flex items-center gap-1 rounded px-1 py-0.5 text-[10px] font-normal text-gray-600 opacity-0 transition-opacity hover:text-gray-300 group-hover:opacity-100"
      aria-label="Copy message"
    >
      {copied ? (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
      ) : (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Animated "agent is working" placeholder shown while a reply is in flight. */
export function ThinkingBubble() {
  const labels = ["Thinking…", "Consulting StorageOps skills…", "Grounding in evidence…", "Drafting a response…"];
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => (x + 1) % labels.length), 2200);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="animate-fade-in">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-accent-soft">
        {Spark}
        Storage Agent
      </div>
      <div className="flex items-center gap-2.5 text-[13px] text-gray-500">
        <span className="flex gap-1">
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-500" style={{ animationDelay: "0ms" }} />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-500" style={{ animationDelay: "150ms" }} />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-500" style={{ animationDelay: "300ms" }} />
        </span>
        <span className="animate-pulse">{labels[i]}</span>
      </div>
    </div>
  );
}

/** A run rendered as a collapsible tool-call block (embeds the full transcript). */
export function RunCard({ run }: { run: SessionRunLink }) {
  const [open, setOpen] = useState(false);
  const st = RUN_STATUS[run.status] ?? { cls: "text-gray-400", label: run.status };
  return (
    <div className="animate-fade-in-up overflow-hidden rounded-xl border border-edge bg-panel/60">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-hover/40"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-accent-soft">
          <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.7 2.7-2-2 2.7-2.7z" />
        </svg>
        <span className="font-mono text-[12px] text-gray-300">{run.run_type}</span>
        <span className={`flex items-center gap-1 text-[11px] ${st.cls}`}>
          {run.status === "completed" && (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
          )}
          {st.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-gray-500">{run.final_summary || ""}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`shrink-0 text-gray-600 transition-transform ${open ? "rotate-180" : ""}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="max-h-[28rem] overflow-auto border-t border-edge animate-fade-in">
          <RunDetail runId={run.run_id} onBack={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

/** An error-triage case rendered as a tool-style block. */
export function TriageCard({ c }: { c: TriageCase }) {
  return (
    <div className="animate-fade-in-up overflow-hidden rounded-xl border border-edge bg-panel/60">
      <div className="flex items-center gap-2 border-b border-edge/70 px-3.5 py-2">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-soft">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span className="text-[11px] font-medium uppercase tracking-wider text-gray-500">Error triage</span>
      </div>
      <div className="px-3.5 py-3 text-[13px]">
        <div className="text-gray-200">{c.summary}</div>
        <ul className="mt-2.5 space-y-1.5">
          {c.candidate_causes.map((cc, i) => (
            <li key={i} className="flex items-start gap-2 text-[12px]">
              <span className={`mt-px shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${CONF_PILL[cc.confidence ?? "low"] ?? "bg-gray-700/40 text-gray-400"}`}>
                {cc.confidence}
              </span>
              <span className="min-w-0">
                <span className="text-gray-200">{cc.title}</span>
                {cc.next_checks?.length ? (
                  <span className="text-gray-500"> — next: {cc.next_checks.slice(0, 3).join("; ")}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        {c.agent_interpretation ? (
          <div className="mt-3 rounded-lg border border-edge bg-elevated p-2.5 text-[12px] leading-relaxed text-gray-300">
            {c.agent_interpretation}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A proposed next step rendered as a light action chip (Review previews, Prepare opens). */
export function ProposalCard({
  proposal,
  preview,
  onReview,
  onPrepare,
}: {
  proposal: NextAction;
  preview?: string | null;
  onReview: (p: NextAction) => void;
  onPrepare: (p: NextAction) => void;
}) {
  return (
    <div className="animate-fade-in-up rounded-xl border border-accent/25 bg-accent-dim/40 px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" className="shrink-0 text-accent-soft">
          <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
        <span className="min-w-0 flex-1 truncate text-[13px] text-gray-100">{proposal.title}</span>
        <button
          onClick={() => onReview(proposal)}
          className="shrink-0 rounded-md px-2 py-1 text-[12px] text-gray-400 transition-colors hover:bg-hover hover:text-gray-200"
        >
          Review
        </button>
        <button
          onClick={() => onPrepare(proposal)}
          className="shrink-0 rounded-md bg-accent/15 px-2.5 py-1 text-[12px] font-medium text-accent-soft transition-colors hover:bg-accent/25"
        >
          Prepare
        </button>
      </div>
      {preview ? <div className="mt-2 pl-6 text-[11px] text-gray-500">{preview}</div> : null}
    </div>
  );
}
