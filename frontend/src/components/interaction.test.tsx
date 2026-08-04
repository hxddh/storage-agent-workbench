/**
 * v0.46.0 interaction rules.
 *
 * These pin the decisions that are easy to "fix" back into something worse:
 * the tool trace must stay open while streaming (the rows ARE the progress
 * indicator) and closed afterwards (the answer is what you came for); the rail's
 * day buckets must follow calendar midnights rather than elapsed hours; and the
 * toast surface must not auto-dismiss a failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { createElement } from "react";
import { I18nProvider } from "../i18n";
import { MessageCard } from "./ThreadCards";
import { dayBucket, clampRailWidth, MIN_RAIL_WIDTH, MAX_RAIL_WIDTH } from "./SessionRail";
import { ToastProvider, useToast } from "./Toast";
import type { ToolActivity } from "../types";

const wrap = (node: React.ReactNode) => render(createElement(I18nProvider, null, node));
const call = (tool: string, result = "ok"): ToolActivity => ({ tool, target: "bucket", result });

describe("tool trace", () => {
  const tools = [call("list_objects"), call("head_bucket"), call("test_credentials")];

  it("stays open while the turn is streaming", () => {
    wrap(createElement(MessageCard, { role: "assistant", content: "", toolActivity: tools, streaming: true }));
    // Mid-turn the rows are the progress indicator — hiding them behind a
    // toggle would make a working agent look frozen.
    expect(screen.getByText("list_objects")).toBeTruthy();
    expect(screen.queryByTestId("tool-trace-toggle")).toBeNull();
  });

  it("collapses to a summary once the answer has landed", () => {
    wrap(createElement(MessageCard, { role: "assistant", content: "done", toolActivity: tools }));
    expect(screen.queryByText("list_objects")).toBeNull();
    const toggle = screen.getByTestId("tool-trace-toggle");
    expect(toggle.textContent).toContain("3");
    fireEvent.click(toggle);
    expect(screen.getByText("list_objects")).toBeTruthy();
  });

  it("surfaces failures in the collapsed summary", () => {
    // A failed call must be visible WITHOUT expanding — otherwise collapsing
    // the trace would hide the one thing worth noticing.
    wrap(createElement(MessageCard, {
      role: "assistant",
      content: "done",
      toolActivity: [call("head_bucket", "error: AccessDenied"), call("list_objects")],
    }));
    expect(screen.getByTestId("tool-trace-toggle").textContent).toMatch(/1/);
  });
});

describe("user messages", () => {
  it("clamps a long paste but truncates nothing", () => {
    const long = "x".repeat(1200);
    wrap(createElement(MessageCard, { role: "user", content: long }));
    // The full text is in the DOM; only its height is constrained.
    expect(screen.getByText(long)).toBeTruthy();
    expect(screen.getByText("Show more")).toBeTruthy();
  });

  it("leaves a short message alone", () => {
    wrap(createElement(MessageCard, { role: "user", content: "why is my bucket public?" }));
    expect(screen.queryByText("Show more")).toBeNull();
  });

  it("hands the original text back for editing", () => {
    const onEdit = vi.fn();
    wrap(createElement(MessageCard, { role: "user", content: "hello there", onEdit }));
    fireEvent.click(screen.getByTestId("edit-message"));
    // Editing seeds the composer; it must never mutate the persisted message,
    // which is part of the audit record.
    expect(onEdit).toHaveBeenCalledWith("hello there");
  });
});

describe("rail day buckets", () => {
  // Fixed "now": Thursday 2026-08-06, 09:00 local.
  const now = new Date(2026, 7, 6, 9, 0, 0);
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).toISOString();

  it("uses calendar midnights, not elapsed hours", () => {
    // 23 hours before 09:00 is 10:00 YESTERDAY. An elapsed-time bucket would
    // call that "today"; a person would not.
    expect(dayBucket(at(2026, 7, 5, 10), now)).toBe("yesterday");
    expect(dayBucket(at(2026, 7, 6, 0), now)).toBe("today");
  });

  it("buckets the rest by calendar distance", () => {
    expect(dayBucket(at(2026, 7, 2), now)).toBe("week");
    expect(dayBucket(at(2026, 6, 20), now)).toBe("month");
    expect(dayBucket(at(2026, 3, 1), now)).toBe("older");
  });

  it("treats a future or unparseable timestamp sanely", () => {
    // Clock skew must not sink a fresh chat to the bottom of the list.
    expect(dayBucket(at(2026, 7, 9), now)).toBe("today");
    expect(dayBucket("not-a-date", now)).toBe("older");
  });
});

describe("rail width", () => {
  it("stays within bounds that keep both panes usable", () => {
    expect(clampRailWidth(10)).toBe(MIN_RAIL_WIDTH);
    expect(clampRailWidth(9999)).toBe(MAX_RAIL_WIDTH);
    expect(clampRailWidth(300.4)).toBe(300);
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
    // A failure the user blinked past is a failure they will hit again.
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

  it("caps the stack so a failing loop cannot paper over the app", () => {
    mount();
    for (let i = 0; i < 9; i++) fireEvent.click(screen.getByText("err"));
    expect(screen.getAllByText("it broke").length).toBe(4);
  });
});
