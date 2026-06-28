import { ProvidersView } from "../views/ProvidersView";
import { Button } from "./ui";
import { useI18n, LANGS, type Lang } from "../i18n";
import { useTheme, type Theme } from "../theme";

/**
 * Right slide-over for setup. Embeds the existing model + cloud provider CRUD
 * (Providers view), plus appearance (theme + language) controls, so all settings
 * live in one place inline with the thread rather than a separate page.
 */
export function SettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
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
          <Button variant="ghost" onClick={onClose}>{t("common.close")}</Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
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

          <ProvidersView onRunCreated={() => onClose()} />
          <div className="border-t border-edge px-8 py-5 text-xs leading-relaxed text-gray-500">
            <div className="mb-1 font-medium text-gray-400">{t("settings.safetyTitle")}</div>
            {t("settings.safety")}
          </div>
        </div>
      </div>
    </div>
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
