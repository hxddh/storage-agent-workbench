import { useEffect, useMemo, useRef, useState } from "react";
import { editQueuedExecution, stopTaskExecution } from "../api";
import { useLiveTask, patchLiveTask } from "../liveTasks";
import { useTurnRunner, cleanError } from "../hooks/useTurnRunner";
import { useTaskDocument } from "../hooks/useTaskDocument";
import { useCompactContext } from "../hooks/useCompactContext";
import { useTaskViewport } from "../hooks/useTaskViewport";
import { useDirectionStepping } from "../hooks/useDirectionStepping";
import { useApprovals } from "../hooks/useApprovals";
import { openAgentReview } from "../agent/commands";
import { pickStartGreeting } from "../agent/startGreeting";
import { publishPaletteActions } from "../agent/paletteActions";
import { Button } from "./ui";
import { useI18n } from "../i18n";
import { matches } from "../shortcuts";
import {
  isCurrentPersistedDirection,
  isCurrentPersistedWorkResult,
  pendingMatchesPersistedDirection,
  visibleQueuedExecutions,
} from "../lib/pendingDirection";
import { TaskBanners } from "./TaskBanners";
import { TaskComposerHost, useComposerActions, useTaskComposer } from "./TaskComposerHost";
import { TaskDocument, lastWorkResult, useTaskItems } from "./TaskDocument";
import { useTaskCopy } from "./taskCopy";

export type AgentTaskProps = {
  taskId: string | null;
  onTaskCreated: (id: string) => void;
  onTaskDiscarded: (id: string) => void;
  sidecarStatus: "starting" | "connected" | "disconnected" | "error";
  onOpenSettings: () => void;
  onChanged: () => void;
  sidecarReady: boolean;
  settingsOpen: boolean;
  reloadKey?: number;
};

/**
 * One Agent Task — the application's primary object and work area. Product
 * callers speak only in Tasks; the historical session persistence stays
 * behind the api/ adapters.
 *
 * This is the composition root (v1.12 split): it owns the durable
 * document (`useTaskDocument`), the runtime state of the task
 * (`useLiveTask`), the one turn runner, the Composer state and the inline
 * approvals, and hands them to `TaskDocument` (transcript · paging · find),
 * `TaskBanners` and `TaskComposerHost`. It paints only the three task-level
 * frames — load failure, the loading skeleton, the empty start — itself.
 */
