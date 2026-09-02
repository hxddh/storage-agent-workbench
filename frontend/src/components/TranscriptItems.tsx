import { memo, useMemo } from "react";
import { segmentsOf, type TurnItem } from "../lib/turnItems";
import { ApprovalCard, type ApprovalResolution, type ApprovalScope } from "./ApprovalCard";
import { Markdown } from "./Markdown";
import { WorkedGroup } from "./WorkedGroup";

/**
 * The items of one Agent turn BEFORE its answer: commentary segments, one
 * "Worked for …" group per run of tool rows, inline approval cards. Live and
 * durable turns feed the same list (lib/turnItems).
 */
export const TranscriptItems = memo(function TranscriptItems({
  items,
  live = false,
  sessionId,
  startedAt = null,
  onResolve,
  resolvingId = null,
}: {
  items: TurnItem[];
  live?: boolean;
  sessionId?: string | null;
  startedAt?: number | null;
  onResolve?: (decisionId: string, resolution: ApprovalResolution, scope: ApprovalScope) => void;
  resolvingId?: string | null;
}) {
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
            />
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
