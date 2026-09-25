/**
 * The turn runner: ensureTask + submit (durable execution + event stream
 * with seq reconnect) + dataset-upload submit + Stop (`stopTaskExecution`,
 * the ONE cancel path). Extracted from the task renderer so the view stays
 * presentational.
 *
 * All run state is written to the liveTasks store keyed by the id the turn
 * STARTED with — not the currently-visible task — so a turn keeps streaming
 * (and keeps its content) if the user switches tasks mid-run.
 *
 * Stream recovery is `after=<last seq>` on the durable event log. There is no
 * blocking POST fallback, no turn-cancel endpoint, and no assistant-id poll.
 */
import { useMemo, useRef } from "react";
import { deriveTaskTitle } from "../lib/taskTitle";
import type { Conclusion } from "../types";
import {
  ApiError,
  createTaskExecution,
  deleteTask,
  createTask,
  getTaskRecord,
  getTaskState,
  followExecutionEvents,
  resumeTaskExecution,
  steerTaskExecution,
  stopTaskExecution,
  submitErrorTriage,
  uploadTaskDataset,
} from "../api";
import {
  CLEAR_TURN,
  getLiveTask,
  liveTurnOf,
  patchLiveTask,
  registerTurnAbort,
  registerTurnCancel,
  unregisterTurnAbort,
  unregisterTurnCancel,
  type LiveTask,
} from "../liveTasks";
import { useI18n, type TFunc } from "../i18n";
import {
  applyCompacted,
  applyDelta,
  applyPlan,
  applySteer,
  applyStatus,
  applyTool,
  completeMessage,
  grantApproval,
  mergeTool,
  openApproval,
  resolveApproval,
  type LiveTurn,
} from "../lib/turnItems";

export { mergeTool };

// Turn a raw sidecar/provider error into a short, actionable, localized line.
// The model-provider hints (bad key / unknown model / provider unreachable)
// only make sense for TURN failures; anything else (e.g. a session-load
// failure) gets the neutral cleaned message instead of misleading guidance.
export const cleanError = (raw: string, t: TFunc, kind: "turn" | "load" = "turn"): string => {
  const s = raw
    .replace(/^(?:ApiError|Error):\s*/, "")
    .replace(/^Session assistant failed:\s*/, "");
  if (kind === "turn") {
    if (/agents sdk is not available|agent runtime/i.test(s)) return t("task.agentRuntimeUnavailable");
    if (/401|authentication|api key.*invalid|invalid.*api key/i.test(s)) return t("task.errKey");
    // The model-404 hint must be provider-shaped: a bare "not found" / "404"
    // (e.g. "session not found" when a session is deleted mid-turn) would
    // otherwise send the user to fix a model name/base-URL that isn't the
    // problem. Require model/provider/endpoint context alongside the 404.
    if (/\b(model|provider|endpoint|base ?url)\b/i.test(s) &&
        /404|not found|does not exist|no such model|unknown model/i.test(s))
      return t("task.err404");
    if (/timeout|timed out|connection|network/i.test(s)) return t("task.errNetwork");
  }
  return s.length > 280 ? `${s.slice(0, 280)}…` : s;
};

// Heuristic: does this message look like a raw error to triage offline?
// A bare 3-digit number is only treated as an HTTP status when it sits next to
// error-ish context (status/HTTP/error/…) — "I have 404 objects" is prose.
export const looksLikeError = (text: string) =>
  /<\?xml|<error>|<code>|accessdenied|signaturedoesnotmatch|nosuchbucket|invalidaccesskey|requesttimeout|slowdown|traceback|botocore|\bhttp\/\d/i.test(text) ||
  /\b(?:status|http|error|code|failed|response|returned)\b[^\d\n]{0,16}\b[45]\d\d\b/i.test(text) ||
  /\b[45]\d\d\b\s+(?:forbidden|unauthorized|access denied|not found|bad request|conflict|too many requests|internal server error|service unavailable|slow ?down|gateway|request timeout)/i.test(text);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const newTurnId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** The one handler map every live follower uses: each durable frame is
 * reduced into the run's ordered turn items (lib/turnItems). */
