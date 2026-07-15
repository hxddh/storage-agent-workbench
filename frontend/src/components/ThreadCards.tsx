import { memo, useEffect, useState } from "react";
import type { Grounding, NextAction, SessionFinding, SessionRunLink, ToolActivity, TriageCase } from "../types";
import { RunDetail } from "./RunDetail";
import { Markdown } from "./Markdown";
import { useI18n } from "../i18n";

const RUN_STATUS: Record<string, { cls: string; key: string }> = {
  pending: { cls: "text-gray-400", key: "run.queued" },
  running: { cls: "text-amber-300", key: "run.running" },
  completed: { cls: "text-emerald-300", key: "run.done" },
  failed: { cls: "text-red-300", key: "run.failed" },
  not_implemented: { cls: "text-gray-500", key: "run.na" },
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

/** A user or agent turn. User = subtle bubble; agent = clean prose with a label.
 * Memoized: historical messages have stable props, so re-renders during a fast
 * stream skip everything except the actively-streaming card (UX1). */
export const MessageCard = memo(function MessageCard({
  role,
  content,
  toolActivity,
  streaming,
}: {
  role: string;
  content: string | null;
  toolActivity?: ToolActivity[];
  streaming?: boolean;
}) {
  const { t } = useI18n();
  if (role === "user") {
    return (
      <div className="flex justify-end animate-fade-in-up">
        <div className="max-w-[82%] whitespace-pre-wrap rounded-2xl border border-edge bg-elevated px-3.5 py-2.5 text-[13px] leading-relaxed text-gray-100">
          {content || ""}
        </div>
      </div>
    );
  }
  // While streaming, the raw deltas may include the trailing metadata JSON block
  // (the backend strips it for the persisted message); hide it from the live view.
  const shown = streaming ? stripMetaBlock(content || "") : content || "";
  return (
    <div className="group animate-fade-in-up">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-accent-soft">
        {Spark}
        {t("card.agentName")}
        {!streaming && <CopyButton text={content || ""} />}
      </div>
      {toolActivity && toolActivity.length > 0 && <ToolActivityList items={toolActivity} />}
      <Markdown text={shown} />
      {streaming &&
        (shown.trim() ? (
          // Mid-answer: a blinking caret after the streamed text.
          <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-pulse bg-accent-soft align-middle" />
        ) : (
          // No answer text yet (model still working after / between tool calls —
          // often the longest wait). Show explicit progress so it doesn't look frozen.
          <div className="flex items-center gap-2.5 text-[13px] text-gray-500">
            <span className="flex gap-1">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-500" style={{ animationDelay: "0ms" }} />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-500" style={{ animationDelay: "150ms" }} />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-500" style={{ animationDelay: "300ms" }} />
            </span>
            <span className="animate-pulse">{t("think.working")}</span>
          </div>
        ))}
    </div>
  );
});

// Drop a trailing (possibly still-open) ```json … ``` metadata block from a
// partially-streamed answer so it never flashes on screen.
function stripMetaBlock(text: string): string {
  const i = text.lastIndexOf("```json");
  return i >= 0 ? text.slice(0, i).trimEnd() : text;
}

/** Compact, Codex/Cursor-style trace of the read-only tools the agent ran. Each
 * row stays on a single line: tool name + a truncating target, with the result
 * pinned to the right. A streamed "started" record renders as an in-progress
 * row (spinner) that resolves in place when the completed record arrives. */
function ToolActivityList({ items }: { items: ToolActivity[] }) {
  const { t } = useI18n();
  return (
    <div className="mb-2.5 space-y-[3px]">
      {items.map((a, i) => (
        <div key={i} className="flex items-center gap-2 text-[11.5px] text-gray-500">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-gray-600">
            <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.7 2.7-2-2 2.7-2.7z" />
          </svg>
          <span className="shrink-0 font-mono text-accent-soft">{a.tool}</span>
          {a.target ? (
            <span className="min-w-0 flex-1 truncate text-gray-600" title={a.target}>· {a.target}</span>
          ) : (
            <span className="flex-1" />
          )}
          {a.status === "started" ? (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-amber-300/80">
              <span className="h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
              {t("tool.running")}
            </span>
          ) : (
            <span className="shrink-0 font-mono text-[11px] text-gray-500" title={a.result}>{a.result}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// Copy `text`, falling back to a temp-textarea + execCommand when the async
// Clipboard API is unavailable (it is absent/blocked in some WebViews) so the
// button never silently no-ops. Returns whether the copy succeeded.
export function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => legacyCopy(text));
  }
  return Promise.resolve(legacyCopy(text));
}

function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() =>
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        })
      }
      className="ml-1 flex items-center gap-1 rounded px-1 py-0.5 text-[10px] font-normal text-gray-600 opacity-0 transition-opacity hover:text-gray-300 group-hover:opacity-100"
      aria-label={t("common.copy")}
    >
      {copied ? (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
      ) : (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
      )}
      {copied ? t("common.copied") : t("common.copy")}
    </button>
  );
}

