import { useEffect, useState } from "react";
import { ProvidersView } from "../views/ProvidersView";
import { useI18n, LANGS, type Lang } from "../i18n";
import { useTheme, type Theme } from "../theme";
import { getVaultStatus } from "../api";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useDismissOnEscape } from "../hooks/useDismissOnEscape";

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
    <div className="border-b border-danger-border bg-danger-bg px-8 py-3 text-xs leading-relaxed text-danger">
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
  const trapRef = useFocusTrap<HTMLDivElement>(open);
  // Registers with the overlay stack rather than relying on App's catch-all,
  // which used to close this drawer alongside whatever else was open.
  useDismissOnEscape(open, onClose);
  if (!open) return null;

  const themes: { value: Theme; label: string }[] = [
    { value: "dark", label: t("settings.themeDark") },
    { value: "light", label: t("settings.themeLight") },
  ];

  return (
    <div
      className="fixed inset-0 z-drawer flex justify-end bg-scrim backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={t("settings.title")}
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
                <div id="seg-theme-label" className="mb-1.5 text-xs font-medium text-gray-400">{t("settings.theme")}</div>
                <Segmented
                  labelId="seg-theme-label"
                  options={themes}
                  value={theme}
                  onChange={(v) => setTheme(v as Theme)}
                />
              </div>
              <div>
                <div id="seg-lang-label" className="mb-1.5 text-xs font-medium text-gray-400">{t("settings.language")}</div>
                <Segmented
                  labelId="seg-lang-label"
                  options={LANGS}
                  value={lang}
                  onChange={(v) => setLang(v as Lang)}
                />
              </div>
            </div>
          </section>

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

/**
 * A small segmented control used for theme/language selection.
 *
 * Which option is active was carried by `bg-accent` and nothing else — no
 * `aria-pressed`, no group name. So a screen reader announced "English, button"
 * and "简体中文, button" with no way to tell which one the app is currently
 * using, and forced-colours / high-contrast mode loses the accent entirely.
 *
 * `aria-pressed` is the app's own established pattern for this (the composer's
 * attach-type toggle and the inspector's filter chips both use it); these two
 * controls had simply diverged from it. The visible caption above each group
 * now names it, via `aria-labelledby`, instead of floating unattached.
 */
function Segmented<T extends string>({
  options,
  value,
  onChange,
  labelId,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  labelId?: string;
}) {
  return (
    <div
      className="inline-flex rounded-lg border border-edge bg-elevated p-0.5"
      role="group"
      aria-labelledby={labelId}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-3 py-1 text-xs transition-colors ${
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
