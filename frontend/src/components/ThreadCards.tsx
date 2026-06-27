import { useState } from "react";
import type { NextAction, SessionRunLink, TriageCase } from "../types";
import { RunDetail } from "./RunDetail";
import { Button } from "./ui";

const STATUS_COLOR: Record<string, string> = {
  pending: "text-gray-400",
  running: "text-amber-400",
  completed: "text-emerald-400",
  failed: "text-red-400",
  not_implemented: "text-gray-500",
};

const CONF_COLOR: Record<string, string> = {
  high: "text-emerald-400",
  medium: "text-amber-400",
  low: "text-gray-400",
};

/** A user or agent message bubble. */
export function MessageCard({ role, content }: { role: string; content: string | null }) {
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-2xl border px-4 py-2.5 text-sm ${
          isUser
            ? "border-emerald-700/40 bg-emerald-600/15 text-gray-100"
            : "border-edge bg-panel text-gray-200"
        }`}
      >
        {!isUser && <div className="mb-1 text-[11px] uppercase tracking-wide text-gray-500">Agent</div>}
        {content || ""}
      </div>
    </div>
  );
}

/** A run rendered as an inline, expandable card (embeds the full run transcript). */
export function RunCard({ run }: { run: SessionRunLink }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-edge bg-panel">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <span className="h-1.5 w-1.5 rounded-full bg-gray-500" />
        <span className="font-mono text-xs text-gray-300">{run.run_type}</span>
        <span className={`text-xs ${STATUS_COLOR[run.status] ?? "text-gray-400"}`}>{run.status}</span>
        <span className="flex-1 truncate text-xs text-gray-500">{run.final_summary || ""}</span>
        <button className="text-xs text-gray-400 hover:text-gray-200" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Details"}
        </button>
      </div>
      {open && (
        <div className="max-h-[28rem] overflow-auto border-t border-edge">
          <RunDetail runId={run.run_id} onBack={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

/** An error-triage case rendered inline. */
export function TriageCard({ c }: { c: TriageCase }) {
  return (
    <div className="rounded-xl border border-edge bg-panel p-4 text-sm">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-gray-500">Error triage</div>
      <div className="text-gray-200">{c.summary}</div>
      <ul className="mt-2 space-y-1">
        {c.candidate_causes.map((cc, i) => (
          <li key={i} className="text-xs">
            <span className={CONF_COLOR[cc.confidence ?? "low"] ?? "text-gray-400"}>[{cc.confidence}]</span>{" "}
            <span className="text-gray-200">{cc.title}</span>
            {cc.next_checks?.length ? (
              <span className="text-gray-500"> — next: {cc.next_checks.slice(0, 3).join("; ")}</span>
            ) : null}
          </li>
        ))}
      </ul>
      {c.agent_interpretation ? (
        <div className="mt-2 rounded border border-violet-900/50 bg-violet-950/20 p-2 text-xs text-gray-300">
          {c.agent_interpretation}
          {c.skills_used?.length ? (
            <div className="mt-1 text-gray-500">Method: {c.skills_used.join(", ")}</div>
          ) : null}
        </div>
      ) : null}
    </div>
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
    <div className="rounded-xl border border-violet-900/40 bg-violet-950/10 p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-gray-200">{proposal.title}</div>
          <div className="text-[11px] text-gray-500">
            {proposal.action_type} · {proposal.confidence}
            {proposal.reason ? ` · ${proposal.reason}` : ""}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button variant="ghost" onClick={() => onReview(proposal)}>Review</Button>
          <Button onClick={() => onPrepare(proposal)}>Prepare</Button>
        </div>
      </div>
      {preview ? <div className="mt-2 text-[11px] text-gray-500">{preview}</div> : null}
    </div>
  );
}
