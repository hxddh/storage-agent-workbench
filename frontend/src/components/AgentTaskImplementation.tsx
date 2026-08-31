import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  approveDecisionOrPrepare,
  listTaskDecisions,
  resolveTaskDecision,
  stopTaskExecution,
  type DecisionImpact,
  type TaskDecision,
} from "../api";
import type {
  Grounding,
  NextAction,
  SessionDetail,
  ToolActivity,
  TriageCase,
} from "../types";
import { useSessionRun, patchSessionRun, getSessionRun } from "../sessionRuns";
import { loadDraft, saveDraft } from "../drafts";
import { useTurnRunner, cleanError } from "../hooks/useTurnRunner";
import { useSessionDocument } from "../hooks/useSessionDocument";
import { useTaskViewport } from "../hooks/useTaskViewport";
import { openAgentReview } from "../agent/commands";
import { publishPaletteActions } from "../agent/paletteActions";
import { Button } from "./ui";
import { Composer } from "./Composer";
import { EvidenceImportDialog } from "./EvidenceImportDialog";
import { AgentTaskResult } from "./AgentTaskResult";
import { AgentNextAction } from "./AgentDecisionCard";
import { TriageCard } from "./AgentRuntimeArtifacts";
import { WorkingRow } from "./LiveTrace";
import { fmtDuration } from "./ExecutionMetrics";
import { useI18n } from "../i18n";
import { matches } from "../shortcuts";
import { clearFind, findRanges, paintFind } from "../lib/findHighlight";
import { stepHit } from "../taskFind";
import { inferDatasetType } from "../datasetType";
import {
  isCurrentPersistedDirection,
  pendingMatchesPersistedDirection,
} from "../lib/pendingDirection";
import { FindBar } from "./FindBar";
import { useTaskProvenance } from "../hooks/useTaskProvenance";
import { AnalysisFigures } from "../viz/AnalysisFigures";
import { ProvenanceMark } from "../viz/ProvenanceMark";

const PENDING_DIRECTION_ID = "task-pending-direction";

function attachKind(name: string): "inventory" | "access_log" {
  return inferDatasetType(name) ?? (/\.(log|txt|json|jsonl|gz)$/i.test(name) ? "access_log" : "inventory");
}

type Item =
  | {
      kind: "message";
      ts: string;
      role: string;
      content: string | null;
      id: string;
      toolActivity?: ToolActivity[];
      grounding?: Grounding | null;
      nextActions?: NextAction[];
      referencedRunIds?: string[];
      referencedEvidenceIds?: string[];
    }
  | { kind: "run"; ts: string; data: SessionDetail["runs"][number] }
  | { kind: "triage"; ts: string; data: TriageCase };

const actionKey = (action: NextAction) => `${action.action_type}::${action.title}`;

function nextActionFromDecision(decision: TaskDecision): NextAction {
  const proposal = decision.proposal;
  return {
    title: proposal?.title || decision.title || decision.action_type,
    reason: proposal?.reason ?? decision.reason,
    action_type: decision.action_type,
    requires_confirmation: true,
    confidence: proposal?.confidence || "high",
    source_run_ids: proposal?.source_run_ids ?? [],
    prefill: proposal?.prefill,
  };
}

