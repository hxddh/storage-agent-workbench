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
    <article className="agent-document agent-report" data-testid="report-artifact">
      <header className="agent-document-heading">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <p className="agent-eyebrow">{copy.report.eyebrow}</p>
            <h1 data-testid="report-artifact-title">{copy.report.title}</h1>
            <p>{copy.report.description}</p>
          </div>
          {report && !loading && !error ? (
            <div className="flex shrink-0 items-center gap-1.5 pt-0.5" aria-label={copy.report.actions}>
              <button
                type="button"
                className="agent-os-command"
                onClick={() => void copyReport()}
                data-testid="report-copy"
              >
                {copied ? copy.report.copied : t("common.copy")}
              </button>
              <button
                type="button"
                className="agent-os-command"
                onClick={() => void save()}
                data-testid="report-save"
                title={savedPath ?? undefined}
              >
                {savedPath ? copy.report.savedTo(savedPath) : copy.report.download}
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {loading ? (
        <div className="space-y-2.5" aria-busy="true" aria-label={copy.report.preparing}>
          <p className="sr-only">{copy.report.preparing}</p>
          <span className="skeleton h-4 w-3/4" />
          <span className="skeleton h-4 w-full" />
          <span className="skeleton h-4 w-2/3" />
          <span className="skeleton h-4 w-1/2" />
        </div>
      ) : null}
      {!loading && error ? <p className="agent-surface-error">{error}</p> : null}
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
