import { memo, useState, type ReactNode } from "react";
import type { Conclusion, TaskMessage } from "../types";
import { unifyFindings, type UnifiedFinding } from "../lib/findings";
import { ProvenanceLink } from "../viz/ProvenanceMark";
import { useCopy } from "../hooks/useCopy";
import { useI18n } from "../i18n";
import { asConclusion } from "../lib/conclusion";
import { resultWhen } from "../lib/time";
import { Markdown } from "./Markdown";
import { severityLabel } from "./SeverityMark";
import { Icon } from "./icons";
import { Badge, SectionLabel, type Tone } from "./ui";

const SEVERITY_TONE: Record<string, Tone> = { high: "danger", medium: "warn", low: "neutral", info: "outline" };

function FindingRow({ finding }: { finding: UnifiedFinding }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const label = severityLabel(finding.severity, t);
  // v3.0 — severity is a labelled badge (colour carries it, the word says
  // it), the title is the row; detail opens in place. v3.1 — the finding's
  // evidence link sits at the row's end when the work recorded one.
  const head = (
    <>
      <Badge tone={SEVERITY_TONE[finding.severity] ?? "neutral"} className="result-finding-badge" data-severity={finding.severity}>{label}</Badge>
      <span className="result-finding-title">{finding.title}</span>
    </>
  );
  return (
    <li className="result-finding" data-severity={finding.severity} data-source={finding.source} data-testid="result-finding">
      <div className="result-finding-row">
        {finding.detail ? (
          <button type="button" className="result-finding-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {head}
            <span className="result-finding-chevron" aria-hidden><Icon name="chevron" size={14} /></span>
          </button>
        ) : (
          <div className="result-finding-head">{head}</div>
        )}
        {finding.provenance ? <ProvenanceLink finding={finding.provenance} /> : null}
      </div>
      {open && finding.detail ? <p className="result-finding-detail">{finding.detail}</p> : null}
    </li>
  );
}

/** The one findings list (v3.1): the conclusion's findings joined by those
 * the work recorded, most severe first. */
export function FindingsBlock({ findings }: { findings: UnifiedFinding[] }) {
  const { t } = useI18n();
  if (findings.length === 0) return null;
  return (
    <div className="result-block">
      <SectionLabel count={findings.length}>{t("result.findings")}</SectionLabel>
      <ul className="result-findings" data-testid="result-findings">
        {findings.map((finding) => <FindingRow key={finding.id} finding={finding} />)}
      </ul>
    </div>
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
  findings,
  onNextStep,
}: {
  conclusion: Conclusion;
  /** The unified list; defaults to the conclusion's own findings. */
  findings?: UnifiedFinding[];
  onNextStep?: (text: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="result-conclusion" data-testid="result-conclusion">
      <p className="result-answer" data-testid="result-answer">{conclusion.answer}</p>
      <FindingsBlock findings={findings ?? unifyFindings(conclusion, [])} />
      {conclusion.next_steps.length > 0 ? (
        <div className="result-block">
          <SectionLabel>{t("result.nextSteps")}</SectionLabel>
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
                  <span className="result-next-step-text">{step}</span>
                  <span className="result-next-step-mark" aria-hidden><Icon name="arrowRight" size={14} /></span>
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
      <Icon name={copied ? "check" : "copy"} size={14} />
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
  findings,
  onNextStep,
}: {
  message: TaskMessage;
  direction: string | null;
  figures?: ReactNode;
  /** v3.1 — the unified findings (conclusion + work). */
  findings?: UnifiedFinding[];
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
        <Badge tone="accent" className="task-result-kicker">{t("result.kicker")}</Badge>
        {when ? <span className="task-result-meta" title={message.created_at}>{when}</span> : null}
        {grounding.length ? (
          <span className="task-result-meta" data-testid="result-grounding">{grounding.join(" · ")}</span>
        ) : null}
      </header>
      {conclusion ? <ConclusionView conclusion={conclusion} findings={findings} onNextStep={onNextStep} /> : null}
      {text.trim() ? (
        <article className="turn-agent" data-testid="work-result" data-work-result="true" data-streaming="false" aria-label={t("turn.answerLabel")}>
          {conclusion ? <div className="result-full-label"><SectionLabel>{t("result.fullAnswer")}</SectionLabel></div> : null}
          <div className="turn-answer" data-testid="turn-answer">
            <Markdown text={text} />
          </div>
          {/* No recorded conclusion: the answer stands alone, and what the
              work recorded follows it — records, never guesses. */}
          {!conclusion && findings?.length ? (
            <div className="result-recorded-findings" data-testid="result-recorded-findings"><FindingsBlock findings={findings} /></div>
          ) : null}
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