export function liveHandlers(id: string) {
  const reduce = (fn: (turn: LiveTurn) => LiveTurn) =>
    patchLiveTask(id, (s: LiveTask) => {
      const next = fn(liveTurnOf(s));
      return { items: next.items, answer: next.answer, waiting: next.waiting };
    });
  return {
    onDelta: (chunk: string) => reduce((turn) => applyDelta(turn, chunk)),
    onTool: (rec: Parameters<typeof applyTool>[1]) => reduce((turn) => applyTool(turn, rec)),
    onMessageCompleted: (payload: Parameters<typeof completeMessage>[1]) => reduce((turn) => completeMessage(turn, payload)),
    onApprovalOpened: (payload: Parameters<typeof openApproval>[1]) => reduce((turn) => openApproval(turn, payload)),
    onApprovalGranted: (payload: Parameters<typeof grantApproval>[1]) => reduce((turn) => grantApproval(turn, payload)),
    onDecisionResolved: (payload: Parameters<typeof resolveApproval>[1]) => reduce((turn) => resolveApproval(turn, payload)),
    onStatus: (payload: { status: string }) => reduce((turn) => applyStatus(turn, payload.status)),
    // v1.12: the plan the model owns, the compaction marker (+ the meter's
    // new figure), and the task's derived status straight from the stream.
    onPlanUpdated: (payload: { steps: Parameters<typeof applyPlan>[1] }) => reduce((turn) => applyPlan(turn, payload.steps)),
    onSteerApplied: (payload: { text: string }) => reduce((turn) => applySteer(turn, payload.text)),
    onContextCompacted: (payload: Parameters<typeof applyCompacted>[1] & { summary_chars?: number }) =>
      patchLiveTask(id, (s: LiveTask) => {
        const next = applyCompacted(liveTurnOf(s), payload);
        return { items: next.items, answer: next.answer, waiting: next.waiting, contextTokens: payload.after_tokens ?? s.contextTokens };
      }),
    onTaskStatus: (payload: LiveTask["taskStatus"]) => patchLiveTask(id, { taskStatus: payload }),
    onConclusionRecorded: (payload: Conclusion) => patchLiveTask(id, { conclusion: payload }),
  };
}

type Outcome = "ok" | "stopped" | "failed" | "triaged" | "inprogress";

type InFlight = {
  controller: AbortController;
  turnId: string;
  /** The durable execution behind this turn, once the submit returned. */
  executionId: string | null;
  cancelPromise: Promise<unknown> | null;
};

