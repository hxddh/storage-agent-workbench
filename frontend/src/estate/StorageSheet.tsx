import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { BucketRow, Estate, EstateProvider, Issue } from "../api/types";
import { Icon } from "../components/icons";
import { Button, StatusDot } from "../components/ui";
import { useI18n } from "../i18n";
import { SEVERITY_TONE } from "../lib/severity";
import { timeAgo } from "../lib/time";
import { Pane } from "../inspector/Inspector";
import { useApp } from "../shell/context";

/**
 * Storage, in the one side pane. This is the estate surface: accounts, what
 * needs attention, and the buckets it was found on. Home stays an empty canvas;
 * the sheet is opened from the sidebar and never submits work.
 */
export function StorageSheet() {
  const { t, lang } = useI18n();
  const app = useApp();
  const [estate, setEstate] = useState<Estate | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(async () => {
    try {
      setEstate(await api.estate(lang));
      setFailed(false);
    } catch {
      setFailed(true);
      setEstate(null);
    }
  }, [lang]);
  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), 60_000);
    return () => clearInterval(timer);
  }, [reload]);
  // Verifying or accepting an Issue in a bucket sheet changes the estate.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    void reload();
  }, [app.estateRev]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Pane title={t("storage.title")} testId="storage-sheet">
      <div className="storage-sheet" data-testid="storage-sheet-body">
        {failed ? <p className="quiet-note">{t("storage.failed")}</p> : null}
        {!failed && estate === null ? <p className="quiet-note">{t("storage.loading")}</p> : null}
        {estate ? (
          estate.providers.length === 0 ? (
            <div className="storage-empty">
              <p>{t("storage.empty")}</p>
              <Button size="sm" icon="plus" onClick={() => app.openSettings("storage")}>
                {t("storage.add")}
              </Button>
            </div>
          ) : (
            <>
              <ul className="storage-accounts" data-testid="estate">
                {estate.providers.map((p) => <StorageAccount key={p.provider_id} provider={p} />)}
              </ul>
              <Attention estate={estate} />
            </>
          )
        ) : null}
      </div>
    </Pane>
  );
}

/**
 * One account. Its bucket list is fetched only when the reader opens it, so the
 * sheet stays a quiet status surface until they want the bucket index.
 */
function StorageAccount({ provider }: { provider: EstateProvider }) {
  const { t } = useI18n();
  const app = useApp();
  const [buckets, setBuckets] = useState<BucketRow[] | null>(null);
  const [reading, setReading] = useState(false);
  const [failed, setFailed] = useState(false);
  const load = async () => {
    if (buckets || reading) return;
    setReading(true);
    try {
      setBuckets((await api.buckets(provider.provider_id)).buckets);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setReading(false);
    }
  };
  const when = provider.last_checked_at
    ? t("home.checked", { when: timeAgo(provider.last_checked_at, t) }) : t("home.neverChecked");
  return (
    <li className="storage-account">
      <div className="storage-account-head">
        <span className="storage-account-name">{provider.name}</span>
        {provider.watch.enabled ? (
          <span className="storage-account-watch" title={t("storage.watched")} aria-label={t("storage.watched")} role="img">
            <Icon name="shield" size={13} />
          </span>
        ) : null}
      </div>
      {provider.last_checked_at && provider.bucket_count > 0 ? (
        <details className="storage-buckets" data-testid="storage-buckets"
          onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) void load(); }}>
          <summary>
            <Icon name="chevron" size={11} />
            <span>{t("home.buckets", { n: provider.bucket_count })}</span>
            <span className="storage-account-when">· {when}</span>
          </summary>
          {reading ? <p className="quiet-note">{t("storage.loading")}</p>
            : failed ? <p className="quiet-note">{t("storage.failed")}</p>
              : buckets ? (
                buckets.length ? (
                  <ul className="storage-bucket-list">
                    {buckets.map((b) => (
                      <li key={b.bucket}>
                        <button type="button" onClick={() => app.openBucket(provider.provider_id, b.bucket)}>
                          {b.bucket}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : <p className="quiet-note">{t("storage.noBuckets")}</p>
              ) : null}
        </details>
      ) : (
        <p className="storage-account-meta">
          {[provider.last_checked_at ? t("home.buckets", { n: provider.bucket_count }) : null, when]
            .filter(Boolean).join(" · ")}
          {provider.last_checked_at ? null : (
            <>
              {" · "}
              <button type="button" className="link" data-testid="not-checked"
                onClick={() => { app.setPane(null); app.prefill(t("storage.surveyPrompt")); }}>
                {t("home.survey")}
              </button>
            </>
          )}
        </p>
      )}
    </li>
  );
}

type Group = { key: string; title: string; severity: Issue["severity"]; recurred: boolean; issues: Issue[] };

const RANK: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };

