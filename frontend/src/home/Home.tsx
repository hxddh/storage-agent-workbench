import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { Estate, Issue } from "../api/types";
import { Composer } from "../composer/Composer";
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
  const starters = [
    { key: "access", needsStorage: false },
    { key: "survey", needsStorage: true },
    { key: "log", needsStorage: false },
  ].filter((s) => !(s.needsStorage && noStorage && app.clouds !== null));
  return (
    <div className="home" data-testid="home">
      <h1 className="home-greeting">{t("home.greeting")}</h1>
      <Composer taskId={null} busy={false} onCreated={app.openTask} autoFocus />
      <div className="starters">
        {starters.map((s) => (
          <button key={s.key} type="button" className="starter" onClick={() => app.prefill(t(`home.starter.${s.key}Prompt`))}>
            {t(`home.starter.${s.key}`)}
          </button>
        ))}
      </div>
      <Readiness />
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

/** What needs attention, most severe first; each opens its bucket beside the Composer. */
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
  // The sheet may have changed an issue (verify, accept): read again when it closes.
  const paneOpen = app.pane?.tab === "bucket";
  useEffect(() => { if (!paneOpen) void reload(); }, [paneOpen, reload]);
  if (!estate || estate.providers.length === 0) return null;
  const shown = estate.issues.slice(0, 6);
  const more = estate.open_issue_count - shown.length;
  return (
    <section className="attention" aria-labelledby="attention-label" data-testid="needs-care">
      <h2 id="attention-label" className="attention-title">{t("home.care")}</h2>
      {shown.length ? (
        <ul className="attention-list">
          {shown.map((i) => <AttentionRow key={i.id} issue={i} />)}
        </ul>
      ) : <p className="quiet-note">{t("home.careEmpty")}</p>}
      {more > 0 ? <p className="quiet-note">{t("home.careMore", { n: more })}</p> : null}
      <p className="accounts" data-testid="estate">
        {estate.providers.map((p) => [
          p.name,
          t("home.buckets", { n: p.bucket_count }),
          p.last_checked_at ? t("home.checked", { when: timeAgo(p.last_checked_at, t) }) : t("home.neverChecked"),
          p.watch.enabled ? t("home.watched") : null,
        ].filter(Boolean).join(" · ")).join("   ")}
      </p>
    </section>
  );
}

function AttentionRow({ issue }: { issue: Issue }) {
  const { t } = useI18n();
  const app = useApp();
  const tone = SEVERITY_TONE[issue.severity];
  return (
    <li>
      <button type="button" className="attention-row" data-testid="issue" data-severity={issue.severity}
        aria-pressed={app.pane?.tab === "bucket" && app.pane.bucket === issue.bucket}
        onClick={() => app.openBucket(issue.provider_id, issue.bucket)}>
        <StatusDot tone={tone === "outline" ? "neutral" : tone} />
        <span className="sr-only">{t(`sev.${issue.severity}`)}: </span>
        <span className="attention-issue">{issue.title}</span>
        <span className="attention-where">{issue.bucket}</span>
        {issue.status === "recurred" ? <span className="attention-where">{t("issue.status.recurred")}</span> : null}
      </button>
    </li>
  );
}
