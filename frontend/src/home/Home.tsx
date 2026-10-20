import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Estate, Issue } from "../api/types";
import { Composer } from "../composer/Composer";
import { Icon, type IconName } from "../components/icons";
import { StatusDot } from "../components/ui";
import { setTrayStatus } from "../hooks/useNativeAgent";
import { useI18n } from "../i18n";
import { SEVERITY_TONE } from "../lib/severity";
import { timeAgo } from "../lib/time";
import { useApp } from "../shell/context";

/**
 * The home is a new conversation: the greeting, the Composer, three starters
 * that only fill it — and, below, what needs attention in the storage the
 * Agent knows (each opens its bucket beside the Composer). Nothing here
 * submits work except the Composer.
 */
export function Home() {
  const { t } = useI18n();
  const app = useApp();
  const noStorage = (app.clouds ?? []).length === 0;
  const starters: Array<{ key: string; needsStorage: boolean; icon: IconName }> = [
    { key: "access", needsStorage: false, icon: "alert" },
    { key: "survey", needsStorage: true, icon: "layers" },
    { key: "log", needsStorage: false, icon: "activity" },
  ];
  const shown = starters.filter((s) => !(s.needsStorage && noStorage && app.clouds !== null));
  return (
    <div className="home" data-testid="home">
      <section className="home-hero">
        <p className="home-kicker"><span className="home-kicker-mark" aria-hidden />{t("home.kicker")}</p>
        <h1 className="home-greeting">{t("home.greeting")}</h1>
        <p className="home-lede">{t("home.lede")}</p>
        <Composer taskId={null} busy={false} onCreated={app.openTask} autoFocus />
        <div className="starters">
          {shown.map((s) => (
            <button key={s.key} type="button" className="starter" onClick={() => app.prefill(t(`home.starter.${s.key}Prompt`))}>
              <span className="starter-icon" aria-hidden><Icon name={s.icon} size={16} /></span>
              <span className="starter-copy">
                <span className="starter-label">{t(`home.starter.${s.key}`)}</span>
                <span className="starter-hint">{t(`home.starter.${s.key}Hint`)}</span>
              </span>
              <Icon name="arrowRight" size={14} className="starter-arrow" />
            </button>
          ))}
        </div>
        <Readiness />
      </section>
      <Attention />
    </div>
  );
}

/** One sentence when a model or a storage account is missing — never a wall of cards. */
function Readiness() {
  const { t } = useI18n();
  const app = useApp();
  if (app.models === null || app.clouds === null) return null;
  const noModel = app.models.length === 0;
  const noStorage = app.clouds.length === 0;
  if (!noModel && !noStorage) return null;
  return (
    <p className="readiness" data-testid="readiness">
      {noModel ? (
        <><button type="button" className="link" onClick={() => app.openSettings("models")}>{t("home.ready.model")}</button>
          {noStorage ? t("home.ready.and") : null}</>
      ) : null}
      {noStorage ? (
        <button type="button" className="link" onClick={() => app.openSettings("storage")}>{t("home.ready.storage")}</button>
      ) : null}
      {t("home.ready.tail")}
    </p>
  );
}

/** What needs attention, most severe first: one row per kind of issue, naming
 * every bucket it was found on; a bucket opens beside the Composer. */
function Attention() {
  const { t, lang } = useI18n();
  const app = useApp();
  const [estate, setEstate] = useState<Estate | null>(null);
  const reload = useCallback(async () => {
    try {
      const next = await api.estate(lang);
      setEstate(next);
      void setTrayStatus(next.open_issue_count ? t("home.careCount", { n: next.open_issue_count }) : t("home.careEmpty"));
    } catch {
      setEstate(null);
    }
  }, [lang, t]);
  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), 60_000);
    return () => clearInterval(timer);
  }, [reload]);
  // The sheet changed an issue (verify, accept): read again at once.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    void reload();
  }, [app.estateRev]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!estate || estate.providers.length === 0) return null;
  const groups = groupIssues(estate.issues);
  const checked = estate.providers.some((p) => p.last_checked_at);
  const survey = () => app.prefill(t("home.starter.surveyPrompt"));
  return (
    <section className="attention" aria-labelledby={checked || groups.length ? "attention-label" : undefined} data-testid="needs-care">
      {checked || groups.length ? (
        <div className="attention-head">
          <h2 id="attention-label" className="attention-title">{t("home.care")}</h2>
          {estate.open_issue_count ? <span className="attention-count">{estate.open_issue_count}</span> : null}
        </div>
      ) : null}
      {groups.length ? (
        <ul className="attention-list">
          {groups.map((g) => <AttentionRow key={g.key} group={g} />)}
        </ul>
      ) : checked ? <p className="quiet-note">{t("home.careEmpty")}</p> : null}
      {/* One quiet line per account; storage never checked says so and offers the survey. */}
      <ul className="accounts" data-testid="estate">
        {estate.providers.map((p) => (
          <li key={p.provider_id}>
            {[
              p.name,
              p.last_checked_at ? t("home.buckets", { n: p.bucket_count }) : null,
              p.last_checked_at ? t("home.checked", { when: timeAgo(p.last_checked_at, t) }) : t("home.neverChecked"),
              p.watch.enabled ? t("home.watched") : null,
            ].filter(Boolean).join(" · ")}
            {p.last_checked_at ? null : (
              <>{" · "}<button type="button" className="link" data-testid="not-checked" onClick={survey}>{t("home.survey")}</button></>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

type Group = { key: string; title: string; severity: Issue["severity"]; recurred: boolean; issues: Issue[] };

const RANK: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };

/** One row per kind of issue, most severe first, then by title; buckets by name — the
 * order stays put while issues change around it. */
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
