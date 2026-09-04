import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, createRef } from "react";
import { I18nProvider } from "../i18n";
import { ActiveTaskContext } from "../agent/activeTask";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import { SeverityMark } from "./SeverityMark";
import { TaskBanners } from "./TaskBanners";
import { getFindRoots, registerFindRoot, resetFindRoots } from "../lib/findRoots";
import { pickStartHint } from "../agent/startGreeting";
import type { TaskExecution } from "../api";

afterEach(cleanup);

const draw = (node: React.ReactElement) => render(<I18nProvider>{node}</I18nProvider>);

describe("v1.14 document rendering", () => {
  it("offers an outline for two sections", () => {
    draw(<Markdown text={"## Cause\n\na\n\n## Fix\n\nb"} />);
    expect(screen.getByTestId("result-outline").querySelectorAll("a")).toHaveLength(2);
  });

  it("gives duplicate headings unique ids", () => {
    const { container } = draw(<Markdown text={"## Status\n\na\n\n## Status\n\nb"} />);
    const ids = [...container.querySelectorAll("h2")].map((h) => h.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("sizes tables and offers a copy", () => {
    draw(<Markdown text={"| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |"} />);
    expect(screen.getByTestId("table-size").textContent).toMatch(/2 rows/);
    expect(screen.getByTestId("table-copy")).toBeTruthy();
  });
});

describe("v1.14 severity labels", () => {
  it("localizes known severities and passes unknown ones through", () => {
    const { rerender } = draw(<SeverityMark severity="high" />);
    expect(screen.getByText("high")).toBeTruthy();
    rerender(
      <I18nProvider>
        <SeverityMark severity="something-custom" />
      </I18nProvider>,
    );
    expect(screen.getByText("something-custom")).toBeTruthy();
  });
});

describe("v1.14 composer length guard", () => {
  const mount = (text: string, busy = false) => {
    const onSend = vi.fn();
    render(
      createElement(
        I18nProvider,
        null,
        createElement(
          ActiveTaskContext.Provider,
          { value: null },
          createElement(Composer, {
            text,
            setText: () => {},
            attached: null,
            onClearAttachment: () => {},
            onPickFile: () => {},
            onOpenFilePicker: () => {},
            fileRef: createRef<HTMLInputElement>(),
            taRef: createRef<HTMLTextAreaElement>(),
            busy,
            offline: false,
            uploading: false,
            onSend,
            onStop: () => {},
            onSteer: () => {},
          }),
        ),
      ),
    );
    return { onSend };
  };

  it("counts past 75% of the cap and blocks past 100%", () => {
    mount("x".repeat(25_000));
    expect(screen.getByTestId("composer-count").textContent).toContain("25,000");
    cleanup();
    const { onSend } = mount("x".repeat(33_000));
    expect(screen.getByTestId("composer-count").getAttribute("data-over")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Delegate task" }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("uses the tighter steer cap while working", () => {
    mount("x".repeat(9_000), true);
    expect(screen.getByTestId("composer-count").getAttribute("data-over")).toBe("true");
  });
});

describe("v1.14 queued edit", () => {
  const queued = { id: "exec-q", direction: "first draft" } as TaskExecution;
  const mount = (onEditQueued = vi.fn()) => {
    const onCancelQueued = vi.fn();
    render(
      <I18nProvider>
        <TaskBanners
          offline={false}
          needKey={false}
          error={null}
          canRetry={false}
          onRetry={() => {}}
          onOpenSettings={() => {}}
          showResume={false}
          lastExecution={null}
          onResume={() => {}}
          queued={[queued]}
          onCancelQueued={onCancelQueued}
          onEditQueued={onEditQueued}
        />
      </I18nProvider>,
    );
    return { onEditQueued };
  };

  it("edits and saves a queued direction", () => {
    const { onEditQueued } = mount();
    fireEvent.click(screen.getByTestId("queued-direction-edit"));
    const editor = screen.getByTestId("queued-direction-editor") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "second draft" } });
    fireEvent.click(screen.getByTestId("queued-direction-save"));
    expect(onEditQueued).toHaveBeenCalledWith("exec-q", "second draft");
  });

  it("labels a steer follow-up as itself, not a second Direction", () => {
    const followup = { id: "exec-s", direction: "also the ACL", kind: "steer_followup" } as TaskExecution;
    render(
      <I18nProvider>
        <TaskBanners
          offline={false}
          needKey={false}
          error={null}
          canRetry={false}
          onRetry={() => {}}
          onOpenSettings={() => {}}
          showResume={false}
          lastExecution={null}
          onResume={() => {}}
          queued={[followup]}
          onCancelQueued={() => {}}
          onEditQueued={() => {}}
        />
      </I18nProvider>,
    );
    const row = screen.getByTestId("queued-direction");
    expect(row.getAttribute("data-kind")).toBe("steer_followup");
    expect(row.textContent).toContain("Steer follow-up");
  });
});

describe("v1.14 find roots", () => {
  it("registers panel bodies alongside the document", () => {
    resetFindRoots();
    const el = document.createElement("div");
    const release = registerFindRoot(el);
    expect(getFindRoots()).toContain(el);
    release();
    expect(getFindRoots()).not.toContain(el);
    resetFindRoots();
  });
});

describe("v1.15 empty start", () => {
  it("paints no hint line — discoverability lives in the palette", () => {
    // v1.15 removed the rotating "Try:" hint; the alias stays empty.
    expect(pickStartHint("en", new Date(2026, 0, 1))).toBe("");
    expect(pickStartHint("zh", new Date(2026, 0, 1))).toBe("");
  });
});
