/**
 * Agent-task interaction rules.
 *
 * Live execution stays visible in the Work Result. Directions can be copied.
 * Task navigation geometry stays usable. Failures never disappear before the
 * operator can act on them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { createElement } from "react";
import { I18nProvider } from "../i18n";
import { AgentTaskResult } from "./AgentTaskResult";
import {
  dayBucket,
  clampTaskNavigationWidth,
  MIN_TASK_NAV_WIDTH,
  MAX_TASK_NAV_WIDTH,
} from "../agent/navigationModel";
import { ToastProvider, useToast } from "./Toast";
import { SHORTCUTS, MOD, matches } from "../shortcuts";
import type { ToolActivity } from "../types";

const wrap = (node: React.ReactNode) => render(createElement(I18nProvider, null, node));
const call = (tool: string, result = "ok"): ToolActivity => ({ tool, target: "bucket", result });

describe("execution details", () => {
  const tools = [call("list_objects"), call("head_bucket"), call("test_credentials")];

  it("keeps live execution visible while the Agent is working", () => {
    wrap(createElement(AgentTaskResult, { role: "assistant", content: "", toolActivity: tools, streaming: true }));
    expect(screen.getByText("list_objects")).toBeTruthy();
    expect(screen.getByTestId("live-trace")).toBeTruthy();
  });

  it("keeps the same tool rows after the Work Result has landed", () => {
    wrap(createElement(AgentTaskResult, { role: "assistant", content: "done", toolActivity: tools }));
    expect(screen.getByText("list_objects")).toBeTruthy();
    expect(screen.getByTestId("work-result")).toBeTruthy();
    expect(screen.getByTestId("live-trace")).toBeTruthy();
    expect(screen.queryByTestId("execution-summary")).toBeNull();
  });
});

describe("Direction events", () => {
  it("clamps a long Direction but truncates nothing", () => {
    const long = "x".repeat(1200);
    wrap(createElement(AgentTaskResult, { role: "user", content: long }));
    expect(screen.getByText(long)).toBeTruthy();
    expect(screen.getByText("Show more")).toBeTruthy();
  });

  it("leaves a short Direction alone", () => {
    wrap(createElement(AgentTaskResult, { role: "user", content: "why is my bucket public?" }));
    expect(screen.queryByText("Show more")).toBeNull();
  });

  it("copies Direction text and does not offer branch or redirect chrome", () => {
    wrap(createElement(AgentTaskResult, { role: "user", content: "hello there" }));
    expect(screen.queryByTestId("redirect-direction")).toBeNull();
    expect(screen.queryByTestId("branch-task")).toBeNull();
    expect(screen.getByLabelText(/copy/i)).toBeTruthy();
  });
});

describe("task navigation day buckets", () => {
  const now = new Date(2026, 7, 6, 9, 0, 0);
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).toISOString();

  it("uses calendar midnights, not elapsed hours", () => {
    expect(dayBucket(at(2026, 7, 5, 10), now)).toBe("yesterday");
    expect(dayBucket(at(2026, 7, 6, 0), now)).toBe("today");
  });

  it("buckets the rest by calendar distance", () => {
    expect(dayBucket(at(2026, 7, 2), now)).toBe("week");
    expect(dayBucket(at(2026, 6, 20), now)).toBe("month");
    expect(dayBucket(at(2026, 3, 1), now)).toBe("older");
  });

  it("treats a future or unparseable timestamp sanely", () => {
    expect(dayBucket(at(2026, 7, 9), now)).toBe("today");
    expect(dayBucket("not-a-date", now)).toBe("older");
  });
});

describe("task navigation width", () => {
  it("stays within bounds that keep task navigation and work area usable", () => {
    expect(clampTaskNavigationWidth(10)).toBe(MIN_TASK_NAV_WIDTH);
    expect(clampTaskNavigationWidth(9999)).toBe(MAX_TASK_NAV_WIDTH);
    expect(clampTaskNavigationWidth(300.4)).toBe(300);
  });
});

describe("toasts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function Harness() {
    const toast = useToast();
    return createElement("div", null,
      createElement("button", { onClick: () => toast.error("it broke") }, "err"),
      createElement("button", { onClick: () => toast.success("saved") }, "ok"),
    );
  }
  const mount = () => render(createElement(ToastProvider, null, createElement(Harness, null)));

  it("keeps an error until it is dismissed", () => {
    mount();
    fireEvent.click(screen.getByText("err"));
    expect(screen.getByText("it broke")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText("it broke")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByText("it broke")).toBeNull();
  });

  it("auto-dismisses a success", () => {
    mount();
    fireEvent.click(screen.getByText("ok"));
    expect(screen.getByText("saved")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(4000); });
    expect(screen.queryByText("saved")).toBeNull();
  });

  it("caps the stack so a failing loop cannot cover the task", () => {
    mount();
    for (let i = 0; i < 9; i++) fireEvent.click(screen.getByText("err"));
    expect(screen.getAllByText("it broke").length).toBe(4);
  });
});

describe("shortcut registry", () => {
  it("documents every binding the handler actually installs", () => {
    const handled = SHORTCUTS.filter((shortcut) => shortcut.handled);
    for (const shortcut of handled) expect(shortcut.key, shortcut.id).toBeTruthy();
    expect(handled.length).toBeGreaterThan(4);
  });

  it("matches the chords it advertises", () => {
    const event = (init: Partial<KeyboardEvent>) => new KeyboardEvent("keydown", init as KeyboardEventInit);
    expect(matches(event({ key: "k", metaKey: true }), "palette")).toBe(true);
    expect(matches(event({ key: "K", ctrlKey: true }), "palette")).toBe(true);
    expect(matches(event({ key: "k" }), "palette")).toBe(false);
  });

  it("does not let a bare-key shortcut swallow a modified chord", () => {
    const event = (init: Partial<KeyboardEvent>) => new KeyboardEvent("keydown", init as KeyboardEventInit);
    expect(matches(event({ key: "?" }), "shortcuts")).toBe(true);
    expect(matches(event({ key: "?", metaKey: true }), "shortcuts")).toBe(false);
  });

  it("renders a platform-correct modifier", () => {
    const palette = SHORTCUTS.find((shortcut) => shortcut.id === "palette")!;
    expect(palette.keys[0]).toBe(MOD);
    expect(["⌘", "Ctrl"]).toContain(MOD);
  });

  it("has no duplicate ids", () => {
    const ids = SHORTCUTS.map((shortcut) => shortcut.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
