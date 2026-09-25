import { memo, useMemo, type ReactNode } from "react";
import type { Conclusion } from "../types";
import { useCopy } from "../hooks/useCopy";
import { useI18n } from "../i18n";
import { isMostlyError, parseS3Error } from "../lib/s3error";
import { segmentsOf, type TurnItem } from "../lib/turnItems";
import { fmtElapsed, useElapsed } from "../hooks/useElapsed";
import { Markdown } from "./Markdown";
import { S3ErrorArtifact } from "./S3ErrorArtifact";
import { TranscriptItems } from "./TranscriptItems";
import { WorkingRow } from "./WorkedGroup";
import { Icon } from "./icons";
import { revealInScroller } from "../lib/scroll";

function CopyAction({ text, testId }: { text: string; testId: string }) {
  const { t } = useI18n();
  const { copied, copy } = useCopy(1200);
  return (
    <button
      type="button"
      className="native-ghost-action"
      onClick={() => copy(text)}
      aria-label={t("common.copy")}
      data-testid={testId}
    >
      <Icon name={copied ? "check" : "copy"} size={14} />
      {copied ? t("common.copied") : t("common.copy")}
    </button>
  );
}

/** The user's Direction: the section heading of a turn, left-aligned in the
 * reading column — not a speech bubble. Copy on hover, no other chrome. */
export const UserTurn = memo(function UserTurn({ content, tag }: { content: string | null; tag?: ReactNode }) {
  const { t } = useI18n();
  const text = content ?? "";
  const parsed = useMemo(() => parseS3Error(text), [text]);
  const structuredError = parsed !== null && isMostlyError(text, parsed);
  return (
    <div className="turn-direction group" data-testid="turn-user" aria-label={t("turn.userLabel")}>
      {structuredError && parsed ? (
        <div className="turn-direction-artifact"><S3ErrorArtifact error={parsed} raw={text} /></div>
      ) : (
        <div className="turn-direction-text">{text}</div>
      )}
      <div className="turn-direction-actions">
        {tag}
        {!structuredError ? <CopyAction text={text} testId="copy-direction" /> : null}
      </div>
    </div>
  );
});

/** The first readable line of a Markdown answer, bounded — the folded
 * summary of a Work Result in the Work log when no conclusion was recorded. */
export function answerGist(text: string, limit = 160): string {
  const line = text
    .split("\n")
    .map((part) => part.replace(/^[#>*\-\s|`]+/, "").replace(/[*_`]/g, "").trim())
    .find((part) => part.length > 0) ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** How a turn shows its answer: whole (live, or a Task without a Result
 * section), folded to one line (older turns in the Work log), as a pointer
 * to the Result at the top of the Task (the latest turn), or not at all — the
 * turn's work under its own Result, in a one-Direction Task (v2.2). */
export type AnswerMode = "full" | "folded" | "above" | "none";

/**
 * One Agent turn: items (commentary · worked group · steer) then the
 * answer as Markdown on the reading measure. `live` renders the same shape
 * from the run store while the execution is still going.
 */
export const AgentTurn = memo(function AgentTurn({
  items,
  answer,
  live = false,
  stoppedLabel = null,
  startedAt = null,
  taskId,
  figures,
  findActive = false,
  answerMode = "full",
  conclusion = null,
  head,
}: {
  items: TurnItem[];
  answer: string | null;
  answerMode?: AnswerMode;
  /** The turn's recorded conclusion (folded summary; live head). */
  conclusion?: Conclusion | null;
  /** Rendered before the answer (the live conclusion, v2.0). */
  head?: ReactNode;
  live?: boolean;
  /** Rendered as a tag on the last segment after the user pressed Stop. */
  stoppedLabel?: string | null;
  startedAt?: number | null;
  taskId?: string | null;
  figures?: ReactNode;
  /** Find holds a runnable query: unfold groups so hits exist in the DOM. */
  findActive?: boolean;
}) {
  const { t } = useI18n();
  const text = answer ?? "";
  const segments = useMemo(() => segmentsOf(items), [items]);
  const last = segments[segments.length - 1];
  const elapsed = useElapsed(startedAt, live && !answer);
  // Something is visibly in progress: a live commentary caret or a growing
  // worked group. Otherwise the shimmer row says so.
  const inProgress = Boolean(last && (
    (last.kind === "commentary" && last.live)
    || last.kind === "worked"
  ));
  const showWorking = live && !stoppedLabel && !text.trim() && !inProgress;
  // v1.13 — long-run reassurance: past 90 s of live work, say the turn is
  // still going (and steer/stop are available) instead of a bare shimmer.
  const longRunning = live && !stoppedLabel && elapsed != null && elapsed >= 90_000;
  const workingLabel = elapsed != null && elapsed >= 1000
      ? t("turn.workingFor", { t: fmtElapsed(elapsed) ?? "" })
      : t("turn.working");

  return (
    <article
      className="turn-agent group"
      // A Work log turn is the process record; the Work Result itself is the
      // Result at the top of the Task (v2.0).
      data-testid={answerMode === "full" ? "work-result" : "log-turn"}
      data-work-result={answerMode === "full" ? "true" : undefined}
      data-streaming={live ? "true" : "false"}
      aria-label={live ? t("turn.executionLabel") : t("turn.answerLabel")}
    >
      <TranscriptItems
        items={items}
        live={live}
        taskId={taskId}
        startedAt={startedAt}
        findActive={findActive}
      />
      {showWorking ? <WorkingRow label={workingLabel} /> : null}
      {longRunning ? (
        <p className="turn-long-running" data-testid="turn-long-running">{t("turn.longRunning")}</p>
      ) : null}
      {head}
      {text.trim() && answerMode === "full" ? (
        <div className="turn-answer" data-testid="turn-answer">
          <Markdown text={text} />
        </div>
      ) : null}
      {/* An open Find walks folded answers as plain text: one copy, visible. */}
      {text.trim() && answerMode === "folded" && findActive ? (
        <div className="turn-answer turn-answer-found" data-testid="log-answer">
          <Markdown text={text} />
        </div>
      ) : null}
      {text.trim() && answerMode === "folded" && !findActive ? (
        <details className="turn-answer-fold" data-testid="log-answer">
          <summary>
            <span className="turn-answer-fold-chevron" aria-hidden><Icon name="chevron" size={14} /></span>
            <span className="turn-answer-fold-gist">{conclusion?.answer || answerGist(text)}</span>
          </summary>
          <div className="turn-answer">
            <Markdown text={text} />
          </div>
        </details>
      ) : null}
      {text.trim() && answerMode === "above" ? (
        <button
          type="button"
          className="turn-result-above"
          data-testid="log-result-above"
          onClick={() => revealInScroller(document.getElementById("task-result"), "start")}
        >
          <Icon name="arrowUp" size={14} />
          {t("log.resultAbove")}
        </button>
      ) : null}
      {figures}
      {stoppedLabel ? <div className="turn-tag" data-testid="turn-stopped">{stoppedLabel}</div> : null}
      {!live && text.trim() && answerMode === "full" ? (
        <div className="native-row-actions">
          <CopyAction text={text} testId="copy-work-result" />
        </div>
      ) : null}
    </article>
  );
});
