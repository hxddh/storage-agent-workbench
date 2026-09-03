import { useEffect, useMemo, useState } from "react";
import { resolveTaskDecision, type TaskDecision, type TaskState } from "../api";
import type { TFunc } from "../i18n";
import { getSessionRun, liveTurnOf, patchSessionRun } from "../sessionRuns";
import { resolveApproval, turnItemsOf, unplacedApprovals, type TurnItem } from "../lib/turnItems";
import type { ApprovalResolution, ApprovalScope } from "../components/ApprovalCard";
import type { TaskItem } from "../components/TaskDocument";
import { cleanError } from "./useTurnRunner";

/**
 * Inline approvals of one Task (v1.11, split out in v1.12): the pending
 * Decisions from durable task state, the per-turn item lists with a pending
 * approval placed at the tool row that raised it, the approvals the document
 * could not place, and Allow / Allow for this task / Deny.
 *
 * Resolving never restarts anything: the execution continues server-side. A
 * live follower keeps reading the same stream; a cold document reattaches to
 * the execution the approval belongs to.
 */
export function useApprovals({
  sessionId,
  localId,
  items,
  taskRuntime,
  busy,
  followExecution,
  reload,
  onChanged,
  setViewError,
  t,
}: {
  sessionId: string | null;
  localId: React.MutableRefObject<string | null>;
  items: TaskItem[];
  taskRuntime: TaskState | null;
  busy: boolean;
  followExecution: (executionId: string, direction?: string | null) => Promise<void>;
  reload: (id: string | null) => Promise<boolean>;
  onChanged: () => void;
  setViewError: (message: string | null) => void;
  t: TFunc;
}) {
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  useEffect(() => setResolvingId(null), [sessionId]);

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
        if (decision.execution_id) void followExecution(decision.execution_id, null);
      }
      onChanged();
    } catch (caught) {
      setViewError(cleanError(String(caught), t));
    } finally {
      setResolvingId(null);
    }
  };

  return { pendingDecisions, turnItems, unplaced, resolvingId, resolveApprovalDecision };
}
