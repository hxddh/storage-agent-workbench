import { useEffect, useMemo, useRef, useState } from "react";
import {
  dispatchDurableEvent,
  followExecutionEvents,
  getSession,
  getTaskExecution,
  listTaskEvents,
  type LiveEventHandlers,
  type TaskEvent,
  type TaskExecution,
} from "../api";
import type { SessionDetail, SessionFinding, SessionMessage } from "../types";
import {
  applyCompacted,
  applyDelta,
  applyPlan,
  applyStatus,
  applyTool,
  completeMessage,
  EMPTY_TURN,
  grantApproval,
  openApproval,
  resolveApproval,
  type LiveTurn,
} from "../lib/turnItems";
import { TranscriptItems } from "./TranscriptItems";
import { Markdown } from "./Markdown";
import { useI18n } from "../i18n";
import { fmtElapsed } from "../hooks/useElapsed";
import { Icon } from "./icons";

const SEVERITY_KEY: Record<string, string> = {
  critical: "metric.critical", error: "metric.critical", warning: "metric.warning",
  opportunity: "metric.opportunity", good: "metric.good",
  "provider unsupported": "metric.providerUnsupported",
  "access denied": "metric.accessDenied",
};

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const EVENT_PAGE = 1000;
const EVENT_PAGES_MAX = 20;

/** What the durable log says about one execution, reduced into the same turn
 * shape the live transcript renders. */
type Replay = {
  turn: LiveTurn;
  lastSeq: number;
  status: string | null;
  error: string | null;
  messageId: string | null;
  stopped: boolean;
};

/** One handler map that folds every durable frame into a `LiveTurn` — the
 * reducers of `lib/turnItems`, so the detail document and the transcript
 * never disagree about what a row means. */
function reducerHandlers(update: (fn: (turn: LiveTurn) => LiveTurn) => void, meta: {
  onTerminal: (status: string, payload: Record<string, any>) => void;
}): LiveEventHandlers {
  return {
    onDelta: (text) => update((turn) => applyDelta(turn, text)),
    onTool: (record) => update((turn) => applyTool(turn, record)),
    onMessageCompleted: (payload) => update((turn) => completeMessage(turn, payload)),
    onApprovalOpened: (payload) => update((turn) => openApproval(turn, payload)),
    onApprovalGranted: (payload) => update((turn) => grantApproval(turn, payload)),
    onDecisionResolved: (payload) => update((turn) => resolveApproval(turn, payload)),
    onPlanUpdated: (payload) => update((turn) => applyPlan(turn, payload.steps)),
    onContextCompacted: (payload) => update((turn) => applyCompacted(turn, payload)),
    onStatus: (payload) => {
      update((turn) => applyStatus(turn, payload.status));
      if (TERMINAL.has(payload.status)) meta.onTerminal(payload.status, payload as Record<string, any>);
    },
  };
}

/** Replay the execution's rows out of the task's durable log — the one
 * vocabulary the transcript speaks. Exported for the unit contract. */
export function replayExecutionEvents(events: TaskEvent[], executionId: string): Replay {
  let turn: LiveTurn = EMPTY_TURN;
  const out: Replay = { turn, lastSeq: 0, status: null, error: null, messageId: null, stopped: false };
  const handlers = reducerHandlers((fn) => { turn = fn(turn); }, {
    onTerminal: (status, payload) => {
      out.status = status;
      out.error = typeof payload.error === "string" ? payload.error : null;
      if (typeof payload.message_id === "string") out.messageId = payload.message_id;
      if (payload.stopped === true) out.stopped = true;
    },
  });
  for (const event of events) {
    if (event.seq > out.lastSeq) out.lastSeq = event.seq;
    if (event.execution_id !== executionId) continue;
    const payload = (event.payload ?? {}) as Record<string, any>;
    if (event.event_type === "work_result.recorded") {
      if (typeof payload.message_id === "string") out.messageId = payload.message_id;
      if (payload.stopped === true) out.stopped = true;
      continue;
    }
    if (event.event_type === "execution.status" && !TERMINAL.has(String(payload.status))) {
      out.status = String(payload.status);
    }
    dispatchDurableEvent(event.event_type, payload, handlers, event.created_at);
  }
  out.turn = turn;
  return out;
}

