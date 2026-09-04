import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { createElement, createRef } from "react";
import { readFileSync } from "node:fs";
import { I18nProvider } from "../i18n";
import { ActiveTaskContext } from "../agent/activeTask";
import { Composer } from "./Composer";
import { WorkedGroup } from "./WorkedGroup";
import type { ToolActivity } from "../types";

afterEach(cleanup);

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

const call = (over: Partial<ToolActivity> = {}): ToolActivity => ({
  id: "c1", tool: "head_bucket", target: "acme-logs", result: "200", ok: true, status: "completed", ...over,
});

describe("v1.17 Codex window", () => {
  it("keeps the ContextMeter off the Composer bar and in the model menu", () => {
    expect(source("./Composer.tsx")).not.toContain("<ContextMeter");
    expect(source("./ModelChip.tsx")).toContain("<ContextMeter />");
    expect(source("./ModelChip.tsx")).toContain("native-model-menu-meter");
  });

  it("paints quiet Find and palette on the title bar, not the document", () => {
    expect(source("../App.tsx")).toContain("titlebar-find");
    expect(source("../App.tsx")).toContain("titlebar-palette");
    expect(source("./TaskDocument.tsx")).not.toContain("task-find-open");
    expect(source("./AgentTaskImplementation.tsx")).not.toContain("start-mark");
    expect(source("../agent/native-document.css")).not.toContain("native-start-mark");
  });

  it("labels a file-while-busy Composer action Delegate, never Steer", () => {
    const file = new File(["a"], "inventory.csv", { type: "text/csv" });
    render(createElement(I18nProvider, null, createElement(ActiveTaskContext.Provider, { value: "t1" }, createElement(Composer, {
      text: "also look at this file",
      setText: () => {},
      attached: file,
      onClearAttachment: () => {},
      onPickFile: () => {},
      onOpenFilePicker: () => {},
      fileRef: createRef<HTMLInputElement>(),
      taRef: createRef<HTMLTextAreaElement>(),
      busy: true,
      offline: false,
      uploading: false,
      onSend: () => {},
      onStop: () => {},
      onSteer: vi.fn(),
    }))));
    const composer = screen.getByTestId("agent-composer");
    expect(within(composer).getByTestId("composer-delegate-queued")).toBeTruthy();
    expect(within(composer).queryByTestId("composer-steer")).toBeNull();
    expect(within(composer).getByRole("textbox").getAttribute("placeholder")).toBe("Describe the storage work to delegate…");
  });

  it("collapses Worked to wall-clock only — count stays inside the group", () => {
    render(createElement(I18nProvider, null, createElement(WorkedGroup, {
      records: [
        call({ id: "a", started_at: "2026-09-01T10:00:00.000Z", finished_at: "2026-09-01T10:00:02.000Z" }),
        call({ id: "b", started_at: "2026-09-01T10:00:01.000Z", finished_at: "2026-09-01T10:00:05.000Z" }),
      ],
    })));
    expect(screen.getByTestId("execution-head").textContent).toBe("Worked for 5.0s");
    expect(screen.getByTestId("execution-head").textContent).not.toMatch(/tool calls/);
  });

  it("keeps the user bubble a quiet fill and the approval card sentence-case", () => {
    const css = source("../agent/native-document.css");
    expect(css).toMatch(/\.turn-user-bubble \{[^}]*border: 0;/);
    expect(css).not.toMatch(/\.turn-user-bubble \{[^}]*box-shadow/);
    expect(css).not.toMatch(/\.approval-card-head \{[^}]*text-transform: uppercase/);
    expect(css).not.toMatch(/\.approval-card \{[^}]*box-shadow/);
    expect(source("./ApprovalCard.tsx")).not.toContain('name="shield"');
    expect(source("../i18n.tsx")).toContain('"approval.eyebrow": "Waiting for approval"');
    expect(source("../i18n.tsx")).toContain('"turn.userLabel": "Direction"');
    expect(source("../i18n.tsx")).toContain('"turn.answerLabel": "Work Result"');
  });

  it("scopes Composer attachments per Task", () => {
    expect(source("./TaskComposerHost.tsx")).toContain("attachments.current");
    expect(source("./TaskComposerHost.tsx")).toContain("attachedRef.current");
  });

  it("finds with the selection token, not yellow", () => {
    const css = source("../index.css");
    expect(css).toContain("::highlight(saw-find)");
    expect(css).toContain("var(--selection)");
    expect(css).not.toContain("250, 204, 21");
    expect(source("../agent/native-shell.css")).toContain("border-radius: var(--radius-md)");
    expect(source("../agent/native-shell.css")).not.toMatch(/\.native-settings-tag \{[^}]*border-radius: 999px/);
  });
});
