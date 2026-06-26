import { useState } from "react";
import {
  attachRunToSession,
  confirmEvidenceImport,
  planEvidenceImport,
  runEvidenceImport,
} from "../api";
import type { EvidenceImport } from "../types";
import { Button, Field, TextInput } from "./ui";

function bytesH(n: number): string {
  let v = n || 0;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} B` : `${v.toFixed(1)} ${units[i]}`;
}

export function EvidenceImportDialog({
  accountRunId,
  bucketName,
  sourceType,
  sessionId,
  onClose,
  onImported,
}: {
  accountRunId: string;
  bucketName: string;
  sourceType: "inventory" | "access_log";
  sessionId?: string;
  onClose: () => void;
  onImported: (analysisRunId: string) => void;
}) {
  const isLog = sourceType === "access_log";
  const [maxFiles, setMaxFiles] = useState("1000");
  const [maxBytes, setMaxBytes] = useState("1073741824"); // 1 GiB
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [plan, setPlan] = useState<EvidenceImport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generatePlan = async () => {
    setError(null);
    setBusy(true);
    try {
      const mf = Number(maxFiles);
      const mb = Number(maxBytes);
      const p = await planEvidenceImport({
        account_run_id: accountRunId,
        bucket_name: bucketName,
        source_type: sourceType,
        max_files: Number.isFinite(mf) && mf > 0 ? mf : undefined,
        max_bytes: Number.isFinite(mb) && mb > 0 ? mb : undefined,
        time_range_start: isLog ? start || undefined : undefined,
        time_range_end: isLog ? end || undefined : undefined,
      });
      setPlan(p);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmAndImport = async () => {
    if (!plan) return;
    setError(null);
    setBusy(true);
    try {
      await confirmEvidenceImport(plan.id);
      const res = await runEvidenceImport(plan.id);
      if (res.analysis_run_id) {
        // Link the resulting analysis run to the session (Phase 17 handoff).
        if (sessionId) {
          try {
            await attachRunToSession(sessionId, res.analysis_run_id);
          } catch {
            /* linkage is best-effort; the run still exists */
          }
        }
        onImported(res.analysis_run_id);
      } else {
        onClose();
      }
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg border border-edge bg-panel p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-100">
            Import {isLog ? "access logs" : "inventory"} — <span className="font-mono">{bucketName}</span>
          </h2>
          <button className="text-xs text-gray-500 hover:text-gray-300" onClick={onClose}>✕</button>
        </div>

        {error && <p className="mb-3 text-xs text-red-400">{error}</p>}

        <p className="mb-3 text-xs text-gray-500">
          Only the discovered {isLog ? "logging target" : "inventory destination"} is read. No business objects are
          scanned and no object bodies are downloaded. Files are bounded by the limits below; nothing downloads until
          you confirm the plan.
        </p>

        <Field label="Max files">
          <TextInput value={maxFiles} onChange={(e) => setMaxFiles(e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="Max bytes" hint="Hard cap 5 GiB">
          <TextInput value={maxBytes} onChange={(e) => setMaxBytes(e.target.value)} inputMode="numeric" />
        </Field>
        {isLog && (
          <>
            <Field label="Time range start (ISO, required)" hint="e.g. 2026-06-01T00:00:00">
              <TextInput value={start} onChange={(e) => setStart(e.target.value)} placeholder="2026-06-01T00:00:00" />
            </Field>
            <Field label="Time range end (ISO, required)">
              <TextInput value={end} onChange={(e) => setEnd(e.target.value)} placeholder="2026-06-08T00:00:00" />
            </Field>
          </>
        )}

        <div className="mb-4 flex gap-2">
          <Button variant="primary" onClick={generatePlan} disabled={busy}>
            {busy && !plan ? "Planning…" : "Generate plan"}
          </Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>

        {plan && (
          <div className="rounded-md border border-edge bg-canvas p-3 text-xs text-gray-300" data-testid="import-plan">
            <div className="mb-2 font-medium text-gray-100">Import plan</div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
              <dt className="text-gray-500">Source bucket</dt>
              <dd className="font-mono">{plan.source_bucket || "—"}</dd>
              <dt className="text-gray-500">Source prefix</dt>
              <dd className="font-mono">{plan.source_prefix || "(root)"}</dd>
              <dt className="text-gray-500">Format</dt>
              <dd>{plan.format || "—"}</dd>
              <dt className="text-gray-500">Plan source</dt>
              <dd>{plan.plan_source || "—"}</dd>
              <dt className="text-gray-500">Files (selected / found)</dt>
              <dd>{plan.selected_file_count} / {plan.planned_file_count}</dd>
              <dt className="text-gray-500">Bytes (selected)</dt>
              <dd>{bytesH(plan.selected_total_bytes)}</dd>
            </dl>

            {plan.warnings.length > 0 && (
              <ul className="mt-2 list-inside list-disc text-amber-400">
                {plan.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}

            <div className="mt-3 flex gap-2">
              <Button
                variant="primary"
                onClick={confirmAndImport}
                disabled={busy || plan.selected_file_count === 0}
              >
                {busy ? "Importing…" : "Confirm and import"}
              </Button>
              {plan.selected_file_count === 0 && (
                <span className="self-center text-amber-400">Nothing to import for this plan.</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
