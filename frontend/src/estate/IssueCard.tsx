import { useEffect, useState } from "react";
import { api } from "../api";
import type { FixFormat, Impact, Issue } from "../api/types";
import { Icon } from "../components/icons";
import { Badge, Button, Segmented, StatusDot, TextInput } from "../components/ui";
import { useToast } from "../components/Toast";
import { useCopy } from "../hooks/useCopy";
import { useI18n } from "../i18n";
import { timeAgo } from "../lib/time";
import { useApp } from "../shell/context";
import { SEVERITY_TONE } from "../task/Result";

/**
 * One Issue: severity, what it is, where; open, it shows the detail, the fix
 * (text the user applies — Storage Agent never writes to storage), a
 * read-only Verify, the task that found it, and Accept risk with a reason
 * that is kept as a note on the bucket.
 */
export function IssueCard({ issue: initial, onChange, showBucket = true }: {
  issue: Issue; onChange: () => void; showBucket?: boolean;
}) {
  const { t, lang } = useI18n();
  const app = useApp();
  const toast = useToast();
  const [issue, setIssue] = useState(initial);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [reason, setReason] = useState("");
  useEffect(() => setIssue(initial), [initial]);

  const act = async (name: string, fn: () => Promise<Issue>) => {
    setBusy(name);
    try {
      setIssue(await fn());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const verify = async () => {
    setBusy("verify");
    try {
      const out = await api.verifyIssue(issue.id, lang);
      setVerdict(out.result);
      setIssue(out.issue);
      if (out.issue.status === "resolved") onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="issue" data-severity={issue.severity} data-status={issue.status} data-testid="issue">
      <button type="button" className="issue-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Badge tone={SEVERITY_TONE[issue.severity]}>{t(`sev.${issue.severity}`)}</Badge>
        <span className="issue-title">{issue.title}</span>
        <span className="issue-where">{showBucket ? issue.bucket : null}</span>
        {issue.status !== "open" ? <span className="issue-status">{t(`issue.status.${issue.status}`)}</span> : null}
        <Icon name="chevron" size={14} className="issue-caret" />
      </button>
      {open ? (
        <div className="issue-body reveal">
          <p className="quiet-note">{issue.provider_name} · {t("issue.firstSeen", { when: timeAgo(issue.first_seen_at, t) })}</p>
          {issue.detail ? <p>{issue.detail}</p> : null}
          {issue.fix ? <FixPack issue={issue} /> : !issue.fixable ? <p className="quiet-note">{t("issue.noFix")}</p> : null}
          {verdict ? (
            <p className="issue-verdict">
              <StatusDot tone={verdict === "resolved" ? "success" : verdict === "still_present" ? "warn" : "neutral"} />
              {t(`issue.verify.${verdict}`)}
            </p>
          ) : null}
          <div className="issue-actions">
            {issue.fixable && !issue.fix ? (
              <Button size="sm" variant="primary" disabled={!!busy} onClick={() => void act("fix", () => api.proposeFix(issue.id, lang))}>
                {t("issue.fix")}
              </Button>
            ) : null}
            <Button size="sm" disabled={!!busy} onClick={() => void verify()}>
              {busy === "verify" ? t("issue.verifying") : t("issue.verify")}
            </Button>
            {issue.source_task_id ? (
              <Button size="sm" variant="ghost" onClick={() => app.openTask(issue.source_task_id!)}>{t("issue.openTask")}</Button>
            ) : null}
            {issue.status === "accepted" ? (
              <Button size="sm" variant="ghost" disabled={!!busy}
                onClick={() => void act("accept", () => api.acceptIssue(issue.id, false, lang)).then(onChange)}>
                {t("issue.unaccept")}
              </Button>
            ) : issue.status !== "resolved" && !accepting ? (
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setAccepting(true)}>{t("issue.accept")}</Button>
            ) : null}
            {showBucket ? (
              <Button size="sm" variant="ghost" onClick={() => app.openEstate(issue.provider_id, issue.bucket)}>{t("issue.openBucket")}</Button>
            ) : null}
          </div>
          {accepting ? (
            <form className="issue-accept" onSubmit={(e) => {
              e.preventDefault();
              setAccepting(false);
              void act("accept", () => api.acceptIssue(issue.id, true, lang, reason.trim())).then(onChange);
            }}>
              <TextInput value={reason} maxLength={1000} autoFocus placeholder={t("issue.acceptReason")}
                aria-label={t("issue.acceptReason")} onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") setAccepting(false); }} />
              <Button size="sm" type="submit" disabled={!!busy}>{t("issue.acceptConfirm")}</Button>
              <Button size="sm" variant="ghost" onClick={() => setAccepting(false)}>{t("common.cancel")}</Button>
            </form>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

const IMPACT_TONE = { low: "success", caution: "warn", unknown: "neutral" } as const;

/**
 * The fix in the forms people apply changes with, and what applying it would
 * change — from the evidence the estate holds, or an honest "cannot tell".
 */
function FixPack({ issue }: { issue: Issue }) {
  const { t, lang } = useI18n();
  const { copied, copy } = useCopy();
  const formats: FixFormat[] = issue.fix?.formats?.length
    ? issue.fix.formats
    : [{ format: "cli", label: "AWS CLI", text: issue.fix?.command ?? "" }];
  const [format, setFormat] = useState<FixFormat["format"]>(formats[0].format);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [impactFailed, setImpactFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api.impact(issue.id, lang).then((i) => live && setImpact(i)).catch(() => live && setImpactFailed(true));
    return () => { live = false; };
  }, [issue.id, lang]);
  const current = formats.find((f) => f.format === format) ?? formats[0];
  const labelId = `fix-${issue.id}`;
  return (
    <div className="issue-fix" data-testid="fix-pack">
      <div className="fix-head">
        <span id={labelId} className="sr-only">{t("issue.fixFormat")}</span>
        {formats.length > 1 ? (
          <Segmented labelId={labelId} value={current.format} onChange={setFormat} testId="fix-formats"
            options={formats.map((f) => ({ value: f.format, label: f.label }))} />
        ) : null}
        <Button size="sm" icon={copied ? "check" : "copy"} onClick={() => copy(current.text)}>
          {copied ? t("common.copied") : t("issue.copyFix")}
        </Button>
      </div>
      <pre data-format={current.format}><code>{current.text}</code></pre>
      {issue.fix?.notes?.length ? (
        <ul className="fix-notes">{issue.fix.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      ) : null}
      <p className="quiet-note">{t("issue.fixNote")}</p>
      <div className="impact" data-verdict={impact?.verdict} data-testid="impact">
        <p className="impact-head">
          <StatusDot tone={impact ? IMPACT_TONE[impact.verdict] : "neutral"} />
          <span>{impact ? t(`impact.${impact.verdict}`) : impactFailed ? t("impact.failed") : t("impact.loading")}</span>
        </p>
        {impact ? (
          <ul className="impact-points">
            {impact.points.map((p) => (
              <li key={p.text}><span className="impact-source">{t(`impact.source.${p.evidence}`)}</span>{p.text}</li>
            ))}
            {impact.gaps.map((g) => <li key={g} data-gap="true"><span className="impact-source">{t("impact.source.gap")}</span>{g}</li>)}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
