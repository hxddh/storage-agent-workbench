import { memo, useMemo, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { isMostlyError, parseS3Error } from "../lib/s3error";
import { segmentsOf, type TurnItem } from "../lib/turnItems";
import { fmtElapsed, useElapsed } from "../hooks/useElapsed";
import type { ApprovalResolution, ApprovalScope } from "./ApprovalCard";
import { Markdown } from "./Markdown";
import { S3ErrorArtifact } from "./S3ErrorArtifact";
import { TranscriptItems } from "./TranscriptItems";
import { WorkingRow } from "./LiveTrace";
import { Icon } from "./icons";

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

function CopyAction({ text, testId }: { text: string; testId: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="native-ghost-action"
      onClick={() => void copyText(text).then((ok) => { if (!ok) return; setCopied(true); window.setTimeout(() => setCopied(false), 1200); })}
      aria-label={t("common.copy")}
      data-testid={testId}
    >
      <Icon name={copied ? "check" : "copy"} size={12} />
      {copied ? t("common.copied") : t("common.copy")}
    </button>
  );
}

/** The user's message: a right-aligned bubble, copy on hover, no other chrome. */
export const UserTurn = memo(function UserTurn({ content, tag }: { content: string | null; tag?: ReactNode }) {
  const { t } = useI18n();
  const text = content ?? "";
  const parsed = useMemo(() => parseS3Error(text), [text]);
  const structuredError = parsed !== null && isMostlyError(text, parsed);
  return (
    <div className="turn-user group" data-testid="turn-user" aria-label={t("turn.userLabel")}>
      {structuredError && parsed ? (
        <div className="turn-user-artifact"><S3ErrorArtifact error={parsed} raw={text} /></div>
      ) : (
        <div className="turn-user-bubble">{text}</div>
      )}
      <div className="turn-user-actions">
        {tag}
        {!structuredError ? <CopyAction text={text} testId="copy-direction" /> : null}
      </div>
    </div>
  );
});

/**
 * One Agent turn: items (commentary · worked group · approval) then the
 * answer as Markdown on the reading measure. `live` renders the same shape
 * from the run store while the execution is still going.
 */
export const AgentTurn = memo(function AgentTurn({
  items,
  answer,
  live = false,
  waiting = false,
  stoppedLabel = null,
  startedAt = null,
  sessionId,
  figures,
  onResolve,
  resolvingId = null,
}: {
  items: TurnItem[];
  answer: string | null;
  live?: boolean;
  waiting?: boolean;
  /** Rendered as a tag on the last segment after the user pressed Stop. */
  stoppedLabel?: string | null;
  startedAt?: number | null;
  sessionId?: string | null;
  figures?: ReactNode;
  onResolve?: (decisionId: string, resolution: ApprovalResolution, scope: ApprovalScope) => void;
  resolvingId?: string | null;
}) {
  const { t } = useI18n();
  const text = answer ?? "";
  const segments = useMemo(() => segmentsOf(items), [items]);
  const last = segments[segments.length - 1];
  const elapsed = useElapsed(startedAt, live && !answer);
  // Something is visibly in progress: a live commentary caret, a growing
  // worked group, or a pending approval. Otherwise the shimmer row says so.
  const inProgress = Boolean(last && (
    (last.kind === "commentary" && last.live)
    || last.kind === "worked"
    || (last.kind === "approval" && last.status === "pending")
  ));
  const showWorking = live && !stoppedLabel && !text.trim() && !inProgress;
  const workingLabel = waiting
    ? t("turn.waitingApproval")
    : elapsed != null && elapsed >= 1000
      ? t("turn.workingFor", { t: fmtElapsed(elapsed) ?? "" })
      : t("turn.working");

  return (
    <article
      className="turn-agent group"
      data-testid="work-result"
      data-work-result="true"
      data-streaming={live ? "true" : "false"}
      aria-label={live ? t("turn.executionLabel") : t("turn.answerLabel")}
    >
      <TranscriptItems
        items={items}
        live={live}
        sessionId={sessionId}
        startedAt={startedAt}
        onResolve={onResolve}
        resolvingId={resolvingId}
      />
      {showWorking ? <WorkingRow label={workingLabel} /> : null}
      {text.trim() ? (
        <div className="turn-answer" data-testid="turn-answer">
          <Markdown text={text} />
        </div>
      ) : null}
      {figures}
      {stoppedLabel ? <div className="turn-tag" data-testid="turn-stopped">{stoppedLabel}</div> : null}
      {!live && text.trim() ? (
        <div className="native-row-actions">
          <CopyAction text={text} testId="copy-work-result" />
        </div>
      ) : null}
    </article>
  );
});
