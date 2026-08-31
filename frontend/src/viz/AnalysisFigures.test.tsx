import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AnalysisFigures } from "./AnalysisFigures";
import type { TaskProvenance } from "./types";

const empty: TaskProvenance = {
  task_id: "t",
  findings: [],
  figures: [],
  analysis: { cost: null, inventory: null, access_log: null, drift: null },
};

describe("AnalysisFigures", () => {
  it("renders nothing when there is no analysis document", () => {
    const { container } = render(<AnalysisFigures provenance={empty} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders an explicit cost gap instead of a line", () => {
    render(
      <AnalysisFigures
        provenance={{
          ...empty,
          analysis: {
            ...empty.analysis,
            cost: {
              tool: "simulate_storage_cost",
              document: { kind: "gap", gaps: [{ code: "no_inventory", message: "Attach inventory." }] },
              coverage: null,
            },
          },
        }}
      />,
    );
    expect(screen.getByTestId("viz-gap")).toHaveTextContent(/No inventory/i);
    expect(screen.queryByTestId("viz-cost-delta")).toBeNull();
  });

  it("withholds the cost axis when prices are unconfirmed, still plotting class mix", () => {
    render(
      <AnalysisFigures
        provenance={{
          ...empty,
          analysis: {
            ...empty.analysis,
            cost: {
              tool: "simulate_storage_cost",
              document: {
                kind: "simulation",
                timeline: [
                  { day: 0, candidate_class_bytes: { STANDARD: 10 }, candidate_monthly_cost: null },
                  { day: 365, candidate_class_bytes: { STANDARD_IA: 10 }, candidate_monthly_cost: null },
                ],
              },
              coverage: { object_count: 10 },
            },
          },
        }}
      />,
    );
    expect(screen.getByTestId("viz-cost")).toHaveTextContent("STANDARD");
    expect(screen.getByTestId("viz-gap")).toHaveTextContent(/Cost axis withheld/i);
    expect(screen.queryByTestId("viz-cost-delta")).toBeNull();
  });

  it("plots a single emitted horizon as a single column, not a filled area", () => {
    render(
      <AnalysisFigures
        provenance={{
          ...empty,
          analysis: {
            ...empty.analysis,
            cost: {
              tool: "simulate_storage_cost",
              document: {
                kind: "simulation",
                timeline: [{
                  day: 0,
                  candidate_class_bytes: { STANDARD: 1e12 },
                  candidate_monthly_cost: { usd_per_month: 99.99 },
                  baseline_monthly_cost: { usd_per_month: 99.99 },
                }],
                monthly_cost_delta: { usd_per_month_at_365d: 0, estimate: true },
              },
              coverage: { object_count: 1, truncated: true },
            },
          },
        }}
      />,
    );
    expect(screen.getByTestId("viz-cost")).toHaveTextContent("0d");
    expect(screen.getByTestId("viz-cost")).not.toHaveTextContent("365d");
    expect(screen.getByTestId("viz-cost-delta")).toHaveTextContent("estimate");
    expect(screen.getByTestId("viz-coverage")).toHaveTextContent(/Estimate/i);
  });

  it("renders drift gap and independent inventory bars, never a joint matrix", () => {
    render(
      <AnalysisFigures
        provenance={{
          ...empty,
          analysis: {
            ...empty.analysis,
            inventory: {
              tool: "analyze_uploaded_file",
              document: {
                object_count: 3,
                object_age_distribution: [{ bucket: "0-7d", count: 1 }],
                storage_class_distribution: [{ value: "STANDARD", count: 3 }],
              },
              coverage: { unknown_age_ratio: 0.2 },
            },
            drift: {
              tool: "compare_task_drift",
              document: { kind: "gap", code: "no_baseline", message: "No comparable baseline exists." },
              coverage: null,
            },
          },
        }}
      />,
    );
    expect(screen.getByTestId("viz-inventory")).toHaveTextContent(/not observed/i);
    expect(screen.getByTestId("viz-drift")).toHaveTextContent(/No comparable baseline/i);
  });
});
