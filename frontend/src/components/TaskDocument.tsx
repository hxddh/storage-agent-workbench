import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SessionDetail, SessionMessage, TriageCase } from "../types";
import type { SessionRun } from "../sessionRuns";
import type { ApprovalItem, TurnItem } from "../lib/turnItems";
import { matches } from "../shortcuts";
import { clearFind, findRanges, paintFind } from "../lib/findHighlight";
import { getFindRoots } from "../lib/findRoots";
import { stepHit } from "../taskFind";
import { fmtElapsed } from "../hooks/useElapsed";
import { useTaskProvenance } from "../hooks/useTaskProvenance";
import type { useTaskViewport } from "../hooks/useTaskViewport";
import { AnalysisFigures } from "../viz/AnalysisFigures";
import { ProvenanceMark } from "../viz/ProvenanceMark";
import { AgentTurn, UserTurn } from "./TranscriptTurn";
import { ApprovalCard, type ApprovalResolution, type ApprovalScope } from "./ApprovalCard";
import { TriageCard } from "./AgentRuntimeArtifacts";
import { FindBar } from "./FindBar";
import { Button } from "./ui";
import { Icon } from "./icons";
import { useTaskCopy } from "./taskCopy";

const PENDING_DIRECTION_ID = "task-pending-direction";

/** One record of the Task document, in time order. */
export type TaskItem =
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

/** The persisted document as one ordered list: messages (earlier pages
 * first), the user's explicit runs, and offline triage cards. */
export function useTaskItems(detail: SessionDetail | null, triage: TriageCase[], earlier: SessionMessage[]): TaskItem[] {
  return useMemo<TaskItem[]>(() => {
    const output: TaskItem[] = [];
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
}

/** The latest Work Result, when nothing the user said came after it. */
export function lastWorkResult(items: TaskItem[]): Extract<TaskItem, { kind: "message" }> | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "message" && item.role === "assistant") return item;
    if (item.kind === "message" && item.role === "user") break;
  }
  return undefined;
}

/**
 * The Task as a document: earlier-history paging, the transcript turns
 * (persisted, then the live one), the approvals the document could not
 * place, banners, and Find (⌘F) over the reading column. Figures and
 * provenance render inline in the latest Work Result.
 */
export function TaskDocument({
  sessionId,
  items,
  turnItems,
  unplaced,
  run,
  hideLiveDirection,
  hideLiveWorkResult,
  remoteExecution,
  hiddenCount,
  loadingEarlier,
  loadEarlier,
  loadAllEarlier,
  onResolve,
  resolvingId,
  liveStatus,
  banners,
  composer,
  viewport,
  findOpen,
  setFindOpen,
  onResync,
}: {
  sessionId: string | null;
  items: TaskItem[];
  turnItems: Map<string, TurnItem[]>;
  unplaced: ApprovalItem[];
  run: SessionRun;
  hideLiveDirection: boolean;
  hideLiveWorkResult: boolean;
  remoteExecution: { running: boolean; age_ms: number | null } | null;
  hiddenCount: number;
  loadingEarlier: boolean;
  loadEarlier: () => void;
  loadAllEarlier: () => void;
  onResolve: (decisionId: string, resolution: ApprovalResolution, scope: ApprovalScope) => void;
  resolvingId: string | null;
  liveStatus: string;
  banners: ReactNode;
  composer: ReactNode;
  viewport: ReturnType<typeof useTaskViewport>;
  findOpen: boolean;
  setFindOpen: (open: boolean) => void;
  /** The stalled banner's Resync: clear the live turn and reload the document. */
  onResync: () => void;
}) {
  const copy = useTaskCopy();
  const { scrollRef, contentRef, pinned, onScroll, releaseToUser, jumpToLatest, followLatest } = viewport;
  const { busy, pending, items: liveItems, answer: liveAnswer, waiting } = run;

  const provenance = useTaskProvenance(sessionId);
  const hasFigures = Boolean(
    provenance?.analysis.cost || provenance?.analysis.inventory || provenance?.analysis.drift || provenance?.analysis.access_log,
  );
  const lastResult = useMemo(() => lastWorkResult(items), [items]);
  const figuresFor = (item: Extract<TaskItem, { kind: "message" }>) =>
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

  // --- Find (⌘F) over the reading column ---
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
    // v1.14 — the open Artifacts panel registers its body, so Find covers
    // open documents too, not just the transcript.
    const roots = [scrollRef.current, ...getFindRoots()].filter((node): node is HTMLDivElement => node != null);
    if (roots.length === 0) return;
    const found = findQuery.trim().length >= 2 ? roots.flatMap((root) => findRanges(root, findQuery)) : [];
    setRanges(found);
    return () => clearFind();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, findQuery, items, liveAnswer, liveItems]);
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
  }, [setFindOpen]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!matches(event, "find")) return;
      event.preventDefault();
      setFindOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setFindOpen]);

  useEffect(() => {
    followLatest();
  }, [items.length, pending, liveAnswer?.length, liveItems, followLatest]);

  return (
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
                  {loadingEarlier ? <span className="inline-flex items-center gap-2"><span className="skeleton h-3 w-16" aria-hidden />{copy.loadingEarlier}</span> : copy.loadEarlier(hiddenCount)}
                </button>
                <button type="button" onClick={loadAllEarlier} disabled={loadingEarlier} data-testid="jump-to-start" className="native-chip disabled:opacity-50">
                  {copy.jumpToStart}
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
                      onResolve={onResolve}
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
                    onResolve={onResolve}
                    busy={resolvingId === approval.decision_id}
                  />
                ))}
              </div>
            ) : null}

            {!pending && remoteExecution?.running ? (
              <div data-testid="remote-execution" className="flex items-center gap-2 text-xs text-gray-400">
                <span className="working-mark" style={{ width: 6, height: 6 }} aria-hidden />
                {copy.remoteExecution(fmtElapsed(remoteExecution.age_ms ?? null) ?? "—")}
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
                  {copy.stalled}
                  <div className="native-banner-actions">
                    <Button variant="default" size="sm" onClick={onResync}>{copy.reload}</Button>
                  </div>
                </div>
              ) : busy || run.stopped || liveItems.length > 0 || liveAnswer ? (
                <AgentTurn
                  items={liveItems}
                  answer={liveAnswer}
                  live={!run.stopped}
                  waiting={waiting}
                  stoppedLabel={run.stopped ? copy.stopped : null}
                  startedAt={run.startedAt}
                  sessionId={sessionId}
                  onResolve={onResolve}
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
              {busy ? copy.jumpWorking : copy.jumpLatest}
            </button>
          </div>
        ) : null}
        <div className="native-document">{composer}</div>
      </div>
    </>
  );
}
