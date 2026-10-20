import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "./theme";

function Probe() {
  const { theme, resolved } = useTheme();
  return <span data-testid="theme">{`${theme}:${resolved}`}</span>;
}

describe("theme preference", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.themePreference;
  });

  it("system resolves to the OS preference instead of always painting dark", () => {
    localStorage.setItem("saw.theme", "system");
    const listeners: Array<() => void> = [];
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: () => {},
    })));
    const view = render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(view.getByTestId("theme")).toHaveTextContent("system:light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.themePreference).toBe("system");
    expect(listeners).toHaveLength(1);
  });

  it("an explicit choice wins over the system preference", () => {
    localStorage.setItem("saw.theme", "dark");
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    })));
    const view = render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(view.getByTestId("theme")).toHaveTextContent("dark:dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.themePreference).toBe("dark");
  });
});
