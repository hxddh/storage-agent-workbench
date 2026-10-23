import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./composer/Composer";
import { ToastProvider } from "./components/Toast";
import { I18nProvider } from "./i18n";
import { AppProvider, useApp } from "./shell/context";
import type { TaskModel } from "./store/task";
import { initial, reduce } from "./store/task";
import { TaskPage } from "./task/TaskPage";
import { item, resetSeq, snapshot, turn } from "./test/fixtures";
import { ThemeProvider } from "./theme";
import { viewFor } from "./tool/ResultView";

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
  it("reads as one assistant article: receipt, answer, findings, no follow-up", async () => {
    await act(async () => { render(wrap(<TaskPage model={modelOf()} setSnapshot={() => {}} />)); });
    expect(screen.getByTestId("message")).toHaveTextContent("Survey my account");
    expect(screen.getByTestId("turn-body")).toBeInTheDocument();
    expect(screen.getByTestId("run-trace")).toHaveTextContent("1 check");
    const answer = screen.getByTestId("answer");
    expect(answer).toHaveTextContent("full");
    expect(screen.getByTestId("findings")).toHaveTextContent("acme-www is public");
    expect(screen.queryByTestId("next-step")).toBeNull();
    expect(screen.queryByTestId("suggestions")).toBeNull();
    expect(screen.queryByTestId("run-body")).toBeNull();
    // No result/work-log split, no outputs bar.
    expect(screen.queryByText("Work log")).toBeNull();
    expect(screen.queryByTestId("outputs")).toBeNull();
  });

  it("keeps the findings, without a second evidence line or a follow-up", async () => {
    const evidence = [
      { call_id: "a", name: "survey_account", target: "prod", summary: "4 buckets" },
      { call_id: "b", name: "query_estate", target: "prod", summary: "2 issues" },
    ];
    const m = modelOf([turn("t1")], [
      item("t1", "user_message", { text: "Survey" }),
      item("t1", "conclusion", { call_id: "c", findings: [
        { title: "Public bucket", severity: "high" },
        { title: "No encryption", severity: "medium" },
      ], evidence, next_steps: ["Show the fix", "Check again"] }),
      item("t1", "agent_message", { text: "Two things need care." }),
    ]);
    await act(async () => { render(wrap(<TaskPage model={m} setSnapshot={() => {}} />)); });
    expect(screen.getByTestId("findings")).not.toHaveTextContent("checks");
    expect(screen.queryByText("Evidence · 2 checks")).toBeNull();
    expect(screen.queryByTestId("next-step")).toBeNull();
    expect(screen.getByTestId("task-page")).not.toHaveTextContent("Show the fix");
  });

  it("keeps every real call visible while the run is live", async () => {
    const m = modelOf([turn("t1", { status: "running" })], [
      item("t1", "user_message", { text: "Look" }),
      item("t1", "tool_call", { call_id: "a", name: "query_estate", args: {}, target: "prod" }),
      item("t1", "tool_output", { call_id: "a", name: "query_estate", ok: true, summary: "2 buckets" }),
      item("t1", "tool_call", { call_id: "b", name: "list_buckets", args: {}, target: "prod" }),
      item("t1", "tool_progress", { call_id: "b", name: "list_buckets", done: 2, total: 4, unit: "buckets" }),
    ]);
    await act(async () => { render(wrap(<TaskPage model={m} setSnapshot={() => {}} />)); });
    expect(screen.getByTestId("run-trace")).toHaveTextContent("2 checks");
    expect(screen.getByTestId("run-body")).toBeVisible();
    expect(screen.getAllByText("Listing buckets").length).toBeGreaterThan(0);
    expect(screen.getByText("2 of 4 buckets")).toBeInTheDocument();
  });

  it("renders a survey result from the call detail, not from the answer prose", async () => {
    const detail = JSON.stringify({ success: true, coverage: { surveyed: 1 },
      buckets: { columns: ["bucket", "publicly_exposed"], rows: [["acme-www", true]] } });
    const m = modelOf([turn("t1")], [
      item("t1", "user_message", { text: "Survey" }),
      item("t1", "tool_call", { call_id: "a", name: "survey_account", args: {}, target: "prod" }),
      item("t1", "tool_output", { call_id: "a", name: "survey_account", ok: true, summary: "1 bucket", detail }),
      item("t1", "tool_call", { call_id: "b", name: "review_bucket_config", args: {}, target: "acme-www" }),
      item("t1", "tool_output", { call_id: "b", name: "review_bucket_config", ok: true, summary: "checked",
        detail: "{\"bucket\":\"acme-www\",\"sections\":{}}" }),
      item("t1", "agent_message", { text: "One bucket is public." }),
    ]);
    await act(async () => { render(wrap(<TaskPage model={m} setSnapshot={() => {}} />)); });
    expect(screen.getByTestId("tool-table")).toHaveTextContent("acme-www");
    expect(screen.getByTestId("tool-table")).toHaveTextContent("Yes");
  });

  it("renders a repeatable result view only for known shapes", () => {
    expect(viewFor({ name: "survey_account", detail: "{\"buckets\":{\"columns\":[\"bucket\"],\"rows\":[[\"b\"]]}}",
      detailTruncated: false })?.kind).toBe("survey");
    expect(viewFor({ name: "survey_account", detail: "{", detailTruncated: false })).toBeNull();
  });


  it("a follow-up comes after the first turn, oldest first, each with its own answer", async () => {
    const turns = [turn("t1"), turn("t2", { parent_turn_id: "t1" })];
    const m = modelOf(turns, [
      item("t1", "user_message", { text: "First" }),
      item("t1", "agent_message", { text: "First answer." }),
      item("t2", "user_message", { text: "Second" }),
      item("t2", "agent_message", { text: "Second answer." }),
    ]);
    await act(async () => { render(wrap(<TaskPage model={m} setSnapshot={() => {}} />)); });
    const text = screen.getByTestId("task-page").textContent ?? "";
    expect(text.indexOf("First")).toBeLessThan(text.indexOf("First answer."));
    expect(text.indexOf("First answer.")).toBeLessThan(text.indexOf("Second"));
    expect(text.indexOf("Second")).toBeLessThan(text.indexOf("Second answer."));
  });

  it("while a follow-up streams, the earlier answer stays where it is and the new text streams below", async () => {
    const turns = [turn("t1"), turn("t2", { parent_turn_id: "t1", status: "running" })];
    const m = reduce(modelOf(turns, [
      item("t1", "user_message", { text: "First" }),
      item("t1", "agent_message", { text: "First answer." }),
      item("t2", "user_message", { text: "Second" }),
    ]), { type: "delta", turn_id: "t2", segment_id: "s", text: "Streaming…" });
    await act(async () => { render(wrap(<TaskPage model={m} setSnapshot={() => {}} />)); });
    expect(screen.getByTestId("answer")).toHaveTextContent("First answer.");
    expect(screen.getByTestId("live-answer")).toHaveTextContent("Streaming…");
    expect(screen.getAllByTestId("turn")[1]).toContainElement(screen.getByTestId("live-answer"));
  });

  it("offers Continue when a turn was interrupted", async () => {
    const m = modelOf([turn("t1", { status: "interrupted" })], [item("t1", "user_message", { text: "Survey" })]);
    await act(async () => { render(wrap(<TaskPage model={m} setSnapshot={() => {}} />)); });
    expect(screen.getByTestId("attention")).toHaveTextContent("Continue");
  });

  it("shows the versions of an edited message", async () => {
    const turns = [turn("t2b", { parent_turn_id: null })];
    const m = reduce(initial("task-1"), { type: "snapshot", snapshot: snapshot(turns,
      [item("t2b", "user_message", { text: "Reworded" }), item("t2b", "agent_message", { text: "A." })],
      { forks: { "": ["t2", "t2b"] } }) });
    await act(async () => { render(wrap(<TaskPage model={m} setSnapshot={() => {}} />)); });
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
  });
});

