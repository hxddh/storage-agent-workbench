import type { ReactNode } from "react";
import { Markdown } from "../components/Markdown";
import { Badge, SectionLabel } from "../components/ui";
import { Icon } from "../components/icons";
import { useI18n } from "../i18n";
import { resultWhen } from "../lib/time";
import type { Severity } from "../api/types";
import type { Section } from "../store/derive";
import { figures } from "../store/derive";
import { AnalysisFigures } from "../viz/AnalysisFigures";
import { useApp } from "../shell/context";

export const SEVERITY_TONE: Record<Severity, "danger" | "warn" | "neutral" | "outline"> = {
  high: "danger", medium: "warn", low: "neutral", info: "outline",
};

/**
 * The latest Result, conclusion first: the recorded answer as the page's
 * focal point, findings most severe first, next steps that fill the Composer
 * (never sent on their own), then the full answer, figures, and the outputs.
 * Without a recorded conclusion it is the answer — nothing is guessed from prose.
 */
export function Result({ section, outputs, work }: {
  section: Section; outputs: { evidence: number; report: boolean; activity: number }; work?: ReactNode;
}) {
  const { t, lang } = useI18n();
  const app = useApp();
  const c = section.conclusion;
  const failed = section.toolCount ? section.blocks.reduce((n, b) => n + (b.kind === "work"
    ? b.tools.filter((r) => r.status !== "ok").length : 0), 0) : 0;
  const when = section.turn.finished_at ?? section.turn.created_at;
  const fig = figures(section);
  const meta = [
    resultWhen(when, t, lang),
    c?.findings.length ? t("task.meta.findings", { n: c.findings.length }) : null,
    failed ? t("task.meta.gaps", { n: failed }) : null,
    section.toolCount ? t("task.meta.tools", { n: section.toolCount }) : null,
  ].filter(Boolean);

  return (
    <article className="result reveal" aria-labelledby="result-label" data-testid="result">
      <header className="result-head">
        <Badge tone="accent" id="result-label">{t("task.result")}</Badge>
        <span className="result-meta" title={when}>{meta.join(" · ")}</span>
      </header>
      {section.stopped ? <p className="quiet-note">{t("task.stopped")}</p> : null}
      {section.finalized ? <p className="quiet-note">{t("task.finalized")}</p> : null}
      {c ? (
        <>
          <p className="result-answer" data-testid="result-answer">{c.answer}</p>
          {c.findings.length ? (
            <ul className="findings" aria-label={t("task.findings")}>
              {c.findings.map((f, i) => (
                <li key={i} className="finding" data-severity={f.severity}>
                  <Badge tone={SEVERITY_TONE[f.severity]}>{t(`sev.${f.severity}`)}</Badge>
                  <div>
                    <p className="finding-title">{f.title}</p>
                    {f.detail ? <p className="finding-detail">{f.detail}</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          {c.next_steps.length ? (
            <div className="next-steps">
              <SectionLabel>{t("task.nextSteps")}</SectionLabel>
              <div className="next-step-list">
                {c.next_steps.slice(0, 4).map((s, i) => (
                  <button key={i} type="button" className="next-step" onClick={() => app.prefill(s)}>
                    <span>{s}</span>
                    <Icon name="arrowRight" size={14} />
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {section.answer ? (
            <div className="result-full">
              <SectionLabel>{t("task.answer")}</SectionLabel>
              <Markdown text={section.answer} />
            </div>
          ) : null}
        </>
      ) : section.answer ? (
        <div className="result-full result-lead"><Markdown text={section.answer} /></div>
      ) : (
        <p className="quiet-note">{t("task.noAnswer")}</p>
      )}
      {fig ? <AnalysisFigures provenance={fig} /> : null}
      {work}
      <Outputs outputs={outputs} />
    </article>
  );
}

export function Outputs({ outputs }: { outputs: { evidence: number; report: boolean; activity: number } }) {
  const { t } = useI18n();
  const app = useApp();
  const items = [
    outputs.evidence ? { tab: "evidence" as const, icon: "evidence" as const, label: t("task.outputs.evidence"), n: outputs.evidence } : null,
    outputs.report ? { tab: "report" as const, icon: "report" as const, label: t("task.outputs.report"), n: null } : null,
    outputs.activity ? { tab: "activity" as const, icon: "activity" as const, label: t("task.outputs.activity"), n: outputs.activity } : null,
  ].filter(Boolean) as Array<{ tab: "evidence" | "report" | "activity"; icon: "evidence" | "report" | "activity"; label: string; n: number | null }>;
  if (!items.length) return null;
  return (
    <nav className="outputs" aria-label="outputs" data-testid="outputs">
      {items.map((o) => (
        <button key={o.tab} type="button" className="output" data-tab={o.tab}
          aria-pressed={app.pane?.tab === o.tab} onClick={() => app.setPane(app.pane?.tab === o.tab ? null : { tab: o.tab })}>
          <Icon name={o.icon} size={16} />
          <span>{o.label}</span>
          {o.n != null ? <small>{o.n}</small> : null}
        </button>
      ))}
    </nav>
  );
}
