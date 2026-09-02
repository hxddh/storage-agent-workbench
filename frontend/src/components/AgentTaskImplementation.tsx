import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  resolveTaskDecision,
  stopTaskExecution,
  type TaskDecision,
} from "../api";
import type { SessionDetail, SessionMessage, TriageCase } from "../types";
import { useSessionRun, patchSessionRun, getSessionRun, liveTurnOf } from "../sessionRuns";
import { loadDraft, saveDraft } from "../drafts";
import { useTurnRunner, cleanError } from "../hooks/useTurnRunner";
import { useSessionDocument } from "../hooks/useSessionDocument";
import { useTaskViewport } from "../hooks/useTaskViewport";
import { fmtElapsed } from "../hooks/useElapsed";
import { openAgentReview } from "../agent/commands";
import { pickStartGreeting } from "../agent/startGreeting";
import { publishPaletteActions } from "../agent/paletteActions";
import { Button } from "./ui";
import { Composer } from "./Composer";
import { AgentTurn, UserTurn } from "./TranscriptTurn";
import { ApprovalCard, type ApprovalResolution, type ApprovalScope } from "./ApprovalCard";
import { TriageCard } from "./AgentRuntimeArtifacts";
import { useI18n } from "../i18n";
import { matches } from "../shortcuts";
import { clearFind, findRanges, paintFind } from "../lib/findHighlight";
import { stepHit } from "../taskFind";
import { inferDatasetType } from "../datasetType";
import {
  isCurrentPersistedDirection,
  isCurrentPersistedWorkResult,
  pendingMatchesPersistedDirection,
} from "../lib/pendingDirection";
import { resolveApproval, turnItemsOf, unplacedApprovals, type TurnItem } from "../lib/turnItems";
import { FindBar } from "./FindBar";
import { useTaskProvenance } from "../hooks/useTaskProvenance";
import { AnalysisFigures } from "../viz/AnalysisFigures";
import { ProvenanceMark } from "../viz/ProvenanceMark";
import { Icon } from "./icons";

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
      message: SessionMessage;
    }
  | { kind: "run"; ts: string; data: SessionDetail["runs"][number] }
  | { kind: "triage"; ts: string; data: TriageCase };

