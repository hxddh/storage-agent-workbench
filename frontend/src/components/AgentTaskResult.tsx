import { memo, useMemo, useState, type ReactNode } from "react";
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

function DirectionEvent({ content }: Pick<AgentTaskResultProps, "content">) {
  const { lang, t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = content ?? "";
  const long = text.length > 600 || text.split("\n").length > 12;
  const parsed = useMemo(() => parseS3Error(text), [text]);
  const structuredError = parsed !== null && isMostlyError(text, parsed);
  const label = lang === "zh" ? "Direction" : "Direction";

  return (
    <section className="group max-w-[46rem] animate-fade-in-up" data-testid="direction-event" aria-label={label}>
      {structuredError && parsed ? (
        <S3ErrorArtifact error={parsed} raw={text} />
      ) : (
        <div className="rounded-lg border border-edge bg-panel/40 px-4 py-3">
          <div className="mb-1 flex items-center gap-2 text-2xs font-medium uppercase tracking-widest text-gray-500">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
            {label}
          </div>
          <div className="whitespace-pre-wrap break-words text-sm leading-6 text-gray-200">
            <div className={long && !expanded ? "max-h-44 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]" : ""}>{text}</div>
            {long ? (
              <button type="button" onClick={() => setExpanded((v) => !v)} className="mt-2 text-xs font-medium text-gray-500 hover:text-accent">
                {expanded ? (lang === "zh" ? "收起" : "Show less") : (lang === "zh" ? "展开" : "Show more")}
              </button>
            ) : null}
          </div>
        </div>
      )}

      {!structuredError ? (
        <div className="mt-2 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            onClick={() => void copyText(text).then((ok) => { if (!ok) return; setCopied(true); window.setTimeout(() => setCopied(false), 1200); })}
            className="rounded-md border border-transparent px-2 py-1 text-xs text-gray-500 hover:border-edge hover:bg-hover hover:text-gray-200"
            aria-label={t("common.copy")}
          >
            {copied ? t("common.copied") : t("common.copy")}
          </button>
        </div>
      ) : null}
    </section>
  );
}

export const AgentTaskResult = memo(function AgentTaskResult({
  referencedEvidenceIds = [],
  referencedRunIds = [],
  hasReport = false,
  figures,
  ...props
}: AgentTaskResultProps) {
  const { lang } = useI18n();
  if (props.role === "user") {
    return <DirectionEvent content={props.content} />;
  }

  const evidenceCount = referencedEvidenceIds.length;
  const executionCount = referencedRunIds.length;
  const showArtifacts = !props.streaming && (evidenceCount > 0 || executionCount > 0 || hasReport);
  const label = props.streaming
    ? (lang === "zh" ? "Execution" : "Execution")
    : (lang === "zh" ? "Work Result" : "Work Result");

  return (
    <article
      className="w-full max-w-[64rem] rounded-lg border border-edge bg-panel px-5 py-5"
      data-testid="work-result"
      data-work-result="true"
      data-streaming={props.streaming ? "true" : "false"}
      data-result-shape={resultShape(props.content)}
      aria-label={label}
    >
      <div className="mb-3 flex items-center gap-2 border-b border-edge pb-3">
        <span className="grid h-7 w-7 place-items-center rounded-md bg-accent text-accent-fg">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" /></svg>
        </span>
        <span className="text-sm font-normal tracking-tight text-gray-100" style={{ letterSpacing: '-0.02em', fontWeight: 400 }}>{label}</span>
        {props.streaming ? <span className="ml-auto flex items-center gap-1.5 text-xs text-gray-500"><span className="working-mark" /> Working</span> : null}
      </div>

      <div className="prose max-w-none">
        <AgentResultRenderer
          content={props.content}
          toolActivity={props.toolActivity}
          streaming={props.streaming}
          sessionId={props.sessionId}
        />
      </div>
      {figures}

      {showArtifacts ? (
        <nav className="mt-4 flex flex-wrap gap-2 border-t border-edge pt-4" aria-label={lang === "zh" ? "工作产物" : "Work artifacts"} data-testid="work-result-artifacts">
          {evidenceCount > 0 ? (
            <button type="button" onClick={() => openAgentReview("evidence")} data-testid="work-result-open-evidence" className="inline-flex items-center gap-1.5 rounded-lg border border-edge bg-canvas px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-hover hover:text-gray-100">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>
              Evidence <span className="rounded-full bg-accent px-1.5 py-0.5 text-2xs font-semibold text-accent-fg">{evidenceCount}</span>
            </button>
          ) : null}
          {executionCount > 0 ? (
            <button type="button" onClick={() => { if (executionCount === 1) openAgentExecution(referencedRunIds[0]); else openAgentReview("execution"); }} data-testid="work-result-open-execution" className="inline-flex items-center gap-1.5 rounded-lg border border-edge bg-canvas px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-hover hover:text-gray-100">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><polyline points="22 12 18 12 14 8 8 8 4 12 22 12" /><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>
              Execution <span className="rounded-full bg-accent px-1.5 py-0.5 text-2xs font-semibold text-accent-fg">{executionCount}</span>
            </button>
          ) : null}
          {hasReport ? (
            <button type="button" onClick={() => openAgentReview("report")} data-testid="work-result-open-report" className="inline-flex items-center gap-1.5 rounded-lg border border-edge bg-canvas px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-hover hover:text-gray-100">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
              Report
            </button>
          ) : null}
        </nav>
      ) : null}
    </article>
  );
});