/** Read the whole task log in pages — never a silent cap. */
async function readTaskLog(taskId: string, after = 0): Promise<{ events: TaskEvent[]; lastSeq: number }> {
  const events: TaskEvent[] = [];
  let cursor = after;
  for (let page = 0; page < EVENT_PAGES_MAX; page++) {
    const chunk = await listTaskEvents(taskId, { after: cursor, limit: EVENT_PAGE });
    events.push(...chunk.events);
    if (chunk.events.length < EVENT_PAGE) break;
    cursor = chunk.events[chunk.events.length - 1]?.seq ?? cursor;
  }
  return { events, lastSeq: events.length ? events[events.length - 1].seq : after };
}

function stamp(value?: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function firstLine(text: string | null | undefined, max = 120): string {
  const line = (text ?? "").split("\n").map((s) => s.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * One durable Execution, read as a document inside the Artifacts panel:
 * header from the execution row, one *Worked for …* group of its tool rows
 * (plan · approvals · compaction marker in order) from the durable event
 * log, the findings and the Work Result it produced. Live while the
 * execution is still going — the same event stream the transcript follows,
 * resumed at the last replayed sequence — durable afterwards.
 */
export function ExecutionDetailImplementation({
  taskId,
  executionId,
  onBack,
}: {
  taskId: string;
  executionId: string;
  onBack: () => void;
}) {
  const [execution, setExecution] = useState<TaskExecution | null>(null);
  const [turn, setTurn] = useState<LiveTurn>(EMPTY_TURN);
  const [replay, setReplay] = useState<Omit<Replay, "turn">>({ lastSeq: 0, status: null, error: null, messageId: null, stopped: false });
  const [document, setDocument] = useState<SessionDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const turnRef = useRef<LiveTurn>(EMPTY_TURN);
  const { t, lang } = useI18n();
  const copy = lang === "zh"
    ? {
        back: "返回 Execution 列表",
        loadFailed: "无法加载这次 Execution：",
        failure: "Execution 失败：",
        fallbackTitle: "Agent Execution",
        direction: "Direction",
        findings: "Findings",
        noFindings: "这次 Execution 没有记录 Findings。",
        noTools: "这次 Execution 没有调用工具。",
        result: "Work Result",
        noResult: "这次 Execution 没有留下 Work Result。",
        stopped: "已由你停止",
        gaps: "证据缺口",
        skills: "使用的技能",
        statuses: {
          queued: "排队中", running: "执行中", waiting: "等待批准", completed: "已完成",
          failed: "失败", cancelled: "已停止", interrupted: "已中断",
        } as Record<string, string>,
        kinds: {
          direction: "方向", verify: "验证", revisit: "回访", steer_followup: "补充方向的后续执行",
        } as Record<string, string>,
      }
    : {
        back: "Back to Executions",
        loadFailed: "Couldn't load this execution:",
        failure: "Execution failed:",
        fallbackTitle: "Agent execution",
        direction: "Direction",
        findings: "Findings",
        noFindings: "This execution recorded no findings.",
        noTools: "This execution called no tools.",
        result: "Work Result",
        noResult: "This execution left no Work Result.",
        stopped: "Stopped by you",
        gaps: "Evidence gaps",
        skills: "Skills used",
        statuses: {
          queued: "queued", running: "running", waiting: "waiting for approval", completed: "complete",
          failed: "failed", cancelled: "stopped", interrupted: "interrupted",
        } as Record<string, string>,
        kinds: {
          direction: "Direction", verify: "Verify", revisit: "Revisit", steer_followup: "Steer follow-up",
        } as Record<string, string>,
      };

  const severityLabel = (severity?: string | null): string => {
    const normalized = (severity || "").toLowerCase();
    return SEVERITY_KEY[normalized] ? t(SEVERITY_KEY[normalized]) : severity || "info";
  };

  useEffect(() => {
    let cancelled = false;
    let followCtl: AbortController | null = null;
    turnRef.current = EMPTY_TURN;
    setTurn(EMPTY_TURN);
    setReplay({ lastSeq: 0, status: null, error: null, messageId: null, stopped: false });
    setExecution(null);
    setDocument(null);
    setLoadError(null);

    const update = (fn: (turn: LiveTurn) => LiveTurn) => {
      turnRef.current = fn(turnRef.current);
      if (!cancelled) setTurn(turnRef.current);
    };
    const readDocument = () => getSession(taskId)
      .then((next) => { if (!cancelled) setDocument(next); })
      .catch(() => undefined);
    const readHeader = () => getTaskExecution(taskId, executionId)
      .then((next) => { if (!cancelled) setExecution(next); return next; });

    (async () => {
      let header: TaskExecution | null = null;
      try {
        header = await readHeader();
      } catch (error) {
        if (!cancelled) setLoadError(String((error as Error)?.message ?? error));
        return;
      }
      let replayed: Replay;
      try {
        const log = await readTaskLog(taskId);
        replayed = replayExecutionEvents(log.events, executionId);
        replayed.lastSeq = log.lastSeq;
      } catch (error) {
        if (!cancelled) setLoadError(String((error as Error)?.message ?? error));
        return;
      }
      if (cancelled) return;
      turnRef.current = replayed.turn;
      setTurn(replayed.turn);
      setReplay({ lastSeq: replayed.lastSeq, status: replayed.status, error: replayed.error, messageId: replayed.messageId, stopped: replayed.stopped });
      void readDocument();
      if (TERMINAL.has(header.status)) return;
      // Still executing: keep reading the SAME durable stream from where the
      // replay stopped. Closing it changes nothing server-side.
      followCtl = new AbortController();
      const handlers = reducerHandlers(update, {
        onTerminal: (status, payload) => {
          if (cancelled) return;
          setReplay((prev) => ({
            ...prev, status,
            error: typeof payload.error === "string" ? payload.error : prev.error,
            messageId: typeof payload.message_id === "string" ? payload.message_id : prev.messageId,
            stopped: payload.stopped === true || prev.stopped,
          }));
        },
      });
      try {
        await followExecutionEvents(taskId, executionId, handlers, { signal: followCtl.signal, after: replayed.lastSeq });
      } catch {
        /* failed / interrupted / disconnected — the header below is the durable truth */
      }
      if (cancelled) return;
      void readHeader().catch(() => undefined);
      void readDocument();
    })();

    return () => {
      cancelled = true;
      followCtl?.abort();
    };
  }, [taskId, executionId]);

  const status = replay.status && TERMINAL.has(replay.status) ? replay.status : execution?.status ?? replay.status ?? "queued";
  const running = status === "running" || status === "queued" || status === "waiting";
  const errorMessage = replay.error ?? execution?.error ?? null;

  const workResult = useMemo<SessionMessage | null>(() => {
    if (!document || !replay.messageId) return null;
    return document.messages.find((message) => message.id === replay.messageId) ?? null;
  }, [document, replay.messageId]);
  // The persisted Work Result carries the full text; the final closed segment
  // of the log is the fallback for an execution whose message paged out.
  const answer = workResult?.content ?? turn.answer;

  const findings = useMemo<SessionFinding[]>(() => {
    if (!document || !workResult) return [];
    const runs = new Set(workResult.referenced_run_ids ?? []);
    if (runs.size === 0) return [];
    return document.findings.filter((finding) => finding.source_run_id && runs.has(finding.source_run_id));
  }, [document, workResult]);
  const grounding = workResult?.grounding ?? null;
  const gaps = grounding?.evidence_gaps ?? [];
  const skills = grounding?.skills_used ?? [];

  const startedMs = stamp(execution?.started_at) ?? stamp(execution?.created_at);
  const finishedMs = stamp(execution?.finished_at);
  const spanMs = startedMs != null && finishedMs != null ? Math.max(0, finishedMs - startedMs) : null;
  const title = firstLine(execution?.direction) || copy.kinds[execution?.kind ?? ""] || copy.fallbackTitle;
  const hasRows = turn.items.length > 0;

  return (
    <article className="native-execution-doc" data-testid="execution-detail-body" data-execution-id={executionId}>
      <header className="native-execution-doc-head">
        <button type="button" className="native-ghost-action -ml-1.5" onClick={onBack}>
          <Icon name="arrowRight" size={13} className="rotate-180" />
          {copy.back}
        </button>
        {loadError ? (
          <p className="native-banner mt-3" data-tone="danger">{copy.loadFailed} {loadError}</p>
        ) : null}
        <h1>{title}</h1>
        <p className="native-execution-doc-meta">
          <span className="native-execution-doc-status" data-status={status} data-testid="execution-status">
            {running ? <span className="working-mark" style={{ width: 6, height: 6 }} aria-hidden /> : null}
            {copy.statuses[status] ?? status}
          </span>
          {execution?.kind ? <span data-testid="execution-kind">{copy.kinds[execution.kind] ?? execution.kind}</span> : null}
          {execution?.started_at ? <span>{execution.started_at.replace("T", " ").slice(0, 19)}</span> : null}
          {spanMs != null ? <span data-testid="execution-span">{fmtElapsed(spanMs) ?? "—"}</span> : null}
          {execution?.steer_count ? <span>steer × {execution.steer_count}</span> : null}
        </p>
      </header>

      {errorMessage ? (
        <div className="native-banner" data-tone="danger" data-testid="execution-error">
          <strong>{copy.failure}</strong> {errorMessage}
        </div>
      ) : null}

      {execution?.direction ? (
        <section className="native-execution-doc-block">
          <h2>{copy.direction}</h2>
          <blockquote className="native-direction">{execution.direction}</blockquote>
        </section>
      ) : null}

      <section className="native-execution-doc-block" data-testid="execution-steps">
        {hasRows ? (
          <TranscriptItems items={turn.items} live={running} sessionId={taskId} startedAt={startedMs} />
        ) : (
          <p className="agent-empty-line">{copy.noTools}</p>
        )}
      </section>

      <section className="native-execution-doc-block" data-testid="execution-findings">
        <h2>{copy.findings}</h2>
        {findings.length === 0 && gaps.length === 0 && skills.length === 0 ? (
          <p className="agent-empty-line">{copy.noFindings}</p>
        ) : (
          <>
            {findings.length > 0 ? (
              <ul className="native-execution-doc-findings">
                {findings.map((finding) => (
                  <li key={finding.id} data-severity={(finding.severity || "").toLowerCase()}>
                    <span className="native-execution-doc-severity">{severityLabel(finding.severity)}</span>
                    <span>
                      <strong>{finding.title}</strong>
                      {finding.interpretation ? <span className="text-gray-500"> — {finding.interpretation}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {gaps.length > 0 ? (
              <p className="agent-empty-line" data-testid="execution-gaps"><strong>{copy.gaps}:</strong> {gaps.join("; ")}</p>
            ) : null}
            {skills.length > 0 ? (
              <p className="agent-empty-line" data-testid="execution-skills"><strong>{copy.skills}:</strong> {skills.join(", ")}</p>
            ) : null}
          </>
        )}
      </section>

      <section className="native-execution-doc-block" data-testid="execution-result">
        <h2>{copy.result}</h2>
        {answer && answer.trim() ? (
          <div className="agent-prose"><Markdown text={answer} /></div>
        ) : running ? null : (
          <p className="agent-empty-line">{copy.noResult}</p>
        )}
        {replay.stopped || (workResult && status === "cancelled") ? <div className="turn-tag">{copy.stopped}</div> : null}
      </section>
    </article>
  );
}
