const RUN_TYPES = [
  "diagnostic",
  "access_log_analysis",
  "inventory_analysis",
  "bucket_config_review",
  "optimization_report",
] as const;

export function MainArea() {
  return (
    <main className="flex flex-1 flex-col overflow-auto bg-canvas">
      <header className="border-b border-edge px-8 py-4">
        <h1 className="text-lg font-semibold text-gray-100">Storage Agent Workbench</h1>
        <p className="text-sm text-gray-500">Analysis Runs</p>
      </header>

      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="mb-3 text-base font-medium text-gray-200">No analysis run selected</div>
          <p className="mb-6 text-sm text-gray-500">
            This is a task-oriented workbench organized around Analysis Runs. Run
            execution, the agent plan, the tool / analysis timeline, metrics, findings,
            and report preview will appear here in later phases.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {RUN_TYPES.map((t) => (
              <span
                key={t}
                className="rounded-full border border-edge px-3 py-1 text-xs text-gray-400"
              >
                {t}
              </span>
            ))}
          </div>
          <p className="mt-6 text-xs text-gray-600">
            Phase 01 — bootstrap only. No agent runtime, S3 tools, or analysis yet.
          </p>
        </div>
      </div>
    </main>
  );
}
