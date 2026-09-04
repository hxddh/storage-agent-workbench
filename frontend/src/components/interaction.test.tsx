/**
 * Agent-task interaction rules.
 *
 * Live execution stays visible in the Agent turn. User messages can be copied.
 * Task navigation geometry stays usable. Failures never disappear before the
 * operator can act on them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { createElement } from "react";
import { I18nProvider } from "../i18n";
import { AgentTurn, UserTurn } from "./TranscriptTurn";
import {
  clampTaskNavigationWidth,
  MIN_TASK_NAV_WIDTH,
  MAX_TASK_NAV_WIDTH,
} from "../agent/navigationModel";
import { ToastProvider, useToast } from "./Toast";
import { SHORTCUTS, MOD, matches } from "../shortcuts";
import { START_GREETINGS, pickStartGreeting, startGreetingIndex } from "../agent/startGreeting";
import type { ToolActivity } from "../types";

const wrap = (node: React.ReactNode) => render(createElement(I18nProvider, null, node));
const call = (tool: string, result = "ok"): ToolActivity => ({ tool, target: "bucket", result });

describe("execution details", () => {
  const tools = [call("list_objects"), call("head_bucket"), call("test_credentials")];
  const items = tools.map((record) => ({ kind: "tool" as const, record }));

  it("keeps live execution visible while the Agent is working", () => {
    wrap(createElement(AgentTurn, { answer: null, items, live: true }));
    expect(screen.getByText("list_objects")).toBeTruthy();
    expect(screen.getByTestId("worked-group")).toBeTruthy();
  });

  it("keeps the same tool rows once the answer has landed, folded behind the group", () => {
    wrap(createElement(AgentTurn, { answer: "done", items }));
    expect(screen.getByTestId("work-result")).toBeTruthy();
    expect(screen.getByTestId("worked-group").getAttribute("data-expanded")).toBe("false");
    fireEvent.click(screen.getByTestId("execution-head"));
    expect(screen.getByText("list_objects")).toBeTruthy();
    expect(screen.queryByTestId("execution-summary")).toBeNull();
  });
});

describe("user turns", () => {
  it("shows a long message whole, as a bubble", () => {
    const long = "x".repeat(1200);
    wrap(createElement(UserTurn, { content: long }));
    expect(screen.getByText(long)).toBeTruthy();
    expect(screen.getByTestId("turn-user")).toBeTruthy();
    expect(screen.queryByText("Show more")).toBeNull();
  });

  it("copies the message and does not offer branch or redirect chrome", () => {
    wrap(createElement(UserTurn, { content: "hello there" }));
    expect(screen.queryByTestId("redirect-direction")).toBeNull();
    expect(screen.queryByTestId("branch-task")).toBeNull();
    expect(screen.getByLabelText(/copy/i)).toBeTruthy();
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
    expect(matches(event({ key: "f", metaKey: true }), "find")).toBe(true);
    expect(matches(event({ key: "F", ctrlKey: true }), "find")).toBe(true);
    expect(matches(event({ key: "f" }), "find")).toBe(false);
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

describe("the start greeting", () => {
  it("is one static line per language — no time rotation, no marketing", () => {
    expect(START_GREETINGS.en).toEqual(["What should the Agent work on?"]);
    expect(START_GREETINGS.zh).toEqual(["让 Agent 处理什么？"]);
    const at = (hour: number) => new Date(2026, 8, 2, hour);
    expect(pickStartGreeting("en", at(8))).toBe("What should the Agent work on?");
    expect(pickStartGreeting("en", at(20))).toBe("What should the Agent work on?");
    expect(pickStartGreeting("zh", at(2))).toBe("让 Agent 处理什么？");
    expect(startGreetingIndex(8)).toBe(0);
  });

  it("is one line with no marketing copy", () => {
    for (const line of [...START_GREETINGS.en, ...START_GREETINGS.zh]) {
      expect(line).not.toContain("\n");
      expect(line.length).toBeLessThan(60);
      expect(line).not.toMatch(/welcome|powerful|seamless/i);
    }
  });
});
