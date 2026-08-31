/**
 * The turn runner: ensureSession + submit (durable execution + event stream
 * with seq reconnect) + dataset-upload submit + Stop (server-side cancel).
 * Extracted from the task renderer so the view stays presentational.
 *
 * All run state is written to the sessionRuns store keyed by the id the turn
 * STARTED with — not the currently-visible session — so a turn keeps streaming
 * (and keeps its content) if the user switches sessions mid-run.
 *
 * Stream recovery is `after=<last seq>` on the durable event log. There is no
 * blocking POST fallback and no assistant-id poll.
 */
import { useRef } from "react";
import { deriveSessionTitle } from "../lib/sessionTitle";
import {
  ApiError,
  cancelSessionTurn,
  createTaskExecution,
  deleteSession,
  createSession,
  getSession,
  getTaskState,
  followExecutionEvents,
  resumeTaskExecution,
  steerTaskExecution,
  stopTaskExecution,
  verifyTaskPlan,
  submitErrorTriage,
  uploadSessionDataset,
} from "../api";
import {
  getSessionRun,
  patchSessionRun,
  registerTurnAbort,
  registerTurnCancel,
  unregisterTurnAbort,
  unregisterTurnCancel,
} from "../sessionRuns";
import { useI18n, type TFunc } from "../i18n";
import type { ToolActivity } from "../types";

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

// Merge a streamed `tool` event into the live list. A "started" record renders
// as an in-progress row; the completed record for the same call resolves it in
// place instead of appending a duplicate.
export const mergeTool = (list: ToolActivity[], rec: ToolActivity): ToolActivity[] => {
  if (rec.status === "started") return [...list, rec];
  // Resolve by the call's own id when it has one (v0.55.0). Matching on
  // tool+target was ambiguous the moment v0.54.0 enabled parallel calls: two
  // concurrent `get_bucket_config_detail` calls on the same bucket are identical
  // under that key, so a completed record could resolve the wrong started row
  // and both would be mislabelled. The tool+target path stays as the fallback
  // for records replayed from pre-v0.55.0 history, which carry no id.
  const byId = rec.id ? list.findIndex((a) => a.status === "started" && a.id === rec.id) : -1;
  const i = byId >= 0 ? byId : list.findIndex(
    (a) => a.status === "started" && !a.id && a.tool === rec.tool
      && (!a.target || !rec.target || a.target === rec.target),
  );
  if (i >= 0) {
    const next = list.slice();
    next[i] = rec;
    return next;
  }
  return [...list, rec];
};

type Outcome = "ok" | "stopped" | "failed" | "triaged" | "inprogress";

type InFlight = {
  controller: AbortController;
  turnId: string;
  /** The durable execution behind this turn, once the submit returned. */
  executionId: string | null;
  cancelPromise: Promise<unknown> | null;
};

