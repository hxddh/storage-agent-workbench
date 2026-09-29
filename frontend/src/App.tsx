import { useEffect } from "react";
import { api } from "./api";
import { QuickAsk } from "./quick/QuickAsk";
import { AppProvider } from "./shell/context";
import { Shell } from "./shell/Shell";
import { useI18n } from "./i18n";
import { useTheme } from "./theme";

/** The Agent window, or — in the second, small window — Quick Ask. */
export default function App() {
  const quick = new URLSearchParams(window.location.search).get("view") === "quick";
  useSyncedPreferences();
  if (quick) return <QuickAsk />;
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}

/** Language and theme live in the Sidecar's settings too, so every window (and the report) agrees. */
function useSyncedPreferences() {
  const { setLang } = useI18n();
  const { setTheme } = useTheme();
  useEffect(() => {
    api.settings().then((s) => {
      if (s.language) setLang(s.language);
      if (s.theme === "light" || s.theme === "dark") setTheme(s.theme);
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
