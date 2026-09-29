import type { ReactNode } from "react";
import { pickStartGreeting } from "../agent/startGreeting";
import { useI18n } from "../i18n";
import { Icon, type IconName } from "./icons";
import { EstatePanel, ReadinessCheck, useEstateHome } from "./EstateHome";

const STARTERS: { key: "access" | "survey" | "logs"; icon: IconName; needsStorage: boolean }[] = [
  { key: "access", icon: "shield", needsStorage: true },
  { key: "survey", icon: "storage", needsStorage: true },
  { key: "logs", icon: "table", needsStorage: false },
];

/**
 * The empty start (v3.0): the greeting as the page's one heading, a line on
 * what the Agent does, the Composer, and three real starting points. A starter
 * only fills the Composer — the user still reads and sends it.
 *
 * v4.0 — the home is "what to care about now": a readiness check when a model
 * or a storage account is missing (starters that need storage say so), then
 * the estate — what earlier tasks established and the issues that need care.
 */
export function TaskStart({
  composerNode,
  banners,
  onStarter,
  home = {},
}: {
  composerNode: ReactNode;
  banners: ReactNode;
  onStarter: (text: string) => void;
  home?: { sidecarReady?: boolean; settingsOpen?: boolean; onOpenSettings?: () => void; onOpenTask?: (id: string) => void };
}) {
  const { sidecarReady = false, settingsOpen = false, onOpenSettings = () => {}, onOpenTask = () => {} } = home;
  const { t, lang } = useI18n();
  const { estate, readiness } = useEstateHome(sidecarReady && !settingsOpen);
  const noStorage = readiness?.storage === false;
  return (
    <div className="native-start" data-testid="task-start">
      <div className="native-start-inner">
        <h1 className="native-start-greeting">{pickStartGreeting(lang)}</h1>
        <p className="native-start-sub">{t("start.sub")}</p>
        {composerNode}
        <div className="native-start-banners empty:hidden">{banners}</div>
        <ReadinessCheck readiness={readiness} onOpenSettings={onOpenSettings} />
        <div className="native-starters" role="group" aria-label={t("start.starters")}>
          {STARTERS.map((starter) => (
            <button
              key={starter.key}
              type="button"
              className="native-starter"
              data-testid="start-starter"
              data-needs-storage={starter.needsStorage && noStorage ? "true" : undefined}
              onClick={() => onStarter(t(`start.${starter.key}.ask`))}
            >
              <span className="native-starter-icon" aria-hidden><Icon name={starter.icon} size={16} /></span>
              <span className="native-starter-title">{t(`start.${starter.key}.title`)}</span>
              <span className="native-starter-body">{t(`start.${starter.key}.body`)}</span>
              {starter.needsStorage && noStorage ? (
                <span className="native-starter-note">{t("start.needsStorage")}</span>
              ) : null}
            </button>
          ))}
        </div>
        <EstatePanel estate={estate} onOpenTask={onOpenTask} />
      </div>
    </div>
  );
}
