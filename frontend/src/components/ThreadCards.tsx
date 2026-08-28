import { Fragment, memo, useEffect, useMemo, useState } from "react";
import type { Grounding, NextAction, SessionFinding, SessionRunLink, ToolActivity, TriageCase } from "../types";
import { RunDetail } from "./RunDetail";
import { Markdown } from "./Markdown";
import { useI18n } from "../i18n";
import { LiveTrace } from "./LiveTrace";
import { isMostlyError, parseS3Error, type S3Error } from "../lib/s3error";

const RUN_STATUS: Record<string, { cls: string; key: string }> = {
  pending: { cls: "text-gray-400", key: "run.queued" },
  running: { cls: "text-warn-fg", key: "run.running" },
  completed: { cls: "text-success", key: "run.done" },
  failed: { cls: "text-danger", key: "run.failed" },
  not_implemented: { cls: "text-gray-500", key: "run.na" },
};

const CONF_PILL: Record<string, string> = {
  high: "bg-accent/15 text-accent-soft",
  medium: "bg-warn-bg text-warn-fg",
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
  sessionId,
  onEdit,
  onRegenerate,
  onBranch,
}: {
  role: string;
  content: string | null;
  toolActivity?: ToolActivity[];
  streaming?: boolean;
  /** Lets a finished trace row be opened to the call's real persisted
   * input/output (v0.56.0). Absent = rows stay read-only. */
  sessionId?: string | null;
  /** Put this user message back in the composer to send again (a NEW turn). */
  onEdit?: (text: string) => void;
  /** Re-ask the question that produced this answer, as a NEW turn. */
  onRegenerate?: () => void;
  /** Branch a NEW investigation from this message (v0.61.0). Distinct from
   * edit, which rewrites the question in place — branching keeps both threads. */
  onBranch?: () => void;
}) {
  const { t } = useI18n();
  if (role === "user") {
    return <UserMessage content={content} onEdit={onEdit} onBranch={onBranch} />;
  }
  // While streaming, the raw deltas may include the trailing metadata JSON block
  // (the backend strips it for the persisted message); hide it from the live view.
  const shown = streaming ? stripMetaBlock(content || "") : content || "";
  return (
    /* A turn is one thing, and it says so.
     *
     * The thread was a flat column: an answer, a metadata line, the next
     * question, all spaced alike and none of them grouped. The agent announced
     * itself with "✦ Storage Agent" above every single answer — a label that
     * stops being information the second time you read it, and still left the
     * answer and its own footer looking like two unrelated blocks.
     *
     * A gutter does both jobs at once. The mark identifies the speaker without
     * a word, the hairline runs the height of the turn so the answer, its trace
     * and its cost read as one unit, and the indent gives the thread the rhythm
     * it had none of. This is the arrangement Codex and Cursor both settle on,
     * and it costs one grid column.
     */
    <div className="group grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2.5 animate-fade-in-up">
      <div className="relative flex justify-center" aria-hidden>
        {/* A badge, not a loose glyph. At 11px on a dark ground an unbacked mark
          * is not an identity, it is a speck — the first version measured that
          * way on screen. A filled chip reads as the speaker at a glance, and
          * it is the only thing in the thread carrying the accent, which is how
          * an accent earns its place. */}
        <span
          className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded-md border border-accent/30 bg-accent/12 text-accent ${
            streaming ? "animate-pulse" : ""
          }`}
        >
          {Spark}
        </span>
        <span className="absolute inset-x-0 top-[22px] bottom-1 mx-auto w-px bg-edge-strong/70" />
      </div>
      <div className="min-w-0">
      {/* The speaker is the mark in the gutter; this row is only the actions,
        * and only on hover. */}
      <div className="mb-0.5 flex h-4 items-center gap-1.5">
        <span className="sr-only">{t("card.agentName")}</span>
        {!streaming && (
          <span className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <CopyButton text={content || ""} />
            {onRegenerate && (
              <button
                onClick={onRegenerate}
                title={t("msg.regenerate")}
                aria-label={t("msg.regenerate")}
                data-testid="regenerate"
                className="text-gray-500 transition-colors hover:text-gray-200"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
              </button>
            )}
          </span>
        )}
      </div>
      {/* Only while streaming. Afterwards the trace lives in the turn footer's
          single expansion, in execution order and next to the grounding it
          supports — see TurnFooter. */}
      {streaming && toolActivity && toolActivity.length > 0 && (
        <LiveTrace items={toolActivity} sessionId={sessionId} />
      )}
      <Markdown text={shown} />
      {streaming &&
        (shown.trim() ? (
          // Mid-answer: a blinking caret after the streamed text.
          <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-pulse bg-accent-soft align-middle" />
        ) : (
          // No answer text yet (model still working after / between tool calls —
          // often the longest wait). Show explicit progress so it doesn't look frozen.
          <div className="flex items-center gap-2.5 text-sm text-gray-500">
            <span className="flex gap-1">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-500" style={{ animationDelay: "0ms" }} />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-500" style={{ animationDelay: "150ms" }} />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-500" style={{ animationDelay: "300ms" }} />
            </span>
            <span className="animate-pulse">{t("think.working")}</span>
          </div>
        ))}
      </div>
    </div>
  );
});


/**
 * A pasted S3 error, read back as the object it is.
 *
 * This is the app's signature input — the thing a person is looking at when
 * they open it — and the thread showed it as a wall of angle brackets in a grey
 * bubble. A storage tool that cannot recognise a storage error is asking the
 * person to be the parser.
 *
 * The raw body stays one click away and stays copyable: the identifiers in it
 * are what support asks for, and a card that swallowed them would be a
 * downgrade dressed as an upgrade.
 */
function S3ErrorCard({ err, raw }: { err: S3Error; raw: string }) {
  const { t } = useI18n();
  const [showRaw, setShowRaw] = useState(false);
  const facts: { label: string; value: string; mono?: boolean }[] = [];
  if (err.bucket) facts.push({ label: t("s3err.bucket"), value: err.bucket, mono: true });
  if (err.key) facts.push({ label: t("s3err.key"), value: err.key, mono: true });
  if (err.operation) facts.push({ label: t("s3err.operation"), value: err.operation, mono: true });
  if (err.requestId) facts.push({ label: t("s3err.requestId"), value: err.requestId, mono: true });
  if (err.hostId) facts.push({ label: t("s3err.hostId"), value: err.hostId, mono: true });

  return (
    <div
      data-testid="s3-error-card"
      className="w-full overflow-hidden rounded-xl border border-danger-border bg-danger-bg/40"
    >
      <div className="flex items-baseline gap-2 px-3.5 pt-3">
        <span className="font-mono text-sm font-semibold text-danger" data-testid="s3-error-code">
          {err.code}
        </span>
        <span className="text-2xs uppercase tracking-wider text-gray-500">{t("s3err.label")}</span>
      </div>
      {err.message && (
        <p className="px-3.5 pt-1 text-prose text-gray-200">{err.message}</p>
      )}
      {facts.length > 0 && (
        <dl className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-3.5 pb-1 text-xs">
          {facts.map((f) => (
            <Fragment key={f.label}>
              <dt className="text-gray-500">{f.label}</dt>
              <dd className={`min-w-0 truncate text-gray-300 ${f.mono ? "font-mono" : ""}`} title={f.value}>
                {f.value}
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
      <div className="mt-2 flex items-center gap-1 border-t border-danger-border/60 px-2.5 py-1">
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          data-testid="s3-error-raw-toggle"
          className="rounded px-1 py-0.5 text-2xs text-gray-500 transition-colors hover:text-gray-300"
        >
          {showRaw ? t("s3err.hideRaw") : t("s3err.showRaw")}
        </button>
        <CopyButton text={raw} />
      </div>
      {showRaw && (
        <pre className="max-h-64 overflow-auto border-t border-danger-border/60 bg-code px-3.5 py-2.5 text-2xs leading-relaxed text-gray-400">
          {raw}
        </pre>
      )}
    </div>
  );
}

/**
 * Edit / branch (and optionally copy) under a user message.
 *
 * Shared rather than repeated per layout: the S3-error card is a second render
 * path for the same message, and when it inlined its own row it silently lost
 * branch — the one message people most want to fork from (a pasted error is a
 * whole investigation's starting point) was the one you could not fork.
 */
function MessageActions({
  text,
  onEdit,
  onBranch,
  copy = false,
}: {
  text: string;
  onEdit?: (text: string) => void;
  onBranch?: () => void;
  copy?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-1 pr-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      {copy && <CopyButton text={text} />}
      {onEdit && (
        <button
          onClick={() => onEdit(text)}
          title={t("msg.edit")}
          aria-label={t("msg.edit")}
          data-testid="edit-message"
          className="text-2xs text-gray-500 transition-colors hover:text-gray-200"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </button>
      )}
      {onBranch && (
        <button
          onClick={onBranch}
          title={t("msg.branch")}
          aria-label={t("msg.branch")}
          data-testid="branch-message"
          className="text-2xs text-gray-500 transition-colors hover:text-gray-200"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** A user turn.
 *
 * Long pastes get clamped: this app's most common user message is a full S3
 * error body or a log excerpt, and letting one fill the viewport buries the
 * conversation around it. The clamp is visual only — nothing is truncated, and
 * "show more" reveals the rest in place.
 */
function UserMessage({
  content,
  onEdit,
  onBranch,
}: {
  content: string | null;
  onEdit?: (text: string) => void;
  /** Branch a new investigation from THIS point in the thread (v0.61.0). */
  onBranch?: () => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const text = content || "";
  const long = text.length > 600 || text.split("\n").length > 12;
  // Recognise the error rather than print it. A question that merely QUOTES one
  // stays prose — see `isMostlyError`.
  const err = useMemo(() => parseS3Error(text), [text]);
  const asCard = err !== null && isMostlyError(text, err);

  if (asCard) {
    return (
      <div className="group flex justify-end animate-fade-in-up">
        <div className="flex w-full max-w-[42rem] flex-col items-end gap-1">
          <S3ErrorCard err={err} raw={text} />
          <MessageActions text={text} onEdit={onEdit} onBranch={onBranch} />
        </div>
      </div>
    );
  }

  return (
    <div className="group flex justify-end animate-fade-in-up">
      <div className="flex max-w-[82%] flex-col items-end gap-1">
        <div className="w-full whitespace-pre-wrap break-words rounded-2xl border border-edge bg-elevated px-3.5 py-2.5 text-prose text-gray-100">
          <div className={long && !expanded ? "max-h-[11.5rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]" : ""}>
            {text}
          </div>
          {long && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 text-2xs text-gray-500 transition-colors hover:text-accent-soft"
            >
              {expanded ? t("msg.showLess") : t("msg.showMore")}
            </button>
          )}
        </div>
        <MessageActions text={text} onEdit={onEdit} onBranch={onBranch} copy />
      </div>
    </div>
  );
}

// Drop a trailing (possibly still-open) ```json … ``` metadata block from a
// partially-streamed answer so it never flashes on screen.
function stripMetaBlock(text: string): string {
  const i = text.lastIndexOf("```json");
  if (i < 0) return text;
  // Only strip when the fence actually looks like the METADATA contract — a
  // legitimate ```json block in the answer (a policy, a config sample) was
  // previously hidden during streaming from the fence onward.
  const rest = text.slice(i);
  const looksMeta = /"(answer|skills_used|evidence_used|next_action_proposals)"/.test(rest)
    || rest.replace(/```json\s*/, "").trimStart().length === 0; // still-empty open fence
  return looksMeta ? text.slice(0, i).trimEnd() : text;
}

/** The LIVE trace, shown only while a turn is streaming.
 *
 * Here the rows ARE the progress indicator — watching them land is how you know
 * the agent is working. Once the answer arrives they are redundant with the turn
 * footer's single expansion, which shows the same calls in execution order
 * alongside the grounding they support, so this no longer renders afterwards.
 */
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
      className="ml-1 flex items-center gap-1 rounded px-1 py-0.5 text-3xs font-normal text-gray-600 opacity-0 transition-opacity hover:text-gray-300 group-hover:opacity-100"
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
      <div className="mb-1.5 flex items-center gap-1.5 text-2xs font-medium text-accent-soft">
        {Spark}
        {t("card.agentName")}
      </div>
      <div className="flex items-center gap-2.5 text-sm text-gray-500">
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
        <span className={`text-3xs font-medium uppercase tracking-wider ${tone}`}>{label}</span>
        <ul className="mt-0.5 space-y-0.5">
          {items.map((s, i) => (
            <li key={i} className="text-xs text-gray-400">· {s}</li>
          ))}
        </ul>
      </div>
    ) : null;
  return (
    <div className="animate-fade-in">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-2xs text-gray-600 transition-colors hover:text-gray-400"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             className={`transition-transform ${open ? "rotate-90" : ""}`}><polyline points="9 18 15 12 9 6" /></svg>
        {t("grounding.title")}
        {gaps.length ? <span className="rounded bg-warn-bg px-1.5 py-0.5 text-3xs text-warn-fg">{gaps.length}</span> : null}
      </button>
      {open && (
        <div className="mt-1 border-l border-edge/70 pl-3">
          <Section label={t("grounding.evidence")} items={evidence} tone="text-gray-500" />
          <Section label={t("grounding.gaps")} items={gaps} tone="text-warn-fg" />
          <Section label={t("grounding.skills")} items={skills} tone="text-accent-soft/80" />
        </div>
      )}
    </div>
  );
}

// Localize a backend severity/kind enum with a raw fallback (mirror
// RunDetail.severityLabel) — zh users previously saw raw English tokens as
// UI labels inside an otherwise fully translated thread.
const severityLabel = (t: (k: string) => string, sev: string): string => {
  const v = t(`metric.${sev}`);
  return v === `metric.${sev}` ? sev : v;
};

const FINDING_TONE: Record<string, string> = {
  critical: "text-danger", high: "text-danger", warning: "text-warn-fg",
  medium: "text-warn-fg", opportunity: "text-accent-soft/90",
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
        className="flex w-full items-center gap-1.5 text-xs font-medium text-gray-300 transition-colors hover:text-gray-100"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             className={`transition-transform ${open ? "rotate-90" : ""}`}><polyline points="9 18 15 12 9 6" /></svg>
        {t("findings.title")}
        <span className="rounded bg-elevated px-1.5 py-0.5 text-3xs text-gray-400">{items.length}</span>
      </button>
      {open && (
        <ul className="mt-2 space-y-1.5 border-l border-edge/70 pl-3">
          {items.map((f) => (
            <li key={f.id} className="text-xs">
              <div className="flex items-baseline gap-1.5">
                <span className={`text-3xs font-medium uppercase tracking-wider ${FINDING_TONE[(f.severity || f.kind || "info").toLowerCase()] || "text-gray-400"}`}>
                  {severityLabel(t, (f.severity || f.kind || "info").toLowerCase())}
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
        <span className="font-mono text-xs text-gray-300">{run.run_type}</span>
        <span className={`flex items-center gap-1 text-2xs ${st.cls}`}>
          {run.status === "completed" && (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
          )}
          {statusLabel}
        </span>
        <span className="min-w-0 flex-1 truncate text-2xs text-gray-500">{run.final_summary || ""}</span>
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
        <span className="text-2xs font-medium uppercase tracking-wider text-gray-500">{t("triage.title")}</span>
      </div>
      <div className="px-3.5 py-3 text-sm">
        <div className="text-gray-200">{c.summary}</div>
        <ul className="mt-2.5 space-y-1.5">
          {c.candidate_causes.map((cc, i) => (
            <li key={i} className="flex items-start gap-2 text-xs">
              <span className={`mt-px shrink-0 rounded px-1.5 py-0.5 text-3xs font-medium ${CONF_PILL[cc.confidence ?? "low"] ?? "bg-gray-700/40 text-gray-400"}`}>
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
            <span className="text-2xs text-gray-600">{t("thread.suggestedNext")}</span>
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
      className="group/prop inline-flex max-w-full animate-fade-in items-center gap-1.5 rounded-full border border-edge bg-panel/60 px-3 py-1.5 text-xs text-gray-300 transition-colors hover:border-accent/45 hover:bg-accent-dim/60 hover:text-gray-100"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" className="shrink-0 text-accent-soft">
        <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
      <span className="truncate">{label}</span>
    </button>
  );
}
