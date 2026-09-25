import type { ReactNode } from "react";
import { pickStartGreeting } from "../agent/startGreeting";
import { useI18n } from "../i18n";
import { Icon, type IconName } from "./icons";

const STARTERS: { key: "access" | "survey" | "logs"; icon: IconName }[] = [
  { key: "access", icon: "shield" },
  { key: "survey", icon: "storage" },
  { key: "logs", icon: "table" },
];

/**
 * The empty start (v3.0): the greeting as the page's one heading, a line on
 * what the Agent does, the Composer, and three real starting points. A starter
 * only fills the Composer — the user still reads and sends it.
 */
export function TaskStart({
  composerNode,
  banners,
  onStarter,
}: {
  composerNode: ReactNode;
  banners: ReactNode;
  onStarter: (text: string) => void;
}) {
  const { t, lang } = useI18n();
  return (
    <div className="native-start" data-testid="task-start">
      <div className="native-start-inner">
        <h1 className="native-start-greeting">{pickStartGreeting(lang)}</h1>
        <p className="native-start-sub">{t("start.sub")}</p>
        {composerNode}
        <div className="native-start-banners empty:hidden">{banners}</div>
        <div className="native-starters" role="group" aria-label={t("start.starters")}>
          {STARTERS.map((starter) => (
            <button
              key={starter.key}
              type="button"
              className="native-starter"
              data-testid="start-starter"
              onClick={() => onStarter(t(`start.${starter.key}.ask`))}
            >
              <span className="native-starter-icon" aria-hidden><Icon name={starter.icon} size={16} /></span>
              <span className="native-starter-title">{t(`start.${starter.key}.title`)}</span>
              <span className="native-starter-body">{t(`start.${starter.key}.body`)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
