interface Row {
  label: string;
  value: string;
}

/**
 * Displays the sanitized result of a read-only tool call. Error messages are
 * shown exactly as the backend sanitized them — never raw.
 */
export function ToolResultCard({
  title,
  success,
  rows,
  errorCode,
  errorMessage,
}: {
  title: string;
  success: boolean;
  rows: Row[];
  errorCode?: string | null;
  errorMessage?: string | null;
}) {
  return (
    <div className="mt-2 rounded-md border border-edge bg-canvas p-3 text-xs" data-testid="tool-result-card">
      <div className="mb-2 flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${success ? "bg-emerald-400" : "bg-red-500"}`} aria-hidden />
        <span className="font-medium text-gray-200">{title}</span>
        <span className={success ? "text-emerald-400" : "text-red-400"}>
          {success ? "success" : "failed"}
        </span>
      </div>

      {rows.length > 0 && (
        <dl className="space-y-1">
          {rows.map((r) => (
            <div key={r.label} className="flex justify-between gap-4">
              <dt className="text-gray-500">{r.label}</dt>
              <dd className="truncate text-gray-300" title={r.value}>{r.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {!success && (errorCode || errorMessage) && (
        <div className="mt-2 rounded border border-red-900/60 bg-red-950/40 p-2 text-red-300">
          {errorCode && <div className="font-mono">{errorCode}</div>}
          {errorMessage && <div className="mt-0.5">{errorMessage}</div>}
        </div>
      )}
    </div>
  );
}
