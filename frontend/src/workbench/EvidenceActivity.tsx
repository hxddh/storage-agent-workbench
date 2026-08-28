import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getSessionActivity, getSessionAudit, getSessionOverview } from "../api";
import type { SessionActivityItem, SessionAuditItem, SessionOverview } from "../types";
import { useI18n } from "../i18n";
import { fmtDuration, fmtTokens } from "../components/TurnMetrics";

type Entry =
  | { kind: "tool"; at: string; id: string; data: SessionActivityItem }
  | { kind: "audit"; at: string; id: string; data: SessionAuditItem };

const PAYLOAD_CHAR_LIMIT = 6000;

function clock(iso: string): string {
  const date = new Date(iso.endsWith("Z") ? iso : `${iso}Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(undefined, { hour12: false });
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="evidence-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

function Filter({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean;
  count?: number;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className="evidence-filter"
      data-active={active ? "true" : "false"}
      onClick={onClick}
    >
      <span>{children}</span>
      {count == null ? null : <span className="evidence-filter-count">{count}</span>}
    </button>
  );
}

function formatPayload(value: Record<string, unknown>) {
  const full = JSON.stringify(value, null, 2);
  if (full.length <= PAYLOAD_CHAR_LIMIT) return { text: full, clipped: 0 };
  return {
    text: full.slice(0, PAYLOAD_CHAR_LIMIT),
    clipped: full.length - PAYLOAD_CHAR_LIMIT,
  };
}

function Payload({ label, value }: { label: string; value: Record<string, unknown> | null }) {
  if (!value) return null;
  const formatted = formatPayload(value);
  return (
    <div className="evidence-payload">
      <div className="flex items-center justify-between gap-3">
        <span>{label}</span>
        {formatted.clipped > 0 ? (
          <span className="text-2xs text-gray-500">+{formatted.clipped.toLocaleString()} chars not rendered</span>
        ) : null}
      </div>
      <pre>{formatted.text}</pre>
    </div>
  );
}

function ActivityEntry({ entry }: { entry: Entry }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const expandable = entry.kind === "tool"
    ? Boolean(entry.data.input || entry.data.output)
    : Boolean(entry.data.payload && Object.keys(entry.data.payload).length);

  return (
    <li className="evidence-activity-row" data-kind={entry.kind}>
      <button
        type="button"
        className="evidence-activity-summary"
        aria-expanded={expandable ? open : undefined}
        onClick={() => expandable && setOpen((value) => !value)}
      >
        <time>{clock(entry.at)}</time>
        <span className="evidence-activity-kind">{entry.kind === "tool" ? "TOOL" : "AUDIT"}</span>
        {entry.kind === "tool" ? (
          <>
            <strong>{entry.data.tool_name}</strong>
            <span className="evidence-activity-state" data-status={entry.data.status ?? "unknown"}>
              {entry.data.status ?? "unknown"}
            </span>
            <span className="evidence-activity-duration">{fmtDuration(entry.data.duration_ms) ?? "—"}</span>
          </>
        ) : (
          <>
            <strong>{entry.data.event_type}</strong>
            <span className="evidence-activity-state">audit</span>
            <span className="evidence-activity-duration">—</span>
          </>
        )}
        {expandable ? <span className="evidence-activity-disclosure" aria-hidden>{open ? "−" : "+"}</span> : null}
      </button>
      {open && entry.kind === "tool" ? (
        <div className="evidence-activity-detail">
          <Payload label={t("inspector.input")} value={entry.data.input} />
          <Payload label={t("inspector.output")} value={entry.data.output} />
        </div>
      ) : null}
      {open && entry.kind === "audit" ? (
        <div className="evidence-activity-detail">
          <Payload label="Payload" value={entry.data.payload} />
        </div>
      ) : null}
    </li>
  );
}

export function EvidenceActivity({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const [overview, setOverview] = useState<SessionOverview | null>(null);
  const [tools, setTools] = useState<SessionActivityItem[]>([]);
  const [audit, setAudit] = useState<SessionAuditItem[]>([]);
  const [totals, setTotals] = useState({ tools: 0, audit: 0 });
  const [showTools, setShowTools] = useState(true);
  const [showAudit, setShowAudit] = useState(true);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState<"tools" | "audit" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      getSessionOverview(sessionId),
      getSessionActivity(sessionId),
      getSessionAudit(sessionId),
    ])
      .then(([nextOverview, nextTools, nextAudit]) => {
        if (cancelled) return;
        setOverview(nextOverview);
        setTools(nextTools.items);
        setAudit(nextAudit.items);
        setTotals({ tools: nextTools.total, audit: nextAudit.total });
      })
      .catch((reason) => {
        if (!cancelled) setError(String((reason as Error)?.message ?? reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [sessionId]);

  const entries = useMemo<Entry[]>(() => {
    const next: Entry[] = [];
    if (showTools) {
      for (const item of tools) {
        if (errorsOnly && item.status !== "error") continue;
        next.push({ kind: "tool", at: item.created_at, id: `tool:${item.id}`, data: item });
      }
    }
    if (showAudit && !errorsOnly) {
      for (const item of audit) next.push({ kind: "audit", at: item.created_at, id: `audit:${item.id}`, data: item });
    }
    return next.sort((a, b) => a.at.localeCompare(b.at));
  }, [tools, audit, showTools, showAudit, errorsOnly]);

  const loadMore = async (kind: "tools" | "audit") => {
    if (loadingMore) return;
    setLoadingMore(kind);
    setError(null);
    try {
      if (kind === "tools") {
        const next = await getSessionActivity(sessionId, undefined, tools.length);
        setTools((current) => [...current, ...next.items]);
        setTotals((current) => ({ ...current, tools: next.total }));
      } else {
        const next = await getSessionAudit(sessionId, undefined, audit.length);
        setAudit((current) => [...current, ...next.items]);
        setTotals((current) => ({ ...current, audit: next.total }));
      }
    } catch (reason) {
      setError(String((reason as Error)?.message ?? reason));
    } finally {
      setLoadingMore(null);
    }
  };

  if (loading) return <p className="workbench-empty-line">{t("inspector.loading")}</p>;

  const usage = overview?.usage;
  const tokenValue = usage?.available ? (fmtTokens(usage.total_tokens) ?? "—") : "—";

  return (
    <div className="evidence-activity" data-testid="evidence-activity">
      {error ? <p className="workbench-surface-error evidence-inline-error">{error}</p> : null}

      <div className="evidence-metrics" aria-label="Investigation metrics">
        <Metric
          label={t("inspector.statCalls")}
          value={String(overview?.tool_calls ?? 0)}
          detail={overview?.tool_errors ? t("inspector.statFailed", { n: overview.tool_errors }) : undefined}
        />
        <Metric label={t("inspector.statToolTime")} value={fmtDuration(overview?.tool_ms) ?? "—"} />
        <Metric
          label={t("inspector.statTokens")}
          value={tokenValue}
          detail={usage?.available
            ? usage.partial
              ? t("inspector.tokensPartial", { n: usage.turns_measured, total: usage.turns })
              : t("inspector.tokensIn", { n: fmtTokens(usage.input_tokens) ?? "0" })
            : t("inspector.tokensUnavailable")}
        />
        <Metric
          label={t("inspector.statAudit")}
          value={String(overview?.audit_events ?? 0)}
          detail={overview?.approvals ? t("inspector.statApprovals", { n: overview.approvals }) : undefined}
        />
      </div>

      <div className="evidence-activity-toolbar" aria-label="Activity filters">
        <div className="evidence-activity-filters">
          <Filter active={showTools} count={tools.length} onClick={() => setShowTools((value) => !value)}>
            {t("inspector.chipTools")}
          </Filter>
          <Filter active={showAudit} count={audit.length} onClick={() => setShowAudit((value) => !value)}>
            {t("inspector.chipAudit")}
          </Filter>
          <Filter active={errorsOnly} onClick={() => setErrorsOnly((value) => !value)}>
            {t("inspector.chipErrors")}
          </Filter>
        </div>
        <span className="evidence-activity-count">{entries.length} visible</span>
      </div>

      <ul className="evidence-activity-list" aria-label="Investigation activity">
        {entries.length ? entries.map((entry) => <ActivityEntry key={entry.id} entry={entry} />) : (
          <li className="workbench-empty-line evidence-activity-empty">No activity matches the current filters.</li>
        )}
      </ul>

      {(tools.length < totals.tools || audit.length < totals.audit) ? (
        <div className="evidence-load-more">
          {tools.length < totals.tools ? (
            <button type="button" onClick={() => void loadMore("tools")} disabled={loadingMore !== null}>
              {loadingMore === "tools" ? t("inspector.loading") : `${t("inspector.loadMore")} ${t("inspector.chipTools")}`}
              <span>{tools.length}/{totals.tools}</span>
            </button>
          ) : null}
          {audit.length < totals.audit ? (
            <button type="button" onClick={() => void loadMore("audit")} disabled={loadingMore !== null}>
              {loadingMore === "audit" ? t("inspector.loading") : `${t("inspector.loadMore")} ${t("inspector.chipAudit")}`}
              <span>{audit.length}/{totals.audit}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
