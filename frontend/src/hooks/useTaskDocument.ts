import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  getTaskRecord,
  getTaskMessages,
  getTaskOverview,
  getTaskTriage,
  getTaskState,
  followExecutionEvents,
  type TaskState,
} from "../api";
import type { TFunc } from "../i18n";
import { getLiveTask, patchLiveTask, useLiveTask } from "../liveTasks";
import { applyTaskStatus } from "../lib/taskStatus";
import { liveHandlers } from "./useTurnRunner";
import type {
  TaskRecord,
  TaskMessage,
  TriageCase,
  TurnMetricsRow,
} from "../types";
import { cleanError } from "./useTurnRunner";

/** Instant task switch: keep the last rendered document so the canvas never flashes empty. */
const DOCUMENT_CACHE_LIMIT = 24;
type CachedDocument = {
  detail: TaskRecord;
  triage: TriageCase[];
  taskRuntime: TaskState | null;
  earlier: TaskMessage[];
};
const documentCache = new Map<string, CachedDocument>();

function rememberDocument(id: string, doc: CachedDocument) {
  documentCache.delete(id);
  documentCache.set(id, doc);
  while (documentCache.size > DOCUMENT_CACHE_LIMIT) {
    const oldest = documentCache.keys().next().value;
    if (oldest) documentCache.delete(oldest);
    else break;
  }
}

