import type { ReactNode } from "react";

/** Designed empty / gap / waiting surfaces. Never a blank default. */
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
    <div className={`empty-state ${compact ? "py-6" : ""}`} data-testid={testId}>
      <div className="empty-state-art" aria-hidden>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
          <ellipse cx="11.5" cy="9" rx="6.3" ry="1.9" />
          <path d="M5.2 9 7.4 19.3Q11.5 21 15.6 19.3L17.8 9" />
        </svg>
      </div>
      <div className="empty-state-title">{title}</div>
      <p>{body}</p>
      {action}
    </div>
  );
}
