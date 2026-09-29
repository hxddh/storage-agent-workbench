import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { BucketPage, BucketRow, Estate, TimelineEntry } from "../api/types";
import { Icon } from "../components/icons";
import { Badge, Button, SectionLabel, StatusDot } from "../components/ui";
import { useI18n } from "../i18n";
import { timeAgo } from "../lib/time";
import { useApp } from "../shell/context";
import { SEVERITY_TONE } from "../task/Result";
import { IssueCard } from "./IssueCard";
import { Notes } from "./Notes";

/**
 * The estate: every account, an account's buckets (most in need of care
 * first), and a bucket page — what is known, its Issues, how it changed and
 * the notes kept about it. Nothing here submits work: *Ask about this bucket*
 * only fills the Composer.
 */
export function EstatePage({ providerId, bucket }: { providerId?: string; bucket?: string }) {
  if (providerId && bucket) return <BucketView key={`${providerId}/${bucket}`} providerId={providerId} bucket={bucket} />;
  if (providerId) return <AccountView key={providerId} providerId={providerId} />;
  return <AccountsView />;
}

function useEstate() {
  const { lang } = useI18n();
  const [estate, setEstate] = useState<Estate | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api.estate(lang).then((e) => live && setEstate(e)).catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [lang]);
  return { estate, failed };
}

function Crumbs({ providerId, name, bucket }: { providerId?: string; name?: string; bucket?: string }) {
  const { t } = useI18n();
  const app = useApp();
  return (
    <nav className="crumbs" aria-label={t("estate.crumbs")}>
      <button type="button" onClick={() => app.openEstate()}>{t("nav.estate")}</button>
      {providerId ? (
        <>
          <Icon name="chevron" size={12} />
          {bucket ? <button type="button" onClick={() => app.openEstate(providerId)}>{name ?? "…"}</button> : <span>{name ?? "…"}</span>}
        </>
      ) : null}
      {bucket ? (<><Icon name="chevron" size={12} /><span className="mono">{bucket}</span></>) : null}
    </nav>
  );
}

function openCount(o: { high: number; medium: number; low: number }) {
  return o.high + o.medium + o.low;
}

function CareBadge({ open }: { open: { high: number; medium: number; low: number } }) {
  const n = openCount(open);
  if (!n) return null;
  return <Badge tone={open.high ? "danger" : open.medium ? "warn" : "neutral"}>{n}</Badge>;
}