/** Animated "agent is working" placeholder shown while a reply is in flight. */
export function ThinkingBubble() {
  const { t } = useI18n();
  const labels = [t("think.0"), t("think.1"), t("think.2"), t("think.3")];
  const [i, setI] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setI((x) => (x + 1) % labels.length), 2200);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="animate-fade-in">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-accent-soft">
        {Spark}
        {t("card.agentName")}
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

/** Compact live progress rollup during a streaming turn: how many read-only
 * checks have completed so far + the latest one, so a long investigation reads
 * as making progress at a glance (complements the detailed tool list). This is
 * evidence/progress, never a plan. */
export function LiveProgress({ tools }: { tools: ToolActivity[] }) {
  const { t } = useI18n();
  if (!tools.length) return null;
  const done = tools.filter((a) => a.status !== "started").length;
  const latest = tools[tools.length - 1];
  const label = latest ? [latest.tool, latest.target].filter(Boolean).join(" · ") : "";
  return (
    <div className="mb-1.5 flex items-center gap-2 text-[11px] text-gray-500">
      <span className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
      <span className="shrink-0">{t("thread.progress", { n: done })}</span>
      {label && (
        <span className="min-w-0 truncate font-mono text-gray-600" title={label}>· {label}</span>
      )}
    </div>
  );
}

/** Transparency for the last answer: what it's grounded in and what the agent
 * couldn't verify. Collapsed by default — subtle, not a wall of text. */
export function GroundingCard({ g }: { g: Grounding }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const evidence = g.evidence_used ?? [];
  const gaps = g.evidence_gaps ?? [];
  const skills = g.skills_used ?? [];
  if (!evidence.length && !gaps.length && !skills.length) return null;
  const Section = ({ label, items, tone }: { label: string; items: string[]; tone: string }) =>
    items.length ? (
      <div className="mt-1.5">
        <span className={`text-[10.5px] font-medium uppercase tracking-wider ${tone}`}>{label}</span>
        <ul className="mt-0.5 space-y-0.5">
          {items.map((s, i) => (
            <li key={i} className="text-[12px] text-gray-400">· {s}</li>
          ))}
        </ul>
      </div>
    ) : null;
  return (
    <div className="animate-fade-in">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-[11px] text-gray-600 transition-colors hover:text-gray-400"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             className={`transition-transform ${open ? "rotate-90" : ""}`}><polyline points="9 18 15 12 9 6" /></svg>
        {t("grounding.title")}
        {gaps.length ? <span className="rounded bg-amber-500/12 px-1.5 py-0.5 text-[10px] text-amber-300/90">{gaps.length}</span> : null}
      </button>
      {open && (
        <div className="mt-1 border-l border-edge/70 pl-3">
          <Section label={t("grounding.evidence")} items={evidence} tone="text-gray-500" />
          <Section label={t("grounding.gaps")} items={gaps} tone="text-amber-300/80" />
          <Section label={t("grounding.skills")} items={skills} tone="text-accent-soft/80" />
        </div>
      )}
    </div>
  );
}

