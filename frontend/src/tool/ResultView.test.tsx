import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { ResultView, viewFor } from "./ResultView";

const survey = JSON.stringify({
  success: true,
  issues: [{ code: "public_exposure", title: "Publicly exposed", severity: "high", buckets: 1 }],
  coverage: { surveyed: 2, whole_account: true },
  buckets: {
    columns: ["bucket", "publicly_exposed", "encryption_status"],
    common: { encryption_status: "not_configured" },
    rows: [["acme-www", true, "not_configured"], ["acme-logs", false, "not_configured"]],
    rows_omitted: 1,
  },
});

describe("deterministic result views", () => {
  it("renders a survey as a table and coverage, without a repeated issue summary", () => {
    const view = viewFor({ name: "survey_account", detail: survey, detailTruncated: false });
    expect(view?.kind).toBe("survey");
    render(<I18nProvider><ResultView row={{ name: "survey_account", detail: survey, detailTruncated: false }} /></I18nProvider>);
    const table = screen.getByTestId("tool-table");
    expect(table).toHaveTextContent("acme-www");
    expect(table).toHaveTextContent("Yes");
    expect(table).toHaveTextContent("Publicly exposed");
    expect(document.querySelector(".result-issues")).toBeNull();
    expect(screen.getByText(/2 buckets checked/)).toBeInTheDocument();
  });

  it("leaves a truncated detail a gap instead of drawing a partial table", () => {
    const row = { name: "survey_account", detail: survey, detailTruncated: true };
    expect(viewFor(row)).toBeNull();
    render(<I18nProvider><ResultView row={row} /></I18nProvider>);
    expect(screen.queryByTestId("tool-table")).toBeNull();
    expect(screen.getByText(/cut before the window/)).toBeInTheDocument();
  });

  it("does not guess an unknown shape", () => {
    expect(viewFor({ name: "list_objects", detail: JSON.stringify({ keys: ["a"] }), detailTruncated: false })).toBeNull();
  });

  it("renders fix formats and the honest impact verdict", () => {
    const detail = JSON.stringify({
      success: true, fixable: true, issue: "Public", bucket: "acme-www",
      formats: [{ format: "cli", label: "AWS CLI", text: "aws s3api put-public-access-block" }],
      impact: { verdict: "caution", points: [], gaps: [] },
    });
    render(<I18nProvider><ResultView row={{ name: "fix_preview", detail, detailTruncated: false }} /></I18nProvider>);
    expect(screen.getByText("AWS CLI")).toBeInTheDocument();
    expect(screen.getByText("aws s3api put-public-access-block")).toBeInTheDocument();
    expect(screen.getByText(/Check before applying/)).toBeInTheDocument();
  });
});
