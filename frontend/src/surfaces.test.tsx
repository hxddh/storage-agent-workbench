import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./composer/Composer";
import { ToastProvider } from "./components/Toast";
import { I18nProvider } from "./i18n";
import { AppProvider } from "./shell/context";
import type { TaskModel } from "./store/task";
import { initial, reduce } from "./store/task";
import { TaskPage } from "./task/TaskPage";
import { item, resetSeq, snapshot, turn } from "./test/fixtures";
import { ThemeProvider } from "./theme";

const model = [{ id: "m1", name: "Fake", kind: "openai-compatible", base_url: null, model: "gpt-5", api_style: "chat",
  has_api_key: false, context_window: null, max_output_tokens: null, reasoning_effort: null, reasoning_capable: false, active: true }];

beforeEach(() => {
  resetSeq();
  localStorage.setItem("saw.lang", "en");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = url.includes("/providers/models") ? model : url.includes("/providers/clouds") ? [] : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});

function wrap(children: ReactNode) {
  return (
    <ThemeProvider><I18nProvider><ToastProvider><AppProvider>{children}</AppProvider></ToastProvider></I18nProvider></ThemeProvider>
  );
}

function modelOf(turns = [turn("t1")], items = [
  item("t1", "user_message", { text: "Survey my account" }),
  item("t1", "agent_message", { text: "Looking." }),
  item("t1", "tool_call", { call_id: "a", name: "survey_account", args: {}, target: "prod" }),
  item("t1", "tool_output", { call_id: "a", name: "survey_account", ok: true, summary: "4 buckets" }),
  item("t1", "conclusion", { call_id: "c", answer: "One bucket is public.", next_steps: ["Show the fix"],
    findings: [{ title: "acme-www is public", severity: "high" }] }),
  item("t1", "agent_message", { text: "The **full** answer." }),
]): TaskModel {
  return reduce(initial("task-1"), { type: "snapshot", snapshot: snapshot(turns, items) });
}

describe("the task page", () => {
  it("leads with the recorded conclusion, then findings, next steps and the full answer", async () => {
    await act(async () => { render(wrap(<TaskPage model={modelOf()} setSnapshot={() => {}} />)); });
    const answer = screen.getByTestId("result-answer");
    expect(answer).toHaveTextContent("One bucket is public.");
    expect(screen.getByText("acme-www is public")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getByText("full")).toBeInTheDocument();
    // One Direction: no Work log, and its work sits in the Result.
    expect(screen.queryByText("Work log")).toBeNull();
    expect(screen.getByText(/Worked for/)).toBeInTheDocument();
    expect(screen.getByTestId("outputs")).toHaveTextContent("Evidence");
  });

  it("a later Direction moves the first into the Work log, folded to one line", async () => {
    const turns = [turn("t1"), turn("t2", { parent_turn_id: "t1" })];
    const m = modelOf(turns, [
      item("t1", "user_message", { text: "First" }),
      item("t1", "conclusion", { call_id: "c", answer: "First answer.", findings: [], next_steps: [] }),
      item("t1", "agent_message", { text: "First long answer." }),
      item("t2", "user_message", { text: "Second" }),
      item("t2", "agent_message", { text: "Second answer." }),
    ]);
    await act(async () => { render(wrap(<TaskPage model={m} setSnapshot={() => {}} />)); });
    expect(screen.getByText("Work log")).toBeInTheDocument();
    expect(screen.getByText("First answer.")).toBeInTheDocument(); // the fold reads the conclusion
    expect(screen.getByText("The latest answer is the Result above.")).toBeInTheDocument();
  });

  it("offers Resume when the last Direction was interrupted", async () => {
    const m = modelOf([turn("t1", { status: "interrupted" })], [item("t1", "user_message", { text: "Survey" })]);
    await act(async () => { render(wrap(<TaskPage model={m} setSnapshot={() => {}} />)); });
    expect(screen.getByTestId("attention")).toHaveTextContent("Resume");
  });

  it("shows the versions of a forked Direction", async () => {
    const turns = [turn("t2b", { parent_turn_id: null })];
    const m = reduce(initial("task-1"), { type: "snapshot", snapshot: snapshot(turns,
      [item("t2b", "user_message", { text: "Reworded" }), item("t2b", "agent_message", { text: "A." })],
      { forks: { "": ["t2", "t2b"] } }) });
    await act(async () => { render(wrap(<TaskPage model={m} setSnapshot={() => {}} />)); });
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
  });
});

describe("the Composer", () => {
  it("delegates at rest; steers with Stop beside it while work is live", async () => {
    const { rerender } = render(wrap(<Composer taskId="task-1" busy={false} />));
    await act(async () => {});
    expect(screen.getByTestId("composer-send")).toHaveTextContent("Delegate");
    expect(screen.queryByTestId("composer-stop")).toBeNull();
    rerender(wrap(<Composer taskId="task-1" busy />));
    expect(screen.getByTestId("composer-send")).toHaveTextContent("Steer");
    expect(screen.getByTestId("composer-stop")).toBeInTheDocument();
  });

  it("a file while busy makes the action Delegate, never Steer", async () => {
    render(wrap(<Composer taskId="task-1" busy />));
    await act(async () => {});
    const file = new File(["x"], "access.log", { type: "text/plain" });
    fireEvent.change(screen.getByTestId("composer-file"), { target: { files: [file] } });
    expect(screen.getByTestId("composer-send")).toHaveTextContent("Delegate");
    expect(screen.getByText("access.log")).toBeInTheDocument();
  });
});
