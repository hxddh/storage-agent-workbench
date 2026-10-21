import { Composer } from "../composer/Composer";
import { useI18n } from "../i18n";

/**
 * Home is the start of a task, not a dashboard. One sentence and the one
 * Composer: the estate lives in the Storage sheet and the sidebar, so there is
 * nothing here to scan or configure before asking.
 */
export function Home({ onCreated }: { onCreated: (taskId: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="home" data-testid="home">
      <div className="home-start">
        <h1 className="home-greeting">{t("home.greeting")}</h1>
        <Composer taskId={null} busy={false} onCreated={onCreated} autoFocus />
      </div>
    </div>
  );
}
