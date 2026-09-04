import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SessionDetail, SessionMessage, TriageCase } from "../types";
import type { SessionRun } from "../sessionRuns";
import type { ApprovalItem, TurnItem } from "../lib/turnItems";
import { matches } from "../shortcuts";
import { clearFind, findRanges, paintFind } from "../lib/findHighlight";
import { getFindRoots } from "../lib/findRoots";
import { meetsMinQuery, stepHit } from "../taskFind";
import { fmtElapsed } from "../hooks/useElapsed";
import { useTaskProvenance } from "../hooks/useTaskProvenance";
import type { useTaskViewport } from "../hooks/useTaskViewport";
import { AnalysisFigures } from "../viz/AnalysisFigures";
import { ProvenanceMark } from "../viz/ProvenanceMark";
import { AgentTurn, UserTurn } from "./TranscriptTurn";
import { ApprovalCard, type ApprovalResolution, type ApprovalScope } from "./ApprovalCard";
import { TriageCard } from "./AgentRuntimeArtifacts";
import { FindBar } from "./FindBar";
import { Icon } from "./icons";
import { useTaskCopy } from "./taskCopy";
import { useI18n } from "../i18n";

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
  /** v1.16 — heal a stalled stream: reload the document, clearing the live
   * turn only on success. Returns whether the reload landed, so the caller
   * can back off and retry instead of going silent. */
  onResync: () => boolean | Promise<boolean>;
}) {
  const copy = useTaskCopy();
  const { t } = useI18n();
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
  // Folded tool rows are unmounted — unfindable. While a runnable query is
  // open every group renders whole, so the counter and the DOM agree.
  // (Call-detail bodies stay collapsed: multi-megabyte dumps would freeze
  // the walk. Their one-line rows are still searchable.)
  const findActive = findOpen && meetsMinQuery(findQuery);
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
    const found = meetsMinQuery(findQuery) ? roots.flatMap((root) => findRanges(root, findQuery)) : [];
    setRanges(found);
    return () => clearFind();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, findQuery, findActive, items, liveAnswer, liveItems]);
  const activeRange = matchTotal ? ranges[Math.min(findIdx, matchTotal - 1)] : null;
  useEffect(() => {
    if (!findOpen) return;
    paintFind(ranges, Math.min(findIdx, Math.max(0, matchTotal - 1)));
  }, [findOpen, ranges, findIdx, matchTotal]);
  useEffect(() => {
    if (!findOpen || !activeRange) return;
    // Scroll the TASK scroller by measured offset: `scrollIntoView` on the
    // match's parent scrolls the nearest inner scroller instead (tables and
    // code blocks nest their own), leaving the document unmoved.
    const frame = requestAnimationFrame(() => {
      const host = activeRange.startContainer.parentElement;
      const root = scrollRef.current;
      if (!host || !root) return;
      const toHost = host.getBoundingClientRect();
      const toRoot = root.getBoundingClientRect();
      root.scrollTop += toHost.top + toHost.height / 2 - (toRoot.top + toRoot.height / 2);
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

  // v1.15 — a stalled stream heals itself instead of asking the user to
  // press Resync. The line below is status, not an action.
  // v1.16 — retry with backoff (2s/4s/8s, then stop): one attempt against a
  // restarting Sidecar went silent forever.
  const stalled = run.stalled && liveItems.length === 0 && !liveAnswer;
  const stallTries = useRef(0);
  const [, setStallTick] = useState(0);
  useEffect(() => { if (!stalled) stallTries.current = 0; }, [stalled]);
  useEffect(() => {
    if (!stalled) return;
    const delay = Math.min(2000 * 2 ** stallTries.current, 8000);
    let alive = true;
    const timer = window.setTimeout(() => {
      void Promise.resolve(onResync()).then((ok) => {
        if (!alive) return;
        // A failed reload keeps the line and schedules the next backoff
        // rung (state tick re-arms this effect); then it stops, never loops.
        if (!ok && stallTries.current < 2) {
          stallTries.current += 1;
          setStallTick((n) => n + 1);
        }
      });
    }, delay);
    return () => { alive = false; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stalled, onResync]);

  // v1.15 — earlier history loads as the reader approaches the top, the
  // buttons below remain as an explicit fallback (and the E2E hook).
  // v1.16 — guarded: state lags the in-flight request, so rapid scrolling
  // fired loadEarlier once per frame.
  const loadingEarlierRef = useRef(false);
  useEffect(() => { loadingEarlierRef.current = loadingEarlier; }, [loadingEarlier]);
  const handleScroll: React.UIEventHandler<HTMLDivElement> = () => {
    onScroll();
    const el = scrollRef.current;
    if (el && el.scrollTop < 120 && hiddenCount > 0 && !loadingEarlierRef.current) {
      loadingEarlierRef.current = true;
      loadEarlier();
    }
  };

  return (
    // min-w-0 on the column and footer wrappers: same flex blowout as the
    // task root — column flex items default to min-width:auto.
    <>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          data-testid="task-scroll"
          onScroll={handleScroll}
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
                      findActive={findActive}
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
              stalled ? (
                <div className="flex items-center gap-2 text-xs text-gray-400" data-testid="task-reconnecting" role="status">
                  <span className="working-mark" style={{ width: 6, height: 6 }} aria-hidden />
                  {t("task.reconnecting")}
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
                  findActive={findActive}
                />
              ) : null
            ) : null}

            <p className="sr-only" role="status" aria-live="polite" data-testid="task-status">{liveStatus}</p>

            <div className="space-y-2 empty:hidden">{banners}</div>
          </div>
        </div>
      </div>

      <div className="relative min-w-0 px-6 pb-4 pt-1">
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
