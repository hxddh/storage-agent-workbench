/**
 * v3.0.0 — design system v3: one component library, one accent, a side pane
 * for outputs, starters that only fill the Composer, and figures with a
 * table view.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { I18nProvider } from "../i18n";
import { Badge, Button, IconButton, Segmented } from "./ui";
import { TaskStart } from "./TaskStart";
import { ChartFrame } from "../viz/marks";
import { fuzzyIndices, fuzzyScore } from "./CommandPalette";

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

afterEach(cleanup);

describe("v3.0 component library", () => {
  it("renders variants as data attributes styled only by the ui-* layer", () => {
    render(
      <div>
        <Button variant="primary">Go</Button>
        <Button>Plain</Button>
        <IconButton icon="close" label="Close" />
        <Badge tone="danger">High</Badge>
      </div>,
    );
    expect(screen.getByText("Go").closest("button")).toHaveAttribute("data-variant", "primary");
    expect(screen.getByText("Plain").closest("button")).toHaveAttribute("data-variant", "secondary");
    expect(screen.getByText("Go").closest("button")).toHaveAttribute("type", "button");
    expect(screen.getByRole("button", { name: "Close" })).toHaveClass("ui-icon-btn");
    expect(screen.getByText("High")).toHaveAttribute("data-tone", "danger");
    const css = source("../agent/native-components.css");
    for (const cls of [".ui-btn", ".ui-icon-btn", ".ui-kbd", ".ui-badge", ".ui-dot", ".ui-segmented", ".ui-input", ".ui-label", ".ui-menu"]) {
      expect(css).toContain(cls);
    }
  });

  it("the segmented control reports its value through aria-pressed", () => {
    const onChange = vi.fn();
    render(
      <div>
        <span id="lbl">Theme</span>
        <Segmented labelId="lbl" options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} value="dark" onChange={onChange} />
      </div>,
    );
    expect(screen.getByText("Dark")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByText("Light"));
    expect(onChange).toHaveBeenCalledWith("light");
  });
});

describe("v3.0 tokens", () => {
  const css = source("../index.css");
  it("carries one accent as fill, ink and tint, and a five-step type scale", () => {
    for (const token of ["--accent:", "--accent-text:", "--accent-dim:", "--accent-fg:"]) expect(css).toContain(token);
    for (const size of ["--text-2xs: 0.6875rem", "--text-sm: 0.8125rem", "--text-prose: 0.9375rem", "--text-xl: 1.25rem", "--text-2xl: 1.75rem"]) {
      expect(css).toContain(size);
    }
  });

  it("keeps the validated categorical order and never reuses status colours as series", () => {
    expect(css).toContain("--viz-1: #6c6af2");
    expect(css).toContain("--viz-1: #4f46e5");
    expect(css).not.toMatch(/--viz-\d: var\(--(?:success|warn|danger)\)/);
  });
});

describe("v3.0 empty start", () => {
  it("offers three starters that only fill the Composer", () => {
    const onStarter = vi.fn();
    render(
      <I18nProvider>
        <TaskStart composerNode={<div data-testid="composer" />} banners={null} onStarter={onStarter} />
      </I18nProvider>,
    );
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
    const starters = screen.getAllByTestId("start-starter");
    expect(starters).toHaveLength(3);
    fireEvent.click(starters[0]);
    expect(onStarter).toHaveBeenCalledTimes(1);
    expect(String(onStarter.mock.calls[0][0]).length).toBeGreaterThan(20);
  });
});

describe("v3.0 figures", () => {
  it("every figure can be read as a table", () => {
    render(
      <I18nProvider>
        <ChartFrame title="Mix" testId="viz-x" table={{ columns: ["Horizon", "STANDARD"], rows: [["0d", "1.0 GB"]] }}>
          <svg data-testid="plot" />
        </ChartFrame>
      </I18nProvider>,
    );
    expect(screen.getByTestId("plot")).toBeTruthy();
    fireEvent.click(screen.getByTestId("viz-table-toggle"));
    expect(screen.queryByTestId("plot")).toBeNull();
    expect(screen.getByTestId("viz-table")).toHaveTextContent("1.0 GB");
  });
});

describe("v3.0 palette ranking", () => {
  it("marks exactly the letters the fuzzy score matched", () => {
    expect(fuzzyScore("srvy", "Survey the account")).toBeGreaterThan(0);
    expect(fuzzyIndices("srvy", "Survey the account")).toEqual([0, 2, 3, 5]);
    expect(fuzzyIndices("zz", "Survey")).toEqual([]);
  });
});

describe("v3.0 side pane", () => {
  it("opens outputs beside the Result, resizable and closable", () => {
    const details = source("./TaskDetails.tsx");
    const shell = source("../agent/AgentShell.tsx");
    const app = source("../App.tsx");
    expect(details).toContain('data-testid="task-sidepane"');
    expect(details).toContain('role="separator"');
    expect(details).toContain("PANE_MIN = 352");
    expect(details).toContain('data-testid="sidepane-close"');
    expect(shell).toContain("<TaskInspector");
    expect(app).toContain('data-testid="titlebar-sidepane"');
    expect(app).toContain("aria-pressed={inspectorOpen}");
  });
});
