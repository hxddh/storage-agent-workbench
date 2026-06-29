import { useEffect, useState } from "react";
import { ProvidersView } from "../views/ProvidersView";
import { useI18n, LANGS, type Lang } from "../i18n";
import { useTheme, type Theme } from "../theme";
import { getAutonomy, getVaultStatus, setAutonomy, type AutonomyPolicy } from "../api";

/**
 * Right slide-over for setup. Embeds the existing model + cloud provider CRUD
 * (Providers view), plus appearance (theme + language) controls, so all settings
 * live in one place inline with the thread rather than a separate page.
 */
/** Warns when the encrypted secret vault couldn't be decrypted this session. */
function VaultWarning() {
  const { t } = useI18n();
  const [unreadable, setUnreadable] = useState(false);
  useEffect(() => {
    getVaultStatus().then((s) => setUnreadable(s.unreadable)).catch(() => undefined);
  }, []);
  if (!unreadable) return null;
  return (
    <div className="border-b border-red-500/30 bg-red-950/40 px-8 py-3 text-xs leading-relaxed text-red-300">
      {t("settings.vaultUnreadable")}
    </div>
  );
}

export function SettingsDrawer(
  { open, onClose }:
  { open: boolean; onClose: () => void },
) {
  const { t, lang, setLang } = useI18n();
  const { theme, setTheme } = useTheme();
  if (!open) return null;

  const themes: { value: Theme; label: string }[] = [
    { value: "dark", label: t("settings.themeDark") },
    { value: "light", label: t("settings.themeLight") },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="flex h-full w-[min(860px,96vw)] flex-col border-l border-edge bg-canvas shadow-pop animate-slide-in-right"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge px-6 py-3.5">
          <span className="text-sm font-semibold text-gray-100">{t("settings.title")}</span>
          <button
            onClick={onClose}
            aria-label={t("common.close")}
            className="grid h-7 w-7 place-items-center rounded-md text-gray-500 transition-colors hover:bg-hover hover:text-gray-200"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <VaultWarning />
          {/* Appearance: theme + language */}
          <section className="border-b border-edge px-8 py-5">
            <div className="mb-1 text-sm font-semibold text-gray-100">{t("settings.appearance")}</div>
            <p className="mb-4 text-xs leading-relaxed text-gray-500">{t("settings.appearanceHint")}</p>
            <div className="flex flex-wrap gap-8">
              <div>
                <div className="mb-1.5 text-xs font-medium text-gray-400">{t("settings.theme")}</div>
                <Segmented
                  options={themes}
                  value={theme}
                  onChange={(v) => setTheme(v as Theme)}
                />
              </div>
              <div>
                <div className="mb-1.5 text-xs font-medium text-gray-400">{t("settings.language")}</div>
                <Segmented
                  options={LANGS}
                  value={lang}
                  onChange={(v) => setLang(v as Lang)}
                />
              </div>
            </div>
          </section>

          <AutonomySection />

          <ProvidersView />
          <div className="border-t border-edge px-8 py-5 text-xs leading-relaxed text-gray-500">
            <div className="mb-1 font-medium text-gray-400">{t("settings.safetyTitle")}</div>
            {t("settings.safety")}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Agent autonomy policy selector (advisory / assisted / autonomous read-only). */
function AutonomySection() {
  const { t } = useI18n();
  const [policy, setPolicy] = useState<AutonomyPolicy | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getAutonomy()
      .then((s) => setPolicy(s.policy))
      .catch(() => setPolicy("autonomous_readonly"));
  }, []);

  const options: { value: AutonomyPolicy; label: string }[] = [
    { value: "assisted", label: t("settings.autonomyAssisted") },
    { value: "autonomous_readonly", label: t("settings.autonomyAutonomous") },
  ];
  const hint: Partial<Record<AutonomyPolicy, string>> = {
    assisted: t("settings.autonomyAssistedHint"),
    autonomous_readonly: t("settings.autonomyAutonomousHint"),
  };

  async function choose(p: AutonomyPolicy) {
    if (p === policy || saving) return;
    const prev = policy;
    setPolicy(p);
    setSaving(true);
    try {
      await setAutonomy(p);
    } catch {
      setPolicy(prev); // revert on failure
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="border-b border-edge px-8 py-5">
      <div className="mb-1 text-sm font-semibold text-gray-100">{t("settings.autonomy")}</div>
      <p className="mb-4 text-xs leading-relaxed text-gray-500">{t("settings.autonomyHint")}</p>
      <Segmented
        options={options}
        value={policy ?? "autonomous_readonly"}
        onChange={(v) => void choose(v as AutonomyPolicy)}
      />
      {policy && <p className="mt-2 text-xs text-gray-400">{hint[policy]}</p>}
    </section>
  );
}

/** A small segmented control used for theme/language selection. */
function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-edge bg-elevated p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-3 py-1 text-[12.5px] transition-colors ${
            value === o.value
              ? "bg-accent text-white"
              : "text-gray-400 hover:text-gray-100"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
