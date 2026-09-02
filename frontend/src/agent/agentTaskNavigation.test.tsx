import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import { AgentTaskNavigation } from "./AgentTaskNavigation";
import type { AgentTaskSummary } from "./navigationModel";

const task = (id: string, title: string): AgentTaskSummary => ({
  id,
  title,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  status: "active",
  requires_decision: false,
  task_status: "ready",
} as unknown as AgentTaskSummary);

afterEach(cleanup);

function renderNav(collapsed = false) {
  const actions = { onRename: vi.fn(), onDelete: vi.fn() };
  render(
    <I18nProvider>
      <AgentTaskNavigation
        tasks={[task("a", "acme-logs 403"), task("b", "inventory review")]}
        activeTaskId="a"
        onSelectTask={() => undefined}
        onNew={() => undefined}
        onOpenSettings={() => undefined}
        actions={actions}
        width={260}
        collapsed={collapsed}
        trafficLights={false}
        onToggleCollapse={() => undefined}
        onResize={() => undefined}
      />
    </I18nProvider>,
  );
  return actions;
}

describe("the sidebar", () => {
  it("opens Rename and Delete behind one More control and nothing else", () => {
    const actions = renderNav();
    fireEvent.click(screen.getAllByRole("button", { name: /more actions/i })[0]);
    expect(screen.getByRole("button", { name: "Rename" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(screen.queryByText(/pin|duplicate|archive/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByTestId("task-row-rename").querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "renamed" } });
    fireEvent.blur(input);
    expect(actions.onRename).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), "renamed");
  });

  it("collapsed: renders no toggle of its own so the title bar owns it", () => {
    renderNav(true);
    expect(screen.queryByTestId("task-navigation-toggle")).toBeNull();
    expect(screen.getByTestId("agent-task-navigation").getAttribute("data-collapsed")).toBe("true");
  });
});
