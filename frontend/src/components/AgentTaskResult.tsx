import { memo, useMemo, useState, type ReactNode } from "react";
import type { ToolActivity } from "../types";
import { useI18n } from "../i18n";
import { isMostlyError, parseS3Error } from "../lib/s3error";
import { openAgentExecution, openAgentReview } from "../agent/commands";
import { AgentResultRenderer } from "./AgentResultRenderer";
import { S3ErrorArtifact } from "./S3ErrorArtifact";
import { Icon } from "./icons";

export type AgentTaskResultProps = {
  role: string;
  content: string | null;
  toolActivity?: ToolActivity[];
  streaming?: boolean;
  sessionId?: string | null;
  referencedEvidenceIds?: string[];
  referencedRunIds?: string[];
  hasReport?: boolean;
  figures?: ReactNode;
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

function useResultCopy() {
  const { lang } = useI18n();
  return lang === "zh"
    ? { direction: "方向", result: "工作结果", execution: "执行", artifacts: "工作产物", evidence: "证据", executionOpen: "执行记录", report: "报告", more: "展开", less: "收起" }
    : { direction: "Direction", result: "Work Result", execution: "Execution", artifacts: "Work artifacts", evidence: "Evidence", executionOpen: "Execution", report: "Report", more: "Show more", less: "Show less" };
}

function CopyAction({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="native-ghost-action"
      onClick={() => void copyText(text).then((ok) => { if (!ok) return; setCopied(true); window.setTimeout(() => setCopied(false), 1200); })}
      aria-label={t("common.copy")}
      data-testid="copy-work-result"
    >
      <Icon name={copied ? "check" : "copy"} size={12} />
      {copied ? t("common.copied") : t("common.copy")}
    </button>
  );
}

function DirectionEvent({ content }: Pick<AgentTaskResultProps, "content">) {
  const copy = useResultCopy();
  const [expanded, setExpanded] = useState(false);
  const text = content ?? "";
  const long = text.length > 600 || text.split("\n").length > 12;
  const parsed = useMemo(() => parseS3Error(text), [text]);
  const structuredError = parsed !== null && isMostlyError(text, parsed);

  return (
    <section className="group" data-testid="direction-event" aria-label={copy.direction}>
      {structuredError && parsed ? (
        <S3ErrorArtifact error={parsed} raw={text} />
      ) : (
        <div className="native-direction" data-long={long ? "true" : "false"} data-expanded={expanded ? "true" : "false"}>{text}</div>
      )}
      <div className="native-row-actions">
        {!structuredError ? <CopyAction text={text} /> : null}
        {long ? (
          <button type="button" onClick={() => setExpanded((value) => !value)} className="native-ghost-action">
            {expanded ? copy.less : copy.more}
          </button>
        ) : null}
      </div>
    </section>
  );
}

/** Direction and Work Result are the two things a Task document is made of. */
export const AgentTaskResult = memo(function AgentTaskResult({
  referencedEvidenceIds = [],
  referencedRunIds = [],
  hasReport = false,
  figures,
  ...props
}: AgentTaskResultProps) {
  const copy = useResultCopy();
  if (props.role === "user") {
    return <DirectionEvent content={props.content} />;
  }

  const evidenceCount = referencedEvidenceIds.length;
  const executionCount = referencedRunIds.length;
  const showArtifacts = !props.streaming && (evidenceCount > 0 || executionCount > 0 || hasReport);

  return (
    <article
      className="native-result group"
      data-testid="work-result"
      data-work-result="true"
      data-streaming={props.streaming ? "true" : "false"}
      data-result-shape={resultShape(props.content)}
      aria-label={props.streaming ? copy.execution : copy.result}
    >
      <AgentResultRenderer
        content={props.content}
        toolActivity={props.toolActivity}
        streaming={props.streaming}
        sessionId={props.sessionId}
      />
      {figures}

      {!props.streaming ? (
        <div className="native-result-foot">
          {showArtifacts ? (
            <nav className="flex flex-wrap items-center gap-1.5" aria-label={copy.artifacts} data-testid="work-result-artifacts">
              {evidenceCount > 0 ? (
                <button type="button" onClick={() => openAgentReview("evidence")} data-testid="work-result-open-evidence" className="native-chip">
                  <Icon name="file" size={13} />
                  {copy.evidence} <b>{evidenceCount}</b>
                </button>
              ) : null}
              {executionCount > 0 ? (
                <button type="button" onClick={() => { if (executionCount === 1) openAgentExecution(referencedRunIds[0]); else openAgentReview("execution"); }} data-testid="work-result-open-execution" className="native-chip">
                  <Icon name="tool" size={13} />
                  {copy.executionOpen} <b>{executionCount}</b>
                </button>
              ) : null}
              {hasReport ? (
                <button type="button" onClick={() => openAgentReview("report")} data-testid="work-result-open-report" className="native-chip">
                  <Icon name="table" size={13} />
                  {copy.report}
                </button>
              ) : null}
            </nav>
          ) : null}
          <div className="native-row-actions" style={{ marginTop: 0 }}>
            <CopyAction text={props.content || ""} />
          </div>
        </div>
      ) : null}
    </article>
  );
});
