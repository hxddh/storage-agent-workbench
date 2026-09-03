import { memo, useMemo } from "react";
import { useI18n } from "../i18n";
import { fmtTokens } from "../hooks/useCompactContext";
import { segmentsOf, type TurnItem } from "../lib/turnItems";
import { ApprovalCard, type ApprovalResolution, type ApprovalScope } from "./ApprovalCard";
import { Markdown } from "./Markdown";
import { PlanCard } from "./PlanCard";
import { WorkedGroup } from "./WorkedGroup";

/**
 * The items of one Agent turn BEFORE its answer: commentary segments, one
 * "Worked for …" group per run of tool rows, inline approval cards, the plan
 * card (v1.12, only from a `plan` item) and the compaction marker. Live and
 * durable turns feed the same list (lib/turnItems).
 */
export const TranscriptItems = memo(function TranscriptItems({
  items,
  live = false,
  sessionId,
  startedAt = null,
  onResolve,
  resolvingId = null,
  /** Find is open with a runnable query: unfold everything searchable. */
  findActive = false,
}: {
  items: TurnItem[];
  live?: boolean;
  sessionId?: string | null;
  startedAt?: number | null;
  onResolve?: (decisionId: string, resolution: ApprovalResolution, scope: ApprovalScope) => void;
  resolvingId?: string | null;
  findActive?: boolean;
}) {
  const { t } = useI18n();
  const segments = useMemo(() => segmentsOf(items), [items]);
  if (segments.length === 0) return null;
  const lastIndex = segments.length - 1;
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === "commentary") {
          return (
            <div key={`c${index}`} className="turn-commentary" data-testid="turn-commentary" data-live={segment.live ? "true" : "false"}>
              <Markdown text={segment.text} />
              {segment.live ? <span className="turn-caret animate-pulse" aria-hidden /> : null}
            </div>
          );
        }
        if (segment.kind === "worked") {
          return (
            <WorkedGroup
              key={`w${index}`}
              records={segment.records}
              sessionId={sessionId}
              live={live && index === lastIndex}
              startedAt={startedAt}
              forceExpanded={findActive}
            />
          );
        }
        if (segment.kind === "plan") {
          return <PlanCard key={`p${index}`} steps={segment.steps} live={live} />;
        }
        if (segment.kind === "compacted") {
          // An endpoint that reports no usage leaves `before` null (or a measured
          // zero, which says the same): show what the summary now costs, never "0 →".
          const before = segment.before_tokens != null && segment.before_tokens > 0 ? segment.before_tokens : null;
          const after = segment.after_tokens;
          return (
            <div key={`k${index}`} className="context-compacted" data-testid="context-compacted" role="note">
              {before != null && after != null
                ? t("compact.marker", { before: fmtTokens(before), after: fmtTokens(after) })
                : after != null
                  ? t("compact.markerAfter", { after: fmtTokens(after) })
                  : t("compact.markerBare")}
            </div>
          );
        }
        return (
          <ApprovalCard
            key={segment.decision_id}
            item={segment}
            onResolve={onResolve}
            busy={resolvingId === segment.decision_id}
          />
        );
      })}
    </>
  );
});
