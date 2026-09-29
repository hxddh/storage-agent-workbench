import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { Estate, Issue } from "../api/types";
import { Composer } from "../composer/Composer";
import { Icon } from "../components/icons";
import { Badge, Button, SectionLabel, StatusDot } from "../components/ui";
import { useToast } from "../components/Toast";
import { useCopy } from "../hooks/useCopy";
import { setTrayStatus } from "../hooks/useNativeAgent";
import { useI18n } from "../i18n";
import { timeAgo } from "../lib/time";
import { useApp } from "../shell/context";
import { SEVERITY_TONE } from "../task/Result";

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

function IssueCard({ issue: initial, onChange }: { issue: Issue; onChange: () => void }) {
  const { t, lang } = useI18n();
  const app = useApp();
  const toast = useToast();
  const { copied, copy } = useCopy();
  const [issue, setIssue] = useState(initial);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<string | null>(null);
  useEffect(() => setIssue(initial), [initial]);

  const act = async (name: string, fn: () => Promise<Issue>) => {
    setBusy(name);
    try {
      setIssue(await fn());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const verify = async () => {
    setBusy("verify");
    try {
      const out = await api.verifyIssue(issue.id, lang);
      setVerdict(out.result);
      setIssue(out.issue);
      if (out.issue.status === "resolved") onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="issue" data-severity={issue.severity} data-status={issue.status} data-testid="issue">
      <button type="button" className="issue-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Badge tone={SEVERITY_TONE[issue.severity]}>{t(`sev.${issue.severity}`)}</Badge>
        <span className="issue-title">{issue.title}</span>
        <span className="issue-where">{issue.bucket}</span>
        {issue.status !== "open" ? <span className="issue-status">{t(`issue.status.${issue.status}`)}</span> : null}
        <Icon name="chevron" size={14} className="issue-caret" />
      </button>
      {open ? (
        <div className="issue-body reveal">
          <p className="quiet-note">{issue.provider_name} · {t("issue.firstSeen", { when: timeAgo(issue.first_seen_at, t) })}</p>
          {issue.detail ? <p>{issue.detail}</p> : null}
          {issue.fix ? (
            <div className="issue-fix">
              <pre><code>{issue.fix.command}</code></pre>
              <Button size="sm" icon={copied ? "check" : "copy"} onClick={() => copy(issue.fix!.command)}>
                {copied ? t("common.copied") : t("issue.copyCommand")}
              </Button>
              <p className="quiet-note">{t("issue.fixNote")}</p>
            </div>
          ) : !issue.fixable ? <p className="quiet-note">{t("issue.noFix")}</p> : null}
          {verdict ? (
            <p className="issue-verdict">
              <StatusDot tone={verdict === "resolved" ? "success" : verdict === "still_present" ? "warn" : "neutral"} />
              {t(`issue.verify.${verdict}`)}
            </p>
          ) : null}
          <div className="issue-actions">
            {issue.fixable && !issue.fix ? (
              <Button size="sm" variant="primary" disabled={!!busy} onClick={() => void act("fix", () => api.proposeFix(issue.id, lang))}>
                {t("issue.fix")}
              </Button>
            ) : null}
            <Button size="sm" disabled={!!busy} onClick={() => void verify()}>
              {busy === "verify" ? t("issue.verifying") : t("issue.verify")}
            </Button>
            {issue.source_task_id ? (
              <Button size="sm" variant="ghost" onClick={() => app.openTask(issue.source_task_id!)}>{t("issue.openTask")}</Button>
            ) : null}
            <Button size="sm" variant="ghost" disabled={!!busy}
              onClick={() => void act("accept", () => api.acceptIssue(issue.id, issue.status !== "accepted", lang)).then(onChange)}>
              {issue.status === "accepted" ? t("issue.unaccept") : t("issue.accept")}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
