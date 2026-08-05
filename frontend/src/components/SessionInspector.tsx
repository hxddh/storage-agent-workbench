import { useCallback, useEffect, useMemo, useState } from "react";
import { getSessionActivity, getSessionAudit, getSessionOverview } from "../api";
import { saveTextFile } from "../config";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useI18n } from "../i18n";
import { Button } from "./ui";
import { fmtDuration, fmtTokens } from "./TurnMetrics";
import type {
  SessionActivityItem,
  SessionAuditItem,
  SessionOverview,
} from "../types";

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
      <div className="truncate text-[10.5px] font-medium uppercase tracking-wider text-gray-600">{label}</div>
      <div className={`mt-0.5 truncate text-[15px] tabular-nums ${tone ?? "text-gray-100"}`}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-gray-600">{sub}</div>}
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
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] transition-colors ${
        on
          ? "border-accent/40 bg-accent/12 text-gray-100"
          : "border-edge text-gray-500 hover:border-edge-strong hover:text-gray-300"
      }`}
    >
      {children}
      {count != null && <span className="tabular-nums text-gray-600">{count}</span>}
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

function ToolRow({ item }: { item: SessionActivityItem }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const failed = item.status === "error";
  const dur = fmtDuration(item.duration_ms);
  return (
    <li className={`border-l-2 pl-3 ${failed ? "border-danger-border" : "border-transparent"}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded py-1 text-left transition-colors hover:bg-hover/60"
      >
        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-gray-700">{clock(item.created_at)}</span>
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${failed ? "bg-danger" : "bg-success/80"}`}
          aria-hidden
        />
        <span className="min-w-0 truncate font-mono text-[12px] text-gray-300">{item.tool_name}</span>
        {dur && <span className="ml-auto shrink-0 tabular-nums text-[11px] text-gray-600">{dur}</span>}
      </button>
      {open && (
        <div className="mb-1 space-y-1.5 pb-1">
          {(["input", "output"] as const).map((k) =>
            item[k] ? (
              <div key={k}>
                <div className="text-[10px] font-medium uppercase tracking-wider text-gray-700">
                  {k === "input" ? t("inspector.input") : t("inspector.output")}
                </div>
                <pre className="mt-0.5 max-h-52 overflow-auto rounded bg-sidebar p-2 text-[10.5px] leading-relaxed text-gray-400">
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

function AuditRow({ item }: { item: SessionAuditItem }) {
  const [open, setOpen] = useState(false);
  const hasPayload = item.payload && Object.keys(item.payload).length > 0;
  return (
    <li className="border-l-2 border-transparent pl-3">
      <button
        type="button"
        onClick={() => hasPayload && setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded py-1 text-left transition-colors hover:bg-hover/60"
      >
        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-gray-700">{clock(item.created_at)}</span>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent/50" aria-hidden />
        <span className="min-w-0 truncate text-[12px] text-gray-400">{item.event_type}</span>
      </button>
      {open && hasPayload && (
        <pre className="mb-1 max-h-52 overflow-auto rounded bg-sidebar p-2 text-[10.5px] leading-relaxed text-gray-400">
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
}: {
  sessionId: string | null;
  open: boolean;
  onClose: () => void;
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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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
      className="fixed inset-0 z-50 flex justify-end bg-scrim backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={t("inspector.title")}
        data-testid="session-inspector"
        className="flex h-full w-[min(680px,96vw)] flex-col border-l border-edge bg-canvas shadow-pop animate-slide-in-right"
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
            <div className="mb-4 rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-[12px] text-danger">
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
              tone={usage?.available ? undefined : "text-gray-600"}
            />
            <Stat
              label={t("inspector.statAudit")}
              value={String(overview?.audit_events ?? 0)}
              sub={overview?.approvals ? t("inspector.statApprovals", { n: overview.approvals }) : undefined}
            />
          </div>

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
              <div key={s.key} className="mt-2 flex items-center gap-2 text-[11px] text-warn-fg">
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

          <ul className="mt-3 space-y-0.5">
            {entries.map((e) =>
              e.kind === "tool" ? (
                <ToolRow key={e.id} item={e.data} />
              ) : (
                <AuditRow key={e.id} item={e.data} />
              ),
            )}
          </ul>

          {!loading && entries.length === 0 && (
            <p className="mt-6 text-center text-[12px] text-gray-600">{t("inspector.empty")}</p>
          )}
        </div>
      </div>
    </div>
  );
}
