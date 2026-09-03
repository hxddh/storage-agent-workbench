import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { createElement } from "react";
import { I18nProvider } from "../i18n";
import { ThemeProvider } from "../theme";
import type { TFunc } from "../i18n";
import { formatUsageLine, contextReading } from "../lib/usage";
import { NAV_DAY_LABELS } from "../agent/navigationCopy";
import { publishPaletteActions, publishBasePaletteActions } from "../agent/paletteActions";
import { CommandPalette } from "./CommandPalette";
import { TaskBanners } from "./TaskBanners";
import type { TaskExecution } from "../api";

afterEach(() => {
  cleanup();
  publishPaletteActions({});
  publishBasePaletteActions({});
});

// Fake `t` with the en templates for the keys under test.
const t = ((key: string, vars?: Record<string, string | number>) => {
  const v = (k: string) => (vars?.[k] ?? `{${k}}`);
  switch (key) {
    case "usage.total": return `${v("n")} total`;
    case "usage.budget": return `budget ${v("n")}`;
    case "usage.reused": return `reused ${v("n")} from memory`;
    case "usage.in": return `${v("n")} in`;
    case "usage.requests": return `${v("n")} calls`;
    default: return key;
  }
}) as TFunc;

const draw = (node: React.ReactElement) => render(<I18nProvider>{node}</I18nProvider>);

describe("v1.16 usage truth, finished", () => {
  it("paints the persisted turn governor and memory reuse", () => {
    const line = formatUsageLine(
      { total_tokens: 12_000, requests: 3, budget_tokens: 50_000, repeat_calls_avoided: 2 },
      t,
    );
    expect(line).toContain("budget 50k");
    expect(line).toContain("reused 2 from memory");
  });

  it("labels the window source instead of hiding the guess", () => {
    const declared = contextReading({ usage: { total_tokens: 1000 }, context_window: 128_000, context_window_source: "declared" });
    const inferred = contextReading({ usage: { total_tokens: 1000 }, context_window: 128_000, context_window_source: "inferred" });
    expect(declared).toMatchObject({ kind: "measured", windowSource: "declared" });
    expect(inferred).toMatchObject({ kind: "measured", windowSource: "inferred" });
    expect(contextReading({ usage: { total_tokens: 1000 }, context_window: 128_000 })).toMatchObject({ windowSource: null });
  });
});

describe("v1.16 discoverability without painted hints", () => {
  it("lists engine asks and the shortcuts sheet in the palette", () => {
    publishPaletteActions({
      prefill: () => {},
      focusComposer: () => {},
      find: () => {},
      hasTask: true,
      busy: false,
    });
    publishBasePaletteActions({ shortcuts: () => {} });
    render(createElement(ThemeProvider, null, createElement(I18nProvider, null, createElement(CommandPalette, {
        open: true,
        onClose: () => {},
        tasks: [],
        onSelectTask: () => {},
        onNew: () => {},
        onOpenSettings: () => {},
      }))));
    expect(screen.getByTestId("command-palette-engines")).toBeTruthy();
    expect(screen.getByText("Analyze storage costs")).toBeTruthy();
    expect(screen.getByText("Keyboard shortcuts")).toBeTruthy();
  });

  it("prefills the Composer instead of navigating away", () => {
    const prefill = vi.fn();
    publishPaletteActions({ prefill, hasTask: true, busy: false });
    render(createElement(ThemeProvider, null, createElement(I18nProvider, null, createElement(CommandPalette, {
        open: true,
        onClose: () => {},
        tasks: [],
        onSelectTask: () => {},
        onNew: () => {},
        onOpenSettings: () => {},
      }))));
    fireEvent.click(screen.getByText("Draft a remediation plan"));
    expect(prefill).toHaveBeenCalledWith("Draft a remediation plan");
  });
});

describe("v1.16 banners tell the truth and let go", () => {
  const base = {
    offline: false,
    needKey: false,
    error: null as string | null,
    canRetry: false,
    onRetry: () => {},
    onOpenSettings: () => {},
    showResume: false,
    lastExecution: null,
    onResume: () => {},
    queued: [],
    onCancelQueued: () => {},
    onEditQueued: () => {},
  };

  it("dismisses a view error that has no retry", () => {
    const onDismissError = vi.fn();
    draw(createElement(TaskBanners, { ...base, error: "approval failed", onDismissError }));
    fireEvent.click(screen.getByText("Dismiss"));
    expect(onDismissError).toHaveBeenCalledTimes(1);
  });

  it("suppresses the model banner while offline", () => {
    draw(createElement(TaskBanners, { ...base, offline: true, needKey: true }));
    expect(screen.getByTestId("offline-banner")).toBeTruthy();
    expect(screen.queryByText(/model provider/i)).toBeNull();
  });

  it("caps the queued editor at the server ceiling", () => {
    const queued = [{ id: "q1", direction: "do it" } as TaskExecution];
    draw(createElement(TaskBanners, { ...base, queued }));
    fireEvent.click(screen.getByTestId("queued-direction-edit"));
    const editor = screen.getByTestId("queued-direction-editor") as HTMLTextAreaElement;
    expect(editor.getAttribute("maxlength")).toBe("32000");
  });
});

describe("v1.16 copy lives in dictionaries", () => {
  it("keeps day labels with navigation copy", () => {
    expect(NAV_DAY_LABELS.en.today).toBe("Today");
    expect(NAV_DAY_LABELS.zh.today).toBe("今天");
    expect(NAV_DAY_LABELS.zh.earlier).toBe("更早");
  });
});
