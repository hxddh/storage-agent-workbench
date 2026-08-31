import type { ReactNode } from "react";

/** Quiet empty / gap copy. No decorative illustration. */
export function EmptyState({
  title,
  body,
  action,
  testId,
  compact = false,
}: {
  title: string;
  body: string;
  action?: ReactNode;
  testId?: string;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state ${compact ? "empty-state-compact" : ""}`} data-testid={testId}>
      <div className="empty-state-title">{title}</div>
      <p>{body}</p>
      {action}
    </div>
  );
}
