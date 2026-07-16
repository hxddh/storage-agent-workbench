import { useState } from "react";
import {
  attachRunToSession,
  confirmEvidenceImport,
  planEvidenceImport,
  runEvidenceImport,
} from "../api";
import type { EvidenceImport } from "../types";
import { Button, Field, TextInput } from "./ui";
import { useI18n } from "../i18n";

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
  const { t } = useI18n();
  const isLog = sourceType === "access_log";
  const what = isLog ? t("imp.whatLog") : t("imp.whatInv");
  const target = isLog ? t("imp.targetLog") : t("imp.targetInv");
  const [maxFiles, setMaxFiles] = useState("1000");
  const [maxBytes, setMaxBytes] = useState("1073741824"); // 1 GiB
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [plan, setPlan] = useState<EvidenceImport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generatePlan = async () => {
    setError(null);
    // Access-log imports require a valid ISO time range. Validate client-side
    // (Date.parse) and show an inline hint instead of round-tripping to a raw
    // 422 String(e) from the server.
    if (isLog) {
      const s = Date.parse(start);
      const e = Date.parse(end);
      if (!start || !end || Number.isNaN(s) || Number.isNaN(e) || e <= s) {
        setError(t("imp.invalidRange"));
        return;
      }
    }
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
    // While an import is in flight, a stray backdrop click must NOT dismiss the
    // dialog — the import continues server-side and the user loses all
    // progress/error feedback. Close is still available via ✕ / Escape when idle.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
         onClick={busy ? undefined : onClose}>
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg border border-edge bg-panel p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-100">
            {t("imp.title", { what })} <span className="font-mono">{bucketName}</span>
          </h2>
          <button className="text-xs text-gray-500 hover:text-gray-300" onClick={onClose}>✕</button>
        </div>

        {error && <p className="mb-3 text-xs text-red-400">{error}</p>}

        <p className="mb-3 text-xs text-gray-500">{t("imp.intro", { target })}</p>

        <Field label={t("imp.maxFiles")}>
          <TextInput value={maxFiles} onChange={(e) => setMaxFiles(e.target.value)} inputMode="numeric" />
        </Field>
        <Field label={t("imp.maxBytes")} hint={t("imp.maxBytesHint")}>
          <TextInput value={maxBytes} onChange={(e) => setMaxBytes(e.target.value)} inputMode="numeric" />
        </Field>
        {isLog && (
          <>
            <Field label={t("imp.rangeStart")} hint={t("imp.rangeStartHint")}>
              <TextInput value={start} onChange={(e) => setStart(e.target.value)} placeholder="2026-06-01T00:00:00" />
            </Field>
            <Field label={t("imp.rangeEnd")}>
              <TextInput value={end} onChange={(e) => setEnd(e.target.value)} placeholder="2026-06-08T00:00:00" />
            </Field>
          </>
        )}

        <div className="mb-4 flex gap-2">
          <Button variant="primary" onClick={generatePlan} disabled={busy}>
            {busy && !plan ? t("imp.planning") : t("imp.generatePlan")}
          </Button>
          <Button variant="ghost" onClick={onClose}>{t("imp.cancel")}</Button>
        </div>

        {plan && (
          <div className="rounded-md border border-edge bg-canvas p-3 text-xs text-gray-300" data-testid="import-plan">
            <div className="mb-2 font-medium text-gray-100">{t("imp.plan")}</div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
              <dt className="text-gray-500">{t("imp.sourceBucket")}</dt>
              <dd className="font-mono">{plan.source_bucket || "—"}</dd>
              <dt className="text-gray-500">{t("imp.sourcePrefix")}</dt>
              <dd className="font-mono">{plan.source_prefix || t("imp.rootPrefix")}</dd>
              <dt className="text-gray-500">{t("imp.format")}</dt>
              <dd>{plan.format || "—"}</dd>
              <dt className="text-gray-500">{t("imp.planSource")}</dt>
              <dd>{plan.plan_source || "—"}</dd>
              <dt className="text-gray-500">{t("imp.filesSelFound")}</dt>
              <dd>{plan.selected_file_count} / {plan.planned_file_count}</dd>
              <dt className="text-gray-500">{t("imp.bytesSel")}</dt>
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
                {busy ? t("imp.importing") : t("imp.confirmImport")}
              </Button>
              {plan.selected_file_count === 0 && (
                <span className="self-center text-amber-400">{t("imp.nothingToImport")}</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
