import { memo, type ComponentProps } from "react";
import { useI18n } from "../i18n";
import { openWorkbenchRun, openWorkbenchSurface } from "../workbench/commands";
import { MessageCard as LegacyMessageCard } from "./ThreadCardsImplementation";

type LegacyMessageCardProps = ComponentProps<typeof LegacyMessageCard>;
export type AnswerDocumentProps = LegacyMessageCardProps & {
  referencedEvidenceIds?: string[];
  referencedRunIds?: string[];
};

function documentShape(content: string | null): "plain" | "structured" | "data-rich" {
  const text = content ?? "";
  if (/^\s*\|.+\|\s*$/m.test(text) || /```[\s\S]*```/.test(text)) return "data-rich";
  if (/^#{1,3}\s+\S/m.test(text) || /^\s*(?:[-*]|\d+\.)\s+\S/m.test(text)) return "structured";
  return "plain";
}

/**
 * Public answer artifact boundary for v0.92.
 *
 * An Agent answer is a technical document with explicit provenance links, not a
 * chat bubble. The historical renderer remains underneath for the proven live
 * stream/copy/regenerate mechanics, while evidence and run relationships belong
 * to this document boundary and navigate the global Workbench directly.
 */
export const AnswerDocument = memo(function AnswerDocument({
  referencedEvidenceIds = [],
  referencedRunIds = [],
  ...props
}: AnswerDocumentProps) {
  const { lang } = useI18n();
  if (props.role === "user") return <LegacyMessageCard {...props} />;

  const evidenceCount = referencedEvidenceIds.length;
  const runCount = referencedRunIds.length;
  const showLinks = !props.streaming && (evidenceCount > 0 || runCount > 0);

  return (
    <article
      className="answer-document"
      data-testid="answer-document"
      data-streaming={props.streaming ? "true" : "false"}
      data-document-shape={documentShape(props.content)}
      aria-label={lang === "zh" ? "Agent 回答" : "Agent answer"}
    >
      <LegacyMessageCard {...props} />

      {showLinks ? (
        <nav
          className="answer-document-references"
          aria-label={lang === "zh" ? "回答引用" : "Answer references"}
          data-testid="answer-references"
        >
          <span className="answer-document-reference-label">{lang === "zh" ? "Review" : "Review"}</span>
          {evidenceCount > 0 ? (
            <button
              type="button"
              onClick={() => openWorkbenchSurface("evidence")}
              data-testid="answer-open-evidence"
            >
              Evidence <span>{evidenceCount}</span>
            </button>
          ) : null}
          {runCount > 0 ? (
            <button
              type="button"
              onClick={() => {
                if (runCount === 1) openWorkbenchRun(referencedRunIds[0]);
                else openWorkbenchSurface("runs");
              }}
              data-testid="answer-open-runs"
            >
              {runCount === 1 ? "Run" : "Runs"} <span>{runCount}</span>
            </button>
          ) : null}
        </nav>
      ) : null}
    </article>
  );
});
