import { useState } from "react";
import { Markdown } from "../components/Markdown";
import { saveTextFile } from "../config";
import { useI18n } from "../i18n";

function browserDownload(content: string) {
  const blob = new Blob([content], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "report.md";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ReportWorkspace({
  report,
  loading,
  error,
}: {
  report: string | null;
  loading: boolean;
  error: string | null;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  const copy = async () => {
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
    <article className="workbench-document workbench-report" data-testid="report-workspace">
      <header className="workbench-document-heading">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <p className="workbench-eyebrow">Report</p>
            <h1>Durable investigation output</h1>
            <p>The report is a first-class work surface: readable, reviewable and exportable without returning to the conversation.</p>
          </div>
          {report && !loading && !error ? (
            <div className="flex shrink-0 items-center gap-1.5 pt-0.5" aria-label="Report actions">
              <button
                type="button"
                className="agent-os-command"
                onClick={() => void copy()}
                data-testid="report-copy"
              >
                {copied ? t("thread.copied") : t("common.copy")}
              </button>
              <button
                type="button"
                className="agent-os-command"
                onClick={() => void save()}
                data-testid="report-save"
                title={savedPath ?? undefined}
              >
                {savedPath ? t("thread.savedTo", { path: savedPath }) : t("thread.download")}
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {loading ? <p className="workbench-empty-line">Preparing report…</p> : null}
      {!loading && error ? <p className="workbench-surface-error">{error}</p> : null}
      {!loading && !error && report ? (
        <div className="workbench-report-body">
          <Markdown text={report} />
        </div>
      ) : null}
      {!loading && !error && !report ? (
        <p className="workbench-empty-line">No durable report has been generated yet.</p>
      ) : null}
    </article>
  );
}
