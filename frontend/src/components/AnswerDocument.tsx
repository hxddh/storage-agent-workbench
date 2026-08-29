import { memo, useMemo, useState, type ComponentProps } from "react";
import { useI18n } from "../i18n";
import { isMostlyError, parseS3Error } from "../lib/s3error";
import { openWorkbenchRun, openWorkbenchSurface } from "../workbench/commands";
import { MessageCard as ProvenTurnRenderer } from "./ThreadCardsImplementation";

type ProvenTurnRendererProps = ComponentProps<typeof ProvenTurnRenderer>;
export type AnswerDocumentProps = ProvenTurnRendererProps & {
  referencedEvidenceIds?: string[];
  referencedRunIds?: string[];
};

function documentShape(content: string | null): "plain" | "structured" | "data-rich" {
  const text = content ?? "";
  if (/^\s*\|.+\|\s*$/m.test(text) || /```[\s\S]*```/.test(text)) return "data-rich";
  if (/^#{1,3}\s+\S/m.test(text) || /^\s*(?:[-*]|\d+\.)\s+\S/m.test(text)) return "structured";
  return "plain";
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the DOM fallback below.
  }
  try {
    const node = document.createElement("textarea");
    node.value = text;
    node.style.position = "fixed";
    node.style.opacity = "0";
    document.body.appendChild(node);
    node.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(node);
    return ok;
  } catch {
    return false;
  }
}

function DirectionEvent({
  content,
  onEdit,
  onBranch,
}: Pick<AnswerDocumentProps, "content" | "onEdit" | "onBranch">) {
  const { lang, t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = content ?? "";
  const long = text.length > 600 || text.split("\n").length > 12;
  const parsed = useMemo(() => parseS3Error(text), [text]);
  const structuredError = parsed !== null && isMostlyError(text, parsed);
  const label = lang === "zh" ? "Direction · 任务方向" : "Direction";

  return (
    <section
      className="group max-w-[min(46rem,100%)] animate-fade-in-up"
      data-testid="direction-event"
      aria-label={label}
    >
      <div className="mb-1.5 flex items-center gap-2 text-2xs font-medium uppercase tracking-wider text-gray-500">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
        {label}
      </div>

      {structuredError ? (
        <ProvenTurnRenderer role="user" content={content} />
      ) : (
        <div className="border-l-2 border-edge-strong pl-3">
          <div className="whitespace-pre-wrap break-words text-prose text-gray-200">
            <div className={long && !expanded ? "max-h-44 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]" : ""}>
              {text}
            </div>
            {long ? (
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                className="mt-1 text-2xs text-gray-500 transition-colors hover:text-accent-soft"
              >
                {expanded ? t("msg.showLess") : t("msg.showMore")}
              </button>
            ) : null}
          </div>
        </div>
      )}

      <div className="mt-1.5 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {!structuredError ? (
          <button
            type="button"
            onClick={() => void copyText(text).then((ok) => {
              if (!ok) return;
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            })}
            className="text-2xs text-gray-500 transition-colors hover:text-gray-200"
            aria-label={t("common.copy")}
          >
            {copied ? t("common.copied") : t("common.copy")}
          </button>
        ) : null}
        {onEdit ? (
          <button
            type="button"
            onClick={() => onEdit(text)}
            title={t("msg.edit")}
            aria-label={t("msg.edit")}
            data-testid="edit-message"
            className="text-2xs text-gray-500 transition-colors hover:text-gray-200"
          >
            {lang === "zh" ? "重新定向" : "Redirect"}
          </button>
        ) : null}
        {onBranch ? (
          <button
            type="button"
            onClick={onBranch}
            title={t("msg.branch")}
            aria-label={t("msg.branch")}
            data-testid="branch-message"
            className="text-2xs text-gray-500 transition-colors hover:text-gray-200"
          >
            {lang === "zh" ? "分支任务" : "Branch task"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Agent-task content boundary.
 *
 * A user contribution is a Direction event: it changes the objective or steers
 * the current task. An Agent contribution is a Work Result: the durable output
 * of execution, with provenance links to the real evidence and runs that support
 * it. The proven streaming/tool renderer remains underneath the Work Result so
 * the UI changes its information architecture without weakening execution truth.
 */
export const AnswerDocument = memo(function AnswerDocument({
  referencedEvidenceIds = [],
  referencedRunIds = [],
  ...props
}: AnswerDocumentProps) {
  const { lang } = useI18n();
  if (props.role === "user") {
    return <DirectionEvent content={props.content} onEdit={props.onEdit} onBranch={props.onBranch} />;
  }

  const evidenceCount = referencedEvidenceIds.length;
  const runCount = referencedRunIds.length;
  const showLinks = !props.streaming && (evidenceCount > 0 || runCount > 0);
  const label = props.streaming
    ? (lang === "zh" ? "Execution · 执行中" : "Execution")
    : (lang === "zh" ? "Work Result · 工作结果" : "Work Result");

  return (
    <article
      className="answer-document agent-work-result"
      data-testid="answer-document"
      data-work-result="true"
      data-streaming={props.streaming ? "true" : "false"}
      data-document-shape={documentShape(props.content)}
      aria-label={label}
    >
      <header className="mb-1.5 flex items-center gap-2 text-2xs font-medium uppercase tracking-wider text-gray-500">
        <span className={`h-1.5 w-1.5 rounded-full ${props.streaming ? "animate-pulse bg-warn" : "bg-success"}`} aria-hidden />
        {label}
      </header>

      <ProvenTurnRenderer {...props} />

      {showLinks ? (
        <nav
          className="answer-document-references"
          aria-label={lang === "zh" ? "工作产物" : "Work artifacts"}
          data-testid="answer-references"
        >
          <span className="answer-document-reference-label">{lang === "zh" ? "Artifacts" : "Artifacts"}</span>
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
              Execution <span>{runCount}</span>
            </button>
          ) : null}
        </nav>
      ) : null}
    </article>
  );
});