export function useTurnRunner(opts: {
  /** Current composer text (via ref) — lets runTurn avoid wiping characters the
   * user typed during a steer's settle window (it only clears its OWN text). */
  getText?: () => string;
  /** Ref tracking the visible session id (owned by Thread). */
  localId: React.MutableRefObject<string | null>;
  onSessionCreated: (id: string) => void;
  /** The session this turn created turned out to be empty and was removed. */
  onSessionDiscarded: (id: string) => void;
  reload: (id: string | null) => Promise<boolean>;
  onChanged: () => void;
  /** Composer text setter — used to restore the user's message on a failed turn. */
  setText: (text: string) => void;
  setViewError: (msg: string | null) => void;
  /** Called after a dataset upload succeeded (clear the attachment chip). */
  onUploaded: () => void;
}) {
  const { getText, localId, onSessionCreated, onSessionDiscarded, reload, onChanged, setText, setViewError, onUploaded } = opts;
  const { t } = useI18n();
  // Per-session in-flight turn (AbortController + turn id) so Stop can abort the
  // stream AND ask the server to cancel. Keyed by the id the turn started with.
  const turnsRef = useRef<Map<string, InFlight>>(new Map());
  // Per-session pending steer payload — see steer()'s latest-wins semantics.
  const steerPendingRef = useRef<Map<string, { q: string; resend?: () => Promise<void> }>>(new Map());
  // PER-SESSION synchronous double-submit latch (F1). `busy` in the store only
  // flips after async work begins, so within one session a double-Enter could
  // start two turns before busy is observable. This latch bridges that gap and
  // is released the instant the turn registers busy for the session — it is NOT
  // held for the whole turn, so a DIFFERENT session can start its own turn
  // concurrently. Keyed by session id; a not-yet-created session (the visible
  // composer submitting into a fresh session) has no id, so its single creation
  // is latched separately.
  const submitLatch = useRef<Set<string>>(new Set());
  const newSessionLatch = useRef(false);
  // Single-flight session creation, so a double-invoke can't create two sessions.
  const ensureFlight = useRef<Promise<string> | null>(null);

  // Acquire the double-submit latch for `startId` (null = the pending new
  // session) synchronously. Returns a release fn, or null when a submit for that
  // session is already starting/in flight so the caller no-ops (F1). Combined
  // with the store's `busy`, this coalesces a same-session double-submit while
  // letting other sessions run concurrently.
  const acquireSubmit = (startId: string | null): (() => void) | null => {
    if (startId) {
      if (submitLatch.current.has(startId) || getSessionRun(startId).busy) return null;
      submitLatch.current.add(startId);
    } else {
      if (newSessionLatch.current) return null;
      newSessionLatch.current = true;
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (startId) submitLatch.current.delete(startId);
      else newSessionLatch.current = false;
    };
  };

  /** True when the session on screen was created by the attempt now running,
   * and nothing has been written to it yet. See the cleanup in `failed`. */
  const createdForThisTurn = useRef(false);

  const ensureSession = (seed: string): Promise<string> => {
    if (localId.current) return Promise.resolve(localId.current);
    if (!ensureFlight.current) {
      ensureFlight.current = createSession({ title: deriveSessionTitle(seed) ?? t("common.untitled") })
        .then((s) => {
          localId.current = s.id;
          createdForThisTurn.current = true;
          onSessionCreated(s.id);
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
          patchSessionRun(id, { error: cleanError(String(e2), t) });
          return "failed";
        }
      }
      patchSessionRun(id, { needKey: true });
      return "failed";
    }
    patchSessionRun(id, { error: cleanError(msg, t) });
    return "failed";
  };

  const followDurable = async (
    id: string,
    executionId: string,
    controller: AbortController,
    after = 0,
  ) => {
    const handlers = {
      onDelta: (chunk: string) => patchSessionRun(id, (s) => ({ streamText: (s.streamText ?? "") + chunk })),
      onTool: (rec: ToolActivity) => patchSessionRun(id, (s) => ({ streamTools: mergeTool(s.streamTools, rec) })),
    };
    return followExecutionEvents(id, executionId, handlers, { signal: controller.signal, after });
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
      if (!reloaded && localId.current === id) patchSessionRun(id, { stalled: true });
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
      id = await ensureSession(q);
    } catch (e) {
      setViewError(cleanError(String(e), t));
      setText(q);
      return;
    }
    const turnId = newTurnId();
    patchSessionRun(id, {
      busy: true, error: null, needKey: false, pending: q,
      streamText: null, streamTools: [], stopped: false, stalled: false,
    });
    onRegistered?.();
    const controller = new AbortController();
    const flight: InFlight = { controller, turnId, executionId: null, cancelPromise: null };
    turnsRef.current.set(id, flight);
    const abort = () => controller.abort();
    registerTurnAbort(id, abort);
    const serverCancel = () => {
      if (flight.executionId) void stopTaskExecution(id, flight.executionId).catch(() => undefined);
      else void cancelSessionTurn(id, turnId).catch(() => undefined);
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
          patchSessionRun(id, { pending: null, streamText: null, streamTools: [], stopped: false });
          onChanged();
          return;
        }
        if (createdForThisTurn.current) {
          void getSession(id)
            .then((d) => {
              if ((d.messages?.length ?? 0) > 0) return;
              return deleteSession(id).then(() => {
                if (localId.current === id) localId.current = null;
                onSessionDiscarded(id);
              });
            })
            .catch(() => undefined);
        }
        if (localId.current === id) {
          setText(q);
          patchSessionRun(id, {
            pending: null, streamText: null, streamTools: [], stopped: false,
            stalled: false, failedText: null,
          });
        } else {
          patchSessionRun(id, {
            pending: null, streamText: null, streamTools: [], stopped: false,
            stalled: false, failedText: q,
          });
        }
        return;
      }
      flight.executionId = submitted.execution.id;
      try {
        const r = await followDurable(id, submitted.execution.id, controller, 0);
        lastSeq = r.last_seq;
        patchSessionRun(id, {
          proposals: r.proposed_actions || [],
          lastMetrics: r.metrics ? { messageId: r.message_id ?? null, metrics: r.metrics } : null,
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
        patchSessionRun(id, { stopped: true });
        try {
          await flight.cancelPromise;
        } catch {
          /* cancel is best-effort */
        }
        await drainAfterStop(id, flight.executionId, lastSeq);
        patchSessionRun(id, { pending: null, streamText: null, streamTools: [], stopped: false });
        onChanged();
        return;
      }

      if (outcome === "failed") {
        if (createdForThisTurn.current) {
          void getSession(id)
            .then((d) => {
              if ((d.messages?.length ?? 0) > 0) return;
              return deleteSession(id).then(() => {
                if (localId.current === id) localId.current = null;
                onSessionDiscarded(id);
              });
            })
            .catch(() => undefined);
        }
        if (localId.current === id) {
          setText(q);
          patchSessionRun(id, {
            pending: null, streamText: null, streamTools: [], stopped: false,
            stalled: false, failedText: null,
          });
        } else {
          patchSessionRun(id, {
            pending: null, streamText: null, streamTools: [], stopped: false,
            stalled: false, failedText: q,
          });
        }
        return;
      }

      if (outcome === "triaged") {
        if (localId.current === id) await reload(id);
        patchSessionRun(id, { pending: null, streamText: null, streamTools: [], stopped: false });
        onChanged();
        return;
      }

      if (localId.current === id) {
        const reloaded = await reload(id);
        if (!reloaded) {
          if (localId.current === id) {
            patchSessionRun(id, { stalled: true });
            onChanged();
            return;
          }
        }
      }
      patchSessionRun(id, { pending: null, streamText: null, streamTools: [], stopped: false });
      onChanged();
    } finally {
      turnsRef.current.delete(id);
      unregisterTurnAbort(id, abort);
      unregisterTurnCancel(id, serverCancel);
      patchSessionRun(id, { busy: false });
    }
  };

  const attachToExecution = async (executionId: string, direction?: string | null) => {
    const id = localId.current;
    if (!id) return;
    const release = acquireSubmit(id);
    if (!release) return;
    patchSessionRun(id, {
      busy: true, error: null, needKey: false,
      pending: direction || getSessionRun(id).pending,
      streamText: null, streamTools: [], stopped: false, stalled: false,
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
      patchSessionRun(id, {
        proposals: r.proposed_actions || [],
        lastMetrics: r.metrics ? { messageId: r.message_id ?? null, metrics: r.metrics } : null,
      });
      if (localId.current === id) await reload(id);
      patchSessionRun(id, { pending: null, streamText: null, streamTools: [], stopped: false });
      onChanged();
    } catch (e) {
      if (!controller.signal.aborted) {
        patchSessionRun(id, { error: cleanError(String(e), t) });
      }
      if (localId.current === id) await reload(id);
    } finally {
      turnsRef.current.delete(id);
      unregisterTurnAbort(id, abort);
      unregisterTurnCancel(id, serverCancel);
      patchSessionRun(id, { busy: false });
    }
  };

  const resume = async (executionId: string) => {
    const id = localId.current;
    if (!id) return;
    try {
      const { execution } = await resumeTaskExecution(id, executionId);
      await attachToExecution(execution.id, execution.direction);
    } catch (e) {
      patchSessionRun(id, { error: cleanError(String(e), t) });
    }
  };

  const verify = async () => {
    const id = localId.current;
    if (!id) return;
    try {
      const { execution } = await verifyTaskPlan(id);
      await attachToExecution(execution.id, execution.direction);
    } catch (e) {
      patchSessionRun(id, { error: cleanError(String(e), t) });
    }
  };

  // Send one turn (from the composer or programmatically).
  const submit = async (q: string) => {
    if (!q) return;
    const release = acquireSubmit(localId.current);
    if (!release) return; // a submit for this session is already in flight (F1)
    try {
      // runTurn releases the latch once busy is set; the finally is a safety net.
      await runTurn(q, release);
    } finally {
      release();
    }
  };

  // Wait until this session's turn has fully SETTLED (busy=false). The stopped
  // branch flips busy only after the partial answer is persisted AND the thread
  // reloaded, so busy=false is a reliable "the prior turn's trace is now in the
  // DB" gate. Bounded so a stuck turn can't hang the redirect forever.
  const waitForIdle = async (id: string): Promise<boolean> => {
    for (let i = 0; i < 120; i++) {
      if (!getSessionRun(id).busy) return true;
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
    if (!id || (!turnsRef.current.get(id) && !getSessionRun(id).busy)) {
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
        else patchSessionRun(id, { failedText: payload.q });
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
        await submit(q);
        return;
      }
      // Restore the text so a failed steer never eats the user's direction.
      if (localId.current === id) setText(q);
      else patchSessionRun(id, { failedText: q });
      patchSessionRun(id, { error: cleanError(String(e), t) });
    }
  };

  // Composer file upload → agent-native analysis. The file is attached to the
  // SESSION, then the user's message is sent as a NORMAL agent turn. The agent
  // discovers the upload and analyzes it with its read-only tools.
  const submitWithDataset = async (message: string, file: File, type: "inventory" | "access_log") => {
    const startId = localId.current;
    // The upload holds the latch until the follow-up turn registers busy, so a
    // same-session double-submit is coalesced; other sessions are unaffected (F1).
    const release = acquireSubmit(startId);
    if (!release) return;
    try {
      let id: string;
      try {
        id = await ensureSession(message || file.name);
      } catch (e) {
        setViewError(cleanError(String(e), t));
        return;
      }
      const prompt = message || (type === "inventory" ? t("attach.promptInventory") : t("attach.promptLog"));
      // Upload FIRST; only clear the composer once the file is safely stored, so
      // a failed upload doesn't lose the user's selected file. `uploading` is
      // stored PER SESSION so only this session's composer shows the spinner (F2).
      patchSessionRun(id, { uploading: true });
      try {
        await uploadSessionDataset(id, file, type);
      } catch (e) {
        patchSessionRun(id, { error: cleanError(String(e), t) });
        // Keep the attachment + text so the user can retry. The STEER path
        // clears the composer before dispatching here — restore the typed
        // message so a failed upload never eats it.
        if (message && getText && getText() === "") setText(message);
        return;
      } finally {
        patchSessionRun(id, { uploading: false });
      }
      onUploaded();
      await runTurn(prompt, release);
    } finally {
      release();
    }
  };

  // Stop the visible session's in-flight turn: abort the local stream AND ask
  // the server to cancel the turn (the persisted partial carries a stopped
  // marker). The run loop keeps the partial text visible and reloads.
  // `sessionId` targets a specific session's flight; default is the visible
  // one. steer() passes its captured id so a session switch between the Enter
  // and this call can't abort the newly visible session's turn (usually a
  // no-op) while leaving the steered session's turn running for the full
  // waitForIdle timeout.
  const stop = (sessionId?: string) => {
    // Defensive about the argument, because the way this gets misused is to hand
    // it to onClick — which calls it with the click event. That is not a session
    // id, so the lookup below found nothing and returned silently: the Stop
    // button did nothing, the model kept generating, and the tokens kept being
    // spent, with no error anywhere to say so.
    const id = typeof sessionId === "string" ? sessionId : localId.current;
    if (!id) return;
    const flight = turnsRef.current.get(id);
    if (!flight) {
      // No local flight — a reattached execution this client is only FOLLOWING
      // (started before a reload, or by another window). Stop it through its
      // durable identity.
      if (!getSessionRun(id).busy) return;
      patchSessionRun(id, { stopped: true });
      void getTaskState(id)
        .then((state) => {
          const execId = state.active_execution?.id
            ?? (state.last_execution && ["queued", "running"].includes(state.last_execution.status)
              ? state.last_execution.id : null);
          if (execId) return stopTaskExecution(id, execId).then(() => undefined);
          return undefined;
        })
        .catch(() => undefined);
      return;
    }
    patchSessionRun(id, { stopped: true });
    flight.cancelPromise = flight.executionId
      ? stopTaskExecution(id, flight.executionId).catch(() => undefined)
      : cancelSessionTurn(id, flight.turnId).catch(() => undefined);
    flight.controller.abort();
  };

  return { submit, submitWithDataset, stop, steer, resume, verify, followExecution: attachToExecution };
}
