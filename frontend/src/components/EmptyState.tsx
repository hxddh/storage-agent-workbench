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
    <div className="flex flex-col gap-4 px-8 py-12" data-testid={testId}>
      <div className="text-3xl font-normal tracking-tight text-gray-100">{title}</div>
      <p className="max-w-[28rem] text-base leading-7 text-gray-500">{body}</p>
      {action ? <div className="pt-2">{action}</div> : null}
    </div>
  );
}
