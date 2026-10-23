import { useEffect } from "react";
import { api } from "./api";
import { AppProvider } from "./shell/context";
import { Shell } from "./shell/Shell";
import { useI18n } from "./i18n";
import { useTheme } from "./theme";

/** One window, one workspace: every request starts from the same Composer. */
export default function App() {
  useSyncedPreferences();
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}

/** Language and theme live in the Sidecar's settings too, so the report and the window agree. */
function useSyncedPreferences() {
  const { lang, setLang } = useI18n();
  const { setTheme } = useTheme();
  useEffect(() => {
    api.settings().then((s) => {
      // The first run follows the system language, and the Agent answers in it too.
      if (s.language) setLang(s.language);
      else void api.updateSettings({ language: lang }).catch(() => {});
      if (s.theme === "system" || s.theme === "light" || s.theme === "dark") setTheme(s.theme);
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
