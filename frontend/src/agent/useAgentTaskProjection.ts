import { useEffect, useState } from "react";
import { getSession, getSessionReport, listTaskArtifacts, type TaskArtifact } from "../api";
import type { SessionDetail } from "../types";
import type { ReviewSurface } from "./model";

/** Load contextual review data without turning it into an application-level page. */
export function useAgentTaskProjection(sessionId: string | null, review: ReviewSurface | null) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [artifacts, setArtifacts] = useState<TaskArtifact[]>([]);
  const [report, setReport] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setArtifacts([]);
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
    // First-class Artifact index (v0.94): reports, evidence imports, analyses.
    void listTaskArtifacts(sessionId)
      .then((next) => { if (!cancelled) setArtifacts(next.artifacts); })
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

  return { detail, artifacts, report, reportLoading, error };
}