describe("the Composer", () => {
  it("has one attach control, not an estate picker", async () => {
    render(wrap(<Composer taskId="task-1" busy={false} />));
    await act(async () => {});
    expect(screen.getByTestId("composer-attach")).toBeInTheDocument();
    expect(screen.queryByTestId("composer-menu")).toBeNull();
    expect(screen.queryByTestId("context-picker")).toBeNull();
  });

  it("sends at rest; adds to the running request with Stop beside it while work is live", async () => {
    const { rerender } = render(wrap(<Composer taskId="task-1" busy={false} />));
    await act(async () => {});
    expect(screen.getByTestId("composer-send")).toHaveAccessibleName("Send");
    expect(screen.queryByTestId("composer-stop")).toBeNull();
    rerender(wrap(<Composer taskId="task-1" busy />));
    expect(screen.getByTestId("composer-send")).toHaveAccessibleName("Add to the request");
    expect(screen.getByTestId("composer-stop")).toBeInTheDocument();
  });

  it("keeps attachments when a message is edited", async () => {
    function Harness() {
      const app = useApp();
      useEffect(() => {
        app.setEditing({ turnId: "t1", parentTurnId: null, text: "Why is acme-www public?",
          attachments: [{ dataset_id: "d1", filename: "access.log", type: "access_log" }] });
      }, []); // eslint-disable-line react-hooks/exhaustive-deps
      return <Composer taskId="task-1" busy={false} />;
    }
    render(wrap(<Harness />));
    await act(async () => {});
    expect(screen.getByTestId("kept-attachment")).toHaveTextContent("access.log");
  });

  it("a file while busy makes the action Send (a new message), never a steer", async () => {
    render(wrap(<Composer taskId="task-1" busy />));
    await act(async () => {});
    const file = new File(["x"], "access.log", { type: "text/plain" });
    fireEvent.change(screen.getByTestId("composer-file"), { target: { files: [file] } });
    expect(screen.getByTestId("composer-send")).toHaveAccessibleName("Send");
    expect(screen.getByText("access.log")).toBeInTheDocument();
  });
});
