import { useState } from "react";
import type { NextAction, SessionRunLink, TriageCase } from "../types";
import { RunDetail } from "./RunDetail";
import { Button } from "./ui";
import { Markdown } from "./Markdown";

const STATUS_PILL: Record<string, string> = {
  pending: "bg-gray-700/40 text-gray-300",
  running: "bg-amber-500/15 text-amber-300",
  completed: "bg-emerald-500/15 text-emerald-300",
  failed: "bg-red-500/15 text-red-300",
  not_implemented: "bg-gray-700/40 text-gray-400",
};

const CONF_PILL: Record<string, string> = {
  high: "bg-emerald-500/15 text-emerald-300",
  medium: "bg-amber-500/15 text-amber-300",
  low: "bg-gray-700/50 text-gray-300",
};

function Avatar({ kind }: { kind: "agent" | "user" }) {
  if (kind === "user") {
    return (
      <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-elevated text-xs font-medium text-gray-300">
        You
      </div>
    );
  }
  return (
    <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-accent to-emerald-700 text-xs font-bold text-white">
      S
    </div>
  );
}

/** A user or agent message row. */
export function MessageCard({ role, content }: { role: string; content: string | null }) {
  const isUser = role === "user";
  return (
    <div className="flex gap-3 animate-fade-in-up">
      <Avatar kind={isUser ? "user" : "agent"} />
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="mb-1 text-[11px] font-medium text-gray-500">{isUser ? "You" : "Agent"}</div>
        {isUser ? (
          <div className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-gray-200">{content || ""}</div>
        ) : (
          <Markdown text={content || ""} />
        )}
      </div>
    </div>
  );
}

function CardShell({
  icon,
  label,
  children,
  accent = "edge",
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
  accent?: "edge" | "violet";
}) {
  return (
    <div
      className={`animate-fade-in-up overflow-hidden rounded-xl border bg-panel shadow-elev ${
        accent === "violet" ? "border-violet-800/40" : "border-edge"
      }`}
    >
      <div className="flex items-center gap-2 border-b border-edge/70 px-4 py-2">
        <span className="text-gray-500">{icon}</span>
        <span className="text-[11px] font-medium uppercase tracking-wider text-gray-500">{label}</span>
      </div>
      {children}
    </div>
  );
}

const RunIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);
const TriageIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);
const ProposalIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
  </svg>
);

/** A run rendered as an inline, expandable card (embeds the full run transcript). */
export function RunCard({ run }: { run: SessionRunLink }) {
  const [open, setOpen] = useState(false);
  return (
    <CardShell icon={RunIcon} label="Analysis run">
      <div className="flex items-center gap-2.5 px-4 py-2.5">
        <span className="font-mono text-xs text-gray-300">{run.run_type}</span>
        <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${STATUS_PILL[run.status] ?? "bg-gray-700/40 text-gray-300"}`}>
          {run.status}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-gray-500">{run.final_summary || ""}</span>
        <button
          className="shrink-0 rounded-md px-2 py-1 text-xs text-gray-400 transition-colors hover:bg-hover hover:text-gray-200"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Hide" : "Details"}
        </button>
      </div>
      {open && (
        <div className="max-h-[28rem] overflow-auto border-t border-edge animate-fade-in">
          <RunDetail runId={run.run_id} onBack={() => setOpen(false)} />
        </div>
      )}
    </CardShell>
  );
}

/** An error-triage case rendered inline. */
export function TriageCard({ c }: { c: TriageCase }) {
  return (
    <CardShell icon={TriageIcon} label="Error triage">
      <div className="px-4 py-3 text-sm">
        <div className="text-gray-200">{c.summary}</div>
        <ul className="mt-2.5 space-y-1.5">
          {c.candidate_causes.map((cc, i) => (
            <li key={i} className="flex items-start gap-2 text-xs">
              <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${CONF_PILL[cc.confidence ?? "low"] ?? "bg-gray-700/50 text-gray-300"}`}>
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
          <div className="mt-3 rounded-lg border border-violet-800/40 bg-violet-950/20 p-2.5 text-xs leading-relaxed text-gray-300">
            {c.agent_interpretation}
            {c.skills_used?.length ? (
              <div className="mt-1 text-gray-500">Method: {c.skills_used.join(", ")}</div>
            ) : null}
          </div>
        ) : null}
      </div>
    </CardShell>
  );
}

/** A proposed next action: review (preview) then prepare-and-open (handoff). */
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
    <div className="animate-fade-in-up rounded-xl border border-violet-800/40 bg-gradient-to-b from-violet-950/20 to-panel p-3.5 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-2.5">
          <span className="mt-0.5 text-violet-300">{ProposalIcon}</span>
          <div className="min-w-0">
            <div className="font-medium text-gray-100">{proposal.title}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500">
              <span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-gray-400">
                {proposal.action_type}
              </span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${CONF_PILL[proposal.confidence] ?? "bg-gray-700/50 text-gray-300"}`}>
                {proposal.confidence}
              </span>
              {proposal.reason ? <span className="text-gray-500">· {proposal.reason}</span> : null}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => onReview(proposal)}>Review</Button>
          <Button variant="default" size="sm" onClick={() => onPrepare(proposal)}>Prepare</Button>
        </div>
      </div>
      {preview ? (
        <div className="mt-2.5 rounded-lg bg-canvas/60 px-2.5 py-1.5 text-[11px] text-gray-400">{preview}</div>
      ) : null}
    </div>
  );
}
