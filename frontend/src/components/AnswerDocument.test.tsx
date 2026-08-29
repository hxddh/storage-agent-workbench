import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import { AnswerDocument } from "./AnswerDocument";

const commands = vi.hoisted(() => ({
  openReview: vi.fn(),
  openExecution: vi.fn(),
}));

vi.mock("../workbench/commands", () => ({
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

function renderResult(props: Partial<React.ComponentProps<typeof AnswerDocument>> = {}) {
  return render(
    <I18nProvider>
      <AnswerDocument role="assistant" content="## Result\nEvidence-backed answer." {...props} />
    </I18nProvider>,
  );
}

describe("Agent Work Result provenance", () => {
  it("opens contextual Evidence review from persisted evidence references", () => {
    renderResult({ referencedEvidenceIds: ["ev-1", "ev-2"] });
    fireEvent.click(screen.getByTestId("answer-open-evidence"));
    expect(commands.openReview).toHaveBeenCalledWith("evidence");
  });

  it("opens the exact execution when the result references one auditable run", () => {
    renderResult({ referencedRunIds: ["run-7"] });
    fireEvent.click(screen.getByTestId("answer-open-runs"));
    expect(commands.openExecution).toHaveBeenCalledWith("run-7");
    expect(commands.openReview).not.toHaveBeenCalledWith("runs");
  });

  it("opens Execution review when provenance spans several runs", () => {
    renderResult({ referencedRunIds: ["run-7", "run-8"] });
    fireEvent.click(screen.getByTestId("answer-open-runs"));
    expect(commands.openReview).toHaveBeenCalledWith("runs");
    expect(commands.openExecution).not.toHaveBeenCalled();
  });

  it("does not add artifact review chrome while execution is still streaming", () => {
    renderResult({ streaming: true, referencedEvidenceIds: ["ev-1"], referencedRunIds: ["run-7"] });
    expect(screen.queryByTestId("answer-references")).toBeNull();
  });
});
