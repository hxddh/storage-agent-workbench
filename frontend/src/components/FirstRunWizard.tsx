import { Button } from "./ui";
import { useI18n } from "../i18n";

const STEP_KEYS = ["step1", "step2", "step3"] as const;

/**
 * One-time first-run overlay shown on a fresh install (no providers yet).
 * Keeps onboarding to a single decision: configure providers now, or start
 * with offline triage. Detailed setup happens in the settings drawer.
 */
export function FirstRunWizard({
  onConfigure,
  onDismiss,
}: {
  onConfigure: () => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm animate-fade-in">
      <div className="w-[min(540px,94vw)] overflow-hidden rounded-2xl border border-edge bg-panel shadow-pop animate-scale-in">
        <div className="border-b border-edge bg-elevated px-7 pb-5 pt-7">
          <div className="mb-3 grid h-11 w-11 place-items-center rounded-xl border border-edge-strong bg-panel text-accent">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round">
              <path d="M12 2 2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <div className="text-lg font-medium text-gray-100">{t("wizard.welcomeTitle")}</div>
          <p className="mt-1.5 text-sm leading-relaxed text-gray-400">{t("wizard.welcomeBody")}</p>
        </div>

        <ol className="space-y-1 px-5 py-5">
          {STEP_KEYS.map((k, i) => (
            <li key={k} className="flex gap-3 rounded-xl px-2 py-2">
              <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border border-accent/40 bg-accent/10 text-xs font-semibold text-accent-soft">
                {i + 1}
              </span>
              <div>
                <div className="text-sm font-medium text-gray-100">{t(`wizard.${k}Title`)}</div>
                <div className="text-[13px] leading-relaxed text-gray-500">{t(`wizard.${k}Body`)}</div>
              </div>
            </li>
          ))}
        </ol>

        <div className="flex justify-end gap-2 border-t border-edge px-5 py-4">
          <Button variant="ghost" onClick={onDismiss}>{t("wizard.skip")}</Button>
          <Button variant="primary" onClick={onConfigure}>{t("wizard.configure")}</Button>
        </div>
      </div>
    </div>
  );
}
