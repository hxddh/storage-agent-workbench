import { useEffect, useState } from "react";
import {
  getSession,
  getSessionReport,
  getTaskRevisit,
  listRemediationPlans,
  listTaskArtifacts,
  listTaskBaselines,
  listTaskDecisions,
  putTaskRevisit,
  type RemediationPlan,
  type RevisitSchedule,
  type TaskArtifact,
  type TaskBaseline,
  type TaskDecision,
} from "../api";
import type { SessionDetail } from "../types";
import type { ReviewSurface } from "./model";

/** Load contextual review data without turning it into an application-level page. */
export function useAgentTaskProjection(sessionId: string | null, review: ReviewSurface | null) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [artifacts, setArtifacts] = useState<TaskArtifact[]>([]);
  const [decisions, setDecisions] = useState<TaskDecision[]>([]);
  const [plans, setPlans] = useState<RemediationPlan[]>([]);
  const [baselines, setBaselines] = useState<TaskBaseline[]>([]);
  const [revisit, setRevisit] = useState<RevisitSchedule | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setArtifacts([]);
    setDecisions([]);
    setPlans([]);
    setBaselines([]);
    setRevisit(null);
    setReport(null);
    setReportLoading(false);
    setError(null);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !review) return;
    let cancelled = false;
    setError(null);
    void getSession(sessionId)
      .then((next) => { if (!cancelled) setDetail(next); })
      .catch((reason) => { if (!cancelled) setError(String((reason as Error)?.message ?? reason)); });
    void listTaskArtifacts(sessionId)
      .then((next) => { if (!cancelled) setArtifacts(next.artifacts); })
      .catch(() => undefined);
    void listTaskDecisions(sessionId)
      .then((next) => { if (!cancelled) setDecisions(next.decisions); })
      .catch(() => undefined);
    void listRemediationPlans(sessionId)
      .then((next) => { if (!cancelled) setPlans(next.plans); })
      .catch(() => undefined);
    void listTaskBaselines(sessionId)
      .then((next) => { if (!cancelled) setBaselines(next.baselines); })
      .catch(() => undefined);
    void getTaskRevisit(sessionId)
      .then((next) => { if (!cancelled) setRevisit(next.schedule); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [sessionId, review]);

  useEffect(() => {
    if (!sessionId || review !== "report") return;
    let cancelled = false;
    setReportLoading(true);
    setError(null);
    void getSessionReport(sessionId)
      .then((next) => { if (!cancelled) setReport(next.content); })
      .catch((reason) => {
        if (!cancelled) {
          setReport(null);
          setError(String((reason as Error)?.message ?? reason));
        }
      })
      .finally(() => { if (!cancelled) setReportLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, review]);

  const saveRevisit = async (intervalDays: number, enabled: boolean) => {
    if (!sessionId) return;
    const next = await putTaskRevisit(sessionId, intervalDays, enabled);
    setRevisit(next.schedule);
  };

  return {
    detail, artifacts, decisions, plans, baselines, revisit, saveRevisit,
    report, reportLoading, error,
  };
}
