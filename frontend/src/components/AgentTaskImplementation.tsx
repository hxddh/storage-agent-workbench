import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  forkSession,
  listModelProviders,
  prepareSessionAction,
} from "../api";
import type {
  Grounding,
  TokenUsage,
  NextAction,
  SessionDetail,
  ToolActivity,
  TriageCase,
  TurnMetricsRow,
} from "../types";
import { useSessionRun, patchSessionRun, getSessionRun } from "../sessionRuns";
import { loadDraft, saveDraft } from "../drafts";
import { useTurnRunner, cleanError } from "../hooks/useTurnRunner";
import { useSessionDocument } from "../hooks/useSessionDocument";
import { useTaskViewport } from "../hooks/useTaskViewport";
import { openAgentExecution, openAgentReview } from "../workbench/commands";
import { Button } from "./ui";
import { Composer } from "./Composer";
import { EvidenceImportDialog } from "./EvidenceImportDialog";
import { GroundingCard, MessageCard, ProposalCard, ThinkingBubble, TriageCard } from "./TaskContent";
import { ExecutionSummary } from "./ExecutionSummary";
import { fmtDuration } from "./TurnMetrics";
import { useI18n } from "../i18n";
import { matches } from "../shortcuts";
import { clearFind, findRanges, paintFind } from "../lib/findHighlight";
import { stepHit } from "../taskFind";
import { inferDatasetType } from "../datasetType";
import { FindBar } from "./FindBar";

const PENDING_DIRECTION_ID = "task-pending-direction";

type Item =
  | {
      kind: "message";
      ts: string;
      role: string;
      content: string | null;
      id: string;
      toolActivity?: ToolActivity[];
      grounding?: Grounding | null;
      proposals?: NextAction[];
      referencedRunIds?: string[];
      referencedEvidenceIds?: string[];
    }
  | { kind: "run"; ts: string; data: SessionDetail["runs"][number] }
  | { kind: "triage"; ts: string; data: TriageCase };

