import { useCallback, useState } from "react";
import { ApiError, compactTaskContext } from "../api";
import { useToast } from "../components/Toast";
import { useI18n } from "../i18n";
import { patchSessionRun } from "../sessionRuns";

export const fmtTokens = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

/**
 * Palette → Compact context (v1.12): run the runtime's compaction step on
 * demand for a task with no live execution, refresh the context meter from
 * the response, and say what happened in a toast. The same step the runtime
 * runs itself at 80 % of the window — never a second Agent.
 */
export function useCompactContext(taskId: string | null) {
  const { t } = useI18n();
  const toast = useToast();
  const [compacting, setCompacting] = useState(false);

  const compact = useCallback(async () => {
    if (!taskId || compacting) return;
    setCompacting(true);
    try {
      const result = await compactTaskContext(taskId);
      if (result.compacted) {
        if (result.after_tokens != null) patchSessionRun(taskId, { contextTokens: result.after_tokens });
        toast.success(t("compact.done", { before: fmtTokens(result.before_tokens), after: fmtTokens(result.after_tokens) }));
      } else {
        toast.info(t("compact.skipped", { reason: result.reason || "" }));
      }
    } catch (caught) {
      const message = caught instanceof ApiError && caught.status === 409
        ? t("compact.busy")
        : caught instanceof ApiError && caught.status === 422
          ? t("compact.noModel")
          : String((caught as Error)?.message ?? caught);
      toast.error(`${t("compact.failed")} ${message}`);
    } finally {
      setCompacting(false);
    }
  }, [taskId, compacting, toast, t]);

  return { compact, compacting };
}
