import { memo, useState, type ReactNode } from "react";
import type { Conclusion, ConclusionFinding, TaskMessage } from "../types";
import { useCopy } from "../hooks/useCopy";
import { useI18n } from "../i18n";
import { asConclusion } from "../lib/conclusion";
import { resultWhen } from "../lib/time";
import { Markdown } from "./Markdown";
import { severityLabel } from "./SeverityMark";
import { Icon } from "./icons";

function FindingRow({ finding }: { finding: ConclusionFinding }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const label = severityLabel(finding.severity, t);
  const head = (
    <>
      <span className="result-finding-dot" data-severity={finding.severity} aria-hidden />
      <span className="sr-only">{label}: </span>
      <span className="result-finding-title">{finding.title}</span>
    </>
  );
  return (
    <li className="result-finding" data-severity={finding.severity} data-testid="result-finding">
      {finding.detail ? (
        <button type="button" className="result-finding-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {head}
          <span className="result-finding-chevron" aria-hidden><Icon name="chevron" size={11} /></span>
        </button>
      ) : (
        <div className="result-finding-head">{head}</div>
      )}
      {open && finding.detail ? <p className="result-finding-detail">{finding.detail}</p> : null}
    </li>
  );
}

/**
 * The Work Result's structured head, exactly as the model recorded it with
 * `record_conclusion`: the answer, the findings most severe first (a status
 * dot each — the only colour), and next steps that go into the Composer
 * (never sent on their own: the user still delegates).
 */
export function ConclusionView({
  conclusion,
  onNextStep,
}: {
  conclusion: Conclusion;
  onNextStep?: (text: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="result-conclusion" data-testid="result-conclusion">
      <p className="result-answer" data-testid="result-answer">{conclusion.answer}</p>
      {conclusion.findings.length > 0 ? (
        <div className="result-block">
          <h3 className="result-label">{t("result.findings")}</h3>
          <ul className="result-findings" data-testid="result-findings">
            {conclusion.findings.map((finding, index) => <FindingRow key={index} finding={finding} />)}
          </ul>
        </div>
      ) : null}
      {conclusion.next_steps.length > 0 ? (
        <div className="result-block">
          <h3 className="result-label">{t("result.nextSteps")}</h3>
          <ul className="result-next-steps" data-testid="result-next-steps">
            {conclusion.next_steps.map((step, index) => (
              <li key={index}>
                <button
                  type="button"
                  className="result-next-step"
                  onClick={() => onNextStep?.(step)}
                  disabled={!onNextStep}
                  title={t("result.askNext")}
                  data-testid="result-next-step"
                >
                  <span className="result-next-step-mark" aria-hidden><Icon name="arrowRight" size={12} /></span>
                  <span className="result-next-step-text">{step}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function CopyResult({ text }: { text: string }) {
  const { t } = useI18n();
  const { copied, copy } = useCopy(1200);
  return (
    <button type="button" className="native-ghost-action" onClick={() => copy(text)} aria-label={t("common.copy")} data-testid="copy-work-result">
      <Icon name={copied ? "check" : "copy"} size={12} />
      {copied ? t("common.copied") : t("common.copy")}
    </button>
  );
}

/** Evidence · gaps · tool calls — derived from the tool trace, never claimed. */
function groundingParts(message: TaskMessage, t: ReturnType<typeof useI18n>["t"]): string[] {
  const evidence = message.grounding?.evidence_used?.length ?? 0;
  const gaps = message.grounding?.evidence_gaps?.length ?? 0;
  const tools = (message.tool_activity ?? []).filter((record) => record.status !== "started").length;
  const parts: string[] = [];
  if (evidence > 0) parts.push(`${t("result.evidence")} ${evidence}`);
  if (gaps > 0) parts.push(`${t("result.gaps")} ${gaps}`);
  if (tools > 0) parts.push(`${t("result.tools")} ${tools}`);
  return parts;
}

/**
 * v2.0 — the top of the Task: the latest Work Result, conclusion first. The
 * full answer (tables, explanation) follows, then the figures, then the
 * detail rows (Evidence · Report · Execution …) that expand in place.
 */
export const TaskResult = memo(function TaskResult({
  message,
  direction,
  figures,
  details,
  onNextStep,
}: {
  message: TaskMessage;
  direction: string | null;
  figures?: ReactNode;
  details?: ReactNode;
  onNextStep?: (text: string) => void;
}) {
  const { t, lang } = useI18n();
  const conclusion = asConclusion(message.conclusion);
  const text = message.content ?? "";
  const when = resultWhen(message.created_at, t, lang);
  const grounding = groundingParts(message, t);
  return (
    <section className="task-result" id="task-result" data-testid="task-result" data-has-conclusion={conclusion ? "true" : "false"}>
      {/* One quiet line: what this is, when, and what it stands on. The
          Direction it answers heads that turn in the Work log; here it is a
          hover hint, not a second copy of the words. */}
      <header className="task-result-head" title={direction ?? undefined}>
        <span className="task-result-kicker">{t("result.kicker")}</span>
        {when ? <span className="task-result-meta" title={message.created_at}>{when}</span> : null}
        {grounding.length ? (
          <span className="task-result-meta" data-testid="result-grounding">{grounding.join(" · ")}</span>
        ) : null}
      </header>
      {conclusion ? <ConclusionView conclusion={conclusion} onNextStep={onNextStep} /> : null}
      {text.trim() ? (
        <article className="turn-agent" data-testid="work-result" data-work-result="true" data-streaming="false" aria-label={t("turn.answerLabel")}>
          {conclusion ? <h3 className="result-label">{t("result.fullAnswer")}</h3> : null}
          <div className="turn-answer" data-testid="turn-answer">
            <Markdown text={text} />
          </div>
          {figures}
          <div className="native-row-actions">
            <CopyResult text={text} />
          </div>
        </article>
      ) : figures}
      {details}
    </section>
  );
});
