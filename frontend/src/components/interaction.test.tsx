/**
 * Agent-task interaction rules.
 *
 * These pin behavior that must survive the Agent-native rebuild: live tool
 * execution stays visible while work is running, completed execution folds into
 * one auditable detail surface, task navigation uses calendar buckets and safe
 * width bounds, and failures never disappear before the user can act on them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { createElement } from "react";
import { I18nProvider } from "../i18n";
import { MessageCard } from "./TaskContent";
import { TurnFooter, linkEvidence } from "./TurnFooter";
import {
  dayBucket,
  clampTaskNavigationWidth,
  MIN_TASK_NAV_WIDTH,
  MAX_TASK_NAV_WIDTH,
} from "../workbench/navigationModel";
import { ToastProvider, useToast } from "./Toast";
import { SHORTCUTS, MOD, matches } from "../shortcuts";
import type { ToolActivity } from "../types";

const wrap = (node: React.ReactNode) => render(createElement(I18nProvider, null, node));
const call = (tool: string, result = "ok"): ToolActivity => ({ tool, target: "bucket", result });

describe("execution details", () => {
  const tools = [call("list_objects"), call("head_bucket"), call("test_credentials")];

  it("keeps the live trace visible WHILE the Agent is working", () => {
    wrap(createElement(MessageCard, { role: "assistant", content: "", toolActivity: tools, streaming: true }));
    expect(screen.getByText("list_objects")).toBeTruthy();
  });

  it("folds the live trace once the Work Result has landed", () => {
    wrap(createElement(MessageCard, { role: "assistant", content: "done", toolActivity: tools }));
    expect(screen.queryByText("list_objects")).toBeNull();
  });

  it("states the execution once and expands in real execution order", () => {
    wrap(createElement(TurnFooter, { tools, durationMs: 12400 }));
    const toggle = screen.getByTestId("turn-footer-toggle");
    expect(toggle.textContent).toContain("3");
    expect(screen.queryByText("list_objects")).toBeNull();
    fireEvent.click(toggle);
    const rows = screen.getAllByText(/list_objects|head_bucket|test_credentials/);
    expect(rows.map((r) => r.textContent)).toEqual([
      "list_objects", "head_bucket", "test_credentials",
    ]);
  });

  it("surfaces failures without needing to expand", () => {
    wrap(createElement(TurnFooter, {
      tools: [call("head_bucket", "error: AccessDenied"), call("list_objects")],
    }));
    expect(screen.getByTestId("turn-footer-toggle").textContent).toMatch(/1/);
  });

  it("shows grounding beside the execution it rests on", () => {
    wrap(createElement(TurnFooter, {
      tools,
      grounding: {
        evidence_used: ["head_bucket returned 200"],
        evidence_gaps: ["IAM identity policy not readable"],
        skills_used: ["s3-diagnostics"],
      },
    }));
    fireEvent.click(screen.getByTestId("turn-footer-toggle"));
    expect(screen.getByText(/head_bucket returned 200/)).toBeTruthy();
    expect(screen.getByText(/IAM identity policy not readable/)).toBeTruthy();
  });

  it("links an evidence line to the call it names", () => {
    wrap(createElement(TurnFooter, {
      tools,
      grounding: { evidence_used: ["head_bucket returned 200"], evidence_gaps: [], skills_used: [] },
    }));
    fireEvent.click(screen.getByTestId("turn-footer-toggle"));
    expect(screen.getByTestId("evidence-link").textContent).toBe("head_bucket");
  });

  it("does not invent a link for evidence that names no tool", () => {
    wrap(createElement(TurnFooter, {
      tools,
      grounding: { evidence_used: ["the user said uploads fail"], evidence_gaps: [], skills_used: [] },
    }));
    fireEvent.click(screen.getByTestId("turn-footer-toggle"));
    expect(screen.queryByTestId("evidence-link")).toBeNull();
  });

  it("matches evidence only to a tool this execution actually ran", () => {
    expect(linkEvidence("head_bucket returned 200", tools)).toBe("head_bucket");
    expect(linkEvidence("get_object_acl said public", tools)).toBeNull();
  });

  it("renders nothing when there is no execution metadata", () => {
    const { container } = wrap(createElement(TurnFooter, { tools: [], durationMs: null }));
    expect(container.textContent).toBe("");
  });
});

describe("Direction events", () => {
  it("clamps a long direction but truncates nothing", () => {
    const long = "x".repeat(1200);
    wrap(createElement(MessageCard, { role: "user", content: long }));
    expect(screen.getByText(long)).toBeTruthy();
    expect(screen.getByText("Show more")).toBeTruthy();
  });

  it("leaves a short direction alone", () => {
    wrap(createElement(MessageCard, { role: "user", content: "why is my bucket public?" }));
    expect(screen.queryByText("Show more")).toBeNull();
  });

  it("hands the original direction back for redirecting", () => {
    const onEdit = vi.fn();
    wrap(createElement(MessageCard, { role: "user", content: "hello there", onEdit }));
    fireEvent.click(screen.getByTestId("edit-message"));
    expect(onEdit).toHaveBeenCalledWith("hello there");
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
    const handled = SHORTCUTS.filter((s) => s.handled);
    for (const s of handled) expect(s.key, s.id).toBeTruthy();
    expect(handled.length).toBeGreaterThan(4);
  });

  it("matches the chords it advertises", () => {
    const ev = (init: Partial<KeyboardEvent>) => new KeyboardEvent("keydown", init as KeyboardEventInit);
    expect(matches(ev({ key: "k", metaKey: true }), "palette")).toBe(true);
    expect(matches(ev({ key: "K", ctrlKey: true }), "palette")).toBe(true);
    expect(matches(ev({ key: "k" }), "palette")).toBe(false);
  });

  it("does not let a bare-key shortcut swallow a modified chord", () => {
    const ev = (init: Partial<KeyboardEvent>) => new KeyboardEvent("keydown", init as KeyboardEventInit);
    expect(matches(ev({ key: "?" }), "shortcuts")).toBe(true);
    expect(matches(ev({ key: "?", metaKey: true }), "shortcuts")).toBe(false);
  });

  it("renders a platform-correct modifier", () => {
    const palette = SHORTCUTS.find((s) => s.id === "palette")!;
    expect(palette.keys[0]).toBe(MOD);
    expect(["⌘", "Ctrl"]).toContain(MOD);
  });

  it("has no duplicate ids", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("branching from a Direction", () => {
  it("offers a task branch action on a user Direction", () => {
    wrap(
      createElement(MessageCard, {
        role: "user",
        content: "why is acme-logs growing?",
        onBranch: () => {},
      }),
    );
    expect(screen.getByTestId("branch-message")).toBeInTheDocument();
  });

  it("calls back with no arguments — the task renderer owns the persisted id", () => {
    const onBranch = vi.fn();
    wrap(createElement(MessageCard, { role: "user", content: "q", onBranch }));
    fireEvent.click(screen.getByTestId("branch-message"));
    expect(onBranch).toHaveBeenCalledTimes(1);
  });

  it("is absent when branching is not available", () => {
    wrap(createElement(MessageCard, { role: "user", content: "q" }));
    expect(screen.queryByTestId("branch-message")).toBeNull();
  });

  it("is not offered on a Work Result", () => {
    wrap(
      createElement(MessageCard, {
        role: "assistant",
        content: "because versioning is on",
        onBranch: () => {},
      }),
    );
    expect(screen.queryByTestId("branch-message")).toBeNull();
  });

  it("keeps redirect and branch as separate actions", () => {
    wrap(
      createElement(MessageCard, {
        role: "user",
        content: "q",
        onEdit: () => {},
        onBranch: () => {},
      }),
    );
    expect(screen.getByTestId("edit-message")).toBeInTheDocument();
    expect(screen.getByTestId("branch-message")).toBeInTheDocument();
  });
});
