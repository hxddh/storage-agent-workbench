import { Fragment, useState } from "react";
import type { S3Error } from "../lib/s3error";
import { useI18n } from "../i18n";

function legacyCopy(text: string): boolean {
  try {
    const node = document.createElement("textarea");
    node.value = text;
    node.style.position = "fixed";
    node.style.opacity = "0";
    document.body.appendChild(node);
    node.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(node);
    return ok;
  } catch {
    return false;
  }
}

async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return legacyCopy(text);
    }
  }
  return legacyCopy(text);
}

/** Structured Direction artifact for pasted S3-compatible errors. */
export function S3ErrorArtifact({
  error,
  raw,
  onRedirect,
  onBranch,
}: {
  error: S3Error;
  raw: string;
  onRedirect?: (text: string) => void;
  onBranch?: () => void;
}) {
  const { lang, t } = useI18n();
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const facts: { label: string; value: string; mono?: boolean }[] = [];
  if (error.bucket) facts.push({ label: t("s3err.bucket"), value: error.bucket, mono: true });
  if (error.key) facts.push({ label: t("s3err.key"), value: error.key, mono: true });
  if (error.operation) facts.push({ label: t("s3err.operation"), value: error.operation, mono: true });
  if (error.requestId) facts.push({ label: t("s3err.requestId"), value: error.requestId, mono: true });
  if (error.hostId) facts.push({ label: t("s3err.hostId"), value: error.hostId, mono: true });

  return (
    <div data-testid="s3-error-card" className="w-full overflow-hidden rounded-xl border border-danger-border bg-danger-bg/40">
      <div className="flex items-baseline gap-2 px-3.5 pt-3">
        <span className="font-mono text-sm font-semibold text-danger" data-testid="s3-error-code">{error.code}</span>
        <span className="text-2xs uppercase tracking-wider text-gray-500">{t("s3err.label")}</span>
      </div>
      {error.message ? <p className="px-3.5 pt-1 text-prose text-gray-200">{error.message}</p> : null}
      {facts.length ? (
        <dl className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-3.5 pb-1 text-xs">
          {facts.map((fact) => (
            <Fragment key={fact.label}>
              <dt className="text-gray-500">{fact.label}</dt>
              <dd className={`min-w-0 truncate text-gray-300 ${fact.mono ? "font-mono" : ""}`} title={fact.value}>{fact.value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
      <div className="mt-2 flex items-center gap-2 border-t border-danger-border/60 px-2.5 py-1.5">
        <button type="button" onClick={() => setShowRaw((value) => !value)} data-testid="s3-error-raw-toggle" className="rounded px-1 py-0.5 text-2xs text-gray-500 transition-colors hover:text-gray-300">
          {showRaw ? t("s3err.hideRaw") : t("s3err.showRaw")}
        </button>
        <button
          type="button"
          onClick={() => void copyText(raw).then((ok) => { if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1200); } })}
          className="text-2xs text-gray-500 transition-colors hover:text-gray-300"
          aria-label={t("common.copy")}
        >
          {copied ? t("common.copied") : t("common.copy")}
        </button>
        <span className="flex-1" />
        {onRedirect ? (
          <button type="button" onClick={() => onRedirect(raw)} data-testid="edit-message" className="text-2xs text-gray-500 transition-colors hover:text-gray-200">
            {lang === "zh" ? "重新定向" : "Redirect"}
          </button>
        ) : null}
        {onBranch ? (
          <button type="button" onClick={onBranch} data-testid="branch-message" className="text-2xs text-gray-500 transition-colors hover:text-gray-200">
            {lang === "zh" ? "分支任务" : "Branch task"}
          </button>
        ) : null}
      </div>
      {showRaw ? <pre className="max-h-64 overflow-auto border-t border-danger-border/60 bg-code px-3.5 py-2.5 text-2xs leading-relaxed text-gray-400">{raw}</pre> : null}
    </div>
  );
}
