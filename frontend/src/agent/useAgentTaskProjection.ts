import { useEffect, useState } from "react";
import { getSession, getSessionReport } from "../api";
import type { SessionDetail } from "../types";
import type { ReviewSurface } from "./model";

/** Load the artifact the document asked to open. Not an application page. */
export function useAgentTaskProjection(sessionId: string | null, review: ReviewSurface | null) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setReport(null);
    setReportLoading(false);
    setError(null);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !review) return;
    if (review === "report") return;
    let cancelled = false;
    setError(null);
    void getSession(sessionId)
      .then((next) => { if (!cancelled) setDetail(next); })
      .catch((reason) => { if (!cancelled) setError(String((reason as Error)?.message ?? reason)); });
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

  return { detail, report, reportLoading, error };
}
