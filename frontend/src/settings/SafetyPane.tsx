import { useEffect, useState } from "react";
import { getApprovalPolicy, putApprovalPolicy, type ApprovalPolicy, type ApprovalPolicyInfo } from "../api";
import { useI18n } from "../i18n";

const POLICIES: ApprovalPolicy[] = ["ask", "allow_session", "allow_always"];

/** v1.16 — backend action ids are stable snake_case; render them localized
 * with the raw id as the fallback so a new gate never paints blank. */
function actionLabel(action: string, t: (key: string) => string): string {
  if (action === "import_inventory") return t("approval.actionImportInventory");
  if (action === "import_access_log") return t("approval.actionImportAccessLog");
  if (action === "survey_account_large") return t("approval.actionSurveyLarge");
  return action;
}

/**
 * Settings → Safety (v1.12): the approval policy the Sidecar enforces in
 * `runtime.request_approval`, one consequence line per option, and the list
 * of gated tools the policy can reach. No policy can approve a tool that
 * does not exist — the read-only floor is stated by the dialog above this.
 */
export function SafetyPane() {
  const { t } = useI18n();
  const [info, setInfo] = useState<ApprovalPolicyInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getApprovalPolicy()
      .then((next) => { if (alive) setInfo(next); })
      .catch((caught) => { if (alive) setError(String((caught as Error)?.message ?? caught)); });
    return () => { alive = false; };
  }, []);

  const choose = async (policy: ApprovalPolicy) => {
    if (!info || saving || info.policy === policy) return;
    const previous = info;
    setInfo({ ...info, policy });
    setSaving(true);
    setError(null);
    try {
      setInfo(await putApprovalPolicy(policy));
    } catch (caught) {
      setInfo(previous);
      setError(String((caught as Error)?.message ?? caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mt-6" data-testid="settings-safety">
      <h3 className="text-sm font-medium text-gray-100" id="approval-policy-label">{t("settings.approvals")}</h3>
      <p className="mt-1 text-xs leading-relaxed text-gray-500">{t("settings.approvalsHint")}</p>
      {info ? (
        <div
          className="mt-3 space-y-1"
          role="radiogroup"
          aria-labelledby="approval-policy-label"
          data-testid="approval-policy"
          data-policy={info.policy}
        >
          {POLICIES.map((policy) => {
            const selected = info.policy === policy;
            return (
              <label
                key={policy}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-[background-color,border-color] duration-fast ${
                  selected ? "border-edge-strong bg-elevated" : "border-edge hover:bg-hover"
                }`}
              >
                <input
                  type="radio"
                  name="approval-policy"
                  value={policy}
                  checked={selected}
                  disabled={saving}
                  onChange={() => void choose(policy)}
                  data-testid={`approval-policy-${policy}`}
                  className="mt-1"
                />
                <span className="min-w-0">
                  <span className="block text-sm text-gray-100">{t(`settings.policy.${policy}`)}</span>
                  <span className="block text-xs leading-relaxed text-gray-500">{t(`settings.policy.${policy}.hint`)}</span>
                </span>
              </label>
            );
          })}
        </div>
      ) : error ? null : (
        <div className="skeleton mt-3 h-24 w-full" aria-hidden />
      )}
      {error ? <p className="mt-2 text-xs text-danger" data-testid="approval-policy-error">{error}</p> : null}
      {info ? (
        <div className="mt-5">
          <h4 className="text-xs font-medium uppercase tracking-wide text-gray-500">{t("settings.gatedTools")}</h4>
          {info.gated_tools.length === 0 ? (
            <p className="mt-1 text-xs text-gray-500">{t("settings.gatedToolsNone")}</p>
          ) : (
            <ul className="native-settings-list mt-2" data-testid="approval-gated-tools">
              {info.gated_tools.map((tool) => (
                <li key={tool.name}>
                  <div className="min-w-0">
                    <div className="font-mono text-sm text-gray-100">{tool.name}</div>
                    <div className="text-xs leading-relaxed text-gray-500">{tool.why}</div>
                  </div>
                  {tool.action_types.length ? (
                    <span className="native-settings-tag">{tool.action_types.map((a) => actionLabel(a, t)).join(" · ")}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
