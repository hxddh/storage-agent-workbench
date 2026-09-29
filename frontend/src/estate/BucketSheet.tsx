import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { BucketPage, TimelineEntry } from "../api/types";
import { Button, StatusDot } from "../components/ui";
import { useI18n } from "../i18n";
import { SEVERITY_TONE } from "../lib/severity";
import { timeAgo } from "../lib/time";
import { Pane } from "../inspector/Inspector";
import { useApp } from "../shell/context";
import { IssueCard } from "./IssueCard";
import { Notes } from "./Notes";

/**
 * One bucket, beside the Composer: what needs attention (each with its fix
 * and Verify), its configuration — what deviates first — the notes kept about
 * it, and its history. *Ask about this bucket* fills the Composer in place.
 */
export function BucketSheet({ providerId, bucket }: { providerId: string; bucket: string }) {
  const { t, lang } = useI18n();
  const app = useApp();
  const [page, setPage] = useState<BucketPage | null>(null);
  const [missing, setMissing] = useState(false);
  const reload = useCallback(() => {
    api.bucket(providerId, bucket, lang).then((p) => { setPage(p); setMissing(false); }).catch(() => setMissing(true));
  }, [providerId, bucket, lang]);
  useEffect(() => reload(), [reload]);
  const account = app.clouds?.find((c) => c.id === providerId)?.name ?? "";
  // An issue this visit touched stays where it was, so its Verify result stays readable.
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const changed = (id: string) => { setTouched((s) => new Set(s).add(id)); reload(); app.estateChanged(); };
  const care = page?.issues.filter((i) => i.status !== "resolved" || touched.has(i.id)) ?? [];
  const past = page?.issues.filter((i) => i.status === "resolved" && !touched.has(i.id)) ?? [];
  const ask = () => {
    app.prefill(t("bucket.askPrompt", { bucket, account }));
  };
  return (
    <Pane title={bucket} testId="bucket-sheet">
      <div className="bucket" data-testid="bucket-page">
        <p className="bucket-meta">
          {[account, page?.region, page?.last_checked_at ? t("home.checked", { when: timeAgo(page.last_checked_at, t) }) : null]
            .filter(Boolean).join(" · ")}
        </p>
        <Button size="sm" icon="compose" onClick={ask} data-testid="ask-bucket">{t("bucket.ask")}</Button>
        {missing ? <p className="quiet-note">{t("bucket.unknown")}</p> : null}
        {page ? (
          <>
            {care.length ? (
              <ul className="issues">{care.map((i) => <IssueCard key={i.id} issue={i} onChange={() => changed(i.id)} />)}</ul>
            ) : <p className="quiet-note">{t("bucket.nothing")}</p>}
            {past.length ? (
              <details className="fold">
                <summary>{t("bucket.resolved", { n: past.length })}</summary>
                <ul className="issues">{past.map((i) => <IssueCard key={i.id} issue={i} onChange={() => changed(i.id)} />)}</ul>
              </details>
            ) : null}
            <Configuration posture={page.posture} />
            <h3 className="pane-label">{t("notes.title")}</h3>
            <Notes scope={{ providerId, bucket }} initial={page.notes} />
            {page.timeline.length ? (
              <details className="fold">
                <summary>{t("bucket.history")}</summary>
                <ol className="timeline" data-testid="timeline">
                  {page.timeline.map((e, n) => <TimelineRow key={n} entry={e} />)}
                </ol>
              </details>
            ) : null}
          </>
        ) : null}
      </div>
    </Pane>
  );
}

const ORDER = [
  "publicly_exposed", "policy_is_public", "acl_public", "public_access_block_status", "policy_status",
  "encryption_status", "versioning_status", "lifecycle_status", "logging_status", "replication_status",
  "object_ownership", "acls_disabled", "inventory_status", "tagging_status", "access_status", "head_bucket_status",
];
const EXPOSURE = new Set(["publicly_exposed", "policy_is_public", "acl_public"]);
// A missing protection is worth a look; a missing policy, replication or tags is not.
const PROTECTIONS = new Set(["public_access_block_status", "encryption_status", "versioning_status",
  "lifecycle_status", "logging_status"]);
const WORDS = new Set(["access_denied", "available", "error", "not_configured", "provider_unsupported", "Enabled", "Suspended", "region_mismatch"]);
const REACHABILITY = new Set(["access_status", "head_bucket_status"]);

/** A setting worth a look: exposure that is on, a protection that is missing, a read that failed. */
function deviates(key: string, v: unknown): boolean {
  if (EXPOSURE.has(key)) return v === true;
  if (REACHABILITY.has(key)) return v !== "available" && v != null;
  if (v === "access_denied" || v === "error") return true;
  return PROTECTIONS.has(key) && v === "not_configured";
}

function Configuration({ posture }: { posture: Record<string, unknown> }) {
  const { t } = useI18n();
  const keys = ORDER.filter((k) => k in posture && posture[k] !== null && posture[k] !== undefined && posture[k] !== "");
  const shown = keys.filter((k) => deviates(k, posture[k]));
  if (!keys.length) return null;
  const value = (k: string, v: unknown) => {
    if (v === true) return t("posture.yes");
    if (v === false) return t("posture.no");
    if (v === "available" && REACHABILITY.has(k)) return t("posture.value.ok");
    const s = String(v);
    return WORDS.has(s) ? t(`posture.value.${s}`) : s.replace(/_/g, " ");
  };
  return (
    <div className="config">
      <h3 className="pane-label">{t("bucket.config")}</h3>
      {shown.length ? (
        <dl className="config-list">
          {shown.map((k) => (
            <div key={k} className="config-row">
              <dt>{t(`posture.${k}`)}</dt>
              <dd>{value(k, posture[k])}</dd>
            </div>
          ))}
        </dl>
      ) : <p className="quiet-note">{t("bucket.configClean")}</p>}
    </div>
  );
}

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  const { t } = useI18n();
  const source = entry.source ? t(`timeline.source.${entry.source}`) : null;
  const tone = entry.kind === "issue"
    ? entry.event === "resolved" ? "success" : SEVERITY_TONE[entry.severity] === "danger" ? "danger"
      : entry.event === "opened" || entry.event === "recurred" ? "warn" : "neutral"
    : "neutral";
  return (
    <li className="timeline-row" data-kind={entry.kind}>
      <span className="timeline-mark" aria-hidden><StatusDot tone={tone} /></span>
      <span className="timeline-text">
        {entry.kind === "issue"
          ? <>{t(`timeline.event.${entry.event}`)} — {entry.title}</>
          : entry.first ? t("timeline.firstSeen")
            : t("timeline.changed", { what: entry.changed.map((k) => t(`posture.${k}`)).join(", ") })}
      </span>
      <span className="timeline-meta">{[source, timeAgo(entry.at, t)].filter(Boolean).join(" · ")}</span>
    </li>
  );
}
