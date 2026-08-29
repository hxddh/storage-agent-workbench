import type { Grounding, ToolActivity, TokenUsage } from "../types";
import { ExecutionSummary, linkEvidence } from "./ExecutionSummary";

export { linkEvidence };

/**
 * Temporary compile boundary while the large AgentTask renderer is migrated.
 * No UI or execution logic lives here: v0.93 renders ExecutionSummary directly.
 * This file is deleted once AgentTaskImplementation stops importing the old name.
 */
export function TurnFooter({
  tools,
  grounding,
  durationMs,
  usage,
  model,
  budgetTokens,
  repeatCallsAvoided,
  sessionId,
  latest,
  onOpenInspector,
}: {
  tools?: ToolActivity[];
  grounding?: Grounding | null;
  durationMs?: number | null;
  usage?: TokenUsage | null;
  model?: string | null;
  budgetTokens?: number | null;
  repeatCallsAvoided?: number | null;
  sessionId?: string | null;
  latest?: boolean;
  onOpenInspector?: () => void;
}) {
  return (
    <ExecutionSummary
      tools={tools}
      grounding={grounding}
      durationMs={durationMs}
      usage={usage}
      model={model}
      budgetTokens={budgetTokens}
      repeatCallsAvoided={repeatCallsAvoided}
      sessionId={sessionId}
      latest={latest}
      onReviewEvidence={onOpenInspector}
    />
  );
}
