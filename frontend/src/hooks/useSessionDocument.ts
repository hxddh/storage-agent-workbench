import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  getSession,
  getSessionMessages,
  getSessionOverview,
  getSessionTriage,
  getSessionTurnState,
  getTaskState,
  streamExecutionEvents,
} from "../api";
import type { TFunc } from "../i18n";
import { getSessionRun, patchSessionRun } from "../sessionRuns";
import { mergeTool } from "./useTurnRunner";
import type {
  SessionDetail,
  SessionMessage,
  SessionTurnState,
  TriageCase,
  TurnMetricsRow,
} from "../types";
import { cleanError } from "./useTurnRunner";

export function useSessionDocument({
  sessionId,
  sidecarReady,
  reloadKey,
  t,
  scrollRef,
  setViewError,
}: {
  sessionId: string | null;
  sidecarReady: boolean;
  reloadKey: number;
  t: TFunc;
  scrollRef: RefObject<HTMLDivElement | null>;
  setViewError: (message: string | null) => void;
}) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [triage, setTriage] = useState<TriageCase[]>([]);
  const [earlier, setEarlier] = useState<SessionMessage[]>([]);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [metrics, setMetrics] = useState<Record<string, TurnMetricsRow>>({});
  const [remoteTurn, setRemoteTurn] = useState<SessionTurnState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const localId = useRef<string | null>(sessionId);
  localId.current = sessionId;
  const loadedIdRef = useRef<string | null>(null);
  const reloadSeqRef = useRef(0);
  const remoteTurnRef = useRef<SessionTurnState | null>(null);
  remoteTurnRef.current = remoteTurn;
  const recheckedRef = useRef<string | null>(null);

  const reload = useCallback(async (id: string | null): Promise<boolean> => {
    if (id !== loadedIdRef.current) setEarlier([]);
    if (!id) {
      setDetail(null);
      setTriage([]);
      setLoadError(null);
      return false;
    }

    const seq = ++reloadSeqRef.current;
    let nextDetail: SessionDetail | null = null;
    let failed: string | null = null;
    const [detailResult, triageResult] = await Promise.allSettled([getSession(id), getSessionTriage(id)]);
    if (detailResult.status === "fulfilled") nextDetail = detailResult.value;
    else failed = cleanError(String(detailResult.reason), t, "load");
    const triageCases = triageResult.status === "fulfilled" ? triageResult.value.cases : [];

    if (id !== localId.current || seq !== reloadSeqRef.current) return false;
    if (nextDetail) {
      loadedIdRef.current = id;
      setDetail(nextDetail);
      setLoadError(null);
      void getSessionOverview(id)
        .then((overview) => {
          if (id !== localId.current) return;
          const byId: Record<string, TurnMetricsRow> = {};
          for (const row of overview.turns) if (row.message_id) byId[row.message_id] = row;
          setMetrics(byId);
        })
        .catch(() => undefined);
      if (triageResult.status === "fulfilled") setTriage(triageCases);
      return true;
    }

    if (failed && loadedIdRef.current !== id) {
      setDetail(null);
      setLoadError(failed);
    }
    if (triageResult.status === "fulfilled") setTriage(triageCases);
    return false;
  }, [t]);

  // Session identity, stale-request protection and first load belong to the
  // persisted document layer, not to Timeline composition.
  useEffect(() => {
    if (sessionId !== loadedIdRef.current) {
      setDetail(null);
      setTriage([]);
    }
    setLoadError(null);
    void reload(sessionId);
  }, [sessionId, reload]);

  useEffect(() => {
    if (reloadKey && sessionId) void reload(sessionId);
  }, [reloadKey, sessionId, reload]);

  // A session observed empty once gets one bounded recheck. This closes the
  // reload-after-Stop persistence race without turning idle sessions into a poll.
  useEffect(() => {
    if (!sessionId || loadError) return;
    if (detail?.id !== sessionId) return;
    const empty =
      (detail.messages?.length ?? 0) === 0 &&
      (detail.runs?.length ?? 0) === 0 &&
      triage.length === 0;
    if (!empty || recheckedRef.current === sessionId) return;
    recheckedRef.current = sessionId;
    const timer = window.setTimeout(() => {
      if (localId.current === sessionId) void reload(sessionId);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [detail, triage.length, sessionId, loadError, reload]);

  // Reattach to an execution this client did not start (a reload mid-run, a
  // task switch back, a delegation from another window). The execution is a
  // durable object with an append-only event log, so reattaching REPLAYS its
  // structured progress from sequence 0 and then follows live — full tool
  // trace and streaming answer tail, not just a spinner. Closing this stream
  // (switching away again) affects nothing server-side.
  useEffect(() => {
    if (!sessionId || !sidecarReady) return;
    let stopped = false;
    let timer = 0;
    let followCtl: AbortController | null = null;
    let following = false;
    // True after a check found this client's own runner busy — used to reload
    // once when the task goes idle, so durable work that finished in the gap
    // (a fast steer follow-up execution) lands in the document.
    let sawOwnBusy = false;

    const follow = async (state: SessionTurnState, executionId: string) => {
      following = true;
      followCtl = new AbortController();
      setRemoteTurn(state);
      patchSessionRun(sessionId, {
        busy: true, error: null, stopped: false, stalled: false,
        streamText: null, streamTools: [],
      });
      // The live view renders under the execution's Direction; the turn-state
      // shape doesn't carry it, so read it from the durable task state (this
      // also covers a steer follow-up, whose Direction is the steer text).
      try {
        const taskState = await getTaskState(sessionId);
        const direction = taskState.active_execution?.direction;
        if (direction) patchSessionRun(sessionId, { pending: direction });
      } catch {
        /* the stream below still shows tools/deltas without the bubble */
      }
      try {
        await streamExecutionEvents(
          sessionId, executionId,
          {
            onDelta: (chunk) =>
              patchSessionRun(sessionId, (s) => ({ streamText: (s.streamText ?? "") + chunk })),
            onTool: (rec) =>
              patchSessionRun(sessionId, (s) => ({ streamTools: mergeTool(s.streamTools, rec) })),
          },
          { signal: followCtl.signal },
        );
      } catch {
        /* failed / interrupted / disconnected — the reload below shows the
           durable truth either way */
      }
      following = false;
      if (stopped) return;
      patchSessionRun(sessionId, {
        busy: false, pending: null, streamText: null, streamTools: [], stopped: false,
      });
      setRemoteTurn(null);
      if (localId.current === sessionId) void reload(sessionId);
      timer = window.setTimeout(tick, 1000);
    };

    const tick = async () => {
      if (stopped) return;
      if (getSessionRun(sessionId).busy) {
        // This client's own runner (or an active follower) owns the live view.
        // Re-check after it settles rather than going dormant: the runtime may
        // hold MORE durable work for this task than the turn this client is
        // watching — a queued delegation, or the automatic follow-up execution
        // a late steer becomes — and nothing else would ever attach to it.
        setRemoteTurn(null);
        sawOwnBusy = true;
        timer = window.setTimeout(tick, 1500);
        return;
      }
      let state: SessionTurnState | null = null;
      try {
        state = await getSessionTurnState(sessionId);
      } catch {
        return;
      }
      if (stopped || localId.current !== sessionId) return;
      if (state.running && state.execution_id) {
        sawOwnBusy = false;
        void follow(state, state.execution_id);
      } else if (state.running) {
        setRemoteTurn(state);
        timer = window.setTimeout(tick, 3000);
      } else {
        if (remoteTurnRef.current || sawOwnBusy) void reload(sessionId);
        sawOwnBusy = false;
        setRemoteTurn(null);
      }
    };
    void tick();
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      followCtl?.abort();
      if (following) {
        // We set busy for a followed execution; release OUR claim on the way
        // out. The execution itself keeps running — the command center still
        // shows it working from the durable task status.
        patchSessionRun(sessionId, {
          busy: false, streamText: null, streamTools: [], stopped: false,
        });
      }
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sessionId, sidecarReady, reload]);

  const shownCount = earlier.length + (detail?.messages?.length ?? 0);
  const hiddenCount = Math.max(0, (detail?.message_total ?? shownCount) - shownCount);

  const loadAllEarlier = useCallback(async () => {
    const id = localId.current;
    if (!id || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      let cursor = (earlier[0] ?? detail?.messages?.[0])?.seq;
      const collected: SessionMessage[] = [];
      for (let pageNo = 0; pageNo < 200 && cursor != null; pageNo++) {
        const page = await getSessionMessages(id, { before: cursor });
        if (id !== localId.current) return;
        if (page.messages.length === 0) break;
        collected.unshift(...page.messages);
        cursor = page.messages[0]?.seq ?? undefined;
        if (!page.has_more) break;
      }
      setEarlier((previous) => [...collected, ...previous]);
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" }));
    } catch (error) {
      setViewError(String((error as Error)?.message ?? error));
    } finally {
      setLoadingEarlier(false);
    }
  }, [loadingEarlier, earlier, detail, scrollRef, setViewError]);

  const loadEarlier = useCallback(async () => {
    const id = localId.current;
    if (!id || loadingEarlier) return;
    const oldest = (earlier[0] ?? detail?.messages?.[0])?.seq;
    if (oldest == null) return;
    setLoadingEarlier(true);
    try {
      const page = await getSessionMessages(id, { before: oldest });
      if (id !== localId.current) return;
      const element = scrollRef.current;
      const before = element ? element.scrollHeight - element.scrollTop : 0;
      setEarlier((previous) => [...page.messages, ...previous]);
      requestAnimationFrame(() => {
        if (element) element.scrollTop = element.scrollHeight - before;
      });
    } catch (error) {
      setViewError(String((error as Error)?.message ?? error));
    } finally {
      setLoadingEarlier(false);
    }
  }, [loadingEarlier, earlier, detail, scrollRef, setViewError]);

  return {
    detail,
    triage,
    earlier,
    loadingEarlier,
    metrics,
    remoteTurn,
    loadError,
    localId,
    reload,
    loadEarlier,
    loadAllEarlier,
    shownCount,
    hiddenCount,
  };
}
