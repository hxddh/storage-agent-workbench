import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import { AgentTaskNavigation, dayGroups } from "./AgentTaskNavigation";
import type { AgentTaskSummary } from "./navigationModel";

const task = (id: string, title: string, updated_at = new Date().toISOString()): AgentTaskSummary => ({
  id,
  title,
  created_at: "2026-09-01T00:00:00Z",
  updated_at,
  status: "active",
  requires_decision: false,
  task_status: "ready",
} as unknown as AgentTaskSummary);

afterEach(cleanup);

function renderNav(collapsed = false, tasks = [task("a", "acme-logs 403"), task("b", "inventory review")]) {
  const actions = { onRename: vi.fn(), onDelete: vi.fn() };
  const onSearch = vi.fn();
  render(
    <I18nProvider>
      <AgentTaskNavigation
        tasks={tasks}
        activeTaskId="a"
        onSelectTask={() => undefined}
        onNew={() => undefined}
        onSearch={onSearch}
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
  return { actions, onSearch };
}

describe("the sidebar", () => {
  it("opens Rename and Delete behind one More control and nothing else", () => {
    // Distinct timestamps: the list sorts newest-first, and two `new Date()`
    // calls in the same millisecond only stay ordered by sort stability —
    // across a millisecond boundary in CI the rows flip and the wrong More
    // button opens.
    const { actions } = renderNav(false, [
      task("a", "acme-logs 403", "2026-09-02T00:00:00Z"),
      task("b", "inventory review", "2026-09-01T00:00:00Z"),
    ]);
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

  it("groups the list by day: Today, Yesterday, then a dated header", () => {
    const now = new Date();
    const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
    renderNav(false, [
      task("a", "acme-logs 403", now.toISOString()),
      task("b", "inventory review", daysAgo(1)),
      task("c", "lifecycle audit", daysAgo(9)),
    ]);
    const groups = screen.getAllByTestId("task-group");
    expect(groups.map((group) => group.getAttribute("data-group"))).toEqual(["today", "yesterday", expect.stringMatching(/^\d+$/)]);
    expect(groups[0].textContent).toContain("Today");
    expect(groups[1].textContent).toContain("Yesterday");
    // The dated header is locale-formatted, never a raw ISO string.
    expect(groups[2].textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(groups[2].querySelector(".native-sidebar-section")?.textContent).toMatch(/^[A-Z][a-z]+ \d{1,2}$/);
    // Rows still flatten in order for ↑ / ↓.
    expect(screen.getAllByTestId("task-row").map((row) => row.textContent)).toEqual([
      expect.stringContaining("acme-logs 403"),
      expect.stringContaining("inventory review"),
      expect.stringContaining("lifecycle audit"),
    ]);
    expect(screen.queryByText("Tasks")).toBeNull();
  });

  it("paints Search under New task and opens the command palette from the left", () => {
    const { onSearch } = renderNav();
    const search = screen.getByTestId("task-navigation-search");
    expect(search.textContent).toMatch(/search/i);
    fireEvent.click(search);
    expect(onSearch).toHaveBeenCalled();
  });

  it("formats day headers for Chinese and keeps the ordering", () => {
    const now = new Date(2026, 8, 2, 12);
    const groups = dayGroups([
      task("a", "a", new Date(2026, 8, 2, 8).toISOString()),
      task("b", "b", new Date(2026, 8, 1, 23).toISOString()),
      task("c", "c", new Date(2026, 7, 20, 9).toISOString()),
      task("d", "d", new Date(2025, 11, 31, 9).toISOString()),
    ], "zh", now);
    expect(groups.map((group) => group.label)).toEqual(["今天", "昨天", "8月20日", "2025年12月31日"]);
    expect(dayGroups([task("d", "d", new Date(2025, 11, 31, 9).toISOString())], "en", now)[0].label).toBe("December 31, 2025");
  });

  it("keeps Settings alone in the footer, never a policy fact or a switch", () => {
    renderNav();
    // v1.15 — the read-only footer fact is gone (it clipped to "之读");
    // the policy lives in Settings → Safety.
    expect(screen.queryByTestId("sidebar-read-only")).toBeNull();
    expect(screen.getByTestId("task-navigation-settings")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