export function AgentTask({
  taskId,
  onTaskCreated,
  onTaskDiscarded,
  sidecarStatus,
  onOpenSettings,
  onChanged,
  sidecarReady,
  settingsOpen,
  reloadKey = 0,
}: AgentTaskProps) {
  const workspaceRef = useRef<HTMLElement | null>(null);
  useDirectionStepping(workspaceRef, taskId);

  const { t, lang } = useI18n();
  const taskCopy = useTaskCopy();
  const viewport = useTaskViewport();
  const composer = useTaskComposer(taskId);
  const run = useLiveTask(taskId);
  const { busy, uploading, pending, needKey, waiting } = run;
  const [viewError, setViewError] = useState<string | null>(null);
  useEffect(() => {
    if (run.busy) setViewError(null);
  }, [run.busy]);
  const error = run.error ?? viewError;
  const {
    detail, triage, earlier, loadingEarlier, remoteTurn: remoteExecution, loadError,
    localId, reload, loadEarlier, loadAllEarlier, hiddenCount, taskRuntime,
  } = useTaskDocument({
    taskId, sidecarReady, reloadKey, t, scrollRef: viewport.scrollRef, setViewError,
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!matches(event, "review")) return;
      if (settingsOpen || !localId.current) return;
      event.preventDefault();
      openAgentReview("evidence");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

  const runner = useTurnRunner({
    getText: composer.getText,
    localId,
    onTaskCreated,
    onTaskDiscarded,
    reload,
    onChanged,
    setText: composer.setText,
    setViewError,
    onUploaded: () => {
      composer.setText("");
      composer.clearAttachment();
    },
  });
  const actions = useComposerActions({ composer, runner, busy, uploading });

  useEffect(() => {
    setViewError(null);
    viewport.resetPinned();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const items = useTaskItems(detail, triage, earlier);
  const hideLiveDirection = isCurrentPersistedDirection(items, pending);
  const hideLiveWorkResult = isCurrentPersistedWorkResult(items, pending);
  useEffect(() => {
    if (!taskId || !pending || busy) return;
    if (!pendingMatchesPersistedDirection(items, pending)) return;
    patchLiveTask(taskId, { pending: null });
  }, [taskId, pending, busy, items]);

  const approvals = useApprovals({
    taskId, localId, items, taskRuntime, busy,
    followExecution: runner.followExecution, reload, onChanged, setViewError, t,
  });

  const cancelQueued = async (executionId: string) => {
    const id = localId.current;
    if (!id) return;
    try {
      await stopTaskExecution(id, executionId);
      await reload(id);
      onChanged();
    } catch (caught) {
      setViewError(cleanError(String(caught), t));
    }
  };

  // v1.14 — queued work is editable until it runs (409 past that point).
  const editQueued = async (executionId: string, direction: string) => {
    const id = localId.current;
    if (!id) return;
    try {
      await editQueuedExecution(id, executionId, direction);
      await reload(id);
      onChanged();
    } catch (caught) {
      setViewError(cleanError(String(caught), t));
    }
  };

  const loadingTask = Boolean(taskId) && detail?.id !== taskId && !loadError;
  const isEmpty = items.length === 0 && !pending && !loadError && !loadingTask;
  const lastResult = useMemo(() => lastWorkResult(items), [items]);

  const lastExec = taskRuntime?.last_execution;
  const offline = sidecarStatus === "disconnected" || sidecarStatus === "error";
  const showResume = Boolean(
    !needKey && !busy && !run.stalled
    && taskRuntime?.status === "needs_attention"
    && lastExec
    && (lastExec.status === "interrupted" || lastExec.status === "failed"),
  );
  const [findOpen, setFindOpen] = useState(false);
  const { compact: compactContext, compacting } = useCompactContext(taskId);
  useEffect(() => publishPaletteActions({
    stop: () => runner.stop(),
    resume: showResume && lastExec ? () => { void runner.resume(lastExec.id); } : undefined,
    focusComposer: composer.focus,
    prefill: (text: string) => { composer.setText(text); composer.focus(); },
    find: () => setFindOpen(true),
    review: taskId ? () => openAgentReview("evidence") : undefined,
    compact: taskId && !busy ? () => { void compactContext(); } : undefined,
    compacting,
    busy,
    canResume: showResume,
    hasTask: Boolean(taskId),
  }), [busy, showResume, lastExec, taskId, runner, compactContext, compacting]);

  const liveStatus = needKey
    ? taskCopy.liveNeedModel
    : error
      ? taskCopy.liveFailed
      : run.stopped
        ? taskCopy.liveStopped
        : busy
          ? (waiting ? taskCopy.liveWaiting : taskCopy.liveWorking)
          : lastResult
            ? taskCopy.liveReady
            : "";

  const composerNode = (
    <TaskComposerHost
      composer={composer}
      actions={actions}
      busy={busy}
      uploading={uploading}
      offline={offline}
      onOpenSettings={onOpenSettings}
      settingsOpen={settingsOpen}
      mentionables={(detail?.attached_files ?? [])
        .filter((f) => f.source_filename)
        .map((f) => ({ id: f.id, filename: f.source_filename as string }))}
    />
  );

  const banners = (
    <TaskBanners
      offline={offline}
      needKey={needKey}
      error={error}
      canRetry={Boolean(composer.text.trim())}
      onRetry={actions.send}
      onDismissError={() => setViewError(null)}
      onOpenSettings={onOpenSettings}
      showResume={showResume}
      lastExecution={lastExec}
      onResume={(executionId) => void runner.resume(executionId)}
      queued={visibleQueuedExecutions(
        taskRuntime?.queued_executions ?? [],
        pending,
        Boolean(taskRuntime?.active_execution),
      )}
      onCancelQueued={(executionId) => void cancelQueued(executionId)}
      onEditQueued={(executionId, direction) => void editQueued(executionId, direction)}
    />
  );

  return (
    // min-w-0: a flex item defaults to min-width:auto (its longest
    // unbreakable run), which stretched the whole column past the window
    // on ARNs and long tokens instead of wrapping them.
    <section
      ref={workspaceRef}
      data-testid="agent-workspace"
      aria-label="Agent task workspace"
      className="relative flex h-full min-w-0 flex-1 overflow-hidden bg-canvas"
    >
    <main aria-label={taskCopy.workspace} className="flex h-full min-w-0 flex-1 flex-col bg-canvas">
      {loadError ? (
        <div className="flex flex-1 items-center justify-center px-6 py-10">
          <div className="native-banner w-full max-w-md" data-tone="danger">
            <span className="font-medium">{taskCopy.loadFailed}</span>
            <p>{loadError}</p>
            <div className="native-banner-actions">
              <Button variant="primary" size="sm" onClick={() => reload(localId.current)}>{taskCopy.retry}</Button>
            </div>
          </div>
        </div>
      ) : loadingTask ? (
        <div className="flex flex-1 flex-col px-6 py-7" data-testid="task-document-skeleton">
          <div className="native-document space-y-4">
            <span className="skeleton ml-auto h-10 w-2/3 max-w-[30rem] rounded-xl" />
            <span className="skeleton h-4 w-40" />
            <span className="skeleton h-32 w-full max-w-[46rem]" />
            <span className="skeleton h-8 w-full max-w-[36rem]" />
          </div>
        </div>
      ) : isEmpty ? (
        <div className="native-start" data-testid="task-start">
          <div className="native-start-inner">
            <p className="native-start-greeting">{pickStartGreeting(lang)}</p>
            {composerNode}
            <div className="mt-4 space-y-2">{banners}</div>
          </div>
        </div>
      ) : (
        <TaskDocument
          taskId={taskId}
          items={items}
          turnItems={approvals.turnItems}
          unplaced={approvals.unplaced}
          run={run}
          hideLiveDirection={hideLiveDirection}
          hideLiveWorkResult={hideLiveWorkResult}
          remoteExecution={remoteExecution}
          hiddenCount={hiddenCount}
          loadingEarlier={loadingEarlier}
          loadEarlier={loadEarlier}
          loadAllEarlier={loadAllEarlier}
          onResolve={approvals.resolveApprovalDecision}
          resolvingId={approvals.resolvingId}
          liveStatus={liveStatus}
          banners={banners}
          composer={composerNode}
          viewport={viewport}
          findOpen={findOpen}
          setFindOpen={setFindOpen}
          onResync={async () => {
            const id = localId.current;
            if (!id) return false;
            // v1.16 — clear the live turn only when the reload landed; on
            // failure the stalled line stays and backs off for another try.
            const ok = await reload(id);
            if (ok) patchLiveTask(id, { pending: null, stalled: false, items: [], answer: null, waiting: false });
            return ok;
          }}
        />
      )}
    </main>
    </section>
  );
}
