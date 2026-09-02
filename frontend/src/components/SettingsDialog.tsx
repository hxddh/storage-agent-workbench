import { useEffect, useState, type ReactNode } from "react";
import { CloudProvidersPanel, ModelProvidersPanel } from "../views/ProvidersView";
import { NativeAgentPanel } from "./NativeAgentPanel";
import { useI18n, LANGS, type Lang } from "../i18n";
import { useTheme, type Theme } from "../theme";
import { getVaultStatus } from "../api";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useDismissOnEscape } from "../hooks/useDismissOnEscape";
import { Icon, type IconName } from "./icons";

const LANGUAGE_KEY = "saw.lang";

type Section = "general" | "model" | "storage" | "agent" | "safety";

function VaultWarning() {
  const { t } = useI18n();
  const [unreadable, setUnreadable] = useState(false);
  useEffect(() => {
    getVaultStatus().then((status) => setUnreadable(status.unreadable)).catch(() => undefined);
  }, []);
  if (!unreadable) return null;
  return (
    <div className="native-banner mb-5" data-tone="danger">
      {t("settings.vaultUnreadable")}
    </div>
  );
}

function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-lg font-medium text-gray-100">{title}</h2>
      {hint ? <p className="mt-1 text-xs leading-relaxed text-gray-500">{hint}</p> : null}
    </div>
  );
}

function Row({ label, hint, children }: { label: ReactNode; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-edge py-4 last:border-0">
      <div className="min-w-0">
        <div className="text-sm text-gray-100">{label}</div>
        {hint ? <div className="mt-0.5 text-xs text-gray-500">{hint}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({ options, value, onChange, labelId }: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  labelId: string;
}) {
  return (
    <div className="inline-flex rounded-lg bg-elevated p-0.5" role="group" aria-labelledby={labelId}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`rounded-md px-3 py-1 text-xs transition-[background-color,color] duration-fast ${
            value === option.value ? "bg-canvas font-medium text-gray-100 shadow-elev" : "text-gray-400 hover:text-gray-100"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Settings: model, storage credentials, language and theme. Nothing else. */
export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, lang, setLang } = useI18n();
  const { theme, setTheme } = useTheme();
  const [section, setSection] = useState<Section>("general");
  const trapRef = useFocusTrap<HTMLDivElement>(open);
  useDismissOnEscape(open, onClose, { ignoreInFields: true });
  useEffect(() => { if (open) setSection("general"); }, [open]);
  if (!open) return null;

  const themes: { value: Theme; label: string }[] = [
    { value: "dark", label: t("settings.themeDark") },
    { value: "light", label: t("settings.themeLight") },
  ];
  const sections: { id: Section; label: string; icon: IconName }[] = [
    { id: "general", label: t("settings.general"), icon: "sun" },
    { id: "model", label: t("prov.tabModel"), icon: "chip" },
    { id: "storage", label: t("prov.tabCloud"), icon: "storage" },
    { id: "agent", label: t("settings.agent"), icon: "tool" },
    { id: "safety", label: t("settings.safetyTitle"), icon: "shield" },
  ];

  const selectLanguage = (next: Lang) => {
    // Persist synchronously at the interaction boundary: a user may switch and
    // immediately close the window before a React effect gets a turn.
    try { localStorage.setItem(LANGUAGE_KEY, next); } catch { /* in-memory selection still works */ }
    setLang(next);
  };

  return (
    <div className="fixed inset-0 z-drawer flex items-center justify-center p-6" onClick={onClose}>
      {/* The scrim fades as a sibling: an opaque dialog must never inherit a fade. */}
      <div className="absolute inset-0 bg-scrim animate-fade-in" aria-hidden />
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={t("settings.title")}
        data-testid="settings-dialog"
        className="relative flex h-[min(640px,92vh)] w-[min(880px,96vw)] overflow-hidden rounded-2xl border border-edge bg-canvas shadow-pop animate-rise-in"
        onClick={(event) => event.stopPropagation()}
      >
        <nav className="flex w-52 shrink-0 flex-col border-r border-edge bg-sidebar p-3" aria-label={t("settings.title")}>
          <div className="px-2 pb-3 pt-1 text-sm font-medium text-gray-100">{t("settings.title")}</div>
          <div className="space-y-0.5" role="group" aria-label={t("settings.title")}>
            {sections.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={section === item.id}
                onClick={() => setSection(item.id)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-[background-color,color] duration-fast ${
                  section === item.id ? "bg-elevated text-gray-100" : "text-gray-300 hover:bg-hover hover:text-gray-100"
                }`}
              >
                <Icon name={item.icon} size={15} className="text-gray-500" />
                {item.label}
              </button>
            ))}
          </div>
          <div className="mt-auto px-2 text-2xs leading-relaxed text-gray-500">{t("settings.footer")}</div>
        </nav>

        <div className="relative flex min-w-0 flex-1 flex-col">
          <button
            onClick={onClose}
            aria-label={t("common.close")}
            className="native-icon-button absolute right-3 top-3"
          >
            <Icon name="close" size={15} />
          </button>
          <div className="min-h-0 flex-1 overflow-auto px-8 py-7">
            <VaultWarning />
            {section === "general" ? (
              <section>
                <SectionHeading title={t("settings.general")} hint={t("settings.appearanceHint")} />
                <Row label={<span id="seg-theme-label">{t("settings.theme")}</span>}>
                  <Segmented labelId="seg-theme-label" options={themes} value={theme} onChange={(value) => setTheme(value as Theme)} />
                </Row>
                <Row label={<span id="seg-lang-label">{t("settings.language")}</span>}>
                  <Segmented labelId="seg-lang-label" options={LANGS} value={lang} onChange={(value) => selectLanguage(value as Lang)} />
                </Row>
              </section>
            ) : null}
            {section === "model" ? <ModelProvidersPanel /> : null}
            {section === "storage" ? <CloudProvidersPanel /> : null}
            {section === "agent" ? <NativeAgentPanel /> : null}
            {section === "safety" ? (
              <section>
                <SectionHeading title={t("settings.safetyTitle")} />
                <p className="max-w-[40rem] text-sm leading-relaxed text-gray-300">{t("settings.safety")}</p>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
