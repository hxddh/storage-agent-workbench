import { useEffect, useState } from "react";
import { getSession, getSessionReport } from "../api";
import type { SessionDetail } from "../types";
import type { WorkSurface } from "./model";

/**
 * Loads persisted investigation projections for non-Timeline work surfaces.
 *
 * The root shell owns navigation/orchestration only. Data fetching for Evidence,
 * Runs and Report lives here so replacing one surface cannot grow the shell into
 * another cross-feature state machine. Timeline transport remains deliberately
 * separate while it is decomposed from the legacy Thread implementation.
 */
export function useWorkbenchProjection(sessionId: string | null, surface: WorkSurface) {
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
    if (!sessionId || (surface !== "evidence" && surface !== "runs")) return;
    let cancelled = false;
    setError(null);
    void getSession(sessionId)
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((reason) => {
        if (!cancelled) setError(String((reason as Error)?.message ?? reason));
      });
    return () => { cancelled = true; };
  }, [sessionId, surface]);

  useEffect(() => {
    if (!sessionId || surface !== "report") return;
    let cancelled = false;
    setReportLoading(true);
    setError(null);
    void getSessionReport(sessionId)
      .then((next) => {
        if (!cancelled) setReport(next.content);
      })
      .catch((reason) => {
        if (!cancelled) {
          setReport(null);
          setError(String((reason as Error)?.message ?? reason));
        }
      })
      .finally(() => {
        if (!cancelled) setReportLoading(false);
      });
    return () => { cancelled = true; };
  }, [sessionId, surface]);

  return { detail, report, reportLoading, error };
}
