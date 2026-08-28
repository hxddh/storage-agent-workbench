import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSessionActivity, getSessionAudit, getSessionOverview } from "../api";
import { saveTextFile } from "../config";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useDismissOnEscape } from "../hooks/useDismissOnEscape";
import { useI18n } from "../i18n";
import { Button } from "./ui";
import { fmtDuration, fmtTokens } from "./TurnMetrics";
import { FindingsCard } from "./ThreadCards";
import { AgentMemoryPanel } from "./AgentMemory";
import type {
  AgentMemoryItem,
  AttachedFile,
  SessionActivityItem,
  SessionAuditItem,
  SessionFinding,
  SessionOverview,
} from "../types";

/** Is this timestamp inside the anchored turn's window? Both ends inclusive —
 * the window is built from the turn's own first/last activity.
 *
 * This is the FALLBACK. A time window is an approximation: a concurrently
 * running inline run writes its own tool_calls and audit rows, and those land
 * inside the same wall-clock window even though they belong to a different piece
 * of work. It stays because audit rows genuinely have no call id to match on. */
export function inAnchor(at: string, anchor?: { from: string; to: string } | null): boolean {
  if (!anchor) return false;
  return at >= anchor.from && at <= anchor.to;
}

/** Does this TOOL row belong to the anchored turn?
 *
 * Exact when the turn told us which calls were its own (v0.57.0): v0.55.0 gave
 * every thread activity record the same id as its persisted tool_calls row, and
 * this is what that id was for. Falls back to the time window for turns replayed
 * from history that carry no ids. */
export function toolInAnchor(
  row: { id: string; created_at: string },
  anchor?: { from: string; to: string } | null,
  anchorIds?: ReadonlySet<string> | null,
): boolean {
  if (anchorIds && anchorIds.size > 0) return anchorIds.has(row.id);
  return inAnchor(row.created_at, anchor);
}

/** Is this timeline entry part of the anchored turn?
 *
 * A tool row is matched EXACTLY by its call id when the turn supplied them; an
 * audit row has no id, so it still falls back to the wall-clock window. */
function entryAnchored(
  e: { kind: string; at: string; id: string },
  anchor?: { from: string; to: string } | null,
  anchorIds?: ReadonlySet<string> | null,
): boolean {
  if (e.kind === "tool") return toolInAnchor({ id: e.id, created_at: e.at }, anchor, anchorIds);
  return inAnchor(e.at, anchor);
}

/** One merged timeline entry — a tool call or an audit event. */
type Entry =
  | { kind: "tool"; at: string; id: string; data: SessionActivityItem }
  | { kind: "audit"; at: string; id: string; data: SessionAuditItem };

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-edge bg-panel/60 px-3 py-2.5">
      <div className="truncate text-2xs font-medium uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`mt-0.5 truncate text-base tabular-nums ${tone ?? "text-gray-100"}`}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-2xs text-gray-500">{sub}</div>}
    </div>
  );
}

function Chip({
  on,
  onClick,
  children,
  count,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
  count?: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-2xs transition-colors ${
        on
          ? "border-accent/40 bg-accent/12 text-gray-100"
          : "border-edge text-gray-500 hover:border-edge-strong hover:text-gray-300"
      }`}
    >
      {children}
      {count != null && <span className="tabular-nums text-gray-500">{count}</span>}
    </button>
  );
}

function clock(iso: string): string {
  // Timestamps are stored UTC; show local wall-clock time, which is what the
  // user was looking at when it happened.
  const d = new Date(iso.endsWith("Z") ? iso : `${iso}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour12: false });
}