/** One row per kind of issue, most severe first, then by title; buckets by name. */
function groupIssues(issues: Issue[]): Group[] {
  const out = new Map<string, Group>();
  for (const i of issues) {
    const key = `${i.code}:${i.severity}`;
    const g = out.get(key) ?? { key, title: i.title, severity: i.severity, recurred: false, issues: [] };
    g.issues.push(i);
    g.recurred ||= i.status === "recurred";
    out.set(key, g);
  }
  const groups = [...out.values()];
  for (const g of groups) g.issues.sort((a, b) => a.bucket.localeCompare(b.bucket));
  return groups.sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9) || a.title.localeCompare(b.title));
}

const SHOWN_BUCKETS = 3;

function Attention({ estate }: { estate: Estate }) {
  const { t } = useI18n();
  const groups = useMemo(() => groupIssues(estate.issues), [estate.issues]);
  // A read that could not see an account decides nothing: only say "nothing
  // needs care" when every account has been checked.
  const allChecked = estate.providers.every((p) => !!p.last_checked_at);
  if (!allChecked && groups.length === 0) return null;
  return (
    <section className="attention" aria-labelledby="storage-attention" data-testid="needs-care">
      <div className="attention-head">
        <h2 id="storage-attention" className="attention-title">{t("home.care")}</h2>
        {estate.open_issue_count ? <span className="attention-count">{t("home.openCount", { n: estate.open_issue_count })}</span> : null}
      </div>
      {groups.length ? (
        <ul className="attention-list">
          {groups.map((g) => <AttentionRow key={g.key} group={g} />)}
        </ul>
      ) : <p className="quiet-note">{t("home.careEmpty")}</p>}
    </section>
  );
}

function AttentionRow({ group }: { group: Group }) {
  const { t } = useI18n();
  const app = useApp();
  const [all, setAll] = useState(false);
  const tone = SEVERITY_TONE[group.severity];
  const shown = all ? group.issues : group.issues.slice(0, SHOWN_BUCKETS);
  const rest = group.issues.length - shown.length;
  return (
    <li className="attention-row" data-testid="issue" data-severity={group.severity}>
      <StatusDot tone={tone === "outline" ? "neutral" : tone} />
      <span className="sr-only">{t(`sev.${group.severity}`)}: </span>
      <span className="attention-issue">{group.title}</span>
      <span className="attention-note">{t("home.issueCount", { n: group.issues.length })}</span>
      {group.recurred ? <span className="attention-note">{t("issue.status.recurred")}</span> : null}
      <span className="attention-where">
        {shown.map((i) => (
          <button key={i.id} type="button" className="attention-bucket" data-testid="issue-bucket"
            aria-pressed={app.pane?.tab === "bucket" && app.pane.providerId === i.provider_id && app.pane.bucket === i.bucket}
            onClick={() => app.openBucket(i.provider_id, i.bucket)}>{i.bucket}</button>
        ))}
        {rest > 0 ? (
          <button type="button" className="attention-bucket" data-more="true" onClick={() => setAll(true)}>
            {t("home.moreBuckets", { n: rest })}
          </button>
        ) : null}
      </span>
    </li>
  );
}
