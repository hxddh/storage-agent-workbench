import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import { AnswerDocument } from "./AnswerDocument";

const commands = vi.hoisted(() => ({
  openSurface: vi.fn(),
  openRun: vi.fn(),
}));

vi.mock("../workbench/commands", () => ({
  openWorkbenchSurface: commands.openSurface,
  openWorkbenchRun: commands.openRun,
}));

vi.mock("./ThreadCardsImplementation", () => ({
  MessageCard: ({ content }: { content: string | null }) => <div data-testid="legacy-answer">{content}</div>,
}));

afterEach(() => {
  cleanup();
  commands.openSurface.mockClear();
  commands.openRun.mockClear();
});

function renderAnswer(props: Partial<React.ComponentProps<typeof AnswerDocument>> = {}) {
  return render(
    <I18nProvider>
      <AnswerDocument role="assistant" content="## Result\nEvidence-backed answer." {...props} />
    </I18nProvider>,
  );
}

describe("AnswerDocument provenance", () => {
  it("opens the global Evidence surface from persisted evidence references", () => {
    renderAnswer({ referencedEvidenceIds: ["ev-1", "ev-2"] });
    fireEvent.click(screen.getByTestId("answer-open-evidence"));
    expect(commands.openSurface).toHaveBeenCalledWith("evidence");
  });

  it("opens the exact Run when the answer references one auditable execution", () => {
    renderAnswer({ referencedRunIds: ["run-7"] });
    fireEvent.click(screen.getByTestId("answer-open-runs"));
    expect(commands.openRun).toHaveBeenCalledWith("run-7");
    expect(commands.openSurface).not.toHaveBeenCalledWith("runs");
  });

  it("opens the Runs surface when provenance spans several executions", () => {
    renderAnswer({ referencedRunIds: ["run-7", "run-8"] });
    fireEvent.click(screen.getByTestId("answer-open-runs"));
    expect(commands.openSurface).toHaveBeenCalledWith("runs");
    expect(commands.openRun).not.toHaveBeenCalled();
  });

  it("does not add review chrome while an answer is still streaming", () => {
    renderAnswer({ streaming: true, referencedEvidenceIds: ["ev-1"], referencedRunIds: ["run-7"] });
    expect(screen.queryByTestId("answer-references")).toBeNull();
  });
});
