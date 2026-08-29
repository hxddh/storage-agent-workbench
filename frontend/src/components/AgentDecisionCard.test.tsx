import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import type { NextAction } from "../types";
import { ProposalCard } from "./AgentDecisionCard";

const proposal = (requiresConfirmation: boolean): NextAction => ({
  title: "Import discovered access logs",
  reason: "This moves bounded evidence from the discovered logging target.",
  action_type: "import_access_logs",
  requires_confirmation: requiresConfirmation,
  confidence: "high",
  source_run_ids: ["run-1"],
});

afterEach(cleanup);

describe("Agent decision boundary", () => {
  it("renders an ordinary next step without inventing approval", () => {
    render(<I18nProvider><ProposalCard proposal={proposal(false)} onRun={vi.fn()} /></I18nProvider>);
    expect(screen.getByTestId("agent-next-action")).toBeTruthy();
    expect(screen.queryByTestId("agent-decision-required")).toBeNull();
  });

  it("elevates backend-required confirmation into an explicit decision", () => {
    const onRun = vi.fn();
    render(<I18nProvider><ProposalCard proposal={proposal(true)} onRun={onRun} /></I18nProvider>);
    expect(screen.getByTestId("agent-decision-required")).toBeTruthy();
    expect(screen.getByText(/Decision required/i)).toBeTruthy();
    expect(onRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("agent-approve-action"));
    expect(onRun).toHaveBeenCalledTimes(1);
  });
});