function ToolRow({
  item,
  anchored,
  innerRef,
}: {
  item: SessionActivityItem;
  anchored?: boolean;
  innerRef?: React.Ref<HTMLLIElement>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const failed = item.status === "error";
  const dur = fmtDuration(item.duration_ms);
  return (
    <li
      ref={innerRef}
      data-anchored={anchored ? "true" : undefined}
      className={`border-l-2 pl-3 ${
        failed ? "border-danger-border" : anchored ? "border-accent" : "border-transparent"
      } ${anchored ? "bg-accent-dim/50" : ""}`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded py-1 text-left transition-colors hover:bg-hover/60"
      >
        <span className="shrink-0 font-mono text-2xs tabular-nums text-gray-500">{clock(item.created_at)}</span>
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${failed ? "bg-danger" : "bg-success/80"}`}
          aria-hidden
        />
        <span className="min-w-0 truncate font-mono text-xs text-gray-300">{item.tool_name}</span>
        {dur && <span className="ml-auto shrink-0 tabular-nums text-2xs text-gray-500">{dur}</span>}
      </button>
      {open && (
        <div className="mb-1 space-y-1.5 pb-1">
          {(["input", "output"] as const).map((k) =>
            item[k] ? (
              <div key={k}>
                <div className="text-2xs font-medium uppercase tracking-wider text-gray-500">
                  {k === "input" ? t("inspector.input") : t("inspector.output")}
                </div>
                <pre className="mt-0.5 max-h-52 overflow-auto rounded bg-sidebar p-2 text-2xs leading-relaxed text-gray-400">
                  {JSON.stringify(item[k], null, 2)}
                </pre>
              </div>
            ) : null,
          )}
        </div>
      )}
    </li>
  );
}

function AuditRow({
  item,
  anchored,
  innerRef,
}: {
  item: SessionAuditItem;
  anchored?: boolean;
  innerRef?: React.Ref<HTMLLIElement>;
}) {
  const [open, setOpen] = useState(false);
  const hasPayload = item.payload && Object.keys(item.payload).length > 0;
  return (
    <li
      ref={innerRef}
      data-anchored={anchored ? "true" : undefined}
      className={`border-l-2 pl-3 ${anchored ? "border-accent bg-accent-dim/50" : "border-transparent"}`}
    >
      <button
        type="button"
        onClick={() => hasPayload && setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded py-1 text-left transition-colors hover:bg-hover/60"
      >
        <span className="shrink-0 font-mono text-2xs tabular-nums text-gray-500">{clock(item.created_at)}</span>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent/50" aria-hidden />
        <span className="min-w-0 truncate text-xs text-gray-400">{item.event_type}</span>
      </button>
      {open && hasPayload && (
        <pre className="mb-1 max-h-52 overflow-auto rounded bg-sidebar p-2 text-2xs leading-relaxed text-gray-400">
          {JSON.stringify(item.payload, null, 2)}
        </pre>
      )}
    </li>
  );
}

/**
 * The session inspector: everything this investigation actually did.
 *
 * One timeline, not a set of tabs — tool calls and audit events happened in a
 * single interleaved sequence, and splitting them into tabs would destroy the
 * ordering that explains what led to what. The chips are ADDITIVE filters over
 * that one timeline, so narrowing never changes which view you are in.
 *
 * Everything shown was sanitized when it was written (rule 14); the inspector is
 * a reader, not a second source of truth. Bounds are surfaced, never silent.
 */
export function SessionInspector({
  sessionId,
  open,
  onClose,
  findings,
  memory,
  files,
  contextMessages,
  messageTotal,
  onCorrectMemory,
  onResolveMemory,
  anchor,
  anchorIds,
}: {
  sessionId: string | null;
  open: boolean;
  onClose: () => void;
  /** Deterministic session findings — standing state, not a timeline event. */
  findings?: SessionFinding[];
  /** The agent's own working memory, correctable in place (v0.51.0). */
  memory?: AgentMemoryItem[];
  files?: AttachedFile[];
  contextMessages?: number;
  messageTotal?: number;
  onCorrectMemory?: (id: string, text: string) => Promise<void>;
  onResolveMemory?: (id: string) => Promise<void>;
  /** Opened from a specific turn: the [from, to] wall-clock window of that
   * turn's activity. Entries inside it are marked and scrolled to, so "inspect"
   * from turn 7 of 30 does not just dump the reader at the top of the session
   * timeline with no idea which rows are theirs. */
  anchor?: { from: string; to: string } | null;
  /** The EXACT call ids the anchored turn produced (v0.57.0). When present these
   * decide which tool rows highlight, instead of a wall-clock guess that also
   * catches a concurrently-running inline run. */
  anchorIds?: ReadonlySet<string> | null;
}) {
  const { t } = useI18n();
  const [overview, setOverview] = useState<SessionOverview | null>(null);
  const [tools, setTools] = useState<SessionActivityItem[]>([]);
  const [audit, setAudit] = useState<SessionAuditItem[]>([]);
  const [total, setTotal] = useState({ tools: 0, audit: 0 });
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showTools, setShowTools] = useState(true);
  const [showAudit, setShowAudit] = useState(true);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [copied, setCopied] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(open);
  const anchorRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (!open || !sessionId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      getSessionOverview(sessionId),
      getSessionActivity(sessionId),
      getSessionAudit(sessionId),
    ])
      .then(([o, a, u]) => {
        if (cancelled) return;
        setOverview(o);
        setTools(a.items);
        setAudit(u.items);
        setTotal({ tools: a.total, audit: u.total });
      })
      .catch((e) => !cancelled && setError(String(e?.message ?? e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, sessionId]);

  /** Fetch the next page of ONE stream.
   *
   * Per-stream rather than both together: a session with 4000 tool calls and 30
   * audit events would otherwise page the short stream to its end on the first
   * click and then keep offering "load more" for a stream with nothing left.
   * Each stream advertises and advances its own remainder.
   */
  const loadMore = async (which: "tools" | "audit") => {
    if (!sessionId || loadingMore) return;
    setLoadingMore(true);
    try {
      if (which === "tools") {
        const a = await getSessionActivity(sessionId, undefined, tools.length);
        setTools((prev) => [...prev, ...a.items]);
      } else {
        const u = await getSessionAudit(sessionId, undefined, audit.length);
        setAudit((prev) => [...prev, ...u.items]);
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLoadingMore(false);
    }
  };

  useDismissOnEscape(open, onClose);

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    if (showTools) {
      for (const it of tools) {
        if (errorsOnly && it.status !== "error") continue;
        out.push({ kind: "tool", at: it.created_at, id: `t:${it.id}`, data: it });
      }
    }
    if (showAudit && !errorsOnly) {
      for (const it of audit) out.push({ kind: "audit", at: it.created_at, id: `a:${it.id}`, data: it });
    }
    return out.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  }, [tools, audit, showTools, showAudit, errorsOnly]);

  const firstAnchoredIndex = useMemo(
    () => (anchor || anchorIds ? entries.findIndex((e) => entryAnchored(e, anchor, anchorIds)) : -1),
    [entries, anchor],
  );

  // Scroll the anchored turn into view once its rows exist. Nearest, not
  // centred: the reader keeps the surrounding timeline in sight, which is the
  // context that makes the turn legible.
  useEffect(() => {
    if (!open || firstAnchoredIndex < 0) return;
    const el = anchorRef.current;
    if (!el) return;
    const id = window.setTimeout(
      () => el.scrollIntoView({ block: "nearest", behavior: "smooth" }),
      60,
    );
    return () => window.clearTimeout(id);
  }, [open, firstAnchoredIndex, anchor]);

  const markdown = useCallback((): string => {
    const lines: string[] = ["# Investigation record", ""];
    if (overview) {
      lines.push(
        `- Tool calls: ${overview.tool_calls} (${overview.tool_errors} failed)`,
        `- Time in tools: ${fmtDuration(overview.tool_ms) ?? "—"}`,
        `- Audit events: ${overview.audit_events}`,
        // Never print a token total we did not measure.
        overview.usage.available
          ? `- Tokens: ${overview.usage.input_tokens} in / ${overview.usage.output_tokens} out` +
            (overview.usage.partial
              ? ` (partial — ${overview.usage.turns_measured} of ${overview.usage.turns} turns reported)`
              : "")
          : "- Tokens: not reported by the model provider",
        "",
      );
    }
    lines.push("## Timeline", "");
    for (const e of entries) {
      lines.push(
        e.kind === "tool"
          ? `- \`${e.at}\` **${e.data.tool_name}** — ${e.data.status ?? "?"}` +
            (e.data.duration_ms != null ? ` (${e.data.duration_ms} ms)` : "")
          : `- \`${e.at}\` _${e.data.event_type}_`,
      );
    }
    if (tools.length < total.tools || audit.length < total.audit) {
      lines.push("", `> Truncated: exported ${tools.length + audit.length} of `
        + `${total.tools + total.audit} entries.`);
    }
    return lines.join("\n");
  }, [overview, entries, tools.length, audit.length, total]);

  if (!open) return null;

  const usage = overview?.usage;
  const tokenValue = usage?.available ? (fmtTokens(usage.total_tokens) ?? "—") : "—";

  return (
    <div
      className="fixed inset-0 z-drawer flex justify-end"
      onClick={onClose}
    >
      {/* The scrim is a SIBLING of the panel, not its parent.
        *
        * It used to be the container: `bg-scrim … animate-fade-in` on the
        * element the panel lives inside, so fading the scrim faded the panel
        * with it, and for the length of the animation an opaque drawer was
        * translucent — the thread's heading legible straight through it, on
        * every open. Removing the opacity from the panel's own keyframe did
        * nothing, because the opacity was never on the panel; it was inherited.
        * Now the scrim fades and the panel only slides. */}
      <div className="absolute inset-0 bg-scrim backdrop-blur-sm animate-fade-in" aria-hidden />
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={t("inspector.title")}
        data-testid="session-inspector"
        className="relative flex h-full w-[min(680px,96vw)] flex-col border-l border-edge bg-canvas shadow-pop animate-slide-in-right"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-edge px-5 py-3.5">
          <span className="text-sm font-semibold text-gray-100">{t("inspector.title")}</span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const text = markdown();
                void navigator.clipboard
                  ?.writeText(text)
                  .then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  })
                  .catch(() => undefined);
              }}
            >
              {copied ? t("common.copied") : t("inspector.copyRecord")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const text = markdown();
                void saveTextFile("investigation-record.md", text).then((path) => {
                  if (path) {
                    setSavedPath(path);
                    window.setTimeout(() => setSavedPath(null), 4000);
                    return;
                  }
                  // Outside Tauri (dev/browser) the anchor download is the path.
                  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "investigation-record.md";
                  a.click();
                  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                });
              }}
            >
              {savedPath ? t("thread.savedTo", { path: savedPath }) : t("thread.download")}
            </Button>
            <button
              onClick={onClose}
              aria-label={t("common.close")}
              className="grid h-7 w-7 place-items-center rounded-md text-gray-500 transition-colors hover:bg-hover hover:text-gray-200"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-auto px-5 py-4">
          {error && (
            <div className="mb-4 rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              label={t("inspector.statCalls")}
              value={String(overview?.tool_calls ?? 0)}
              sub={overview?.tool_errors ? t("inspector.statFailed", { n: overview.tool_errors }) : undefined}
              tone={overview?.tool_errors ? "text-danger" : undefined}
            />
            <Stat label={t("inspector.statToolTime")} value={fmtDuration(overview?.tool_ms) ?? "—"} />
            <Stat
              label={t("inspector.statTokens")}
              value={tokenValue}
              // "unavailable" is a fact about the provider, not a loading state.
              sub={
                usage?.available
                  ? usage.partial
                    ? t("inspector.tokensPartial", { n: usage.turns_measured, total: usage.turns })
                    : t("inspector.tokensIn", { n: fmtTokens(usage.input_tokens) ?? "0" })
                  : t("inspector.tokensUnavailable")
              }
              tone={usage?.available ? undefined : "text-gray-500"}
            />
            <Stat
              label={t("inspector.statAudit")}
              value={String(overview?.audit_events ?? 0)}
              sub={overview?.approvals ? t("inspector.statApprovals", { n: overview.approvals }) : undefined}
            />
          </div>

          {findings && findings.length > 0 && (
            <div className="mt-4">
              <FindingsCard findings={findings} />
            </div>
          )}

          {onCorrectMemory && onResolveMemory && (
            <AgentMemoryPanel
              memory={memory ?? []}
              files={files}
              contextMessages={contextMessages}
              messageTotal={messageTotal}
              onCorrect={onCorrectMemory}
              onResolve={onResolveMemory}
            />
          )}

          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            <Chip on={showTools} onClick={() => setShowTools((v) => !v)} count={tools.length}>
              {t("inspector.chipTools")}
            </Chip>
            <Chip on={showAudit} onClick={() => setShowAudit((v) => !v)} count={audit.length}>
              {t("inspector.chipAudit")}
            </Chip>
            <Chip on={errorsOnly} onClick={() => setErrorsOnly((v) => !v)}>
              {t("inspector.chipErrors")}
            </Chip>
          </div>

          {([
            { key: "tools" as const, have: tools.length, all: total.tools, label: t("inspector.chipTools") },
            { key: "audit" as const, have: audit.length, all: total.audit, label: t("inspector.chipAudit") },
          ]).map((s) =>
            s.have < s.all ? (
              <div key={s.key} className="mt-2 flex items-center gap-2 text-2xs text-warn-fg">
                <span>
                  {s.label} — {t("inspector.showing", { n: s.have, total: s.all })}
                </span>
                <button
                  type="button"
                  onClick={() => loadMore(s.key)}
                  disabled={loadingMore}
                  data-testid={`inspector-load-more-${s.key}`}
                  className="rounded border border-edge px-2 py-0.5 text-gray-400 transition-colors hover:border-edge-strong hover:text-gray-200 disabled:opacity-50"
                >
                  {loadingMore ? t("inspector.loading") : t("inspector.loadMore")}
                </button>
              </div>
            ) : null,
          )}

          {anchor && (
            <p className="mt-3 text-2xs text-accent-soft" data-testid="anchor-note">
              {t("inspector.anchored")}
            </p>
          )}

          <ul className="mt-3 space-y-0.5">
            {entries.map((e, i) => {
              const hit = entryAnchored(e, anchor, anchorIds);
              // Scroll target: the FIRST row of the anchored turn, so the reader
              // lands at the start of that turn's work, not its middle.
              const isFirstHit = hit && i === firstAnchoredIndex;
              return e.kind === "tool" ? (
                <ToolRow
                  key={e.id}
                  item={e.data}
                  anchored={hit}
                  innerRef={isFirstHit ? anchorRef : undefined}
                />
              ) : (
                <AuditRow key={e.id} item={e.data} anchored={hit} innerRef={isFirstHit ? anchorRef : undefined} />
              );
            })}
          </ul>

          {!loading && entries.length === 0 && (
            <p className="mt-6 text-center text-xs text-gray-500">{t("inspector.empty")}</p>
          )}
        </div>
      </div>
    </div>
  );
}
