import { Composer } from "../composer/Composer";
import { useI18n } from "../i18n";

/**
 * Home is the start of a task, not a dashboard. One sentence and the one
 * Composer: the Agent resolves the estate from the request, so there is no
 * account/bucket tree to learn before asking.
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