function useTaskCopy() {
  const { lang } = useI18n();
  return lang === "zh"
    ? {
        loadFailed: "无法加载这个任务。",
        actionFailed: "Agent 无法继续这个任务。",
        workspace: "Agent 任务",
        stopped: "已由你停止",
        offline: "本地运行时暂时不可用，任务现在无法执行。",
        offlineHint: "正在自动重连。你写下的方向会保留，恢复后可以继续。",
        needModel: "先配置一个模型提供商，Agent 才能继续这个任务。",
        needModelAction: "配置模型提供商",
        retry: "重试任务",
        loadingEarlier: "正在载入更早的记录…",
        loadEarlier: (n: number) => `载入更早的 ${n} 条记录`,
        jumpToStart: "回到任务开始",
        remoteExecution: (age: string) => `这个任务的一次执行仍在后台进行（${age}）。结果完成后会回到这里。`,
        stalled: "这次执行比预期更久；结果可能已经持久化，可以重新同步任务。",
        reload: "重新同步",
        jumpLatest: "回到最新",
        jumpWorking: "回到最新 · Agent 仍在执行",
        liveNeedModel: "Agent 需要先配置模型提供商才能继续。",
        liveFailed: "这个任务执行失败。",
        liveStopped: "这个任务已停止。",
        liveWorking: "Agent 正在执行这个任务。",
        liveWaiting: "Agent 正在等待你的批准。",
        liveReady: "工作结果已就绪。",
        resumeTitle: "这次执行被中断了",
        resumeBody: "恢复会用同一条方向开始新的执行。",
        resumeAction: "恢复执行",
        queued: "排队中",
        queuedHint: "排队中 · 当前执行结束后开始",
        queuedCancel: "取消",
        greeting: "让 Agent 处理什么？",
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
        jumpLatest: "Jump to latest",
        jumpWorking: "Jump to latest · Agent still working",
        liveNeedModel: "The Agent needs a Model Provider before it can continue.",
        liveFailed: "This task failed.",
        liveStopped: "This task was stopped.",
        liveWorking: "The Agent is working on this task.",
        liveWaiting: "The Agent is waiting for your approval.",
        liveReady: "Work result is ready.",
        resumeTitle: "This execution was interrupted",
        resumeBody: "Resume starts a new execution with the same Direction.",
        resumeAction: "Resume execution",
        queued: "Queued",
        queuedHint: "Queued · starts when the current execution finishes",
        queuedCancel: "Cancel",
        greeting: "What should the Agent work on?",
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
  const taskCopy = useTaskCopy();
  const {
    scrollRef, contentRef, pinned, onScroll, releaseToUser,
    jumpToLatest, resetPinned, followLatest,
  } = useTaskViewport();
  const [text, setTextState] = useState("");
  const setText = (next: string) => {
    setTextState(next);
    saveDraft(localId.current, next);
  };
  const run = useSessionRun(sessionId);
  const { busy, uploading, pending, items: liveItems, answer: liveAnswer, waiting, needKey } = run;
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
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const provenance = useTaskProvenance(sessionId);
  const hasFigures = Boolean(
    provenance?.analysis.cost || provenance?.analysis.inventory || provenance?.analysis.drift || provenance?.analysis.access_log,
  );
  // Settings edits providers; when it closes, the model chip re-reads the list.
  const [modelRefreshKey, setModelRefreshKey] = useState(0);
  useEffect(() => { if (!settingsOpen) setModelRefreshKey((key) => key + 1); }, [settingsOpen]);

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
    setViewError(null);
    setResolvingId(null);
    resetPinned();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const items = useMemo<Item[]>(() => {
    const output: Item[] = [];
    for (const message of [...earlier, ...(detail?.messages ?? [])]) {
      output.push({
        kind: "message", ts: message.created_at, role: message.role, content: message.content, id: message.id,
        message,
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
  const hideLiveWorkResult = isCurrentPersistedWorkResult(items, pending);
  useEffect(() => {
    if (!sessionId || !pending || busy) return;
    if (!pendingMatchesPersistedDirection(items, pending)) return;
    patchSessionRun(sessionId, { pending: null });
  }, [sessionId, pending, busy, items]);

  const pendingDecisions = useMemo<TaskDecision[]>(
    () => (taskRuntime?.pending_decisions ?? []).filter((d) => d.status === "pending"),
    [taskRuntime],
  );
  // The durable projection of every Agent turn: ordered items + answer. A
  // pending inline approval renders at the tool row that raised it.
  const turnItems = useMemo(() => {
    const byId = new Map<string, TurnItem[]>();
    for (const item of items) {
      if (item.kind === "message" && item.role === "assistant") byId.set(item.id, turnItemsOf(item.message, pendingDecisions));
    }
    return byId;
  }, [items, pendingDecisions]);
  const unplaced = useMemo(
    () => (busy ? [] : unplacedApprovals([...turnItems.values()], pendingDecisions)),
    [busy, turnItems, pendingDecisions],
  );

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
  }, [findOpen, findQuery, items, earlier.length, liveAnswer, liveItems]);

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
  }, [items.length, pending, liveAnswer?.length, liveItems, followLatest]);

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

  // Allow / Allow for this task / Deny an inline approval. The execution
  // continues server-side; a live follower keeps reading the same stream, a
  // cold document reattaches to the execution the approval belongs to.
  const resolveApprovalDecision = async (decisionId: string, resolution: ApprovalResolution, scope: ApprovalScope) => {
    const id = localId.current;
    if (!id) return;
    setResolvingId(decisionId);
    try {
      const { decision } = await resolveTaskDecision(id, decisionId, resolution, scope);
      patchSessionRun(id, (s) => {
        const next = resolveApproval(liveTurnOf(s), { decision_id: decisionId, resolution, scope });
        return { items: next.items, answer: next.answer, waiting: next.waiting };
      });
      if (!getSessionRun(id).busy) {
        await reload(id);
        if (decision.execution_id) void runner.followExecution(decision.execution_id, null);
      }
      onChanged();
    } catch (caught) {
      setViewError(cleanError(String(caught), t));
    } finally {
      setResolvingId(null);
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
    find: () => setFindOpen(true),
    review: sessionId ? () => openAgentReview("evidence") : undefined,
    busy,
    canResume: showResume,
    hasTask: Boolean(sessionId),
  }), [busy, showResume, lastExec, sessionId, runner]);
  const queuedDirections = taskRuntime?.queued_executions ?? [];

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
      onOpenSettings={onOpenSettings}
      modelRefreshKey={modelRefreshKey}
    />
  );

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

  const figuresFor = (item: Extract<Item, { kind: "message" }>) =>
    item.id === lastResult?.id && (hasFigures || provenance?.findings.length) ? (
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
    ) : undefined;

  const banners = (
    <>
      {offline ? (
        <div data-testid="offline-banner" className="native-banner" data-tone="danger">
          {taskCopy.offline}
          <p>{taskCopy.offlineHint}</p>
        </div>
      ) : null}
      {needKey ? (
        <div className="native-banner" data-tone="warn">
          {taskCopy.needModel}
          <div className="native-banner-actions">
            <Button variant="primary" size="sm" onClick={onOpenSettings}>{taskCopy.needModelAction}</Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="native-banner" data-tone="danger">
          {taskCopy.actionFailed}
          <p className="break-words">{error}</p>
          <div className="native-banner-actions">
            {text.trim() ? <Button variant="primary" size="sm" onClick={send}>{taskCopy.retry}</Button> : null}
            <Button variant="default" size="sm" onClick={onOpenSettings}>{t("common.openSettings")}</Button>
          </div>
        </div>
      ) : null}
      {showResume && lastExec ? (
        <div data-testid="task-resume" className="native-banner" data-tone="warn">
          <span className="font-medium text-gray-100">{taskCopy.resumeTitle}</span>
          <p>{taskCopy.resumeBody}</p>
          <div className="native-banner-actions">
            <Button data-testid="task-resume-action" variant="primary" size="sm" onClick={() => void runner.resume(lastExec.id)}>
              <Icon name="play" size={12} />
              {taskCopy.resumeAction}
            </Button>
          </div>
        </div>
      ) : null}
      {queuedDirections.map((execution) => (
        <div key={execution.id} data-testid="queued-direction" className="turn-user native-queued" title={taskCopy.queuedHint}>
          <div className="turn-user-bubble" data-queued="true">{execution.direction}</div>
          <div className="turn-user-actions" data-always="true">
            <span className="turn-tag">{taskCopy.queued}</span>
            <button type="button" data-testid="queued-direction-cancel" className="native-ghost-action" onClick={() => void cancelQueued(execution.id)}>
              {taskCopy.queuedCancel}
            </button>
          </div>
        </div>
      ))}
    </>
  );

  return (
    <main aria-label={taskCopy.workspace} className="flex h-full flex-1 flex-col bg-canvas">
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
              className="flex-1 overflow-auto px-6 pb-6 pt-5"
            >
              {findOpen ? (
                <FindBar query={findQuery} onQuery={setFindQuery} total={matchTotal} index={findIdx} onStep={stepFind} onClose={closeFind} />
              ) : null}
              <div ref={contentRef} className="native-document space-y-6">
                {hiddenCount > 0 ? (
                  <div className="flex justify-center gap-1.5">
                    <button type="button" onClick={loadEarlier} disabled={loadingEarlier} data-testid="load-earlier" className="native-chip disabled:opacity-50">
                      {loadingEarlier ? <span className="inline-flex items-center gap-2"><span className="skeleton h-3 w-16" aria-hidden />{taskCopy.loadingEarlier}</span> : taskCopy.loadEarlier(hiddenCount)}
                    </button>
                    <button type="button" onClick={loadAllEarlier} disabled={loadingEarlier} data-testid="jump-to-start" className="native-chip disabled:opacity-50">
                      {taskCopy.jumpToStart}
                    </button>
                  </div>
                ) : null}

                {items.map((item) => {
                  if (item.kind === "message") {
                    if (item.role === "user") {
                      return (
                        <div key={item.id} id={`task-item-${item.id}`} className="task-item" data-direction={item.content ?? ""}>
                          <UserTurn content={item.content} />
                        </div>
                      );
                    }
                    return (
                      <div key={item.id} id={`task-item-${item.id}`} className="task-item">
                        <AgentTurn
                          items={turnItems.get(item.id) ?? []}
                          answer={item.content}
                          sessionId={sessionId}
                          figures={figuresFor(item)}
                          onResolve={resolveApprovalDecision}
                          resolvingId={resolvingId}
                        />
                      </div>
                    );
                  }
                  if (item.kind === "run") return null;
                  return <div key={item.data.id} className="task-item"><TriageCard c={item.data} /></div>;
                })}

                {unplaced.length > 0 ? (
                  <div className="space-y-3" data-testid="pending-approvals">
                    {unplaced.map((approval) => (
                      <ApprovalCard
                        key={approval.decision_id}
                        item={approval}
                        onResolve={resolveApprovalDecision}
                        busy={resolvingId === approval.decision_id}
                      />
                    ))}
                  </div>
                ) : null}

                {!pending && remoteExecution?.running ? (
                  <div data-testid="remote-execution" className="flex items-center gap-2 text-xs text-gray-400">
                    <span className="working-mark" style={{ width: 6, height: 6 }} aria-hidden />
                    {taskCopy.remoteExecution(fmtElapsed(remoteExecution.age_ms ?? null) ?? "—")}
                  </div>
                ) : null}

                {pending && !hideLiveDirection ? (
                  <div id={PENDING_DIRECTION_ID} className="task-item" data-direction={pending}>
                    <UserTurn content={pending} />
                  </div>
                ) : null}

                {pending && !hideLiveWorkResult ? (
                  run.stalled && liveItems.length === 0 && !liveAnswer ? (
                    <div className="native-banner">
                      {taskCopy.stalled}
                      <div className="native-banner-actions">
                        <Button variant="default" size="sm" onClick={() => {
                          const id = localId.current;
                          if (!id) return;
                          patchSessionRun(id, { pending: null, stalled: false, items: [], answer: null, waiting: false });
                          void reload(id);
                        }}>{taskCopy.reload}</Button>
                      </div>
                    </div>
                  ) : busy || run.stopped || liveItems.length > 0 || liveAnswer ? (
                    <AgentTurn
                      items={liveItems}
                      answer={liveAnswer}
                      live={!run.stopped}
                      waiting={waiting}
                      stoppedLabel={run.stopped ? taskCopy.stopped : null}
                      startedAt={run.startedAt}
                      sessionId={sessionId}
                      onResolve={resolveApprovalDecision}
                      resolvingId={resolvingId}
                    />
                  ) : null
                ) : null}

                <p className="sr-only" role="status" aria-live="polite" data-testid="task-status">{liveStatus}</p>

                <div className="space-y-2 empty:hidden">{banners}</div>
              </div>
            </div>
          </div>

          <div className="relative px-6 pb-4 pt-1">
            {!pinned ? (
              <div className="pointer-events-none absolute -top-10 left-0 right-0 z-floating flex justify-center">
                <button type="button" onClick={jumpToLatest} data-testid="jump-to-latest" className="native-chip pointer-events-auto bg-panel shadow-pop">
                  <Icon name="arrowDown" size={12} stroke={2} />
                  {busy ? taskCopy.jumpWorking : taskCopy.jumpLatest}
                </button>
              </div>
            ) : null}
            <div className="native-document">{composer}</div>
          </div>
        </>
      )}
    </main>
  );
}