function AccountsView() {
  const { t } = useI18n();
  const app = useApp();
  const { estate, failed } = useEstate();
  return (
    <div className="estate-page" data-testid="estate-page">
      <h1 className="page-title">{t("nav.estate")}</h1>
      {failed ? <p className="quiet-note">{t("estate.unavailable")}</p> : null}
      {estate && estate.providers.length === 0 ? (
        <div className="estate-empty">
          <p>{t("estate.empty")}</p>
          <Button onClick={() => app.openSettings("storage")}>{t("home.ready.storage")}</Button>
        </div>
      ) : null}
      {estate?.providers.length ? (
        <ul className="estate-accounts">
          {estate.providers.map((p) => (
            <li key={p.provider_id} className="estate-account">
              <button type="button" className="estate-account-link" onClick={() => app.openEstate(p.provider_id)}
                data-testid="estate-account">
                <div className="estate-account-head">
                  <Icon name="storage" size={16} />
                  <span className="estate-account-name">{p.name}</span>
                  <CareBadge open={p.open_issues} />
                </div>
                <p className="estate-account-meta">
                  {[t("home.buckets", { n: p.bucket_count }),
                    p.last_checked_at ? t("home.checked", { when: timeAgo(p.last_checked_at, t) }) : t("home.neverChecked"),
                  ].join(" · ")}
                </p>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <section className="page-section" aria-labelledby="estate-notes">
        <SectionLabel id="estate-notes">{t("notes.title")}</SectionLabel>
        <Notes scope={{}} />
      </section>
    </div>
  );
}

function AccountView({ providerId }: { providerId: string }) {
  const { t } = useI18n();
  const app = useApp();
  const { estate } = useEstate();
  const [rows, setRows] = useState<BucketRow[] | null>(null);
  const [notFound, setNotFound] = useState(false);
  useEffect(() => {
    let live = true;
    api.buckets(providerId).then((r) => live && setRows(r.buckets)).catch(() => live && setNotFound(true));
    return () => { live = false; };
  }, [providerId]);
  const account = estate?.providers.find((p) => p.provider_id === providerId);
  return (
    <div className="estate-page" data-testid="estate-account-page">
      <Crumbs providerId={providerId} name={account?.name} />
      <h1 className="page-title">{account?.name ?? (notFound ? t("estate.notFound") : "…")}</h1>
      {account ? (
        <p className="page-meta">
          {[t("home.buckets", { n: account.bucket_count }),
            account.last_checked_at ? t("home.checked", { when: timeAgo(account.last_checked_at, t) }) : t("home.neverChecked"),
            account.watch.enabled ? t("home.watched", { interval: [6, 24, 168].includes(account.watch.interval_hours) ? t(`interval.${account.watch.interval_hours}`) : `${account.watch.interval_hours} h` }) : t("home.notWatched"),
          ].join(" · ")}
        </p>
      ) : null}
      <section className="page-section" aria-labelledby="bucket-list">
        <SectionLabel id="bucket-list" count={rows?.length ?? null}>{t("estate.buckets")}</SectionLabel>
        {rows && rows.length === 0 ? <p className="quiet-note">{t("estate.noBuckets")}</p> : null}
        {rows?.length ? (
          <ul className="bucket-list">
            {rows.map((r) => (
              <li key={r.bucket}>
                <button type="button" className="bucket-row" onClick={() => app.openEstate(providerId, r.bucket)}
                  data-testid="bucket-row">
                  <span className="bucket-name mono">{r.bucket}</span>
                  <span className="bucket-meta">
                    {[r.region, r.last_checked_at ? t("home.checked", { when: timeAgo(r.last_checked_at, t) }) : null]
                      .filter(Boolean).join(" · ")}
                  </span>
                  <CareBadge open={r.open_issues} />
                  <Icon name="chevron" size={14} className="bucket-caret" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      <section className="page-section" aria-labelledby="account-notes">
        <SectionLabel id="account-notes">{t("notes.title")}</SectionLabel>
        <Notes scope={{ providerId }} accountOnly />
      </section>
    </div>
  );
}

const POSTURE_ORDER = [
  "publicly_exposed", "policy_is_public", "acl_public", "public_access_block_status", "policy_status",
  "encryption_status", "versioning_status", "lifecycle_status", "logging_status", "replication_status",
  "object_ownership", "acls_disabled", "inventory_status", "tagging_status", "access_status", "head_bucket_status",
];

function postureValue(v: unknown, t: (k: string) => string): string {
  if (v === true) return t("posture.yes");
  if (v === false) return t("posture.no");
  if (v === null || v === undefined || v === "") return t("posture.unknown");
  return String(v).replace(/_/g, " ");
}

function BucketView({ providerId, bucket }: { providerId: string; bucket: string }) {
  const { t, lang } = useI18n();
  const app = useApp();
  const { estate } = useEstate();
  const [page, setPage] = useState<BucketPage | null>(null);
  const [notFound, setNotFound] = useState(false);
  const reload = useCallback(() => {
    api.bucket(providerId, bucket, lang).then(setPage).catch(() => setNotFound(true));
  }, [providerId, bucket, lang]);
  useEffect(() => reload(), [reload]);
  const account = estate?.providers.find((p) => p.provider_id === providerId);
  const posture = page ? POSTURE_ORDER.filter((k) => k in page.posture) : [];
  const care = page?.issues.filter((i) => i.status !== "resolved") ?? [];
  const past = page?.issues.filter((i) => i.status === "resolved") ?? [];

  const ask = () => {
    app.prefill(t("estate.askPrompt", { bucket, account: account?.name ?? "" }));
    app.goHome();
  };

  return (
    <div className="estate-page" data-testid="bucket-page">
      <Crumbs providerId={providerId} name={account?.name} bucket={bucket} />
      <div className="page-head">
        <h1 className="page-title mono">{bucket}</h1>
        <Button icon="compose" onClick={ask} data-testid="ask-bucket">{t("estate.ask")}</Button>
      </div>
      {notFound ? <p className="quiet-note">{t("estate.notFound")}</p> : null}
      {page ? (
        <>
          <p className="page-meta">
            {[page.region, page.last_checked_at ? t("home.checked", { when: timeAgo(page.last_checked_at, t) }) : t("home.neverChecked")]
              .filter(Boolean).join(" · ")}
            {page.source_task_id ? (
              <> · <button type="button" className="link" onClick={() => app.openTask(page.source_task_id!)}>{t("estate.foundBy")}</button></>
            ) : null}
          </p>
          <section className="page-section" aria-labelledby="bucket-issues">
            <SectionLabel id="bucket-issues" count={care.length}>{t("home.care")}</SectionLabel>
            {care.length ? (
              <ul className="issues">{care.map((i) => <IssueCard key={i.id} issue={i} onChange={reload} showBucket={false} />)}</ul>
            ) : <p className="quiet-note">{t("estate.nothingOpen")}</p>}
            {past.length ? (
              <details className="past-issues">
                <summary>{t("estate.resolved", { n: past.length })}</summary>
                <ul className="issues">{past.map((i) => <IssueCard key={i.id} issue={i} onChange={reload} showBucket={false} />)}</ul>
              </details>
            ) : null}
          </section>
          {posture.length ? (
            <section className="page-section" aria-labelledby="bucket-posture">
              <SectionLabel id="bucket-posture">{t("estate.posture")}</SectionLabel>
              <dl className="posture">
                {posture.map((k) => (
                  <div key={k} className="posture-row">
                    <dt>{t(`posture.${k}`)}</dt>
                    <dd>{postureValue(page.posture[k], t)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
          <section className="page-section" aria-labelledby="bucket-notes">
            <SectionLabel id="bucket-notes">{t("notes.title")}</SectionLabel>
            <Notes scope={{ providerId, bucket }} initial={page.notes} />
          </section>
          {page.timeline.length ? (
            <section className="page-section" aria-labelledby="bucket-timeline">
              <SectionLabel id="bucket-timeline">{t("estate.timeline")}</SectionLabel>
              <ol className="timeline" data-testid="timeline">
                {page.timeline.map((e, n) => <TimelineRow key={n} entry={e} />)}
              </ol>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  const { t } = useI18n();
  const app = useApp();
  const source = entry.source ? t(`timeline.source.${entry.source}`) : null;
  return (
    <li className="timeline-row" data-kind={entry.kind}>
      <span className="timeline-mark" aria-hidden>
        {entry.kind === "issue" ? <StatusDot tone={entry.event === "resolved" ? "success" : SEVERITY_TONE[entry.severity] === "danger" ? "danger" : entry.event === "opened" || entry.event === "recurred" ? "warn" : "neutral"} /> : <StatusDot tone="neutral" />}
      </span>
      <span className="timeline-text">
        {entry.kind === "issue"
          ? <>{t(`timeline.event.${entry.event}`)} — {entry.title}</>
          : entry.first
            ? t("timeline.firstSeen")
            : t("timeline.changed", { what: entry.changed.map((k) => t(`posture.${k}`)).join(", ") })}
      </span>
      <span className="timeline-meta">
        {[source, timeAgo(entry.at, t)].filter(Boolean).join(" · ")}
        {entry.kind === "posture" && entry.task_id ? (
          <> · <button type="button" className="link" onClick={() => app.openTask(entry.task_id!)}>{t("estate.task")}</button></>
        ) : null}
      </span>
    </li>
  );
}