export function AgentTaskImplementation({
  sessionId,
  onSessionCreated,
  onSessionDiscarded,
  sidecarStatus,
  onOpenSettings,
  onChanged,
  sidecarReady,
  settingsOpen,
  reloadKey = 0,
}: {
  sessionId: string | null;
  onSessionCreated: (id: string) => void;
  onSessionDiscarded: (id: string) => void;
  sidecarStatus: "starting" | "connected" | "disconnected" | "error";
  onOpenSettings: () => void;
  onChanged: () => void;
  sidecarReady: boolean;
  settingsOpen: boolean;
  reloadKey?: number;
}) {
  const { t, lang } = useI18n();
  const taskCopy = lang === "zh"
    ? {
        loadFailed: "无法加载这个任务。",
        actionFailed: "Agent 无法继续当前任务。",
        workspace: "当前任务",
        stopped: "已由你停止",
        offline: "本地运行时暂时不可用，任务无法继续执行。",
        offlineHint: "正在自动重连。你写下的方向会保留，恢复后可以继续。",
        needModel: "先配置模型提供商，Agent 才能继续这个任务。",
        needModelAction: "配置模型提供商",
        retry: "重试任务",
        loadingEarlier: "正在载入更早的记录…",
        loadEarlier: (n: number) => `载入更早的 ${n} 条记录`,
        jumpToStart: "回到任务开始",
        remoteExecution: (age: string) => `这个 Task 的一次执行仍在后台进行（${age}）。结果完成后会回到这里。`,
        stalled: "这次执行比预期更久；结果可能已经持久化，可以重新同步任务。",
        reload: "重新同步",
        jumpLatest: "回到当前工作",
        jumpWorking: "回到当前工作 · Agent 仍在执行",
        liveNeedModel: "Agent 需要先配置模型提供商才能继续。",
        liveFailed: "Agent Task 执行失败。",
        liveStopped: "Agent Task 已停止。",
        liveWorking: "Agent 正在执行 Task。",
        liveReady: "Work Result 已就绪。",
        continueTask: "继续当前 Task，从尚未完成的线索继续推进并深入检查。",
        resumeTitle: "这次执行被中断了",
        resumeBody: "恢复会用同一条方向开始新的执行。",
        resumeAction: "恢复执行",
        queuedTitle: "排队中的方向",
        queuedHint: "当前执行结束后会开始这条方向。",
        queuedCancel: "取消排队",
        declineMissing: "没有找到对应的待处理 Decision。",
      }
    : {
        loadFailed: "Couldn't load this task.",
        actionFailed: "The Agent couldn't continue this task.",
        workspace: "Agent task",
        stopped: "Stopped by you",
        offline: "The local runtime is unavailable, so this task cannot run right now.",
        offlineHint: "Reconnecting automatically. What you typed is kept and can continue when the runtime is back.",
        needModel: "Configure a Model Provider before the Agent can continue this task.",
        needModelAction: "Configure Model Provider",
        retry: "Retry task",
        loadingEarlier: "Loading earlier history…",
        loadEarlier: (n: number) => `Load ${n} earlier records`,
        jumpToStart: "Jump to the start",
        remoteExecution: (age: string) => `Execution for this task is still running in the background (${age}). Its result will return here.`,
        stalled: "This execution is taking longer than expected; the result may already be durable. Resync the task to check.",
        reload: "Resync task",
        jumpLatest: "Return to current work",
        jumpWorking: "Return to current work · Agent still executing",
        liveNeedModel: "The Agent needs a Model Provider before it can continue.",
        liveFailed: "This task failed.",
        liveStopped: "This task was stopped.",
        liveWorking: "The Agent is working on this task.",
        liveReady: "Work result is ready.",
        continueTask: "Continue this task from the unfinished lines of work and go deeper where needed.",
        resumeTitle: "This execution was interrupted",
        resumeBody: "Resume starts a new execution with the same Direction.",
        resumeAction: "Resume execution",
        queuedTitle: "Queued direction",
        queuedHint: "This waits until the current execution finishes.",
        queuedCancel: "Cancel queued direction",
        declineMissing: "No matching pending Decision was found.",
      };
  const {
    scrollRef, contentRef, pinned, onScroll, releaseToUser,
    jumpToLatest, resetPinned, followLatest,
  } = useTaskViewport();
  const [text, setTextState] = useState("");
  const setText = (next: string) => {
    setTextState(next);
    saveDraft(localId.current, next);
  };
  const [importHandoff, setImportHandoff] = useState<
    { sourceType: "inventory" | "access_log"; accountRunId: string; bucketName: string } | null
  >(null);
  const run = useSessionRun(sessionId);
  const { busy, uploading, pending, streamText, streamTools, needKey } = run;
  const liveNextActions = run.proposals;
  const [viewError, setViewError] = useState<string | null>(null);
  useEffect(() => {
    if (run.busy) setViewError(null);
  }, [run.busy]);
  const error = run.error ?? viewError;
  const {
    detail, triage, earlier, loadingEarlier, remoteTurn: remoteExecution, loadError,
    localId, reload, loadEarlier, loadAllEarlier, hiddenCount, taskRuntime,
  } = useSessionDocument({
    sessionId, sidecarReady, reloadKey, t, scrollRef, setViewError,
  });
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [attached, setAttached] = useState<File | null>(null);
  const [attachType, setAttachType] = useState<"inventory" | "access_log" | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const presetTypeRef = useRef<"inventory" | "access_log" | null>(null);
  const provenance = useTaskProvenance(sessionId);
  const hasFigures = Boolean(
    provenance?.analysis.cost || provenance?.analysis.inventory || provenance?.analysis.drift || provenance?.analysis.access_log,
  );

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
    getText: () => taRef.current?.value ?? "",
    localId,
    onSessionCreated,
    onSessionDiscarded,
    reload,
    onChanged,
    setText,
    setViewError,
    onUploaded: () => {
      setText("");
      setAttached(null);
      setAttachType(null);
    },
  });

  useEffect(() => {
    const failed = sessionId ? getSessionRun(sessionId).failedText : null;
    if (failed) {
      setText(failed);
      patchSessionRun(sessionId!, { failedText: null });
    } else {
      setText(loadDraft(sessionId));
    }
    setImportHandoff(null);
    setViewError(null);
    resetPinned();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const items = useMemo<Item[]>(() => {
    const output: Item[] = [];
    for (const message of [...earlier, ...(detail?.messages ?? [])]) {
      output.push({
        kind: "message", ts: message.created_at, role: message.role, content: message.content, id: message.id,
        toolActivity: message.tool_activity, grounding: message.grounding, nextActions: message.proposed_actions,
        referencedRunIds: message.referenced_run_ids ?? [],
        referencedEvidenceIds: message.referenced_evidence_ids ?? [],
      });
    }
    for (const execution of detail?.runs ?? []) {
      if (execution.origin === "agent") continue;
      output.push({ kind: "run", ts: execution.created_at, data: execution });
    }
    for (const record of triage) output.push({ kind: "triage", ts: record.created_at || "", data: record });
    return output.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }, [detail, triage, earlier]);

  const hideLiveDirection = isCurrentPersistedDirection(items, pending);
  useEffect(() => {
    if (!sessionId || !pending || busy) return;
    if (!pendingMatchesPersistedDirection(items, pending)) return;
    patchSessionRun(sessionId, { pending: null });
  }, [sessionId, pending, busy, items]);

  const nextActions = liveNextActions ?? [];

  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIdx, setFindIdx] = useState(0);
  useEffect(() => setFindIdx(0), [findQuery]);

  const [ranges, setRanges] = useState<Range[]>([]);
  const matchTotal = ranges.length;
  useEffect(() => {
    if (!findOpen) {
      clearFind();
      setRanges([]);
      return;
    }
    const root = scrollRef.current;
    if (!root) return;
    const found = findQuery.trim().length >= 2 ? findRanges(root, findQuery) : [];
    setRanges(found);
    return () => clearFind();
  }, [findOpen, findQuery, items, earlier.length, streamText]);

  const activeRange = matchTotal ? ranges[Math.min(findIdx, matchTotal - 1)] : null;
  useEffect(() => {
    if (!findOpen) return;
    paintFind(ranges, Math.min(findIdx, Math.max(0, matchTotal - 1)));
  }, [findOpen, ranges, findIdx, matchTotal]);
  useEffect(() => {
    if (!findOpen || !activeRange) return;
    const frame = requestAnimationFrame(() => {
      activeRange.startContainer.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [findOpen, activeRange]);

  const stepFind = useCallback(
    (delta: number) => setFindIdx((index) => stepHit(index, matchTotal, delta)),
    [matchTotal],
  );
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery("");
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!matches(event, "find")) return;
      event.preventDefault();
      setFindOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    followLatest();
  }, [items.length, nextActions.length, pending, streamText?.length, streamTools.length, followLatest]);

  const send = () => {
    if (busy || uploading) return;
    if (attached) {
      const type = attachType ?? attachKind(attached.name);
      void runner.submitWithDataset(text.trim(), attached, type);
      return;
    }
    void runner.submit(text.trim());
  };

  const onPickFile = (file: File | null) => {
    if (!file) return;
    const preset = presetTypeRef.current;
    presetTypeRef.current = null;
    setAttached(file);
    setAttachType(preset ?? attachKind(file.name));
  };

  const INLINE_ACTION_PROMPT: Record<string, string> = {
    run_account_discovery: "act.run_account_discovery",
    run_bucket_config_review: "act.run_bucket_config_review",
    run_diagnostic: "act.run_diagnostic",
  };
  const promptForAction = (actionType: string): string | null => {
    if (actionType === "continue_investigation") return taskCopy.continueTask;
    const key = INLINE_ACTION_PROMPT[actionType];
    return key ? t(key) : null;
  };

  const runAction = async (action: NextAction) => {
    const actionPrompt = promptForAction(action.action_type);
    if (run.busy) {
      if (actionPrompt) void runner.steer(actionPrompt);
      return;
    }
    if (actionPrompt) {
      void runner.submit(actionPrompt);
      return;
    }
    if (action.action_type === "run_inventory_analysis" || action.action_type === "run_access_log_analysis") {
      presetTypeRef.current = action.action_type === "run_inventory_analysis" ? "inventory" : "access_log";
      fileRef.current?.click();
      return;
    }
    if (!localId.current) return;
    try {
      // A confirmation-gated action may be backed by a first-class durable
      // Decision: approving records the resolution durably (and settles the
      // execution waiting on it) before handing over to the confirmed flow.
      // Actions with no pending durable decision use the legacy prepare path.
      const prepared = await approveDecisionOrPrepare(localId.current, action);
      await reload(localId.current);
      if (prepared.open === "evidence_import" && prepared.status === "ready") {
        setImportHandoff({
          sourceType: prepared.prefill.source_type as "inventory" | "access_log",
          accountRunId: prepared.prefill.account_run_id,
          bucketName: prepared.prefill.bucket_name,
        });
      } else if (prepared.open === "session_report") {
        openAgentReview("report");
      } else if (prepared.open === "message_composer") {
        setText(prepared.prefill.question || "");
        taRef.current?.focus();
      } else {
        void runner.submit(action.title);
      }
    } catch (caught) {
      setViewError(cleanError(String(caught), t));
    }
  };

  const declineAction = async (action: NextAction) => {
    const id = localId.current;
    if (!id) return;
    try {
      let match = (taskRuntime?.pending_decisions ?? []).find((d) => d.action_type === action.action_type);
      if (!match) {
        const listed = await listTaskDecisions(id, "pending");
        match = listed.decisions.find((d) => d.action_type === action.action_type);
      }
      if (!match) {
        setViewError(taskCopy.declineMissing);
        return;
      }
      await resolveTaskDecision(id, match.id, "declined");
      await reload(id);
      onChanged();
    } catch (caught) {
      setViewError(cleanError(String(caught), t));
    }
  };

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

  const loadingTask = Boolean(sessionId) && detail?.id !== sessionId && !loadError;
  const isEmpty = items.length === 0 && !pending && !loadError && !loadingTask;

  const lastResult = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind === "message" && item.role === "assistant") return item;
      if (item.kind === "message" && item.role === "user") break;
    }
    return undefined;
  }, [items]);
  const lastPersisted = !!(
    lastResult &&
    (lastResult.grounding || (lastResult.nextActions && lastResult.nextActions.length > 0))
  );

  const pendingDecisions = taskRuntime?.pending_decisions ?? [];
  const impactByType = new Map(pendingDecisions.map((d) => [d.action_type, d.impact ?? null]));
  const shownActionTypes = new Set<string>();
  for (const item of items) {
    if (item.kind === "message") item.nextActions?.forEach((action) => shownActionTypes.add(action.action_type));
  }
  nextActions.forEach((action) => shownActionTypes.add(action.action_type));
  const extraPending = pendingDecisions.filter((d) => d.status === "pending" && !shownActionTypes.has(d.action_type));
  const lastExec = taskRuntime?.last_execution;
  const offline = sidecarStatus === "disconnected" || sidecarStatus === "error";
  const showResume = Boolean(
    !needKey && !busy && !run.stalled
    && taskRuntime?.status === "needs_attention"
    && lastExec
    && (lastExec.status === "interrupted" || lastExec.status === "failed"),
  );
  useEffect(() => publishPaletteActions({
    stop: () => runner.stop(),
    resume: showResume && lastExec ? () => { void runner.resume(lastExec.id); } : undefined,
    focusComposer: () => taRef.current?.focus(),
    busy,
    canResume: showResume,
    hasTask: Boolean(sessionId),
  }), [busy, showResume, lastExec, sessionId, runner]);
  const queuedDirections = taskRuntime?.queued_executions ?? [];
  const renderAction = (action: NextAction, actionIndex: number, impact?: DecisionImpact | null) => (
    <AgentNextAction
      key={`${actionKey(action)}-${actionIndex}`}
      action={action}
      onRun={runAction}
      onDecline={action.requires_confirmation ? declineAction : undefined}
      impact={impact ?? impactByType.get(action.action_type)}
    />
  );

  const composer = (
    <Composer
      text={text}
      setText={setText}
      attached={attached}
      onClearAttachment={() => { setAttached(null); setAttachType(null); }}
      onPickFile={onPickFile}
      onOpenFilePicker={() => { presetTypeRef.current = null; fileRef.current?.click(); }}
      fileRef={fileRef}
      taRef={taRef}
      busy={busy}
      offline={offline}
      uploading={uploading}
      onSend={send}
      onStop={() => runner.stop()}
      onSteer={() => {
        if (attached) {
          const type = attachType ?? attachKind(attached.name);
          void runner.steer(text.trim(), () => runner.submitWithDataset(text.trim(), attached, type));
          return;
        }
        if (text.trim()) void runner.steer(text.trim());
      }}
    />
  );

  const liveStatus = needKey
    ? taskCopy.liveNeedModel
    : error
      ? taskCopy.liveFailed
      : run.stopped
        ? taskCopy.liveStopped
        : busy
          ? taskCopy.liveWorking
          : lastPersisted
            ? taskCopy.liveReady
            : "";

  const banners = (
    <>
      {offline ? (
        <div data-testid="offline-banner" className="animate-fade-in-up rounded-xl border border-danger-border bg-danger-bg p-3.5 text-sm text-danger">
          {taskCopy.offline}
          <div className="mt-1 text-xs text-gray-400">{taskCopy.offlineHint}</div>
        </div>
      ) : null}
      {needKey ? (
        <div className="animate-fade-in-up rounded-xl border border-warn-border bg-warn-bg p-3.5 text-sm text-warn-fg">
          {taskCopy.needModel}
          <div className="mt-2.5">
            <Button variant="primary" size="sm" onClick={onOpenSettings}>{taskCopy.needModelAction}</Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="animate-fade-in-up rounded-xl border border-danger-border bg-danger-bg p-3.5 text-sm">
          <div className="font-medium text-danger">{taskCopy.actionFailed}</div>
          <div className="mt-1 break-words text-xs text-gray-300">{error}</div>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {text.trim() ? <Button variant="primary" size="sm" onClick={send}>{taskCopy.retry}</Button> : null}
            <Button variant="default" size="sm" onClick={onOpenSettings}>{t("common.openSettings")}</Button>
          </div>
        </div>
      ) : null}
      {showResume && lastExec ? (
        <div data-testid="task-resume" className="animate-fade-in-up rounded-xl border border-warn-border bg-warn-bg p-3.5 text-sm text-warn-fg">
          <div className="font-medium text-gray-100">{taskCopy.resumeTitle}</div>
          <p className="mt-1 text-xs leading-relaxed text-gray-400">{taskCopy.resumeBody}</p>
          <div className="mt-2.5">
            <Button data-testid="task-resume-action" variant="primary" size="sm" onClick={() => void runner.resume(lastExec.id)}>
              {taskCopy.resumeAction}
            </Button>
          </div>
        </div>
      ) : null}
      {queuedDirections.map((execution) => (
        <div
          key={execution.id}
          data-testid="queued-direction"
          className="flex items-center gap-3 text-sm text-gray-400"
        >
          <span className="min-w-0 flex-1 truncate">{execution.direction}</span>
          <button type="button" data-testid="queued-direction-cancel" className="shrink-0 text-2xs text-gray-500 hover:text-gray-200" onClick={() => void cancelQueued(execution.id)}>
            {taskCopy.queuedCancel}
          </button>
        </div>
      ))}
    </>
  );

  return (
    <main aria-label={taskCopy.workspace} className="flex h-full flex-1 flex-col bg-canvas">
      {loadError ? (
        <div className="flex flex-1 items-center justify-center px-6 py-10">
          <div className="w-full max-w-md animate-fade-in-up rounded-xl border border-danger-border bg-danger-bg p-5 text-center">
            <div className="text-base font-medium text-danger">{taskCopy.loadFailed}</div>
            <div className="mt-1.5 text-xs text-danger/80">{loadError}</div>
            <div className="mt-3.5 flex justify-center">
              <Button variant="primary" size="sm" onClick={() => reload(localId.current)}>{taskCopy.retry}</Button>
            </div>
          </div>
        </div>
      ) : loadingTask ? (
        <div className="flex flex-1 flex-col px-6 py-7" data-testid="task-document-skeleton">
          <div className="mx-auto w-full max-w-[min(64rem,100%)] space-y-4">
            <span className="skeleton h-3 w-28" />
            <span className="skeleton h-5 w-64" />
            <span className="skeleton h-32 w-full max-w-[46rem]" />
            <span className="skeleton h-8 w-full max-w-[36rem]" />
          </div>
        </div>
      ) : isEmpty ? (
        <div className="flex flex-1 items-start justify-center overflow-auto px-6 pb-10 pt-16">
          <div className="w-full max-w-[44rem] animate-fade-in-up">
            {composer}
            <div className="mt-4 space-y-2">{banners}</div>
          </div>
        </div>
      ) : (
        <>
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              ref={scrollRef}
              data-testid="task-scroll"
              onScroll={onScroll}
              onWheel={releaseToUser}
              onTouchMove={releaseToUser}
              onKeyDown={releaseToUser}
              className="flex-1 overflow-auto px-6 py-7"
            >
              {findOpen ? (
                <FindBar query={findQuery} onQuery={setFindQuery} total={matchTotal} index={findIdx} onStep={stepFind} onClose={closeFind} />
              ) : null}
              <div ref={contentRef} className="task-document space-y-6">
                {hiddenCount > 0 ? (
                  <div className="flex justify-center">
                    <div className="flex items-center gap-1.5">
                      <button type="button" onClick={loadEarlier} disabled={loadingEarlier} data-testid="load-earlier" className="rounded-full border border-edge px-3 py-1.5 text-2xs text-gray-500 transition-colors hover:border-edge-strong hover:text-gray-200 disabled:opacity-50">
                        {loadingEarlier ? <span className="inline-flex items-center gap-2"><span className="skeleton h-3 w-16" aria-hidden />{taskCopy.loadingEarlier}</span> : taskCopy.loadEarlier(hiddenCount)}
                      </button>
                      <button type="button" onClick={loadAllEarlier} disabled={loadingEarlier} data-testid="jump-to-start" className="rounded-full border border-edge px-3 py-1.5 text-2xs text-gray-500 transition-colors hover:border-edge-strong hover:text-gray-200 disabled:opacity-50">
                        {taskCopy.jumpToStart}
                      </button>
                    </div>
                  </div>
                ) : null}

                {items.map((item, index) => {
                  if (item.kind === "message") {
                    const latest = item.id === lastResult?.id;
                    const decisions = (item.nextActions ?? []).filter((action) => action.requires_confirmation);
                    return (
                      <div
                        key={item.id}
                        id={`task-item-${item.id}`}
                        className={`task-item space-y-3 ${item.role === "user" && index > 0 ? "pt-6" : ""}`}
                        data-direction={item.role === "user" ? (item.content ?? "") : undefined}
                      >
                        <AgentTaskResult
                          role={item.role}
                          content={item.content}
                          toolActivity={item.toolActivity}
                          referencedRunIds={item.referencedRunIds}
                          referencedEvidenceIds={item.referencedEvidenceIds}
                          hasReport={latest}
                          sessionId={sessionId}
                          figures={latest && item.role === "assistant" && (hasFigures || provenance?.findings.length) ? (
                            <section className="task-analysis-figures mt-4" data-testid="task-analysis-figures">
                              {hasFigures ? <AnalysisFigures provenance={provenance} /> : null}
                              {provenance?.findings.length ? (
                                <div className={hasFigures ? "mt-4 space-y-1" : "space-y-1"}>
                                  {provenance.findings.slice(0, 8).map((finding) => (
                                    <ProvenanceMark key={finding.id} finding={finding} />
                                  ))}
                                </div>
                              ) : null}
                            </section>
                          ) : undefined}
                        />
                        {decisions.length > 0 ? (
                          <div className="space-y-3">
                            {decisions.map((action, actionIndex) => renderAction(action, actionIndex))}
                          </div>
                        ) : null}
                      </div>
                    );
                  }
                  if (item.kind === "run") return null;
                  return <div key={item.data.id} className="task-item"><TriageCard c={item.data} onRun={runAction} /></div>;
                })}

                {!pending && remoteExecution?.running ? (
                  <div data-testid="remote-execution" className="animate-fade-in flex items-center gap-2 text-xs text-gray-400">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
                    {taskCopy.remoteExecution(fmtDuration(remoteExecution.age_ms ?? null) ?? "—")}
                  </div>
                ) : null}

                {pending && !hideLiveDirection ? (
                  <div id={PENDING_DIRECTION_ID} data-direction={pending}>
                    <AgentTaskResult role="user" content={pending} />
                  </div>
                ) : null}

                {pending ? (
                  <>
                    {streamText !== null || streamTools.length ? (
                      <>
                        <AgentTaskResult role="assistant" content={streamText ?? ""} toolActivity={streamTools} streaming={!run.stopped} sessionId={sessionId} />
                        {run.stopped ? <div className="flex items-center gap-1.5 text-2xs text-gray-500">{taskCopy.stopped}</div> : null}
                      </>
                    ) : run.stopped ? (
                      <div className="flex items-center gap-1.5 text-2xs text-gray-500">{taskCopy.stopped}</div>
                    ) : run.stalled ? (
                      <div className="animate-fade-in text-xs text-gray-400">
                        {taskCopy.stalled}
                        <div className="mt-2">
                          <Button variant="default" size="sm" onClick={() => {
                            const id = localId.current;
                            if (!id) return;
                            patchSessionRun(id, { pending: null, stalled: false, streamText: null, streamTools: [] });
                            void reload(id);
                          }}>{taskCopy.reload}</Button>
                        </div>
                      </div>
                    ) : busy ? <WorkingRow label={t("think.working")} /> : null}
                  </>
                ) : null}

                <p className="sr-only" role="status" aria-live="polite" data-testid="task-status">{liveStatus}</p>

                {banners}

                {extraPending.length > 0 ? (
                  <div className="space-y-3" data-testid="durable-pending-decisions">
                    {extraPending.map((decision, actionIndex) =>
                      renderAction(nextActionFromDecision(decision), actionIndex, decision.impact))}
                  </div>
                ) : null}

                {!pending && nextActions.some((action) => action.requires_confirmation) && !lastPersisted ? (
                  <div className="space-y-3">
                    {nextActions.filter((action) => action.requires_confirmation).map((action, actionIndex) => renderAction(action, actionIndex))}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="relative px-6 pb-5 pt-1">
            {!pinned ? (
              <div className="pointer-events-none absolute -top-11 left-0 right-0 flex justify-center">
                <button type="button" onClick={jumpToLatest} data-testid="jump-to-latest" className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-edge bg-elevated/95 px-3 py-1.5 text-2xs text-gray-300 shadow-elev backdrop-blur transition-colors hover:border-edge-strong hover:text-gray-100 animate-fade-in-up">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><line x1="12" y1="5" x2="12" y2="19" /><polyline points="19 12 12 19 5 12" /></svg>
                  {busy ? taskCopy.jumpWorking : taskCopy.jumpLatest}
                </button>
              </div>
            ) : null}
            <div className="max-w-[min(46rem,100%)]">{composer}</div>
          </div>
        </>
      )}

      {importHandoff ? (
        <EvidenceImportDialog
          accountRunId={importHandoff.accountRunId}
          bucketName={importHandoff.bucketName}
          sourceType={importHandoff.sourceType}
          sessionId={localId.current ?? undefined}
          onClose={() => setImportHandoff(null)}
          onImported={async () => {
            setImportHandoff(null);
            await reload(localId.current);
            onChanged();
          }}
        />
      ) : null}
    </main>
  );
}