const FINDING_TONE: Record<string, string> = {
  critical: "text-red-300", high: "text-red-300", warning: "text-amber-300/90",
  medium: "text-amber-300/90", opportunity: "text-accent-soft/90",
  low: "text-gray-400", info: "text-gray-400",
};

// Persisted, deterministic session findings (rebuilt from run artifacts). Read-only
// and collapsible — surfaces what the API already holds so the user can see them
// in the thread rather than only in the report.
export function FindingsCard({ findings }: { findings: SessionFinding[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const items = (findings ?? []).filter((f) => f.title || f.interpretation);
  if (!items.length) return null;
  return (
    <div className="animate-fade-in rounded-lg border border-edge bg-panel/60 p-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 text-[12px] font-medium text-gray-300 transition-colors hover:text-gray-100"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             className={`transition-transform ${open ? "rotate-90" : ""}`}><polyline points="9 18 15 12 9 6" /></svg>
        {t("findings.title")}
        <span className="rounded bg-elevated px-1.5 py-0.5 text-[10px] text-gray-400">{items.length}</span>
      </button>
      {open && (
        <ul className="mt-2 space-y-1.5 border-l border-edge/70 pl-3">
          {items.map((f) => (
            <li key={f.id} className="text-[12px]">
              <div className="flex items-baseline gap-1.5">
                <span className={`text-[10px] font-medium uppercase tracking-wider ${FINDING_TONE[(f.severity || f.kind || "info").toLowerCase()] || "text-gray-400"}`}>
                  {f.severity || f.kind || "info"}
                </span>
                <span className="text-gray-200">{f.title || "—"}</span>
              </div>
              {f.interpretation && <p className="mt-0.5 text-gray-400">{f.interpretation}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A run rendered as a collapsible tool-call block (embeds the full transcript). */
export function RunCard({ run }: { run: SessionRunLink }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const st = RUN_STATUS[run.status] ?? { cls: "text-gray-400", key: "" };
  const statusLabel = st.key ? t(st.key) : run.status;
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
          {statusLabel}
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
export function TriageCard({ c, onRun }: { c: TriageCase; onRun?: (p: NextAction) => void }) {
  const { t } = useI18n();
  return (
    <div className="animate-fade-in-up overflow-hidden rounded-xl border border-edge bg-panel/60">
      <div className="flex items-center gap-2 border-b border-edge/70 px-3.5 py-2">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-soft">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span className="text-[11px] font-medium uppercase tracking-wider text-gray-500">{t("triage.title")}</span>
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
                  <span className="text-gray-500"> — {t("proposal.next")}: {cc.next_checks.slice(0, 3).join("; ")}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        {onRun && c.safe_next_actions?.length ? (
          <div className="mt-3 border-t border-edge/60 pt-2.5">
            <span className="text-[11px] text-gray-600">{t("thread.suggestedNext")}</span>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {c.safe_next_actions.map((p, i) => (
                <ProposalCard key={`${p.action_type}-${i}`} proposal={p} onRun={onRun} />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A proposed next step rendered as a compact, clickable chip (ChatGPT/Cursor
 * style). One click hands the task back to the agent (it does it inline) or
 * opens the purpose-built dialog — no configuration form. */
export function ProposalCard({
  proposal,
  onRun,
}: {
  proposal: NextAction;
  onRun: (p: NextAction) => void;
}) {
  const { t } = useI18n();
  // The server-injected cut-short continuation carries a fixed English title;
  // localize its chip label (agent-authored proposals are already in the user's
  // language). Everything else shows the agent's own title verbatim.
  const label =
    proposal.action_type === "continue_investigation"
      ? t("proposal.continueTitle")
      : proposal.title;
  return (
    <button
      onClick={() => onRun(proposal)}
      title={proposal.reason || label}
      className="group/prop inline-flex max-w-full animate-fade-in items-center gap-1.5 rounded-full border border-edge bg-panel/60 px-3 py-1.5 text-[12.5px] text-gray-300 transition-colors hover:border-accent/45 hover:bg-accent-dim/60 hover:text-gray-100"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" className="shrink-0 text-accent-soft">
        <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
      <span className="truncate">{label}</span>
    </button>
  );
}
