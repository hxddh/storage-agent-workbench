import type { ReactNode } from "react";

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
  if (compact) {
    return (
      <div className={`empty-state ${compact ? "empty-state-compact" : ""}`} data-testid={testId}>
        <div className="empty-state-title">{title}</div>
        <p>{body}</p>
        {action}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 px-6 py-8" data-testid={testId}>
      <div className="text-2xl font-normal tracking-tight text-gray-100" style={{ letterSpacing: "-0.02em", lineHeight: "1.1" }}>{title}</div>
      <p className="max-w-[28rem] text-sm leading-6 text-gray-500">{body}</p>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}
