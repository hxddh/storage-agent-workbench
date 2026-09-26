import { useEffect, useState } from "react";
import {
  getTaskRecord,
  getTaskReport,
  listTaskExecutions,
  type TaskExecution,
} from "../api";
import type { TaskRecord } from "../types";
import type { ArtifactSelection } from "./model";
import { useI18n } from "../i18n";

export type ArtifactsProjection = {
  detail: TaskRecord | null;
  /** The task's durable Executions (`task_executions`), newest first (v1.12). */
  executions: TaskExecution[];
  report: string | null;
  reportLoading: boolean;
  error: string | null;
};

/**
 * Load what the detail rows list for the active task: the task detail
 * (findings, attached files) and the durable Executions. The Report body is
 * read only when its row is open. (v2.1: Remediation Plans and Baselines &
 * Drift have no rows — the Agent narrates them in the answer.) `reloadKey` re-reads everything (the shell bumps it when an
 * execution settles). Nothing here is an application page.
 */
export function useAgentTaskProjection(
  taskId: string | null,
  open: boolean,
  selection: ArtifactSelection | null,
  reloadKey = 0,
): ArtifactsProjection {
  const { lang } = useI18n();
  const [detail, setDetail] = useState<TaskRecord | null>(null);
  const [executions, setExecutions] = useState<TaskExecution[]>([]);
  const [report, setReport] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setExecutions([]);
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
    return () => { cancelled = true; };
  }, [taskId, open, reloadKey]);

  const wantsReport = open && selection?.kind === "report";
  useEffect(() => {
    if (!taskId || !wantsReport) return;
    let cancelled = false;
    setReportLoading(true);
    void getTaskReport(taskId, lang)
      .then((next) => { if (!cancelled) { setReport(next.content); setError(null); } })
      .catch((reason) => {
        if (!cancelled) {
          setReport(null);
          setError(String((reason as Error)?.message ?? reason));
        }
      })
      .finally(() => { if (!cancelled) setReportLoading(false); });
    return () => { cancelled = true; };
  }, [taskId, wantsReport, reloadKey, lang]);

  return { detail, executions, report, reportLoading, error };
}