function useRunnerActions(opts: {
  /** Current composer text (via ref) — lets runTurn avoid wiping characters the
   * user typed during a steer's settle window (it only clears its OWN text). */
  getText?: () => string;
  /** Ref tracking the visible task id (owned by AgentTask). */
  localId: React.MutableRefObject<string | null>;
  onTaskCreated: (id: string) => void;
  /** The task this turn created turned out to be empty and was removed. */
  onTaskDiscarded: (id: string) => void;
  reload: (id: string | null) => Promise<boolean>;
  onChanged: () => void;
  /** Composer text setter — used to restore the user's message on a failed turn. */
  setText: (text: string) => void;
  setViewError: (msg: string | null) => void;
  /** Called after a dataset upload succeeded (clear the attachment chip). */
  onUploaded: () => void;
}) {
  const { getText, localId, onTaskCreated, onTaskDiscarded, reload, onChanged, setText, setViewError, onUploaded } = opts;
  const { t } = useI18n();
  // Per-task in-flight turn (AbortController + turn id) so Stop can abort the
  // stream AND ask the server to cancel. Keyed by the id the turn started with.
  const turnsRef = useRef<Map<string, InFlight>>(new Map());
  // Per-task pending steer payload — see steer()'s latest-wins semantics.
  const steerPendingRef = useRef<Map<string, { q: string; resend?: () => Promise<void> }>>(new Map());
  // PER-TASK synchronous double-submit latch (F1). `busy` in the store only
  // flips after async work begins, so within one task a double-Enter could
  // start two turns before busy is observable. This latch bridges that gap and
  // is released the instant the turn registers busy for the task — it is NOT
  // held for the whole turn, so a DIFFERENT task can start its own turn
  // concurrently. Keyed by task id; a not-yet-created task (the visible
  // composer submitting into a fresh task) has no id, so its single creation
  // is latched separately.
  const submitLatch = useRef<Set<string>>(new Set());
  const newTaskLatch = useRef(false);
  // Single-flight task creation, so a double-invoke can't create two tasks.
  const ensureFlight = useRef<Promise<string> | null>(null);

  // Acquire the double-submit latch for `startId` (null = the pending new
  // task) synchronously. Returns a release fn, or null when a submit for that
  // task is already starting/in flight so the caller no-ops (F1). Combined
  // with the store's `busy`, this coalesces a same-task double-submit while
  // letting other tasks run concurrently.
  const acquireSubmit = (startId: string | null): (() => void) | null => {
    if (startId) {
      if (submitLatch.current.has(startId) || getLiveTask(startId).busy) return null;
      submitLatch.current.add(startId);
    } else {
      if (newTaskLatch.current) return null;
      newTaskLatch.current = true;
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (startId) submitLatch.current.delete(startId);
      else newTaskLatch.current = false;
    };
  };

  /** True when the task on screen was created by the attempt now running,
   * and nothing has been written to it yet. See the cleanup in `failed`. */
  const createdForThisTurn = useRef(false);

  const ensureTask = (seed: string): Promise<string> => {
    if (localId.current) return Promise.resolve(localId.current);
    if (!ensureFlight.current) {
      ensureFlight.current = createTask({ title: deriveTaskTitle(seed) ?? t("common.untitled") })
        .then((s) => {
          localId.current = s.id;
          createdForThisTurn.current = true;
          onTaskCreated(s.id);
          return s.id;
        })
        .finally(() => {
          ensureFlight.current = null;
        });
    }
    return ensureFlight.current;
  };

  const classifySubmitError = async (id: string, q: string, msg: string): Promise<Outcome> => {
    if (/no model provider configured|no api key stored/i.test(msg)) {
      if (looksLikeError(q)) {
        try {
          await submitErrorTriage({ content: q, input_kind: "mixed", session_id: id });
          return "triaged";
        } catch (e2) {
          patchLiveTask(id, { error: cleanError(String(e2), t) });
          return "failed";
        }
      }
      patchLiveTask(id, { needKey: true });
      return "failed";
    }
    patchLiveTask(id, { error: cleanError(msg, t) });
    return "failed";
  };

  const followDurable = async (
    id: string,
    executionId: string,
    controller: AbortController,
    after = 0,
  ) => {
    return followExecutionEvents(id, executionId, liveHandlers(id), { signal: controller.signal, after });
  };

  // After Stop aborts the local view, drain remaining durable events at
  // after=<last seq> until the execution is terminal, then reload. Seq-based;
  // not an assistant-id poll.
  const drainAfterStop = async (id: string, executionId: string | null, after: number) => {
    if (!executionId) {
      if (localId.current === id) await reload(id);
      return;
    }
    const drainCtl = new AbortController();
    const timer = setTimeout(() => drainCtl.abort(), 30_000);
    try {
      await followExecutionEvents(
        id, executionId,
        { onDelta: () => undefined, onTool: () => undefined },
        { signal: drainCtl.signal, after },
      );
    } catch {
      /* cancelled / already terminal / timed out */
    } finally {
      clearTimeout(timer);
    }
    if (localId.current === id) {
      const reloaded = await reload(id);
      if (!reloaded && localId.current === id) patchLiveTask(id, { stalled: true });
    }
  };

  // One full turn: create a durable execution and follow its event log.
  // A dropped stream reconnects with after=<last seq>. There is no blocking
  // POST fallback. `onRegistered` fires the instant this turn sets `busy`.
  const runTurn = async (q: string, onRegistered?: () => void) => {
    const cur = getText ? getText() : null;
    if (cur === null || cur.trim() === "" || cur.trim() === q) setText("");
    let id: string;
    try {
      id = await ensureTask(q);
    } catch (e) {
      setViewError(cleanError(String(e), t));
      setText(q);
      return;
    }
    const turnId = newTurnId();
    patchLiveTask(id, {
      busy: true, error: null, needKey: false, pending: q,
      ...CLEAR_TURN, startedAt: Date.now(), stopped: false, stalled: false,
    });
    onRegistered?.();
    const controller = new AbortController();
    const flight: InFlight = { controller, turnId, executionId: null, cancelPromise: null };
    turnsRef.current.set(id, flight);
    const abort = () => controller.abort();
    registerTurnAbort(id, abort);
    // Stop before the submit returned has no durable identity to address yet;
    // the execution is stopped the moment its id is known (below).
    const serverCancel = () => {
      if (flight.executionId) void stopTaskExecution(id, flight.executionId).catch(() => undefined);
    };
    registerTurnCancel(id, serverCancel);
    let outcome: Outcome = "failed";
    let lastSeq = 0;
    try {
      let submitted: { execution: { id: string } };
      try {
        submitted = await createTaskExecution(id, q, turnId);
      } catch (e) {
        outcome = await classifySubmitError(id, q, String(e));
        if (outcome === "triaged") {
          if (localId.current === id) await reload(id);
          patchLiveTask(id, { pending: null, ...CLEAR_TURN, stopped: false });
          onChanged();
          return;
        }
        if (createdForThisTurn.current) {
          void getTaskRecord(id)
            .then((d) => {
              if ((d.messages?.length ?? 0) > 0) return;
              return deleteTask(id).then(() => {
                if (localId.current === id) localId.current = null;
                onTaskDiscarded(id);
              });
            })
            .catch(() => undefined);
        }
        if (localId.current === id) {
          setText(q);
          patchLiveTask(id, {
            pending: null, ...CLEAR_TURN, stopped: false,
            stalled: false, failedText: null,
          });
        } else {
          patchLiveTask(id, {
            pending: null, ...CLEAR_TURN, stopped: false,
            stalled: false, failedText: q,
          });
        }
        return;
      }
      flight.executionId = submitted.execution.id;
      if (controller.signal.aborted) {
        // Stop was pressed while the submit was in flight: the execution now
        // exists, so stop it by its durable identity before draining.
        flight.cancelPromise = stopTaskExecution(id, flight.executionId).catch(() => undefined);
      }
      try {
        const r = await followDurable(id, submitted.execution.id, controller, 0);
        lastSeq = r.last_seq;
        patchLiveTask(id, {
          lastMetrics: r.metrics ? { messageId: r.message_id ?? null, metrics: r.metrics } : null,
          ...(r.metrics ? { contextTokens: null } : {}),
        });
        outcome = r.stopped ? "stopped" : "ok";
      } catch (e) {
        if (controller.signal.aborted) {
          outcome = "stopped";
        } else {
          outcome = await classifySubmitError(id, q, String(e));
        }
      }

      if (outcome === "stopped") {
        patchLiveTask(id, { stopped: true });
        try {
          await flight.cancelPromise;
        } catch {
          /* cancel is best-effort */
        }
        await drainAfterStop(id, flight.executionId, lastSeq);
        patchLiveTask(id, { pending: null, ...CLEAR_TURN, stopped: false });
        onChanged();
        return;
      }

      if (outcome === "failed") {
        if (createdForThisTurn.current) {
          void getTaskRecord(id)
            .then((d) => {
              if ((d.messages?.length ?? 0) > 0) return;
              return deleteTask(id).then(() => {
                if (localId.current === id) localId.current = null;
                onTaskDiscarded(id);
              });
            })
            .catch(() => undefined);
        }
        if (localId.current === id) {
          setText(q);
          patchLiveTask(id, {
            pending: null, ...CLEAR_TURN, stopped: false,
            stalled: false, failedText: null,
          });
        } else {
          patchLiveTask(id, {
            pending: null, ...CLEAR_TURN, stopped: false,
            stalled: false, failedText: q,
          });
        }
        return;
      }

      if (outcome === "triaged") {
        if (localId.current === id) await reload(id);
        patchLiveTask(id, { pending: null, ...CLEAR_TURN, stopped: false });
        onChanged();
        return;
      }

      if (localId.current === id) {
        const reloaded = await reload(id);
        if (!reloaded) {
          if (localId.current === id) {
            patchLiveTask(id, { stalled: true });
            onChanged();
            return;
          }
        }
      }
      patchLiveTask(id, { pending: null, ...CLEAR_TURN, stopped: false });
      onChanged();
    } finally {
      turnsRef.current.delete(id);
      unregisterTurnAbort(id, abort);
      unregisterTurnCancel(id, serverCancel);
      patchLiveTask(id, { busy: false });
    }
  };

  const attachToExecution = async (executionId: string, direction?: string | null) => {
    const id = localId.current;
    if (!id) return;
    const release = acquireSubmit(id);
    if (!release) return;
    patchLiveTask(id, {
      busy: true, error: null, needKey: false,
      pending: direction || getLiveTask(id).pending,
      ...CLEAR_TURN, startedAt: Date.now(), stopped: false, stalled: false,
    });
    const turnId = newTurnId();
    const controller = new AbortController();
    const flight: InFlight = { controller, turnId, executionId, cancelPromise: null };
    turnsRef.current.set(id, flight);
    const abort = () => controller.abort();
    registerTurnAbort(id, abort);
    const serverCancel = () => {
      void stopTaskExecution(id, executionId).catch(() => undefined);
    };
    registerTurnCancel(id, serverCancel);
    release();
    try {
      const r = await followDurable(id, executionId, controller, 0);
      patchLiveTask(id, {
        lastMetrics: r.metrics ? { messageId: r.message_id ?? null, metrics: r.metrics } : null,
        ...(r.metrics ? { contextTokens: null } : {}),
      });
      if (localId.current === id) await reload(id);
      patchLiveTask(id, { pending: null, ...CLEAR_TURN, stopped: false });
      onChanged();
    } catch (e) {
      if (!controller.signal.aborted) {
        patchLiveTask(id, { error: cleanError(String(e), t) });
      }
      if (localId.current === id) await reload(id);
    } finally {
      turnsRef.current.delete(id);
      unregisterTurnAbort(id, abort);
      unregisterTurnCancel(id, serverCancel);
      patchLiveTask(id, { busy: false });
    }
  };

  const resume = async (executionId: string) => {
    const id = localId.current;
    if (!id) return;
    try {
      const { execution } = await resumeTaskExecution(id, executionId);
      await attachToExecution(execution.id, execution.direction);
    } catch (e) {
      patchLiveTask(id, { error: cleanError(String(e), t) });
    }
  };

  // Send one turn (from the composer or programmatically).
  const submit = async (q: string) => {
    if (!q) return;
    const release = acquireSubmit(localId.current);
    if (!release) return; // a submit for this task is already in flight (F1)
    try {
      // runTurn releases the latch once busy is set; the finally is a safety net.
      await runTurn(q, release);
    } finally {
      release();
    }
  };

  // Wait until this task's turn has fully SETTLED (busy=false). The stopped
  // branch flips busy only after the partial answer is persisted AND the thread
  // reloaded, so busy=false is a reliable "the prior turn's trace is now in the
  // DB" gate. Bounded so a stuck turn can't hang the redirect forever.
  const waitForIdle = async (id: string): Promise<boolean> => {
    for (let i = 0; i < 120; i++) {
      if (!getLiveTask(id).busy) return true;
      await sleep(100);
    }
    return false;
  };

  // STEER: direct the CURRENT execution while it runs. The text is delivered
  // into the running model loop server-side (injected at its next tool
  // boundary, recorded durably as steer.received/steer.applied) — the
  // execution, its tool trace, and its budget all CONTINUE. This is not
  // cancel-and-resend: nothing is aborted, nothing restarts. A steer the loop
  // could no longer take (it was already writing its answer) is carried by the
  // runtime into an automatic follow-up execution, so it is never dropped.
  //
  // `resend` (optional) is passed when the composer holds an ATTACHMENT: a file
  // cannot ride a steer, so that direction goes through the dataset-upload
  // path as a NEW delegation once the current execution settles.
  const steer = async (text: string, resend?: () => Promise<void>) => {
    const q = text.trim();
    if (!q && !resend) return;
    const id = localId.current;
    if (!id || (!turnsRef.current.get(id) && !getLiveTask(id).busy)) {
      await (resend ? resend() : submit(q));
      return;
    }
    // Clear the composer only when it still holds this steered text (or is empty):
    // a proposal-chip click steers the CHIP's prompt, not the composer content, so
    // wiping an unsent draft the user typed would lose it (FE3). Mirror runTurn.
    const curDraft = getText ? getText() : null;
    if (curDraft === null || curDraft.trim() === "" || curDraft.trim() === q) setText("");
    if (resend) {
      // Attachment path: wait for the current execution to settle, then send
      // the upload + direction as its own delegation. LATEST WINS while
      // settling, exactly as before.
      if (steerPendingRef.current.has(id)) {
        steerPendingRef.current.set(id, { q, resend });
        return;
      }
      steerPendingRef.current.set(id, { q, resend });
      const settled = await waitForIdle(id);
      const payload = steerPendingRef.current.get(id) ?? { q, resend };
      steerPendingRef.current.delete(id);
      if (!settled || localId.current !== id) {
        if (localId.current === id) setText(payload.q);
        else patchLiveTask(id, { failedText: payload.q });
        return;
      }
      await (payload.resend ? payload.resend() : submit(payload.q));
      return;
    }
    try {
      await steerTaskExecution(id, q);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // The execution settled between the check and the steer — the
        // direction becomes an ordinary delegation instead of being lost.
        // The local flight may still hold the submit latch for a moment
        // (its stream is draining), so wait for it rather than have the
        // delegation refused silently.
        const settled = await waitForIdle(id);
        if (!settled || localId.current !== id) {
          if (localId.current === id) setText(q);
          else patchLiveTask(id, { failedText: q });
          return;
        }
        await submit(q);
        return;
      }
      // Restore the text so a failed steer never eats the user's direction.
      if (localId.current === id) setText(q);
      else patchLiveTask(id, { failedText: q });
      patchLiveTask(id, { error: cleanError(String(e), t) });
    }
  };

  // Composer file upload → agent-native analysis. The file is attached to the
  // TASK, then the user's message is sent as a NORMAL agent turn. The agent
  // discovers the upload and analyzes it with its read-only tools.
  const submitWithDataset = async (message: string, file: File, type: "inventory" | "access_log") => {
    const startId = localId.current;
    // The upload holds the latch until the follow-up turn registers busy, so a
    // same-task double-submit is coalesced; other tasks are unaffected (F1).
    const release = acquireSubmit(startId);
    if (!release) return;
    try {
      let id: string;
      try {
        id = await ensureTask(message || file.name);
      } catch (e) {
        setViewError(cleanError(String(e), t));
        return;
      }
      const prompt = message || (type === "inventory" ? t("attach.promptInventory") : t("attach.promptLog"));
      // Upload FIRST; only clear the composer once the file is safely stored, so
      // a failed upload doesn't lose the user's selected file. `uploading` is
      // stored PER TASK so only this task's composer shows the spinner (F2).
      patchLiveTask(id, { uploading: true });
      try {
        await uploadTaskDataset(id, file, type);
      } catch (e) {
        patchLiveTask(id, { error: cleanError(String(e), t) });
        // Keep the attachment + text so the user can retry. The STEER path
        // clears the composer before dispatching here — restore the typed
        // message so a failed upload never eats it.
        if (message && getText && getText() === "") setText(message);
        return;
      } finally {
        patchLiveTask(id, { uploading: false });
      }
      onUploaded();
      await runTurn(prompt, release);
    } finally {
      release();
    }
  };

  // Stop the visible task's in-flight turn: abort the local stream AND ask
  // the server to cancel the turn (the persisted partial carries a stopped
  // marker). The run loop keeps the partial text visible and reloads.
  // `taskId` targets a specific task's flight; default is the visible
  // one. steer() passes its captured id so a task switch between the Enter
  // and this call can't abort the newly visible task's turn (usually a
  // no-op) while leaving the steered task's turn running for the full
  // waitForIdle timeout.
  const stop = (taskId?: string) => {
    // Defensive about the argument, because the way this gets misused is to hand
    // it to onClick — which calls it with the click event. That is not a task
    // id, so the lookup below found nothing and returned silently: the Stop
    // button did nothing, the model kept generating, and the tokens kept being
    // spent, with no error anywhere to say so.
    const id = typeof taskId === "string" ? taskId : localId.current;
    if (!id) return;
    const flight = turnsRef.current.get(id);
    if (!flight) {
      // No local flight — a reattached execution this client is only FOLLOWING
      // (started before a reload, or by another window). Stop it through its
      // durable identity.
      if (!getLiveTask(id).busy) return;
      patchLiveTask(id, { stopped: true });
      void getTaskState(id)
        .then((state) => {
          const execId = state.active_execution?.id
            ?? (state.last_execution && ["queued", "running", "waiting"].includes(state.last_execution.status)
              ? state.last_execution.id : null);
          if (execId) return stopTaskExecution(id, execId).then(() => undefined);
          return undefined;
        })
        .catch(() => undefined);
      return;
    }
    patchLiveTask(id, { stopped: true });
    // One cancel path: the durable execution. Before the submit has returned
    // there is nothing to address yet; runTurn stops it as soon as it exists.
    flight.cancelPromise = flight.executionId
      ? stopTaskExecution(id, flight.executionId).catch(() => undefined)
      : null;
    flight.controller.abort();
  };

  return { submit, submitWithDataset, stop, steer, resume, followExecution: attachToExecution };
}

export type TurnRunnerOptions = Parameters<typeof useRunnerActions>[0];
export type TurnController = ReturnType<typeof useRunnerActions>;

/**
 * The runner as one STABLE controller: the Composer, the approval card and
 * the palette hold it across renders, and every call reaches the latest
 * closure (the visible task id, the latest reload).
 */
export function useTurnRunner(opts: TurnRunnerOptions): TurnController {
  const actions = useRunnerActions(opts);
  const latest = useRef(actions);
  latest.current = actions;
  return useMemo<TurnController>(() => ({
    submit: (text) => latest.current.submit(text),
    submitWithDataset: (message, file, type) => latest.current.submitWithDataset(message, file, type),
    stop: (id) => latest.current.stop(id),
    steer: (text, resend) => latest.current.steer(text, resend),
    resume: (executionId) => latest.current.resume(executionId),
    followExecution: (executionId, direction) => latest.current.followExecution(executionId, direction),
  }), []);
}
