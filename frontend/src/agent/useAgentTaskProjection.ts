import { useEffect, useState } from "react";
import {
  getTaskRecord,
  getTaskReport,
  listRemediationPlans,
  listTaskArtifacts,
  listTaskExecutions,
  type RemediationPlan,
  type TaskArtifact,
  type TaskExecution,
} from "../api";
import type { TaskRecord } from "../types";
import type { ArtifactSelection } from "./model";

const BASELINE_TYPES = new Set(["baseline", "drift_report"]);

export type ArtifactsProjection = {
  detail: TaskRecord | null;
  /** The task's durable Executions (`task_executions`), newest first (v1.12). */
  executions: TaskExecution[];
  plans: RemediationPlan[];
  baselines: TaskArtifact[];
  report: string | null;
  reportLoading: boolean;
  error: string | null;
};

/**
 * Load what the Artifacts panel lists for the active task: the task detail
 * (findings, attached files), the durable Executions, remediation plans, and
 * the baseline / drift artifacts. The Report body is read only when its document
 * is open. `reloadKey` re-reads everything (the shell bumps it when an
 * execution settles). Nothing here is an application page.
 */
export function useAgentTaskProjection(
  taskId: string | null,
  open: boolean,
  selection: ArtifactSelection | null,
  reloadKey = 0,
): ArtifactsProjection {
  const [detail, setDetail] = useState<TaskRecord | null>(null);
  const [executions, setExecutions] = useState<TaskExecution[]>([]);
  const [plans, setPlans] = useState<RemediationPlan[]>([]);
  const [baselines, setBaselines] = useState<TaskArtifact[]>([]);
  const [report, setReport] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setExecutions([]);
    setPlans([]);
    setBaselines([]);
    setReport(null);
    setReportLoading(false);
    setError(null);
  }, [taskId]);

  useEffect(() => {
    if (!taskId || !open) return;
    let cancelled = false;
    setError(null);
    void getTaskRecord(taskId)
      .then((next) => { if (!cancelled) setDetail(next); })
      .catch((reason) => { if (!cancelled) setError(String((reason as Error)?.message ?? reason)); });
    void listTaskExecutions(taskId)
      .then((next) => { if (!cancelled) setExecutions(next.executions ?? []); })
      .catch(() => { if (!cancelled) setExecutions([]); });
    // Engine outputs are optional: a task without plans or baselines simply
    // lists none, and an unavailable endpoint stays an empty section.
    void listRemediationPlans(taskId)
      .then((next) => { if (!cancelled) setPlans(next.plans ?? []); })
      .catch(() => { if (!cancelled) setPlans([]); });
    void listTaskArtifacts(taskId)
      .then((next) => {
        if (cancelled) return;
        setBaselines((next.artifacts ?? []).filter((artifact) => BASELINE_TYPES.has(artifact.artifact_type)));
      })
      .catch(() => { if (!cancelled) setBaselines([]); });
    return () => { cancelled = true; };
  }, [taskId, open, reloadKey]);

  const wantsReport = open && selection?.kind === "report";
  useEffect(() => {
    if (!taskId || !wantsReport) return;
    let cancelled = false;
    setReportLoading(true);
    void getTaskReport(taskId)
      .then((next) => { if (!cancelled) { setReport(next.content); setError(null); } })
      .catch((reason) => {
        if (!cancelled) {
          setReport(null);
          setError(String((reason as Error)?.message ?? reason));
        }
      })
      .finally(() => { if (!cancelled) setReportLoading(false); });
    return () => { cancelled = true; };
  }, [taskId, wantsReport, reloadKey]);

  return { detail, executions, plans, baselines, report, reportLoading, error };
}
