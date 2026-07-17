/**
 * The turn runner: ensureSession + submit (streaming with blocking fallback) +
 * dataset-upload submit + Stop (server-side cancel). Extracted from Thread.tsx
 * so the view component stays presentational.
 *
 * All run state is written to the sessionRuns store keyed by the id the turn
 * STARTED with — not the currently-visible session — so a turn keeps streaming
 * (and keeps its content) if the user switches sessions mid-run.
 */
import { useRef } from "react";
import {
  ApiError,
  cancelSessionTurn,
  createSession,
  getSession,
  postSessionMessage,
  streamSessionMessage,
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
import type { SessionDetail, ToolActivity } from "../types";

// Turn a raw sidecar/provider error into a short, actionable, localized line.
// The model-provider hints (bad key / unknown model / provider unreachable)
// only make sense for TURN failures; anything else (e.g. a session-load
// failure) gets the neutral cleaned message instead of misleading guidance.
export const cleanError = (raw: string, t: TFunc, kind: "turn" | "load" = "turn"): string => {
  const s = raw
    .replace(/^(?:ApiError|Error):\s*/, "")
    .replace(/^Session assistant failed:\s*/, "");
  if (kind === "turn") {
    if (/agents sdk is not available|agent runtime/i.test(s)) return t("thread.agentRuntimeUnavailable");
    if (/401|authentication|api key.*invalid|invalid.*api key/i.test(s)) return t("thread.errKey");
    // The model-404 hint must be provider-shaped: a bare "not found" / "404"
    // (e.g. "session not found" when a session is deleted mid-turn) would
    // otherwise send the user to fix a model name/base-URL that isn't the
    // problem. Require model/provider/endpoint context alongside the 404.
    if (/\b(model|provider|endpoint|base ?url)\b/i.test(s) &&
        /404|not found|does not exist|no such model|unknown model/i.test(s))
      return t("thread.err404");
    if (/timeout|timed out|connection|network/i.test(s)) return t("thread.errNetwork");
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
const mergeTool = (list: ToolActivity[], rec: ToolActivity): ToolActivity[] => {
  if (rec.status === "started") return [...list, rec];
  const i = list.findIndex(
    (a) => a.status === "started" && a.tool === rec.tool && (!a.target || !rec.target || a.target === rec.target),
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
  cancelPromise: Promise<unknown> | null;
};

export function useTurnRunner(opts: {
  /** Current composer text (via ref) — lets runTurn avoid wiping characters the
   * user typed during a steer's settle window (it only clears its OWN text). */
  getText?: () => string;
  /** Ref tracking the visible session id (owned by Thread). */
  localId: React.MutableRefObject<string | null>;
  onSessionCreated: (id: string) => void;
  reload: (id: string | null) => Promise<boolean>;
  onChanged: () => void;
  /** Composer text setter — used to restore the user's message on a failed turn. */
  setText: (text: string) => void;
  setViewError: (msg: string | null) => void;
  /** Called after a dataset upload succeeded (clear the attachment chip). */
  onUploaded: () => void;
}) {
  const { getText, localId, onSessionCreated, reload, onChanged, setText, setViewError, onUploaded } = opts;
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

  const ensureSession = (seed: string): Promise<string> => {
    if (localId.current) return Promise.resolve(localId.current);
    if (!ensureFlight.current) {
      ensureFlight.current = createSession({ title: (seed || "New chat").slice(0, 80) })
        .then((s) => {
          localId.current = s.id;
          onSessionCreated(s.id);
          return s.id;
        })
        .finally(() => {
          ensureFlight.current = null;
        });
    }
    return ensureFlight.current;
  };

  // The blocking turn (also the streaming fallback). Returns how it ended; on
  // needKey/error nothing was persisted server-side.
  const sendBlocking = async (id: string, q: string, turnId: string): Promise<Outcome> => {
    try {
      const r = await postSessionMessage(id, q, turnId);
      patchSessionRun(id, {
        proposals: r.proposed_actions || [],
        grounding: {
          evidence_used: r.evidence_used || [],
          evidence_gaps: r.evidence_gaps || [],
          skills_used: r.skills_used || [],
        },
      });
      // If the persisted turn was cancelled (user hit Stop, or the streaming
      // attempt was steered), carry the stopped marker through so the fallback
      // shows "Stopped by user" instead of a normal answer (FE7).
      return r.stopped ? "stopped" : "ok";
    } catch (e) {
      // 409 "turn still in progress": the same turn is still streaming
      // server-side — not a failure. The caller keeps the pending state and
      // reloads shortly after.
      if (e instanceof ApiError && e.status === 409) return "inprogress";
      const msg = String(e);
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
    }
  };

  // The blocking fallback returned 409: the turn is still running server-side
  // and NOTHING is persisted yet. Poll (bounded, backing off) until the
  // assistant answer for THIS turn is actually persisted, then reload. Returns
  // "ok" once the persisted answer is visible, or "inprogress" if it gives up —
  // in which case the caller keeps the pending bubble rather than dropping the
  // user's message (F4).
  const waitForPersistedTurn = async (
    id: string,
    baselinePromise?: Promise<Set<string> | null>,
  ): Promise<Outcome> => {
    // The assistant answer for this turn is a NEW assistant message. Prefer the
    // baseline captured BEFORE the turn started (baselinePromise) — it can't
    // include this turn's answer, so it's race-free. Only if that snapshot failed
    // do we fall back to capturing from the first successful fetch here.
    let baseline: Set<string> | null = baselinePromise ? await baselinePromise : null;
    const captureOrDetect = (d: SessionDetail): boolean => {
      const asstIds = d.messages.filter((m) => m.role === "assistant").map((m) => m.id);
      if (baseline === null) {
        baseline = new Set(asstIds);
        return false;
      }
      return asstIds.some((mid) => !baseline!.has(mid));
    };
    if (baseline === null) {
      try {
        captureOrDetect(await getSession(id));
      } catch {
        /* the loop retries the fetch; baseline stays null until one succeeds */
      }
    }
    // Bounded backoff aligned with the server's own turn budget (its blocking
    // wait is ~150 s), then give up polling — but never drop the message.
    const delays = [3000, 4000, 5000, 6000, 8000, 10000, 12000, 15000, 15000, 20000, 20000, 30000];
    for (const delay of delays) {
      await sleep(delay);
      let d: SessionDetail;
      try {
        d = await getSession(id);
      } catch {
        continue;
      }
      if (captureOrDetect(d)) {
        // Persisted — reload the thread if this session is on screen (otherwise
        // its answer loads when the user switches back).
        if (localId.current === id) await reload(id);
        return "ok";
      }
    }
    return "inprogress";
  };

  // One full turn: stream (live tool traces + token deltas); if the stream
  // fails (provider tool-call streaming is flaky, or no model → 422) fall back
  // to the reliable blocking turn with the SAME turn id (the server dedups).
  // `onRegistered` fires the instant this turn sets `busy` for its session, so
  // the caller's double-submit latch can release without waiting out the turn.
  const runTurn = async (q: string, onRegistered?: () => void) => {
    // Clear the composer ONLY when it still holds this turn's text (or is
    // empty): after a steer there is a ~1s settle gap, and anything the user
    // typed into the empty composer during it must not be wiped here.
    const cur = getText ? getText() : null;
    if (cur === null || cur === "" || cur === q) setText("");
    let id: string;
    try {
      id = await ensureSession(q);
    } catch (e) {
      // Surface the failure (e.g. sidecar not ready) instead of silently
      // dropping the message, and keep the user's text so they can retry.
      setViewError(cleanError(String(e), t));
      setText(q);
      return;
    }
    const turnId = newTurnId();
    // Snapshot the assistant-message ids BEFORE the turn runs (in parallel with
    // the stream, so no added latency). The 409 blocking-fallback uses this as its
    // "which assistant messages predate this turn" baseline. Capturing it here —
    // rather than from a GET issued AFTER the 409 — closes a race where the worker
    // persisted the answer in the gap after the 409 but before that GET, poisoning
    // the baseline so the new answer was never detected and the UI hung (P2b).
    const preTurnAsstIds: Promise<Set<string> | null> = getSession(id)
      .then((d) => new Set(d.messages.filter((m) => m.role === "assistant").map((m) => m.id)))
      .catch(() => null);
    patchSessionRun(id, {
      busy: true, error: null, needKey: false, pending: q,
      streamText: null, streamTools: [], stopped: false, stalled: false,
    });
    // busy is set for this session → the synchronous double-submit latch can
    // release now; further same-session submits are gated by `busy` (F1).
    onRegistered?.();
    const controller = new AbortController();
    const flight: InFlight = { controller, turnId, cancelPromise: null };
    turnsRef.current.set(id, flight);
    // Let a session-delete abort this turn's stream (F3). Identity-checked on
    // unregister so a newer turn's aborter isn't clobbered.
    const abort = () => controller.abort();
    registerTurnAbort(id, abort);
    // And let it cancel the turn SERVER-SIDE too — otherwise the worker keeps
    // generating (and spending) against a deleted session.
    const serverCancel = () => {
      void cancelSessionTurn(id, turnId).catch(() => undefined);
    };
    registerTurnCancel(id, serverCancel);
    let outcome: Outcome = "failed";
    try {
      try {
        const r = await streamSessionMessage(
          id, q,
          {
            onDelta: (chunk) => patchSessionRun(id, (s) => ({ streamText: (s.streamText ?? "") + chunk })),
            onTool: (rec) => patchSessionRun(id, (s) => ({ streamTools: mergeTool(s.streamTools, rec) })),
          },
          controller.signal, turnId,
        );
        patchSessionRun(id, {
          proposals: r.proposed_actions || [],
          grounding: {
            evidence_used: r.evidence_used || [],
            evidence_gaps: r.evidence_gaps || [],
            skills_used: r.skills_used || [],
          },
        });
        outcome = r.stopped ? "stopped" : "ok";
      } catch {
        if (controller.signal.aborted) {
          // The user hit Stop: the local stream was aborted and the server-side
          // cancel was requested. The partial answer is persisted server-side
          // with a stopped marker — don't fall back to the blocking turn.
          outcome = "stopped";
        } else {
          outcome = await sendBlocking(id, q, turnId);
        }
      }

      if (outcome === "stopped") {
        // Keep the partially streamed text visible, marked as stopped, until the
        // persisted partial is swapped in.
        patchSessionRun(id, { stopped: true });
        try {
          await flight.cancelPromise;
        } catch {
          /* cancel is best-effort */
        }
        // The server persists the (stopped) partial as a NEW assistant message.
        // WAIT until it's actually visible before clearing the streamed bubble —
        // a fixed 800 ms sleep raced the persist, and the reload then found no new
        // message and wiped the whole turn until a manual reload (FE1). On success
        // waitForPersistedTurn reloads; on timeout keep the bubble + stall.
        const persisted = await waitForPersistedTurn(id, preTurnAsstIds);
        if (persisted === "ok") {
          patchSessionRun(id, { pending: null, streamText: null, streamTools: [], stopped: false });
        } else {
          patchSessionRun(id, { stalled: true });
        }
        onChanged();
        return;
      } else if (outcome === "inprogress") {
        // The turn is still running server-side (nothing persisted yet). Poll
        // until this turn's assistant answer is actually persisted, then clear
        // the pending bubble — never on a fixed timer (F4).
        outcome = await waitForPersistedTurn(id, preTurnAsstIds);
        if (outcome === "inprogress") {
          // Gave up waiting, but the turn may still be running (its answer may
          // already be persisted server-side). Keep the pending bubble — the
          // user's message must never silently disappear — but mark it STALLED so
          // the thread shows a "reload" affordance instead of an eternal
          // "thinking" spinner (the answer never surfaced otherwise). busy is
          // released by the finally so the composer isn't locked.
          patchSessionRun(id, { stalled: true });
          return;
        }
      }

      if (outcome === "failed") {
        // Nothing was persisted (error or missing key): drop the pending bubble
        // and preserve the user's message. If this session is on screen, restore
        // it straight into the composer; otherwise stash it as failedText so it's
        // restored when the user switches back — a failure in a backgrounded
        // session must not silently eat the message (FE2 / M3). The
        // error/needKey banner is already set.
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

      // Refresh the just-run session's thread only if it's the one on screen;
      // otherwise its persisted answer loads when the user switches back to it.
      if (localId.current === id) {
        const reloaded = await reload(id);
        if (!reloaded) {
          // reload returned false. Distinguish two cases (FE5): if the user
          // navigated AWAY during the async reload, this is a supersede — the
          // answer IS persisted and loads on switch-back, so just clear the
          // bubble (fall through). If we're still ON this session, it's a genuine
          // fetch blip: `detail` still lacks the new messages, so clearing the
          // streamed bubble would erase the answer the user just watched — keep it
          // and offer a reload affordance instead.
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

  // STEER: redirect a running turn without losing its work. Cancel the in-flight
  // turn (its partial answer + tool_activity persist), wait for it to settle,
  // then send `text` as a NEW turn — whose context REPLAYS the cancelled turn's
  // tool trace (v0.24.7), so the agent continues from what it already probed
  // toward the new ask instead of restarting from scratch. If nothing is
  // running, it degrades to a normal submit. The timing gate (waitForIdle) is
  // load-bearing: reopening before the partial persists would lose the trace.
  // `resend` (optional) is how the redirected message is sent once the turn
  // settles — the caller passes it when the composer holds an ATTACHMENT, so a
  // steer routes through the dataset-upload path instead of silently dropping
  // the file (the two send paths must agree about attachments).
  const steer = async (text: string, resend?: () => Promise<void>) => {
    const q = text.trim();
    if (!q && !resend) return;
    const id = localId.current;
    const flight = id ? turnsRef.current.get(id) : null;
    if (!id || !flight) {
      await (resend ? resend() : submit(q));
      return;
    }
    // Clear the composer only when it still holds this steered text (or is empty):
    // a proposal-chip click steers the CHIP's prompt, not the composer content, so
    // wiping an unsent draft the user typed would lose it (FE3). Mirror runTurn.
    const curDraft = getText ? getText() : null;
    if (curDraft === null || curDraft === "" || curDraft === q) setText("");
    // LATEST WINS: a second steer while the first is still settling REPLACES the
    // pending payload instead of racing it — previously the second submit hit
    // the busy latch and the corrected message vanished (not sent, not restored).
    if (steerPendingRef.current.has(id)) {
      steerPendingRef.current.set(id, { q, resend });
      return;
    }
    steerPendingRef.current.set(id, { q, resend });
    stop(); // cancel the current turn; its partial + trace are persisted server-side
    const settled = await waitForIdle(id);
    const payload = steerPendingRef.current.get(id) ?? { q, resend };
    steerPendingRef.current.delete(id);
    // If it didn't settle, or the user navigated to another session while it
    // did, don't cross-send — restore the text so nothing is lost.
    if (!settled || localId.current !== id) {
      setText(payload.q);
      return;
    }
    await (payload.resend ? payload.resend() : submit(payload.q));
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
  const stop = () => {
    const id = localId.current;
    if (!id) return;
    const flight = turnsRef.current.get(id);
    if (!flight) return;
    patchSessionRun(id, { stopped: true });
    flight.cancelPromise = cancelSessionTurn(id, flight.turnId).catch(() => undefined);
    flight.controller.abort();
  };

  return { submit, submitWithDataset, stop, steer };
}