const propKey = (p: NextAction) => `${p.action_type}::${p.title}`;
const SUGGESTION_KEYS = ["diagnose", "logs", "inventory", "config", "account", "optimize"] as const;

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
        startTitle: "把目标交给 Agent",
        startDescription: "描述要完成的工作、约束和期望结果。Agent 会执行只读检查、持续展示进展，并在需要你决定时明确停下来。",
        startingPoints: "常用任务",
        reportNeedsTask: "先创建一个 Agent Task，再生成 Report Artifact。",
        loadFailed: "无法加载这个 Agent Task。",
        actionFailed: "Agent 无法继续当前任务。",
        workspace: "Agent Task",
        stopped: "已由你停止",
        offline: "Agent Runtime 当前不可用，因此任务暂时不能继续执行。",
        offlineHint: "正在自动重连。你的 Direction 会保留，Runtime 恢复后可以继续。",
        needModel: "需要配置 Model Provider，Agent 才能继续执行这个任务。",
        needModelAction: "配置 Model Provider",
        retry: "重试任务",
        loadingEarlier: "正在加载…",
        loadEarlier: (n: number) => `加载更早的任务历史（${n} 条）`,
        jumpToStart: "回到任务开始",
        suggestedNext: "下一步",
        remoteExecution: (age: string) => `这个 Task 的一次执行仍在后台进行（${age}）。结果完成后会回到这里。`,
        stalled: "这次执行比预期更久；结果可能已经持久化，可以重新同步任务。",
        reload: "重新同步",
        jumpLatest: "回到当前工作",
        jumpWorking: "回到当前工作 · Agent 仍在执行",
        liveNeedModel: "Agent 需要 Model Provider 才能继续。",
        liveFailed: "Agent Task 执行失败。",
        liveStopped: "Agent Task 已停止。",
        liveWorking: "Agent 正在执行 Task。",
        liveReady: "Work Result 已就绪。",
      }
    : {
        startTitle: "Delegate a goal to the Agent",
        startDescription: "Describe the job, constraints, and desired outcome. The Agent will run read-only checks, expose progress, and stop explicitly when it needs your decision.",
        startingPoints: "Common tasks",
        reportNeedsTask: "Create an Agent task before generating a Report artifact.",
        loadFailed: "Couldn't load this Agent task.",
        actionFailed: "The Agent couldn't continue this task.",
        workspace: "Agent task",
        stopped: "Stopped by you",
        offline: "The Agent Runtime is unavailable, so this task cannot execute right now.",
        offlineHint: "Reconnecting automatically. Your Direction is preserved and can continue when the Runtime is back.",
        needModel: "Configure a Model Provider before the Agent can continue this task.",
        needModelAction: "Configure Model Provider",
        retry: "Retry task",
        loadingEarlier: "Loading…",
        loadEarlier: (n: number) => `Load earlier task history (${n})`,
        jumpToStart: "Jump to task start",
        suggestedNext: "Next action",
        remoteExecution: (age: string) => `Execution for this task is still running in the background (${age}). Its result will return here.`,
        stalled: "This execution is taking longer than expected; the result may already be durable. Resync the task to check.",
        reload: "Resync task",
        jumpLatest: "Return to current work",
        jumpWorking: "Return to current work · Agent still executing",
        liveNeedModel: "The Agent needs a Model Provider before it can continue.",
        liveFailed: "Agent task execution failed.",
        liveStopped: "Agent task stopped.",
        liveWorking: "The Agent is executing this task.",
        liveReady: "Work Result ready.",
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
  const [modelName, setModelName] = useState<string | null>(null);
  const run = useSessionRun(sessionId);
  const { busy, uploading, pending, streamText, streamTools, needKey } = run;
  const liveProposals = run.proposals;
  const [viewError, setViewError] = useState<string | null>(null);
  useEffect(() => {
    if (run.busy) setViewError(null);
  }, [run.busy]);
  const error = run.error ?? viewError;
  const {
    detail, triage, earlier, loadingEarlier, metrics, remoteTurn, loadError,
    localId, reload, loadEarlier, loadAllEarlier, hiddenCount,
  } = useSessionDocument({
    sessionId, sidecarReady, reloadKey, t, scrollRef, setViewError,
  });
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [attached, setAttached] = useState<File | null>(null);
  const [attachType, setAttachType] = useState<"inventory" | "access_log" | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const presetTypeRef = useRef<"inventory" | "access_log" | null>(null);
  const suggestions = SUGGESTION_KEYS.map((k) => ({ key: k, label: t(`sugg.${k}`), prompt: t(`prompt.${k}`) }));

  const refreshModel = (attempt = 0) =>
    listModelProviders()
      .then((ps) => {
        const activeP = ps.find((p) => p.active) ?? ps[0];
        setModelName(activeP ? activeP.model || activeP.name : null);
      })
      .catch(() => {
        if (attempt < 3) setTimeout(() => refreshModel(attempt + 1), 2000);
      });

  useEffect(() => {
    if (sidecarReady) refreshModel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidecarReady]);

  useEffect(() => {
    if (!settingsOpen && sidecarReady) refreshModel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen]);

  const metricsFor = (messageId: string): (TurnMetricsRow & { usage?: TokenUsage }) | null => {
    const persisted = metrics[messageId];
    if (persisted) return persisted;
    const live = run.lastMetrics;
    if (live && live.messageId === messageId) {
      const m = live.metrics;
      return {
        turn_id: null, message_id: messageId, model: m.model ?? null,
        duration_ms: m.duration_ms ?? null, tool_calls: m.tool_calls ?? null,
        budget_tokens: m.budget_tokens ?? null,
        repeat_calls_avoided: m.repeat_calls_avoided ?? null,
        created_at: "", usage: m.usage,
        ...(m.usage ?? {}),
      };
    }
    return null;
  };

  const seedComposer = (next: string) => {
    setText(next);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  };
  const directionBefore = (idx: number): string | null => {
    for (let i = idx - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "message" && it.role === "user") return it.content ?? null;
    }
    return null;
  };

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
    refreshModel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const m of [...earlier, ...(detail?.messages ?? [])])
      out.push({
        kind: "message", ts: m.created_at, role: m.role, content: m.content, id: m.id,
        toolActivity: m.tool_activity, grounding: m.grounding, proposals: m.proposed_actions,
        referencedRunIds: m.referenced_run_ids ?? [],
        referencedEvidenceIds: m.referenced_evidence_ids ?? [],
      });
    for (const r of detail?.runs ?? []) {
      if (r.origin === "agent") continue;
      out.push({ kind: "run", ts: r.created_at, data: r });
    }
    for (const c of triage) out.push({ kind: "triage", ts: c.created_at || "", data: c });
    return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }, [detail, triage, earlier]);

  const proposals = liveProposals ?? [];

  const branchFrom = useCallback(
    async (messageId: string) => {
      if (!sessionId) return;
      try {
        const forked = await forkSession(sessionId, messageId);
        onSessionCreated(forked.id);
        onChanged();
      } catch (e) {
        setViewError(cleanError(String(e), t));
      }
    },
    [sessionId, onSessionCreated, onChanged, t],
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
  }, [findOpen, findQuery, items, earlier.length, streamText]);

  const activeRange = matchTotal ? ranges[Math.min(findIdx, matchTotal - 1)] : null;
  useEffect(() => {
    if (!findOpen) return;
    paintFind(ranges, Math.min(findIdx, Math.max(0, matchTotal - 1)));
  }, [findOpen, ranges, findIdx, matchTotal]);
  useEffect(() => {
    if (!findOpen || !activeRange) return;
    const raf = requestAnimationFrame(() => {
      const el = activeRange.startContainer.parentElement;
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(raf);
  }, [findOpen, activeRange]);

  const stepFind = useCallback(
    (delta: number) => setFindIdx((i) => stepHit(i, matchTotal, delta)),
    [matchTotal],
  );
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery("");
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matches(e, "find")) return;
      e.preventDefault();
      setFindOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    followLatest();
  }, [items.length, proposals.length, pending, streamText?.length, streamTools.length, followLatest]);

  const send = () => {
    if (busy || uploading) return;
    if (attached) {
      const type = attachType ?? inferDatasetType(attached.name);
      if (!type) {
        setViewError(t("attach.pickTypeHint"));
        return;
      }
      void runner.submitWithDataset(text.trim(), attached, type);
      return;
    }
    void runner.submit(text.trim());
  };

  const onPickFile = (f: File | null) => {
    if (!f) return;
    const preset = presetTypeRef.current;
    presetTypeRef.current = null;
    setAttached(f);
    setAttachType(preset ?? inferDatasetType(f.name));
  };

  const openReport = () => {
    if (localId.current) openAgentReview("report");
    else setViewError(taskCopy.reportNeedsTask);
  };

  const INLINE_ACTION_PROMPT: Record<string, string> = {
    run_account_discovery: "act.run_account_discovery",
    run_bucket_config_review: "act.run_bucket_config_review",
    run_diagnostic: "act.run_diagnostic",
    continue_investigation: "act.continueInvestigation",
  };

  const runProposal = async (p: NextAction) => {
    if (run.busy) {
      const key = INLINE_ACTION_PROMPT[p.action_type];
      if (key) void runner.steer(t(key));
      return;
    }
    const inlineKey = INLINE_ACTION_PROMPT[p.action_type];
    if (inlineKey) {
      void runner.submit(t(inlineKey));
      return;
    }
    if (p.action_type === "run_inventory_analysis" || p.action_type === "run_access_log_analysis") {
      presetTypeRef.current = p.action_type === "run_inventory_analysis" ? "inventory" : "access_log";
      fileRef.current?.click();
      return;
    }
    if (!localId.current) return;
    try {
      const r = await prepareSessionAction(localId.current, p);
      if (r.open === "evidence_import" && r.status === "ready") {
        setImportHandoff({
          sourceType: r.prefill.source_type as "inventory" | "access_log",
          accountRunId: r.prefill.account_run_id,
          bucketName: r.prefill.bucket_name,
        });
      } else if (r.open === "session_report") {
        openAgentReview("report");
      } else if (r.open === "message_composer") {
        setText(r.prefill.question || "");
        taRef.current?.focus();
      } else {
        void runner.submit(p.title);
      }
    } catch (e) {
      setViewError(cleanError(String(e), t));
    }
  };

  const seed = (prompt: string) => {
    setText(prompt);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const onSuggestion = (key: string, prompt: string) => {
    if (key === "logs" || key === "inventory") {
      presetTypeRef.current = key === "logs" ? "access_log" : "inventory";
      fileRef.current?.click();
      return;
    }
    seed(prompt);
  };

  const loadingTask = Boolean(sessionId) && detail?.id !== sessionId && !loadError;
  const isEmpty = items.length === 0 && !pending && !loadError && !loadingTask;

  const lastResult = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "message" && it.role === "assistant") return it;
      if (it.kind === "message" && it.role === "user") break;
    }
    return undefined;
  }, [items]);
  const lastPersisted = !!(
    lastResult &&
    (lastResult.grounding ||
      (lastResult.proposals && lastResult.proposals.length > 0))
  );
  const showLiveGrounding = !pending && !lastPersisted && (!!run.grounding || proposals.length > 0);

  const offline = sidecarStatus === "disconnected" || sidecarStatus === "error";

  const composer = (
    <Composer
      text={text}
      setText={setText}
      attached={attached}
      attachType={attachType}
      setAttachType={setAttachType}
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
          const type = attachType ?? inferDatasetType(attached.name);
          if (!type) {
            setViewError(t("attach.pickTypeHint"));
            return;
          }
          void runner.steer(text.trim(), () => runner.submitWithDataset(text.trim(), attached, type));
          return;
        }
        if (text.trim()) void runner.steer(text.trim());
      }}
      modelName={modelName}
      onOpenSettings={onOpenSettings}
      onSlashReport={openReport}
      onSlashPickFile={(type) => {
        presetTypeRef.current = type;
        fileRef.current?.click();
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
      ) : isEmpty ? (
        <div className="flex flex-1 items-start justify-center overflow-auto px-6 pb-10 pt-20">
          <div className="w-full max-w-[44rem] animate-fade-in-up">
            <div className="mb-7 flex flex-col items-center text-center">
              <h1 className="text-2xl font-semibold tracking-[-0.02em] text-gray-100">{taskCopy.startTitle}</h1>
              <p className="mt-2.5 max-w-md text-sm leading-relaxed text-gray-500">{taskCopy.startDescription}</p>
            </div>
            {composer}
            <div className="mt-5">
              <div className="mb-1.5 px-1 text-2xs font-medium uppercase tracking-[0.08em] text-gray-500">{taskCopy.startingPoints}</div>
              <div className="grid sm:grid-cols-2">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion.key}
                    onClick={() => onSuggestion(suggestion.key, suggestion.prompt)}
                    disabled={offline}
                    className="group flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-gray-300 transition-colors hover:bg-hover hover:text-gray-100 disabled:cursor-default disabled:text-gray-500 disabled:hover:bg-transparent"
                  >
                    <span className="min-w-0 truncate">{suggestion.label}</span>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-gray-400 opacity-0 transition-opacity group-hover:opacity-100">
                      <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                    </svg>
                  </button>
                ))}
              </div>
            </div>
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
              <div ref={contentRef} className="mx-auto max-w-[min(64rem,100%)] space-y-6">
                {hiddenCount > 0 ? (
                  <div className="flex justify-center">
                    <div className="flex items-center gap-1.5">
                      <button type="button" onClick={loadEarlier} disabled={loadingEarlier} data-testid="load-earlier" className="rounded-full border border-edge px-3 py-1.5 text-2xs text-gray-500 transition-colors hover:border-edge-strong hover:text-gray-200 disabled:opacity-50">
                        {loadingEarlier ? taskCopy.loadingEarlier : taskCopy.loadEarlier(hiddenCount)}
                      </button>
                      <button type="button" onClick={loadAllEarlier} disabled={loadingEarlier} data-testid="jump-to-start" className="rounded-full border border-edge px-3 py-1.5 text-2xs text-gray-500 transition-colors hover:border-edge-strong hover:text-gray-200 disabled:opacity-50">
                        {taskCopy.jumpToStart}
                      </button>
                    </div>
                  </div>
                ) : null}

                {items.map((it, idx) => {
                  if (it.kind === "message") {
                    return (
                      <div
                        key={it.id}
                        id={`task-item-${it.id}`}
                        className={`task-item space-y-3 ${it.role === "user" && idx > 0 ? "pt-6" : ""}`}
                        data-direction={it.role === "user" ? (it.content ?? "") : undefined}
                      >
                        <MessageCard
                          role={it.role}
                          content={it.content}
                          toolActivity={it.toolActivity}
                          onEdit={it.role === "user" && !busy ? seedComposer : undefined}
                          onBranch={it.role === "user" && !busy && sessionId ? () => void branchFrom(it.id) : undefined}
                          onRegenerate={it.role === "assistant" && !busy && directionBefore(idx) ? () => seedComposer(directionBefore(idx) as string) : undefined}
                          referencedRunIds={it.referencedRunIds}
                          referencedEvidenceIds={it.referencedEvidenceIds}
                        />
                        {it.role === "assistant" ? (
                          <div className="max-w-[min(46rem,100%)]">
                            <ExecutionSummary
                              latest={it.id === lastResult?.id}
                              tools={it.toolActivity}
                              grounding={it.grounding}
                              durationMs={metricsFor(it.id)?.duration_ms}
                              usage={metricsFor(it.id)?.usage ?? metricsFor(it.id) ?? undefined}
                              model={metricsFor(it.id)?.model}
                              budgetTokens={metricsFor(it.id)?.budget_tokens}
                              repeatCallsAvoided={metricsFor(it.id)?.repeat_calls_avoided}
                              sessionId={sessionId}
                              onReviewEvidence={() => openAgentReview("evidence")}
                            />
                          </div>
                        ) : null}
                        {it.proposals && it.proposals.length > 0 ? (
                          <div className="flex flex-wrap items-center gap-2 pt-0.5">
                            <span className="text-2xs text-gray-500">{taskCopy.suggestedNext}</span>
                            {it.proposals.map((proposal, index) => <ProposalCard key={`${propKey(proposal)}-${index}`} proposal={proposal} onRun={runProposal} />)}
                          </div>
                        ) : null}
                      </div>
                    );
                  }
                  if (it.kind === "run") {
                    return (
                      <button
                        key={it.data.run_id}
                        type="button"
                        data-testid="execution-link"
                        onClick={() => openAgentExecution(it.data.run_id)}
                        className="task-item flex w-full items-center gap-3 border-y border-edge/70 py-3 text-left text-xs transition-colors hover:bg-hover/30"
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-gray-500" aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-gray-300">{it.data.title || it.data.run_type}</span>
                        <span className="font-mono text-2xs uppercase text-gray-500">{it.data.status}</span>
                        <span className="text-gray-500" aria-hidden>→</span>
                      </button>
                    );
                  }
                  return <div key={it.data.id} className="task-item"><TriageCard c={it.data} onRun={runProposal} /></div>;
                })}

                {!pending && remoteTurn?.running ? (
                  <div data-testid="remote-execution" className="animate-fade-in flex items-center gap-2 rounded-lg border border-edge bg-panel/60 px-3 py-2 text-xs text-gray-400">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
                    {taskCopy.remoteExecution(fmtDuration(remoteTurn.age_ms ?? null) ?? "—")}
                  </div>
                ) : null}

                {pending ? (
                  <>
                    <div id={PENDING_DIRECTION_ID} data-direction={pending}>
                      <MessageCard role="user" content={pending} />
                    </div>
                    {streamText !== null || streamTools.length ? (
                      <>
                        <MessageCard role="assistant" content={streamText ?? ""} toolActivity={streamTools} streaming={!run.stopped} sessionId={sessionId} />
                        {run.stopped ? <div className="flex items-center gap-1.5 text-2xs text-gray-500"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>{taskCopy.stopped}</div> : null}
                      </>
                    ) : run.stopped ? (
                      <div className="flex items-center gap-1.5 text-2xs text-gray-500"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>{taskCopy.stopped}</div>
                    ) : run.stalled ? (
                      <div className="animate-fade-in rounded-lg border border-edge bg-panel/60 p-3 text-xs text-gray-400">
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
                    ) : <ThinkingBubble />}
                  </>
                ) : null}

                <p className="sr-only" role="status" aria-live="polite" data-testid="task-status">{liveStatus}</p>

                {banners}

                {showLiveGrounding ? (
                  <div className="space-y-3">
                    {run.grounding ? <GroundingCard g={run.grounding} /> : null}
                    {proposals.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-2 pt-0.5">
                        <span className="text-2xs text-gray-500">{taskCopy.suggestedNext}</span>
                        {proposals.map((proposal, index) => <ProposalCard key={`${propKey(proposal)}-${index}`} proposal={proposal} onRun={runProposal} />)}
                      </div>
                    ) : null}
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
            <div className="mx-auto max-w-[min(64rem,100%)]"><div className="max-w-[min(46rem,100%)]">{composer}</div></div>
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