export function useTaskDocument({
  taskId,
  sidecarReady,
  reloadKey,
  t,
  scrollRef,
  setViewError,
}: {
  taskId: string | null;
  sidecarReady: boolean;
  reloadKey: number;
  t: TFunc;
  scrollRef: RefObject<HTMLDivElement | null>;
  setViewError: (message: string | null) => void;
}) {
  const [detail, setDetail] = useState<TaskRecord | null>(null);
  const [triage, setTriage] = useState<TriageCase[]>([]);
  const [earlier, setEarlier] = useState<TaskMessage[]>([]);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [metrics, setMetrics] = useState<Record<string, TurnMetricsRow>>({});
  const [remoteTurn, setRemoteTurn] = useState<{ running: boolean; age_ms: number | null } | null>(null);
  const [taskRuntime, setTaskRuntime] = useState<TaskState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const localId = useRef<string | null>(taskId);
  localId.current = taskId;
  // loadedIdRef is a successful getTaskRecord for this id. shownIdRef is whatever
  // document is on screen (including a cache restore) so reload does not wipe
  // restored earlier messages. Cache restore must not set loadedIdRef or a
  // failed refresh after revisit would keep a stale document with no error.
  const loadedIdRef = useRef<string | null>(null);
  const shownIdRef = useRef<string | null>(null);
  const reloadSeqRef = useRef(0);
  const remoteTurnRef = useRef<{ running: boolean; age_ms: number | null } | null>(null);
  remoteTurnRef.current = remoteTurn;
  const recheckedRef = useRef<string | null>(null);
  // v1.12: while a follower is open (this hook's or the runner's) the task's
  // derived status arrives as `task.status` frames on the stream. Fold each
  // new frame into the document's task state instead of polling `/state`.
  const run = useLiveTask(taskId);
  const appliedStatusRef = useRef<typeof run.taskStatus>(null);
  useEffect(() => {
    const payload = run.taskStatus;
    if (!taskId || !payload || payload === appliedStatusRef.current) return;
    appliedStatusRef.current = payload;
    setTaskRuntime((prev) => applyTaskStatus(prev, taskId, payload));
  }, [run.taskStatus, taskId]);
  // One discovery poll when the follower ends (busy → idle), never an interval.
  const tickRef = useRef<(() => void) | null>(null);
  const busyRef = useRef(run.busy);
  useEffect(() => {
    const was = busyRef.current;
    busyRef.current = run.busy;
    if (was && !run.busy) tickRef.current?.();
  }, [run.busy]);

  const reload = useCallback(async (id: string | null): Promise<boolean> => {
    if (id !== shownIdRef.current) setEarlier([]);
    if (!id) {
      setDetail(null);
      setTriage([]);
      setTaskRuntime(null);
      setLoadError(null);
      return false;
    }

    const seq = ++reloadSeqRef.current;
    let nextDetail: TaskRecord | null = null;
    let failed: string | null = null;
    const [detailResult, triageResult, stateResult] = await Promise.allSettled([
      getTaskRecord(id), getTaskTriage(id), getTaskState(id),
    ]);
    if (detailResult.status === "fulfilled") nextDetail = detailResult.value;
    else failed = cleanError(String(detailResult.reason), t, "load");
    const triageCases = triageResult.status === "fulfilled" ? triageResult.value.cases : [];
    if (stateResult.status === "fulfilled") setTaskRuntime(stateResult.value);

    if (id !== localId.current || seq !== reloadSeqRef.current) return false;
    if (nextDetail) {
      loadedIdRef.current = id;
      shownIdRef.current = id;
      setDetail(nextDetail);
      setLoadError(null);
      void getTaskOverview(id)
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

  // Task identity, stale-request protection and first load belong to the
  // persisted document layer, not to task composition.
  // Restore a cached document synchronously so switching tasks never whites out.
  useEffect(() => {
    const cached = taskId ? documentCache.get(taskId) : undefined;
    if (cached) {
      setDetail(cached.detail);
      setTriage(cached.triage);
      setTaskRuntime(cached.taskRuntime);
      setEarlier(cached.earlier);
      shownIdRef.current = taskId;
    } else if (taskId !== shownIdRef.current) {
      setDetail(null);
      setTriage([]);
      setEarlier([]);
      setTaskRuntime(null);
    }
    setLoadError(null);
    void reload(taskId);
  }, [taskId, reload]);

  useEffect(() => {
    if (!taskId || !detail || detail.id !== taskId) return;
    // v1.13 — cache by count AND size: keep only the latest 200 messages in
    // the cached document (earlier pages reload via loadEarlier from
    // message_total/hiddenCount, so nothing is lost, only re-fetched).
    const slim = detail.messages.length > 200
      ? { ...detail, messages: detail.messages.slice(-200) }
      : detail;
    rememberDocument(taskId, { detail: slim, triage, taskRuntime, earlier });
  }, [taskId, detail, triage, taskRuntime, earlier]);

  useEffect(() => {
    if (reloadKey && taskId) void reload(taskId);
  }, [reloadKey, taskId, reload]);

  // A task observed empty once gets one bounded recheck. This closes the
  // reload-after-Stop persistence race without turning idle tasks into a poll.
  useEffect(() => {
    if (!taskId || loadError) return;
    if (detail?.id !== taskId) return;
    const empty =
      (detail.messages?.length ?? 0) === 0 &&
      (detail.runs?.length ?? 0) === 0 &&
      triage.length === 0;
    if (!empty || recheckedRef.current === taskId) return;
    recheckedRef.current = taskId;
    const timer = window.setTimeout(() => {
      if (localId.current === taskId) void reload(taskId);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [detail, triage.length, taskId, loadError, reload]);

  // Reattach to an execution this client did not start (a reload mid-run, a
  // task switch back, a delegation from another window). Discovery and stream
  // recovery both use the durable task state + event seq — never GET /turn or
  // a blocking POST. Closing this stream affects nothing server-side.
  //
  // `/state` is read once on attach, on a visibility change, and once when a
  // follower ends (v1.12). While a stream is open the `task.status` frames
  // carry the queue and the pending Decisions; there is no interval.
  useEffect(() => {
    if (!taskId || !sidecarReady) return;
    let stopped = false;
    let timer = 0;
    let followCtl: AbortController | null = null;
    let following = false;
    let sawOwnBusy = false;
    // Execution id whose settled Work Result we already reloaded. Catch-up
    // revisits often finish before this client follows the stream; without a
    // reload the Decision card can appear from task state while the Work Result
    // never lands in the document.
    let loadedSettledExecId: string | null = null;
    let discoverPolls = 0;
    let loadFailures = 0;

    const follow = async (executionId: string, direction: string | null, startedAt: string | null) => {
      following = true;
      followCtl = new AbortController();
      const ageMs = startedAt ? Math.max(0, Date.now() - Date.parse(startedAt)) : null;
      setRemoteTurn({ running: true, age_ms: Number.isFinite(ageMs) ? ageMs : null });
      const startedMs = startedAt ? Date.parse(startedAt) : NaN;
      patchLiveTask(taskId, {
        busy: true, error: null, stopped: false, stalled: false,
        items: [], answer: null, conclusion: null,
        startedAt: Number.isFinite(startedMs) ? startedMs : Date.now(),
        ...(direction ? { pending: direction } : {}),
      });
      try {
        await followExecutionEvents(
          taskId, executionId,
          liveHandlers(taskId),
          { signal: followCtl.signal },
        );
      } catch {
        /* failed / interrupted / disconnected — reload shows durable truth */
      }
      following = false;
      if (stopped) return;
      loadedSettledExecId = executionId;
      setRemoteTurn(null);
      if (localId.current === taskId) void reload(taskId);
      // busy → idle: the effect above runs the one "end" poll.
      patchLiveTask(taskId, {
        busy: false, pending: null, items: [], answer: null, conclusion: null, startedAt: null, stopped: false,
      });
    };

    const tick = async () => {
      if (stopped) return;
      let state: TaskState | null = null;
      try {
        state = await getTaskState(taskId);
        if (!stopped && localId.current === taskId) setTaskRuntime(state);
      } catch {
        // Sidecar unreachable: back off (1.5 s → 30 s) instead of a fixed poll.
        loadFailures += 1;
        timer = window.setTimeout(tick, Math.min(1500 * 2 ** (loadFailures - 1), 30_000));
        return;
      }
      loadFailures = 0;
      if (stopped || localId.current !== taskId) return;
      // A follower is open (this client's own turn, or the stream above):
      // queued Directions and pending Decisions now arrive as `task.status`
      // frames on it. Do not attach a second follower and do not poll — the
      // next read happens when the follower ends or the window comes back.
      if (getLiveTask(taskId).busy) {
        setRemoteTurn(null);
        sawOwnBusy = true;
        return;
      }
      const active = state.active_execution;
      // `waiting` (v1.11) is an execution parked on an inline approval whose
      // worker is alive: follow it so the approval card renders from replay.
      if (active && (active.status === "running" || active.status === "queued"
        || (active.status === "waiting" && active.id !== loadedSettledExecId))) {
        sawOwnBusy = false;
        void follow(active.id, active.direction, active.started_at);
      } else {
        const settledId = state.last_execution?.id ?? null;
        const settled = Boolean(
          settledId
          && state.last_execution
          && state.last_execution.status !== "running"
          && state.last_execution.status !== "queued"
          && state.last_execution.status !== "waiting",
        );
        if (remoteTurnRef.current || sawOwnBusy) {
          if (settledId) loadedSettledExecId = settledId;
          void reload(taskId);
          // The execution this client drove just settled: look once more for
          // a follow-up the runtime queued behind it (a late steer).
          timer = window.setTimeout(tick, 1200);
        } else if (settled && loadedSettledExecId !== settledId) {
          loadedSettledExecId = settledId;
          void reload(taskId);
        }
        sawOwnBusy = false;
        setRemoteTurn(null);
        // A catch-up revisit may still be queued when this Task is first
        // selected (the Sidecar's revisit scheduler submits it on its own
        // clock, even for a Task that never executed). Keep a bounded poll
        // until an Execution settles.
        if (!settled && discoverPolls < 40) {
          discoverPolls += 1;
          timer = window.setTimeout(tick, 1500);
        }
      }
    };
    tickRef.current = () => { void tick(); };
    void tick();
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      tickRef.current = null;
      window.clearTimeout(timer);
      followCtl?.abort();
      if (following) {
        patchLiveTask(taskId, {
          busy: false, items: [], answer: null, conclusion: null, startedAt: null, stopped: false,
        });
      }
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [taskId, sidecarReady, reload]);

  const shownCount = earlier.length + (detail?.messages?.length ?? 0);
  const hiddenCount = Math.max(0, (detail?.message_total ?? shownCount) - shownCount);

  const loadAllEarlier = useCallback(async () => {
    const id = localId.current;
    if (!id || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      let cursor = (earlier[0] ?? detail?.messages?.[0])?.seq;
      const collected: TaskMessage[] = [];
      for (let pageNo = 0; pageNo < 200 && cursor != null; pageNo++) {
        const page = await getTaskMessages(id, { before: cursor });
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
      const page = await getTaskMessages(id, { before: oldest });
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
    taskRuntime,
    loadError,
    localId,
    reload,
    loadEarlier,
    loadAllEarlier,
    shownCount,
    hiddenCount,
  };
}
