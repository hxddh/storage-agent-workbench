/**
 * The turn runner: ensureSession + submit (streaming with blocking fallback) +
 * dataset-upload submit + Stop (server-side cancel). Extracted from Thread.tsx
 * so the view component stays presentational.
 *
 * All run state is written to the sessionRuns store keyed by the id the turn
 * STARTED with — not the currently-visible session — so a turn keeps streaming
 * (and keeps its content) if the user switches sessions mid-run.
 */
import { useRef, useState } from "react";
import {
  ApiError,
  cancelSessionTurn,
  createSession,
  postSessionMessage,
  streamSessionMessage,
  submitErrorTriage,
  uploadSessionDataset,
} from "../api";
import { getSessionRun, patchSessionRun } from "../sessionRuns";
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
    if (/agents sdk is not available|agent runtime/i.test(s)) return t("thread.agentRuntimeUnavailable");
    if (/401|authentication|api key.*invalid|invalid.*api key/i.test(s)) return t("thread.errKey");
    if (/404|not found|model.*exist/i.test(s)) return t("thread.err404");
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
  /** Ref tracking the visible session id (owned by Thread). */
  localId: React.MutableRefObject<string | null>;
  onSessionCreated: (id: string) => void;
  reload: (id: string | null) => Promise<void>;
  onChanged: () => void;
  /** Composer text setter — used to restore the user's message on a failed turn. */
  setText: (text: string) => void;
  setViewError: (msg: string | null) => void;
  /** Called after a dataset upload succeeded (clear the attachment chip). */
  onUploaded: () => void;
}) {
  const { localId, onSessionCreated, reload, onChanged, setText, setViewError, onUploaded } = opts;
  const { t } = useI18n();
  // Per-session in-flight turn (AbortController + turn id) so Stop can abort the
  // stream AND ask the server to cancel. Keyed by the id the turn started with.
  const turnsRef = useRef<Map<string, InFlight>>(new Map());
  // Synchronous double-submit guard: `busy` only flips after async work starts,
  // so a double-click/double-Enter could start two turns without this (M5).
  const submittingRef = useRef(false);
  // Single-flight session creation, so a double-invoke can't create two sessions.
  const ensureFlight = useRef<Promise<string> | null>(null);
  const [uploading, setUploading] = useState(false);

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
      return "ok";
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

  // One full turn: stream (live tool traces + token deltas); if the stream
  // fails (provider tool-call streaming is flaky, or no model → 422) fall back
  // to the reliable blocking turn with the SAME turn id (the server dedups).
  const runTurn = async (q: string) => {
    setText("");
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
    patchSessionRun(id, {
      busy: true, error: null, needKey: false, pending: q,
      streamText: null, streamTools: [], stopped: false,
    });
    const controller = new AbortController();
    const flight: InFlight = { controller, turnId, cancelPromise: null };
    turnsRef.current.set(id, flight);
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
        // Keep the partially streamed text visible, marked as stopped, until
        // the reload swaps in the persisted partial.
        patchSessionRun(id, { stopped: true });
        try {
          await flight.cancelPromise;
        } catch {
          /* cancel is best-effort */
        }
        await sleep(800); // give the server a beat to persist the partial
      } else if (outcome === "inprogress") {
        // The turn is still running server-side. Keep the pending bubble and
        // retry the reload a few times so the persisted result appears when it
        // completes — never show this as a failure.
        for (let i = 0; i < 3; i++) {
          await sleep(4000);
          if (localId.current === id) await reload(id);
        }
        outcome = "ok";
      }

      if (outcome === "failed") {
        // Nothing was persisted (error or missing key): restore the user's
        // message into the composer and drop the pending bubble so nothing is
        // lost (M3). The error/needKey banner is already set.
        if (localId.current === id) setText(q);
        patchSessionRun(id, { pending: null, streamText: null, streamTools: [], stopped: false });
        return;
      }

      // Refresh the just-run session's thread only if it's the one on screen;
      // otherwise its persisted answer loads when the user switches back to it.
      if (localId.current === id) await reload(id);
      patchSessionRun(id, { pending: null, streamText: null, streamTools: [], stopped: false });
      onChanged();
    } finally {
      turnsRef.current.delete(id);
      patchSessionRun(id, { busy: false });
    }
  };

  // Send one turn (from the composer or programmatically).
  const submit = async (q: string) => {
    if (!q || submittingRef.current) return;
    if (getSessionRun(localId.current).busy) return;
    submittingRef.current = true;
    try {
      await runTurn(q);
    } finally {
      submittingRef.current = false;
    }
  };

  // Composer file upload → agent-native analysis. The file is attached to the
  // SESSION, then the user's message is sent as a NORMAL agent turn. The agent
  // discovers the upload and analyzes it with its read-only tools.
  const submitWithDataset = async (message: string, file: File, type: "inventory" | "access_log") => {
    if (submittingRef.current || uploading) return;
    if (getSessionRun(localId.current).busy) return;
    submittingRef.current = true;
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
      // a failed upload doesn't lose the user's selected file.
      setUploading(true);
      try {
        await uploadSessionDataset(id, file, type);
      } catch (e) {
        patchSessionRun(id, { error: cleanError(String(e), t) });
        return; // keep the attachment + text so the user can retry
      } finally {
        setUploading(false);
      }
      onUploaded();
      await runTurn(prompt);
    } finally {
      submittingRef.current = false;
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

  return { submit, submitWithDataset, stop, uploading };
}
