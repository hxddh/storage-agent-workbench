import { useState } from "react";
import { Markdown } from "../components/Markdown";
import { saveTextFile } from "../config";
import { useI18n } from "../i18n";
import { useAgentCopy } from "./agentCopy";

function browserDownload(content: string) {
  const blob = new Blob([content], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "report.md";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Durable report artifact produced by the active Agent task. */
export function ReportArtifact({
  report,
  loading,
  error,
}: {
  report: string | null;
  loading: boolean;
  error: string | null;
}) {
  const { t } = useI18n();
  const copy = useAgentCopy();
  const [copied, setCopied] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  const copyReport = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const save = async () => {
    if (!report) return;
    const path = await saveTextFile("report.md", report);
    if (path) {
      setSavedPath(path);
      window.setTimeout(() => setSavedPath(null), 4000);
      return;
    }
    browserDownload(report);
  };

  return (
    <article className="agent-review-artifact" data-testid="report-artifact">
      {report && !loading && !error ? (
        <div className="mb-4 flex items-center gap-2" aria-label={copy.report.actions}>
          <strong className="sr-only" data-testid="report-artifact-title">{copy.report.title}</strong>
          <button type="button" className="text-2xs text-gray-400 hover:text-gray-100" onClick={() => void copyReport()} data-testid="report-copy">
            {copied ? copy.report.copied : t("common.copy")}
          </button>
          <button type="button" className="text-2xs text-gray-400 hover:text-gray-100" onClick={() => void save()} data-testid="report-save" title={savedPath ?? undefined}>
            {savedPath ? copy.report.savedTo(savedPath) : copy.report.download}
          </button>
        </div>
      ) : (
        <strong className="sr-only" data-testid="report-artifact-title">{copy.report.title}</strong>
      )}

      {loading ? (
        <div className="space-y-2.5" aria-busy="true" aria-label={copy.report.preparing}>
          <p className="sr-only">{copy.report.preparing}</p>
          <span className="skeleton h-4 w-3/4" />
          <span className="skeleton h-4 w-full" />
          <span className="skeleton h-4 w-2/3" />
          <span className="skeleton h-4 w-1/2" />
        </div>
      ) : null}
      {!loading && error ? <p className="agent-review-error">{error}</p> : null}
      {!loading && !error && report ? (
        <div className="agent-report-body">
          <Markdown text={report} />
        </div>
      ) : null}
      {!loading && !error && !report ? (
        <p className="agent-empty-line">{copy.report.empty}</p>
      ) : null}
    </article>
  );
}
