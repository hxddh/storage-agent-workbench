/**
 * The plan card (v1.12) renders the model's `update_plan` list and nothing
 * else: a mark per status, folded to one line once every step is done.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import type { PlanStep } from "../types";
import { PlanCard } from "./PlanCard";

const draw = (node: React.ReactElement) => render(<I18nProvider>{node}</I18nProvider>);

const steps: PlanStep[] = [
  { text: "Confirm the bucket is reachable", status: "completed" },
  { text: "Read the bucket policy", status: "in_progress" },
  { text: "Compare with the IAM statement", status: "pending" },
];

describe("the plan card", () => {
  it("lists each step with its status and the running count", () => {
    draw(<PlanCard steps={steps} live />);
    const card = screen.getByTestId("plan-card");
    expect(card.getAttribute("data-collapsed")).toBe("false");
    expect(screen.getByTestId("plan-head").textContent).toContain("Plan · 1/3");
    const rows = screen.getAllByTestId("plan-step");
    expect(rows.map((row) => row.getAttribute("data-status"))).toEqual(["completed", "in_progress", "pending"]);
    expect(rows[1].textContent).toContain("Read the bucket policy");
    expect(rows[1].querySelector(".working-mark")).toBeTruthy();
    expect(rows[2].querySelector(".plan-step-dot")).toBeTruthy();
    expect(rows[0].querySelector("svg")).toBeTruthy();
  });

  it("folds to one line once every step is completed and the turn is not live", () => {
    const done = steps.map((step) => ({ ...step, status: "completed" as const }));
    draw(<PlanCard steps={done} />);
    const card = screen.getByTestId("plan-card");
    expect(card.getAttribute("data-collapsed")).toBe("true");
    expect(card.textContent).toContain("Plan · 3/3");
    expect(screen.queryAllByTestId("plan-step")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("plan-head"));
    expect(screen.getAllByTestId("plan-step")).toHaveLength(3);
  });

  it("stays open while the turn is live even when every step is completed", () => {
    const done = steps.map((step) => ({ ...step, status: "completed" as const }));
    draw(<PlanCard steps={done} live />);
    expect(screen.getByTestId("plan-card").getAttribute("data-collapsed")).toBe("false");
  });

  it("renders nothing for an empty list — the UI never invents a plan", () => {
    const { container } = draw(<PlanCard steps={[]} />);
    expect(container.textContent).toBe("");
  });
});
