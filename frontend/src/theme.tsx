import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";

export type Theme = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
const KEY = "saw.theme";

/** The OS preference, with a deterministic dark fallback outside a browser. */
export function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function resolvedTheme(theme: Theme): ResolvedTheme {
  return theme === "system" ? systemTheme() : theme;
}

/** Apply the resolved theme to <html>; the preference is kept separately. */
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = resolvedTheme(theme);
  document.documentElement.dataset.themePreference = theme;
}

/** Resolve the initial preference: stored choice → follow the system. */
export function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "system" || saved === "light" || saved === "dark") return saved;
  } catch {
    /* ignore */
  }
  return "system";
}

type Ctx = {
  theme: Theme;
  resolved: ResolvedTheme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
};
const ThemeContext = createContext<Ctx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => initialTheme());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolvedTheme(theme));

  useEffect(() => {
    const apply = () => {
      const next = resolvedTheme(theme);
      setResolved(next);
      applyTheme(theme);
    };
    apply();
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* ignore */
    }
    if (theme !== "system" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => apply();
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, [theme]);

  const setTheme = (t: Theme) => setThemeState(t);
  const toggle = () => {
    const next: Theme = resolved === "dark" ? "light" : "dark";
    setThemeState(next);
    // The menu shortcut is a real preference, not a one-window override: the
    // next window must open in the theme the reader just chose.
    void api.updateSettings({ theme: next }).catch(() => {});
  };

  return <ThemeContext.Provider value={{ theme, resolved, setTheme, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Ctx {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
