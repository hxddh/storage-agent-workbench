import { useEffect, useState } from "react";
import { ProvidersView } from "../views/ProvidersView";
import { useI18n, LANGS, type Lang } from "../i18n";
import { useTheme, type Theme } from "../theme";
import { getVaultStatus } from "../api";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useDismissOnEscape } from "../hooks/useDismissOnEscape";

const LANGUAGE_KEY = "saw.lang";

/** Right slide-over for Agent setup, providers, appearance and safety policy. */
function VaultWarning() {
  const { t } = useI18n();
  const [unreadable, setUnreadable] = useState(false);
  useEffect(() => {
    getVaultStatus().then((status) => setUnreadable(status.unreadable)).catch(() => undefined);
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
  useDismissOnEscape(open, onClose, { ignoreInFields: true });
  if (!open) return null;

  const themes: { value: Theme; label: string }[] = [
    { value: "dark", label: t("settings.themeDark") },
    { value: "light", label: t("settings.themeLight") },
  ];
  const safety = lang === "zh"
    ? "Secrets 只保存在本机加密 Vault，不进入数据库、日志、Report Artifact 或 Model 输入。Storage Provider 使用只读权限；Agent 没有写入或破坏性能力。下载、大规模扫描、Evidence Import 等数据移动操作必须经过明确 Decision。你主动附加到 Task 的本地文件只在当前分析流程中使用。"
    : "Secrets stay only in the encrypted local vault and never enter the database, logs, Report artifacts, or model input. Storage Providers are read-only and the Agent has no write or destructive capability. Downloads, large scans, Evidence Import, and other data-moving operations require an explicit Decision. A local file you attach to a Task is used only by that analysis flow.";

  const selectLanguage = (next: Lang) => {
    // Persist synchronously at the interaction boundary. React effects run after
    // paint; a user can legitimately switch language and immediately reload or
    // close the desktop window before that effect gets a turn. The visible
    // selection and the durable preference must be one atomic user action.
    try {
      localStorage.setItem(LANGUAGE_KEY, next);
    } catch {
      // The in-memory selection still works when storage is unavailable.
    }
    setLang(next);
  };

  return (
    <div className="fixed inset-0 z-drawer flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-scrim backdrop-blur-sm animate-fade-in" aria-hidden />
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={t("settings.title")}
        className="relative flex h-full w-[min(620px,96vw)] flex-col border-l border-edge bg-canvas shadow-pop animate-slide-in-right"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge px-6 py-3.5">
          <span className="text-sm font-semibold text-gray-100">{t("settings.title")}</span>
          <button
            onClick={onClose}
            aria-label={t("common.close")}
            className="grid h-7 w-7 place-items-center rounded-md text-gray-500 transition-colors hover:bg-hover hover:text-gray-200"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <VaultWarning />
          <section className="border-b border-edge px-8 py-5">
            <div className="mb-1 text-sm font-semibold text-gray-100">{t("settings.appearance")}</div>
            <p className="mb-4 text-xs leading-relaxed text-gray-500">{t("settings.appearanceHint")}</p>
            <div className="flex flex-wrap gap-8">
              <div>
                <div id="seg-theme-label" className="mb-1.5 text-xs font-medium text-gray-400">{t("settings.theme")}</div>
                <Segmented labelId="seg-theme-label" options={themes} value={theme} onChange={(value) => setTheme(value as Theme)} />
              </div>
              <div>
                <div id="seg-lang-label" className="mb-1.5 text-xs font-medium text-gray-400">{t("settings.language")}</div>
                <Segmented labelId="seg-lang-label" options={LANGS} value={lang} onChange={(value) => selectLanguage(value as Lang)} />
              </div>
            </div>
          </section>

          <ProvidersView />
          <div className="border-t border-edge px-8 py-5 text-xs leading-relaxed text-gray-500">
            <div className="mb-1 font-medium text-gray-400">{t("settings.safetyTitle")}</div>
            {safety}
          </div>
        </div>
      </div>
    </div>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  labelId,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  labelId?: string;
}) {
  return (
    <div className="inline-flex rounded-lg border border-edge bg-elevated p-0.5" role="group" aria-labelledby={labelId}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`rounded-md px-3 py-1 text-xs transition-colors ${
            value === option.value
              ? "bg-elevated font-medium text-gray-100 shadow-elev"
              : "text-gray-400 hover:text-gray-100"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
