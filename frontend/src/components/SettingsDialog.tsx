import { useEffect, useState, type ReactNode } from "react";
import { ModelProvidersPanel } from "../settings/ModelProvidersPane";
import { CloudProvidersPanel } from "../settings/CloudProvidersPane";
import { NativeAgentPanel } from "./NativeAgentPanel";
import { useI18n, LANGS, type Lang } from "../i18n";
import { useTheme, type Theme } from "../theme";
import { getVaultStatus } from "../api";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useDismissOnEscape } from "../hooks/useDismissOnEscape";
import { Icon, type IconName } from "./icons";
import { IconButton, Segmented } from "./ui";

const LANGUAGE_KEY = "saw.lang";

type Section = "general" | "model" | "storage" | "agent";

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
    <header className="native-settings-pane-head">
      <h2>{title}</h2>
      {hint ? <p>{hint}</p> : null}
    </header>
  );
}

function Row({ label, hint, children }: { label: ReactNode; hint?: string; children: ReactNode }) {
  return (
    <div className="native-settings-row">
      <div className="min-w-0">
        <div className="native-settings-row-label">{label}</div>
        {hint ? <div className="native-settings-row-hint">{hint}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

const SAFETY_POINTS: Array<{ key: "secrets" | "readOnly" | "imports"; icon: IconName }> = [
  { key: "secrets", icon: "lock" },
  { key: "readOnly", icon: "shield" },
  { key: "imports", icon: "download" },
];

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
      <div className="ui-scrim" aria-hidden />
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={t("settings.title")}
        data-testid="settings-dialog"
        className="native-settings-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <nav className="native-settings-nav" aria-label={t("settings.title")}>
          <div className="native-settings-nav-title">{t("settings.title")}</div>
          <div className="native-settings-nav-items" role="group" aria-label={t("settings.title")}>
            {sections.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={section === item.id}
                onClick={() => setSection(item.id)}
                className="native-settings-nav-item"
              >
                <Icon name={item.icon} size={16} />
                {item.label}
              </button>
            ))}
          </div>
        </nav>

        <div className="relative flex min-w-0 flex-1 flex-col">
          <IconButton icon="close" label={t("common.close")} onClick={onClose} className="native-settings-close" />
          <div className="native-settings-body">
            <VaultWarning />
            {section === "general" ? (
              <section>
                <SectionHeading title={t("settings.general")} hint={t("settings.appearanceHint")} />
                <div className="native-settings-group">
                  <Row label={<span id="seg-theme-label">{t("settings.theme")}</span>}>
                    <Segmented labelId="seg-theme-label" options={themes} value={theme} onChange={(value) => setTheme(value as Theme)} />
                  </Row>
                  <Row label={<span id="seg-lang-label">{t("settings.language")}</span>}>
                    <Segmented labelId="seg-lang-label" options={LANGS} value={lang} onChange={(value) => selectLanguage(value as Lang)} />
                  </Row>
                </div>
                {/* v2.1 — nothing asks for approval; the floor is a statement.
                    v3.0 — stated as three points, not a paragraph. */}
                <h3 className="ui-label native-settings-group-label">{t("settings.safetyTitle")}</h3>
                <ul className="native-settings-note" data-testid="settings-safety">
                  {SAFETY_POINTS.map((point) => (
                    <li key={point.key}>
                      <span aria-hidden><Icon name={point.icon} size={14} /></span>
                      <div>
                        <strong>{t(`settings.safety.${point.key}.title`)}</strong>
                        <p>{t(`settings.safety.${point.key}.body`)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {section === "model" ? <ModelProvidersPanel /> : null}
            {section === "storage" ? <CloudProvidersPanel /> : null}
            {section === "agent" ? <NativeAgentPanel /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
