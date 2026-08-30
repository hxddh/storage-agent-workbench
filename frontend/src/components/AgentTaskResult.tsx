import { memo, useMemo, useState } from "react";
import type { ToolActivity } from "../types";
import { useI18n } from "../i18n";
import { isMostlyError, parseS3Error } from "../lib/s3error";
import { openAgentExecution, openAgentReview } from "../agent/commands";
import { AgentResultRenderer } from "./AgentResultRenderer";
import { S3ErrorArtifact } from "./S3ErrorArtifact";

export type AgentTaskResultProps = {
  role: string;
  content: string | null;
  toolActivity?: ToolActivity[];
  streaming?: boolean;
  sessionId?: string | null;
  onEdit?: (text: string) => void;
  onRerun?: () => void;
  onBranch?: () => void;
  referencedEvidenceIds?: string[];
  referencedRunIds?: string[];
};

function resultShape(content: string | null): "plain" | "structured" | "data-rich" {
  const text = content ?? "";
  if (/^\s*\|.+\|\s*$/m.test(text) || /```[\s\S]*```/.test(text)) return "data-rich";
  if (/^#{1,3}\s+\S/m.test(text) || /^\s*(?:[-*]|\d+\.)\s+\S/m.test(text)) return "structured";
  return "plain";
}

function fallbackCopy(text: string): boolean {
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

async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return fallbackCopy(text);
    }
  }
  return fallbackCopy(text);
}

function DirectionEvent({
  content,
  onEdit,
  onBranch,
}: Pick<AgentTaskResultProps, "content" | "onEdit" | "onBranch">) {
  const { lang, t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = content ?? "";
  const long = text.length > 600 || text.split("\n").length > 12;
  const parsed = useMemo(() => parseS3Error(text), [text]);
  const structuredError = parsed !== null && isMostlyError(text, parsed);
  const copy = lang === "zh"
    ? {
        label: "Direction · 任务方向",
        redirect: "重新定向",
        redirectAria: "重新定向这个任务",
        branch: "分支任务",
        branchAria: "从这个 Direction 分支新的 Agent Task",
        more: "展开 Direction",
        less: "收起 Direction",
      }
    : {
        label: "Direction",
        redirect: "Redirect",
        redirectAria: "Redirect this task",
        branch: "Branch task",
        branchAria: "Branch a new Agent task from this Direction",
        more: "Show full Direction",
        less: "Collapse Direction",
      };

  return (
    <section className="group max-w-[min(46rem,100%)] animate-fade-in-up" data-testid="direction-event" aria-label={copy.label}>
      <div className="mb-1.5 flex items-center gap-2 text-2xs font-medium uppercase tracking-wider text-gray-500">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
        {copy.label}
      </div>

      {structuredError && parsed ? (
        <S3ErrorArtifact error={parsed} raw={text} onRedirect={onEdit} onBranch={onBranch} />
      ) : (
        <div className="border-l-2 border-edge-strong pl-3">
          <div className="whitespace-pre-wrap break-words text-prose text-gray-200">
            <div className={long && !expanded ? "max-h-44 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]" : ""}>{text}</div>
            {long ? (
              <button type="button" onClick={() => setExpanded((value) => !value)} className="mt-1 text-2xs text-gray-500 transition-colors hover:text-accent-soft">
                {expanded ? copy.less : copy.more}
              </button>
            ) : null}
          </div>
        </div>
      )}

      {!structuredError ? (
        <div className="mt-1.5 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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
          {onEdit ? (
            <button type="button" onClick={() => onEdit(text)} title={copy.redirectAria} aria-label={copy.redirectAria} data-testid="redirect-direction" className="text-2xs text-gray-500 transition-colors hover:text-gray-200">
              {copy.redirect}
            </button>
          ) : null}
          {onBranch ? (
            <button type="button" onClick={onBranch} title={copy.branchAria} aria-label={copy.branchAria} data-testid="branch-task" className="text-2xs text-gray-500 transition-colors hover:text-gray-200">
              {copy.branch}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The durable content primitive of an Agent task.
 * A user contribution is Direction. Agent output is a Work Result backed by
 * real Execution and Evidence artifacts. Streaming output is live Execution
 * that later resolves into the durable Work Result for the same task.
 */
export const AgentTaskResult = memo(function AgentTaskResult({
  referencedEvidenceIds = [],
  referencedRunIds = [],
  ...props
}: AgentTaskResultProps) {
  const { lang } = useI18n();
  if (props.role === "user") {
    return <DirectionEvent content={props.content} onEdit={props.onEdit} onBranch={props.onBranch} />;
  }

  const evidenceCount = referencedEvidenceIds.length;
  const executionCount = referencedRunIds.length;
  const showArtifacts = !props.streaming && (evidenceCount > 0 || executionCount > 0);
  const label = props.streaming
    ? (lang === "zh" ? "Execution · 执行中" : "Execution")
    : (lang === "zh" ? "Work Result · 工作结果" : "Work Result");

  return (
    <article
      className="agent-work-result"
      data-testid="work-result"
      data-work-result="true"
      data-streaming={props.streaming ? "true" : "false"}
      data-result-shape={resultShape(props.content)}
      aria-label={label}
    >
      <header className="mb-1.5 flex items-center gap-2 text-2xs font-medium uppercase tracking-wider text-gray-500">
        <span className={`h-1.5 w-1.5 rounded-full ${props.streaming ? "animate-pulse bg-warn" : "bg-success"}`} aria-hidden />
        {label}
      </header>

      <AgentResultRenderer
        content={props.content}
        toolActivity={props.toolActivity}
        streaming={props.streaming}
        sessionId={props.sessionId}
        onRerun={props.onRerun}
      />

      {showArtifacts ? (
        <nav className="work-result-artifacts" aria-label={lang === "zh" ? "工作产物" : "Work artifacts"} data-testid="work-result-artifacts">
          <span className="work-result-artifact-label">Artifacts</span>
          {evidenceCount > 0 ? (
            <button type="button" onClick={() => openAgentReview("evidence")} data-testid="work-result-open-evidence">
              Evidence <span>{evidenceCount}</span>
            </button>
          ) : null}
          {executionCount > 0 ? (
            <button type="button" onClick={() => { if (executionCount === 1) openAgentExecution(referencedRunIds[0]); else openAgentReview("execution"); }} data-testid="work-result-open-execution">
              Execution <span>{executionCount}</span>
            </button>
          ) : null}
        </nav>
      ) : null}
    </article>
  );
});
