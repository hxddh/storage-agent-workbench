import { memo, useState, type ReactNode } from "react";
import type { Conclusion, ConclusionFinding, TaskMessage } from "../types";
import { useCopy } from "../hooks/useCopy";
import { useI18n } from "../i18n";
import { asConclusion } from "../lib/conclusion";
import { timeAgo } from "../lib/time";
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
  meta,
}: {
  conclusion: Conclusion;
  onNextStep?: (text: string) => void;
  /** A quiet line under the answer (the grounding counts). */
  meta?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="result-conclusion" data-testid="result-conclusion">
      <p className="result-answer" data-testid="result-answer">{conclusion.answer}</p>
      {meta}
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
          <div className="result-next-steps" data-testid="result-next-steps">
            {conclusion.next_steps.map((step, index) => (
              <button
                key={index}
                type="button"
                className="result-next-step"
                onClick={() => onNextStep?.(step)}
                disabled={!onNextStep}
                title={t("result.askNext")}
                data-testid="result-next-step"
              >
                {step}
              </button>
            ))}
          </div>
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
function GroundingLine({ message }: { message: TaskMessage }) {
  const { t } = useI18n();
  const evidence = message.grounding?.evidence_used?.length ?? 0;
  const gaps = message.grounding?.evidence_gaps?.length ?? 0;
  const tools = (message.tool_activity ?? []).filter((record) => record.status !== "started").length;
  const parts: string[] = [];
  if (evidence > 0) parts.push(`${t("result.evidence")} ${evidence}`);
  if (gaps > 0) parts.push(`${t("result.gaps")} ${gaps}`);
  if (tools > 0) parts.push(`${t("result.tools")} ${tools}`);
  if (parts.length === 0) return null;
  return <p className="result-grounding" data-testid="result-grounding">{parts.join(" · ")}</p>;
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
  const { t } = useI18n();
  const conclusion = asConclusion(message.conclusion);
  const text = message.content ?? "";
  const when = timeAgo(message.created_at, t);
  return (
    <section className="task-result" id="task-result" data-testid="task-result" data-has-conclusion={conclusion ? "true" : "false"}>
      <header className="task-result-head">
        <span className="task-result-kicker">{t("result.kicker")}</span>
        {/* The Direction it answers heads that turn in the Work log; here it
            is a hover hint, not a second copy of the words. */}
        <span className="task-result-for" title={direction ?? undefined}>{when}</span>
      </header>
      {conclusion ? (
        <ConclusionView conclusion={conclusion} onNextStep={onNextStep} meta={<GroundingLine message={message} />} />
      ) : null}
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
      {/* Without a conclusion the grounding reads as a footnote to the answer. */}
      {!conclusion ? <GroundingLine message={message} /> : null}
      {details}
    </section>
  );
});
