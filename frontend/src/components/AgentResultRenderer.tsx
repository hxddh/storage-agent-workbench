import { memo } from "react";
import type { ToolActivity } from "../types";
import { useI18n } from "../i18n";
import { Markdown } from "./Markdown";
import { LiveTrace, WorkingRow } from "./LiveTrace";

export type AgentResultRendererProps = {
  content: string | null;
  toolActivity?: ToolActivity[];
  streaming?: boolean;
  sessionId?: string | null;
};

function stripMetaBlock(text: string): string {
  const index = text.lastIndexOf("```json");
  if (index < 0) return text;
  const rest = text.slice(index);
  const looksMeta = /"(answer|skills_used|evidence_used|next_action_proposals)"/.test(rest)
    || rest.replace(/```json\s*/, "").trimStart().length === 0;
  return looksMeta ? text.slice(0, index).trimEnd() : text;
}

/**
 * Assistant-only renderer for a real Agent Work Result: the execution group
 * (real tool rows, live and durable) followed by the result prose.
 */
export const AgentResultRenderer = memo(function AgentResultRenderer({
  content,
  toolActivity,
  streaming,
  sessionId,
}: AgentResultRendererProps) {
  const { t } = useI18n();
  const shown = streaming ? stripMetaBlock(content || "") : content || "";
  const hasTools = Boolean(toolActivity?.length);

  return (
    <div data-testid="agent-result-renderer">
      {hasTools ? <LiveTrace items={toolActivity as ToolActivity[]} sessionId={sessionId} streaming={streaming && !shown.trim()} /> : null}
      {shown.trim() ? <Markdown text={shown} /> : null}
      {streaming ? (
        shown.trim() ? (
          <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-pulse bg-gray-100 align-middle" aria-hidden />
        ) : !hasTools ? (
          <WorkingRow label={t("task.working")} />
        ) : null
      ) : null}
    </div>
  );
});
