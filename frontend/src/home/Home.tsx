import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { Estate } from "../api/types";
import { Composer } from "../composer/Composer";
import { Icon } from "../components/icons";
import { Badge, SectionLabel } from "../components/ui";
import { setTrayStatus } from "../hooks/useNativeAgent";
import { useI18n } from "../i18n";
import { timeAgo } from "../lib/time";
import { useApp } from "../shell/context";
import { IssueCard } from "../estate/IssueCard";

/**
 * The home is "what to care about now": the greeting, the Composer, three
 * starters that only fill it, a readiness check when a model or storage
 * account is missing, then the estate — your storage and what needs care.
 * Nothing here submits work except the Composer.
 */
export function Home() {
  const { t } = useI18n();
  const app = useApp();
  const noStorage = (app.clouds ?? []).length === 0;
  const starters = [
    { key: "access", needsStorage: false },
    { key: "survey", needsStorage: true },
    { key: "log", needsStorage: false },
  ];
  return (
    <div className="home" data-testid="home">
      <div className="home-hero">
        <h1 className="home-greeting">{t("home.greeting")}</h1>
        <p className="home-sub">{t("home.sub")}</p>
        <Composer taskId={null} busy={false} onCreated={app.openTask} autoFocus />
        <div className="starters">
          {starters.map((s) => {
            const blocked = s.needsStorage && noStorage && app.clouds !== null;
            return (
              <button key={s.key} type="button" className="starter" disabled={blocked}
                title={blocked ? t("home.starter.needsStorage") : undefined}
                onClick={() => app.prefill(t(`home.starter.${s.key}Prompt`))}>
                <span>{t(`home.starter.${s.key}`)}</span>
                {blocked ? <small>{t("home.starter.needsStorage")}</small> : null}
              </button>
            );
          })}
        </div>
      </div>
      <Readiness />
      <EstateView />
    </div>
  );
}

function Readiness() {
  const { t } = useI18n();
  const app = useApp();
  if (app.models === null || app.clouds === null) return null;
  const missing = [
    app.models.length === 0 ? { key: "model", section: "models" } : null,
    app.clouds.length === 0 ? { key: "storage", section: "storage" } : null,
  ].filter(Boolean) as Array<{ key: string; section: string }>;
  if (!missing.length) return null;
  return (
    <section className="home-section" aria-labelledby="ready-label" data-testid="readiness">
      <SectionLabel id="ready-label">{t("home.ready.title")}</SectionLabel>
      <div className="ready-cards">
        {missing.map((m) => (
          <button key={m.key} type="button" className="ready-card" onClick={() => app.openSettings(m.section)}>
            <Icon name={m.key === "model" ? "chip" : "storage"} size={16} />
            <span className="ready-title">{t(`home.ready.${m.key}`)}</span>
            <span className="ready-body">{t(`home.ready.${m.key}Body`)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function EstateView() {
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
  if (!estate || estate.providers.length === 0) return null;
  const more = estate.open_issue_count - estate.issues.length;
  return (
    <>
      <section className="home-section" aria-labelledby="storage-label" data-testid="estate">
        <SectionLabel id="storage-label">{t("home.storage")}</SectionLabel>
        <ul className="estate-accounts">
          {estate.providers.map((p) => {
            const open = p.open_issues.high + p.open_issues.medium + p.open_issues.low;
            return (
              <li key={p.provider_id} className="estate-account">
                <button type="button" className="estate-account-link" onClick={() => app.openEstate(p.provider_id)}
                  data-testid="estate-account">
                <div className="estate-account-head">
                  <Icon name="storage" size={16} />
                  <span className="estate-account-name">{p.name}</span>
                  {open ? <Badge tone={p.open_issues.high ? "danger" : p.open_issues.medium ? "warn" : "neutral"}>{open}</Badge> : null}
                </div>
                <p className="estate-account-meta">
                  {[
                    t("home.buckets", { n: p.bucket_count }),
                    p.last_checked_at ? t("home.checked", { when: timeAgo(p.last_checked_at, t) }) : t("home.neverChecked"),
                    p.watch.enabled ? t("home.watched", { interval: [6, 24, 168].includes(p.watch.interval_hours) ? t(`interval.${p.watch.interval_hours}`) : `${p.watch.interval_hours} h` }) : t("home.notWatched"),
                  ].join(" · ")}
                </p>
                </button>
              </li>
            );
          })}
        </ul>
        {estate.last_watch_at ? <p className="quiet-note">{t("home.lastWatch", { when: timeAgo(estate.last_watch_at, t) })}</p> : null}
      </section>
      <section className="home-section" aria-labelledby="care-label" data-testid="needs-care">
        <SectionLabel id="care-label" count={estate.open_issue_count}>{t("home.care")}</SectionLabel>
        {estate.issues.length ? (
          <ul className="issues">
            {estate.issues.map((i) => <IssueCard key={i.id} issue={i} onChange={reload} />)}
          </ul>
        ) : <p className="quiet-note">{t("home.careEmpty")}</p>}
        {more > 0 ? <p className="quiet-note">{t("home.careMore", { n: more })}</p> : null}
      </section>
    </>
  );
}
