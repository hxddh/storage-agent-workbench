import { useCallback, useEffect, useState } from "react";
import {
  acceptIssue,
  getEstate,
  listCloudProviders,
  listModelProviders,
  proposeIssueFix,
  verifyIssue,
  type EstateIssue,
  type EstateOverview,
} from "../api";
import { useI18n } from "../i18n";
import { useCopy } from "../hooks/useCopy";
import { timeAgo } from "../lib/time";
import { Badge, Button, SectionLabel, StatusDot, type Tone } from "./ui";
import { severityLabel } from "./SeverityMark";

const SEVERITY_TONE: Record<string, Tone> = { high: "danger", medium: "warn", low: "neutral", info: "outline" };
const FOLD = 5;

/** `false` = checked and missing; `null` = could not be read (offline). */
export type Readiness = { model: string | null | false; storage: number | null | false } | null;

/**
 * v4.0 — the home is "what to care about now". Readiness first (a model and a
 * storage account, each with its real state), then the estate: what earlier
 * tasks established about the user's storage and the issues that need care,
 * most severe first. Every issue opens where it was found, carries a fix the
 * user applies (storage stays read-only) and a read-only Verify.
 */
export function useEstateHome(sidecarReady: boolean) {
  const { lang } = useI18n();
  const [estate, setEstate] = useState<EstateOverview | null>(null);
  const [readiness, setReadiness] = useState<Readiness>(null);
  const reload = useCallback(async () => {
    const [models, clouds, overview] = await Promise.allSettled([
      listModelProviders(), listCloudProviders(), getEstate(lang),
    ]);
    const active = models.status === "fulfilled" ? models.value.find((m) => m.active) ?? models.value[0] : undefined;
    setReadiness({
      model: models.status === "fulfilled" ? (active ? active.model || active.name : false) : null,
      storage: clouds.status === "fulfilled" ? (clouds.value.length || false) : null,
    });
    if (overview.status === "fulfilled") setEstate(overview.value);
  }, [lang]);
  useEffect(() => {
    if (!sidecarReady) return;
    void reload();
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [sidecarReady, reload]);
  return { estate, readiness, reload };
}

export function ReadinessCheck({ readiness, onOpenSettings }: { readiness: Readiness; onOpenSettings: () => void }) {
  const { t } = useI18n();
  // Only a checked-and-missing prerequisite is shown; an unreachable runtime
  // is the offline banner's to say.
  if (!readiness || (readiness.model !== false && readiness.storage !== false)) return null;
  const rows = [
    { key: "model", label: t("ready.model"), ok: Boolean(readiness.model),
      text: readiness.model ? t("ready.modelReady", { name: String(readiness.model) }) : t("ready.modelMissing") },
    { key: "storage", label: t("ready.storage"), ok: Boolean(readiness.storage),
      text: readiness.storage ? t("ready.storageReady", { n: readiness.storage }) : t("ready.storageMissing") },
  ];
  return (
    <section className="estate-ready" data-testid="readiness" aria-label={t("ready.title")}>
      <SectionLabel>{t("ready.title")}</SectionLabel>
      <ul className="estate-ready-list">
        {rows.map((row) => (
          <li key={row.key} className="estate-ready-row" data-testid={`readiness-${row.key}`} data-ready={row.ok ? "true" : "false"}>
            <StatusDot tone={row.ok ? "success" : "warn"} />
            <span className="estate-ready-label">{row.label}</span>
            <span className="estate-ready-text">{row.text}</span>
            {row.ok ? null : (
              <Button size="sm" variant="secondary" onClick={onOpenSettings}>{t("ready.setUp")}</Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function IssueRow({
  issue,
  onChange,
  onOpenTask,
}: {
  issue: EstateIssue;
  onChange: (next: EstateIssue) => void;
  onOpenTask: (id: string) => void;
}) {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"fix" | "verify" | "accept" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { copied, copy } = useCopy();
  const act = async (kind: "fix" | "verify" | "accept", run: () => Promise<EstateIssue>) => {
    setBusy(kind);
    setError(null);
    try {
      onChange(await run());
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  };
  const verified = issue.last_verify_result && issue.last_verified_at
    ? t(`issue.result.${issue.last_verify_result}`, { when: timeAgo(issue.last_verified_at, t) })
    : null;
  return (
    <li className="estate-issue" data-testid="estate-issue" data-issue-code={issue.code} data-status={issue.status}>
      <button type="button" className="estate-issue-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Badge tone={SEVERITY_TONE[issue.severity] ?? "neutral"} className="result-finding-badge" data-severity={issue.severity}>
          {severityLabel(issue.severity, t)}
        </Badge>
        <span className="estate-issue-title">{issue.title}</span>
        <span className="estate-issue-bucket">{issue.bucket}</span>
        <span className="estate-issue-state">
          {issue.status === "open" ? t("issue.seen", { when: timeAgo(issue.last_seen_at, t) }) : t(`issue.status.${issue.status}`)}
        </span>
      </button>
      {open ? (
        <div className="estate-issue-body">
          {issue.detail ? <p>{issue.detail}</p> : null}
          {issue.fix ? (
            <div className="estate-fix" data-testid="issue-fix">
              <p className="estate-fix-title">{t("issue.fixTitle")}</p>
              <pre className="estate-fix-command"><code>{issue.fix.command}</code></pre>
              {issue.fix.notes.length ? (
                <ul className="estate-fix-notes">{issue.fix.notes.map((note) => <li key={note}>{note}</li>)}</ul>
              ) : null}
            </div>
          ) : !issue.fixable ? (
            <p className="estate-issue-note">{t("issue.noFix")}</p>
          ) : null}
          {verified ? <p className="estate-issue-note" data-testid="issue-verify-result">{verified}</p> : null}
          {error ? <p className="estate-issue-note" role="alert">{t("issue.failed", { error })}</p> : null}
          <div className="estate-issue-actions">
            {issue.fixable && !issue.fix ? (
              <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void act("fix", () => proposeIssueFix(issue.id, lang))}>
                {t("issue.fix")}
              </Button>
            ) : null}
            {issue.fix ? (
              <Button size="sm" variant="secondary" onClick={() => copy(issue.fix?.command ?? "")}>
                {copied ? t("common.copied") : t("common.copy")}
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" disabled={busy !== null} data-testid="issue-verify"
              onClick={() => void act("verify", async () => (await verifyIssue(issue.id, lang)).issue)}>
              {busy === "verify" ? t("issue.verifying") : t("issue.verify")}
            </Button>
            {issue.source_task_id ? (
              <Button size="sm" variant="ghost" onClick={() => onOpenTask(issue.source_task_id as string)}>{t("issue.openTask")}</Button>
            ) : null}
            <Button size="sm" variant="ghost" disabled={busy !== null}
              onClick={() => void act("accept", () => acceptIssue(issue.id, issue.status !== "accepted", lang))}>
              {issue.status === "accepted" ? t("issue.unaccept") : t("issue.accept")}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function EstatePanel({
  estate,
  onOpenTask,
}: {
  estate: EstateOverview | null;
  onOpenTask: (id: string) => void;
}) {
  const { t } = useI18n();
  const [all, setAll] = useState(false);
  const [local, setLocal] = useState<Record<string, EstateIssue>>({});
  useEffect(() => setLocal({}), [estate]);
  if (!estate || estate.providers.length === 0) return null;
  const lastChecked = estate.providers.map((p) => p.last_checked_at).filter(Boolean).sort().pop() ?? null;
  const issues = estate.issues.map((issue) => local[issue.id] ?? issue);
  const shown = all ? issues : issues.slice(0, FOLD);
  const meta = lastChecked
    ? t("estate.meta", { accounts: estate.providers.length, buckets: estate.bucket_count, when: timeAgo(lastChecked, t) })
    : t("estate.metaNever", { accounts: estate.providers.length });
  return (
    <section className="estate-panel" data-testid="estate-panel" aria-label={t("estate.title")}>
      <div className="estate-head">
        <SectionLabel>{t("estate.title")}</SectionLabel>
        <span className="estate-meta" data-testid="estate-meta">
          {meta}
          {estate.last_watch_at ? ` · ${t("estate.lastWatch", { when: timeAgo(estate.last_watch_at, t) })}` : ""}
        </span>
      </div>
      {estate.bucket_count === 0 ? (
        <p className="agent-empty-line">{t("estate.empty")}</p>
      ) : issues.length === 0 ? (
        <p className="agent-empty-line" data-testid="estate-all-clear">{t("estate.allClear")}</p>
      ) : (
        <>
          <SectionLabel count={estate.open_issue_count}>{t("estate.care")}</SectionLabel>
          <ul className="estate-issues" data-testid="estate-issues">
            {shown.map((issue) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                onOpenTask={onOpenTask}
                // The row keeps its new state (Resolved, Accepted) in place
                // until the estate is next read, so the outcome stays visible.
                onChange={(next) => setLocal((prev) => ({ ...prev, [next.id]: next }))}
              />
            ))}
          </ul>
          {issues.length > FOLD ? (
            <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>
              {all ? t("estate.showFewer") : t("estate.showAll", { n: issues.length })}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
