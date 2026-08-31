import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import { AgentTaskResult } from "./AgentTaskResult";

const commands = vi.hoisted(() => ({
  openReview: vi.fn(),
  openExecution: vi.fn(),
}));

vi.mock("../agent/commands", () => ({
  openAgentReview: commands.openReview,
  openAgentExecution: commands.openExecution,
}));

vi.mock("./AgentResultRenderer", () => ({
  AgentResultRenderer: ({ content }: { content: string | null }) => <div data-testid="agent-result-renderer">{content}</div>,
}));

afterEach(() => {
  cleanup();
  commands.openReview.mockClear();
  commands.openExecution.mockClear();
});

function renderResult(props: Partial<React.ComponentProps<typeof AgentTaskResult>> = {}) {
  return render(
    <I18nProvider>
      <AgentTaskResult role="assistant" content="## Result\nEvidence-backed result." {...props} />
    </I18nProvider>,
  );
}

describe("Agent Work Result provenance", () => {
  it("opens contextual Evidence review from persisted evidence references", () => {
    renderResult({ referencedEvidenceIds: ["ev-1", "ev-2"] });
    fireEvent.click(screen.getByTestId("work-result-open-evidence"));
    expect(commands.openReview).toHaveBeenCalledWith("evidence");
  });

  it("opens the exact execution when the result references one auditable execution", () => {
    renderResult({ referencedRunIds: ["run-7"] });
    fireEvent.click(screen.getByTestId("work-result-open-execution"));
    expect(commands.openExecution).toHaveBeenCalledWith("run-7");
    expect(commands.openReview).not.toHaveBeenCalledWith("execution");
  });

  it("opens Execution review when provenance spans several executions", () => {
    renderResult({ referencedRunIds: ["run-7", "run-8"] });
    fireEvent.click(screen.getByTestId("work-result-open-execution"));
    expect(commands.openReview).toHaveBeenCalledWith("execution");
    expect(commands.openExecution).not.toHaveBeenCalled();
  });

  it("opens the task Report artifact from the latest Work Result", () => {
    renderResult({ hasReport: true });
    fireEvent.click(screen.getByTestId("work-result-open-report"));
    expect(commands.openReview).toHaveBeenCalledWith("report");
  });

  it("does not paint a Report control when the task has no report to open", () => {
    renderResult();
    expect(screen.queryByTestId("work-result-open-report")).toBeNull();
  });

  it("does not add artifact review chrome while execution is streaming", () => {
    renderResult({ streaming: true, referencedEvidenceIds: ["ev-1"], referencedRunIds: ["run-7"] });
    expect(screen.queryByTestId("work-result-artifacts")).toBeNull();
  });

  it("renders a user contribution as Direction rather than a message bubble", () => {
    render(
      <I18nProvider>
        <AgentTaskResult role="user" content="Check the lifecycle policy and explain the impact." />
      </I18nProvider>,
    );
    expect(screen.getByTestId("direction-event")).toBeInTheDocument();
    expect(screen.queryByTestId("work-result")).toBeNull();
  });
});
