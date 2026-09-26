import { Fragment, useState } from "react";
import { useCopy } from "../hooks/useCopy";
import type { S3Error } from "../lib/s3error";
import { useI18n } from "../i18n";
import { Button, StatusDot } from "./ui";

/** Structured Direction artifact for pasted S3-compatible errors. */
export function S3ErrorArtifact({
  error,
  raw,
}: {
  error: S3Error;
  raw: string;
}) {
  const { t } = useI18n();
  const [showRaw, setShowRaw] = useState(false);
  const { copied, copy } = useCopy(1200);
  const facts: { label: string; value: string; mono?: boolean }[] = [];
  if (error.bucket) facts.push({ label: t("s3err.bucket"), value: error.bucket, mono: true });
  if (error.key) facts.push({ label: t("s3err.key"), value: error.key, mono: true });
  if (error.operation) facts.push({ label: t("s3err.operation"), value: error.operation, mono: true });
  if (error.requestId) facts.push({ label: t("s3err.requestId"), value: error.requestId, mono: true });
  if (error.hostId) facts.push({ label: t("s3err.hostId"), value: error.hostId, mono: true });

  return (
    <div data-testid="s3-error-card" className="s3-error-card">
      <div className="s3-error-head">
        <StatusDot tone="danger" />
        <span className="s3-error-code" data-testid="s3-error-code">{error.code}</span>
        <span className="s3-error-label">{t("s3err.label")}</span>
      </div>
      {error.message ? <p className="s3-error-message">{error.message}</p> : null}
      {facts.length ? (
        <dl className="s3-error-facts">
          {facts.map((fact) => (
            <Fragment key={fact.label}>
              <dt>{fact.label}</dt>
              <dd data-mono={fact.mono ? "true" : undefined} title={fact.value}>{fact.value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
      <div className="s3-error-actions">
        <Button variant="ghost" size="sm" onClick={() => setShowRaw((value) => !value)} data-testid="s3-error-raw-toggle" aria-expanded={showRaw}>
          {showRaw ? t("s3err.hideRaw") : t("s3err.showRaw")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => copy(raw)} aria-label={t("common.copy")}>
          {copied ? t("common.copied") : t("common.copy")}
        </Button>
      </div>
      {showRaw ? <pre className="s3-error-raw">{raw}</pre> : null}
    </div>
  );
}
