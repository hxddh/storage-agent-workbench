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
import { TurnFooter, linkEvidence } from "./TurnFooter";
import { dayBucket, clampRailWidth, MIN_RAIL_WIDTH, MAX_RAIL_WIDTH } from "./SessionRail";
import { ToastProvider, useToast } from "./Toast";
import { SHORTCUTS, MOD, matches } from "../shortcuts";
import type { ToolActivity } from "../types";

const wrap = (node: React.ReactNode) => render(createElement(I18nProvider, null, node));
const call = (tool: string, result = "ok"): ToolActivity => ({ tool, target: "bucket", result });

describe("the turn footer", () => {
  const tools = [call("list_objects"), call("head_bucket"), call("test_credentials")];

  it("keeps the live trace above the answer WHILE streaming", () => {
    wrap(createElement(MessageCard, { role: "assistant", content: "", toolActivity: tools, streaming: true }));
    // Mid-turn the rows are the progress indicator — hiding them behind a
    // toggle would make a working agent look frozen.
    expect(screen.getByText("list_objects")).toBeTruthy();
  });

  it("drops that trace once the answer has landed", () => {
    wrap(createElement(MessageCard, { role: "assistant", content: "done", toolActivity: tools }));
    // It is not gone — it moved into the footer's single expansion, so the same
    // calls are no longer described twice on opposite sides of the answer.
    expect(screen.queryByText("list_objects")).toBeNull();
  });

  it("states the turn's work once, and expands to the execution order", () => {
    wrap(createElement(TurnFooter, { tools, durationMs: 12400 }));
    const toggle = screen.getByTestId("turn-footer-toggle");
    expect(toggle.textContent).toContain("3");
    expect(screen.queryByText("list_objects")).toBeNull();
    fireEvent.click(toggle);
    const rows = screen.getAllByText(/list_objects|head_bucket|test_credentials/);
    // Execution order, not sorted by name or duration: the sequence is what
    // explains what led to what.
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

  it("shows grounding in the same expansion as the trace it rests on", () => {
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
    // A fabricated citation would be worse than none.
    expect(screen.queryByTestId("evidence-link")).toBeNull();
  });

  it("matches evidence to a tool only when the turn actually ran it", () => {
    expect(linkEvidence("head_bucket returned 200", tools)).toBe("head_bucket");
    expect(linkEvidence("get_object_acl said public", tools)).toBeNull();
  });

  it("renders nothing when there is nothing to report", () => {
    const { container } = wrap(createElement(TurnFooter, { tools: [], durationMs: null }));
    expect(container.textContent).toBe("");
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

/**
 * The shortcut registry (v0.47.0).
 *
 * The help sheet and the key handler used to be two hand-maintained lists.
 * Adding a shortcut to one and forgetting the other produced either an
 * undocumented binding or a documented one that does nothing — a lie the UI
 * tells confidently. Both now read `src/shortcuts.ts`.
 */
describe("shortcut registry", () => {
  it("documents every binding the handler actually installs", () => {
    const handled = SHORTCUTS.filter((s) => s.handled);
    // Each handled row must carry the key the matcher compares against;
    // without it the row renders in the sheet but can never fire.
    for (const s of handled) expect(s.key, s.id).toBeTruthy();
    expect(handled.length).toBeGreaterThan(4);
  });

  it("matches the chords it advertises", () => {
    const ev = (init: Partial<KeyboardEvent>) => new KeyboardEvent("keydown", init as KeyboardEventInit);
    expect(matches(ev({ key: "k", metaKey: true }), "palette")).toBe(true);
    expect(matches(ev({ key: "K", ctrlKey: true }), "palette")).toBe(true);
    // Without the modifier it is just a letter someone is typing.
    expect(matches(ev({ key: "k" }), "palette")).toBe(false);
  });

  it("does not let a bare-key shortcut swallow a modified chord", () => {
    const ev = (init: Partial<KeyboardEvent>) => new KeyboardEvent("keydown", init as KeyboardEventInit);
    expect(matches(ev({ key: "?" }), "shortcuts")).toBe(true);
    // ⌘? belongs to whatever else claims it, not to us.
    expect(matches(ev({ key: "?", metaKey: true }), "shortcuts")).toBe(false);
  });

  it("renders a platform-correct modifier", () => {
    // Showing ⌘ to a Windows user documents a chord they will press and watch
    // fail; the registry resolves it once for everyone.
    const palette = SHORTCUTS.find((s) => s.id === "palette")!;
    expect(palette.keys[0]).toBe(MOD);
    expect(["⌘", "Ctrl"]).toContain(MOD);
  });

  it("has no duplicate ids", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("branching from a message (v0.61.0)", () => {
  it("offers a branch action on a user message", () => {
    // Whole-session fork existed since v0.28.0; what was missing is departing
    // from a POINT in the thread. Both threads survive — the original is the
    // record of what was actually asked, not a draft.
    wrap(
      createElement(MessageCard, {
        role: "user",
        content: "why is acme-logs growing?",
        onBranch: () => {},
      }),
    );
    expect(screen.getByTestId("branch-message")).toBeInTheDocument();
  });

  it("calls back with no arguments — the caller owns the message id", () => {
    const onBranch = vi.fn();
    wrap(createElement(MessageCard, { role: "user", content: "q", onBranch }));
    fireEvent.click(screen.getByTestId("branch-message"));
    expect(onBranch).toHaveBeenCalledTimes(1);
  });

  it("is absent when branching is not available", () => {
    // Mid-turn, or before the session exists: the affordance must not be a
    // button that does nothing.
    wrap(createElement(MessageCard, { role: "user", content: "q" }));
    expect(screen.queryByTestId("branch-message")).toBeNull();
  });

  it("is not offered on an assistant answer", () => {
    // You branch from a question you want to re-ask differently. Offering it on
    // the answer would suggest the answer can be re-run in place, which is what
    // "Ask again" already does.
    wrap(
      createElement(MessageCard, {
        role: "assistant",
        content: "because versioning is on",
        onBranch: () => {},
      }),
    );
    expect(screen.queryByTestId("branch-message")).toBeNull();
  });

  it("keeps edit and branch as separate actions", () => {
    // They are different acts: edit rewrites in place, branch keeps both.
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
