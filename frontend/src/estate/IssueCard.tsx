import { useEffect, useState } from "react";
import { api } from "../api";
import type { FixFormat, Impact, Issue } from "../api/types";
import { Icon } from "../components/icons";
import { Button, Segmented, StatusDot, TextInput } from "../components/ui";
import { useToast } from "../components/Toast";
import { useCopy } from "../hooks/useCopy";
import { useI18n } from "../i18n";
import { useDismiss } from "../lib/useDismiss";
import { SEVERITY_TONE } from "../lib/severity";
import { useApp } from "../shell/context";

/**
 * One Issue on its bucket: what it is; opened, the detail, Show fix and a
 * read-only Verify, then the fix (text the user applies — Storage Agent never
 * writes to storage) with one sentence on what applying it would change. The rest (the task that found it,
 * accepting the risk) sits behind ⋯.
 */
export function IssueCard({ issue: initial, onChange }: { issue: Issue; onChange: () => void }) {
  const { t, lang } = useI18n();
  const app = useApp();
  const toast = useToast();
  const [issue, setIssue] = useState(initial);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useDismiss<HTMLSpanElement>(menu, () => setMenu(false));
  const [busy, setBusy] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [reason, setReason] = useState("");
  // The fix opens under the actions, which stay where they are.
  const [fixShown, setFixShown] = useState(Boolean(initial.fix));
  useEffect(() => setIssue(initial), [initial]);

  const act = async (name: string, fn: () => Promise<Issue>) => {
    setBusy(name);
    try {
      setIssue(await fn());
      onChange();
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
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const tone = SEVERITY_TONE[issue.severity];
  const settled = issue.status === "resolved" || issue.status === "accepted";

  return (
    <li className="issue" data-severity={issue.severity} data-status={issue.status} data-testid="issue">
      <button type="button" className="issue-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <StatusDot tone={tone === "outline" ? "neutral" : tone} />
        <span className="sr-only">{t(`sev.${issue.severity}`)}: </span>
        <span className="issue-title">{issue.title}</span>
        {issue.status !== "open" && issue.status !== "fix_proposed"
          ? <span className="issue-status">{t(`issue.status.${issue.status}`)}</span> : null}
        <Icon name="chevron" size={14} className="issue-caret" />
      </button>
      {open ? (
        <div className="issue-body reveal">
          {issue.detail ? <p className="issue-detail">{issue.detail}</p> : null}
          <div className="issue-actions">
            {issue.fixable ? (
              <Button size="sm" variant={fixShown ? "secondary" : "primary"} disabled={!!busy} aria-expanded={fixShown}
                onClick={() => {
                  if (issue.fix) setFixShown(!fixShown);
                  else void act("fix", () => api.proposeFix(issue.id, lang)).then(() => setFixShown(true));
                }}>
                {fixShown ? t("issue.hideFix") : t("issue.fix")}
              </Button>
            ) : null}
            <Button size="sm" disabled={!!busy} onClick={() => void verify()}>
              {busy === "verify" ? t("issue.verifying") : t("issue.verify")}
            </Button>
            <span className="issue-more" ref={menuRef}>
              <Button size="sm" variant="ghost" icon="more" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
                {t("issue.more")}
              </Button>
              {menu ? (
                <div className="ui-menu issue-menu" role="menu" onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setMenu(false); } }}>
                  {issue.source_task_id ? (
                    <button type="button" role="menuitem" className="ui-menu-item" autoFocus
                      onClick={() => { setMenu(false); app.setPane(null); app.openTask(issue.source_task_id!); }}>
                      {t("issue.openTask")}
                    </button>
                  ) : null}
                  {issue.status === "accepted" ? (
                    <button type="button" role="menuitem" className="ui-menu-item"
                      onClick={() => { setMenu(false); void act("accept", () => api.acceptIssue(issue.id, false, lang)); }}>
                      {t("issue.unaccept")}
                    </button>
                  ) : !settled ? (
                    <button type="button" role="menuitem" className="ui-menu-item" onClick={() => { setMenu(false); setAccepting(true); }}>
                      {t("issue.accept")}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </span>
          </div>
          {accepting ? (
            <form className="issue-accept" onSubmit={(e) => {
              e.preventDefault();
              setAccepting(false);
              const why = reason.trim();
              setReason("");
              void act("accept", () => api.acceptIssue(issue.id, true, lang, why));
            }}>
              <TextInput value={reason} maxLength={1000} autoFocus placeholder={t("issue.acceptReason")}
                aria-label={t("issue.acceptReason")} onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setAccepting(false); } }} />
              <Button size="sm" type="submit" disabled={!!busy}>{t("issue.acceptConfirm")}</Button>
            </form>
          ) : null}
          {verdict ? (
            <p className="issue-verdict">
              <StatusDot tone={verdict === "resolved" ? "success" : verdict === "still_present" ? "warn" : "neutral"} />
              {t(`issue.verify.${verdict}`)}
            </p>
          ) : null}
          {fixShown && issue.fix ? <FixPack issue={issue} /> : null}
          {!issue.fixable ? <p className="quiet-note">{t("issue.noFix")}</p> : null}
        </div>
      ) : null}
    </li>
  );
}

const IMPACT_TONE = { low: "success", caution: "warn", unknown: "neutral" } as const;
const FORMAT_LABEL: Record<FixFormat["format"], string> = { cli: "CLI", terraform: "Terraform", json: "JSON" };

/** The fix in the forms people apply changes with, and what applying it would change. */
function FixPack({ issue }: { issue: Issue }) {
  const { t, lang } = useI18n();
  const { copied, copy } = useCopy();
  const formats: FixFormat[] = issue.fix?.formats?.length
    ? issue.fix.formats
    : [{ format: "cli", label: "AWS CLI", text: issue.fix?.command ?? "" }];
  const [format, setFormat] = useState<FixFormat["format"]>(formats[0].format);
  const [impact, setImpact] = useState<Impact | null>(null);
  useEffect(() => {
    let live = true;
    api.impact(issue.id, lang).then((i) => live && setImpact(i)).catch(() => {});
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
            options={formats.map((f) => ({ value: f.format, label: FORMAT_LABEL[f.format] }))} />
        ) : <span />}
        <Button size="sm" variant="ghost" icon={copied ? "check" : "copy"} onClick={() => copy(current.text)}>
          {copied ? t("common.copied") : t("common.copy")}
        </Button>
      </div>
      <pre data-format={current.format}><code>{current.text}</code></pre>
      {impact ? (
        <details className="impact" data-verdict={impact.verdict} data-testid="impact">
          <summary className="impact-head"><StatusDot tone={IMPACT_TONE[impact.verdict]} />{t(`impact.${impact.verdict}`)}</summary>
          <ul className="impact-points">
            {impact.points.map((p) => <li key={p.text}>{p.text}</li>)}
            {impact.gaps.map((g) => <li key={g} data-gap="true">{g}</li>)}
            {issue.fix?.notes?.map((n) => <li key={n} data-note="true">{n}</li>)}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
