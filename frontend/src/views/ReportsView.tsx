import { useEffect, useState } from "react";
import { getReport, listRuns } from "../api";
import type { ReportOut, RunSummary } from "../types";

export function ReportsView() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<ReportOut | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRuns().then(setRuns).catch((e) => setError(String(e)));
  }, []);

  const open = async (runId: string) => {
    setSelected(runId);
    setReport(null);
    setError(null);
    try {
      setReport(await getReport(runId));
    } catch {
      setError("No report available for this run yet.");
    }
  };

  // Runs that are likely to have a report.
  const reportable = runs.filter((r) => r.status === "completed" || r.status === "failed");

  return (
    <div className="flex flex-1 overflow-hidden bg-canvas">
      <div className="w-72 shrink-0 overflow-auto border-r border-edge p-4">
        <h1 className="mb-3 text-sm font-semibold text-gray-100">Reports</h1>
        {error && !report && <p className="mb-2 text-xs text-amber-400">{error}</p>}
        <ul className="space-y-1">
          {reportable.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => open(r.id)}
                className={`w-full rounded-md px-3 py-2 text-left text-xs ${
                  selected === r.id ? "bg-panel text-gray-100" : "text-gray-400 hover:bg-panel"
                }`}
              >
                <div className="font-medium">{r.title || r.run_type}</div>
                <div className="text-gray-600">{r.bucket || "—"} · {r.status}</div>
              </button>
            </li>
          ))}
          {reportable.length === 0 && <li className="text-xs text-gray-600">No reports yet.</li>}
        </ul>
      </div>

      <div className="flex-1 overflow-auto p-8">
        {report ? (
          <pre className="whitespace-pre-wrap rounded-md border border-edge bg-sidebar p-4 text-[12px] text-gray-300">
            {report.content}
          </pre>
        ) : (
          <p className="text-sm text-gray-600">Select a run to view its report.</p>
        )}
      </div>
    </div>
  );
}
