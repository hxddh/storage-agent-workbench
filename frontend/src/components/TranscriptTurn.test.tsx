/**
 * One renderer for both the live run and the persisted message: user bubble,
 * commentary segments, worked group, inline approval, answer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import type { TurnItem } from "../lib/turnItems";
import type { ToolActivity } from "../types";
import { AgentTurn, UserTurn } from "./TranscriptTurn";

vi.mock("../api", () => ({ getSessionCall: vi.fn() }));

const call = (over: Partial<ToolActivity> = {}): ToolActivity => ({
  id: "c1", tool: "head_bucket", target: "acme-logs", result: "200", ok: true, duration_ms: 40, status: "completed", ...over,
});

afterEach(cleanup);

const draw = (node: React.ReactElement) => render(<I18nProvider>{node}</I18nProvider>);

describe("the user turn", () => {
  it("is a bubble with copy on hover and nothing else", () => {
    draw(<UserTurn content="why does acme-logs return 403?" />);
    expect(screen.getByTestId("turn-user").textContent).toContain("why does acme-logs return 403?");
    expect(screen.getByTestId("copy-direction")).toBeTruthy();
    expect(screen.queryByText(/Direction/)).toBeNull();
  });
});

describe("the Agent turn", () => {
  const items: TurnItem[] = [
    { kind: "message", text: "I will check the bucket policy first." },
    { kind: "tool", record: call() },
    { kind: "tool", record: call({ id: "c2", tool: "get_bucket_policy" }) },
    { kind: "message", text: "The policy is missing a statement; checking the ACL." },
    { kind: "tool", record: call({ id: "c3", tool: "get_bucket_acl" }) },
  ];

  it("renders commentary, one worked group per run of tools, then the answer, in order", () => {
    const { container } = draw(<AgentTurn items={items} answer="The policy omits **s3:ListBucket**." />);
    const order = [...container.querySelectorAll("[data-testid]")]
      .map((el) => el.getAttribute("data-testid"))
      .filter((id) => ["turn-commentary", "worked-group", "turn-answer"].includes(id ?? ""));
    expect(order).toEqual(["turn-commentary", "worked-group", "turn-commentary", "worked-group", "turn-answer"]);
    expect(screen.getByTestId("turn-answer").textContent).toContain("The policy omits s3:ListBucket.");
    expect(screen.getByTestId("work-result").getAttribute("data-streaming")).toBe("false");
    expect(container.querySelector(".native-chip")).toBeNull();
    expect(container.textContent).not.toMatch(/Decision required|Report|Evidence \d/);
  });

  it("folds a finished worked group and opens it on click", () => {
    draw(<AgentTurn items={items.slice(1, 3)} answer="done" />);
    const group = screen.getByTestId("worked-group");
    expect(group.getAttribute("data-expanded")).toBe("false");
    expect(group.textContent).toMatch(/Worked for/);
    fireEvent.click(screen.getByTestId("execution-head"));
    expect(screen.getAllByTestId("worked-row")).toHaveLength(2);
  });

  it("shows a working row with the elapsed time before the first item", () => {
    draw(<AgentTurn items={[]} answer={null} live startedAt={Date.now() - 12_000} />);
    expect(screen.getByTestId("working-row").textContent).toMatch(/Working · 12s/);
  });

  it("says it is waiting for approval while an approval is pending", () => {
    const pending: TurnItem[] = [
      { kind: "tool", record: call({ status: "started", decision_id: "d1" }) },
      { kind: "approval", decision_id: "d1", action_type: "import_access_log", title: "Download logs", reason: null, impact: null, status: "pending" },
    ];
    const onResolve = vi.fn();
    draw(<AgentTurn items={pending} answer={null} live waiting onResolve={onResolve} />);
    expect(screen.getByTestId("approval-card")).toBeTruthy();
    fireEvent.click(screen.getByTestId("approval-allow"));
    expect(onResolve).toHaveBeenCalledWith("d1", "approved", "once");
    expect(screen.queryByTestId("working-row")).toBeNull();
  });

  it("streams the live commentary with a caret and no answer yet", () => {
    const { container } = draw(<AgentTurn items={[{ kind: "message", text: "Checking", live: true }]} answer={null} live />);
    expect(screen.getByTestId("turn-commentary").getAttribute("data-live")).toBe("true");
    expect(container.querySelector(".turn-caret")).toBeTruthy();
    expect(screen.queryByTestId("turn-answer")).toBeNull();
  });

  it("tags a stopped turn", () => {
    draw(<AgentTurn items={[]} answer="partial" live={false} stoppedLabel="Stopped by you" />);
    expect(screen.getByTestId("turn-stopped").textContent).toBe("Stopped by you");
  });
});
