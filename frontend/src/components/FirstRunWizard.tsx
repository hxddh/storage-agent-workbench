import { Button } from "./ui";

/**
 * One-time first-run overlay shown on a fresh install (no providers yet).
 * Keeps onboarding to a single decision: configure providers now, or start
 * with offline triage. Detailed setup happens in the settings drawer.
 */
export function FirstRunWizard({
  onConfigure,
  onDismiss,
}: {
  onConfigure: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div className="w-[min(560px,94vw)] rounded-2xl border border-edge bg-panel p-7 shadow-xl">
        <div className="text-lg font-semibold text-gray-100">Welcome to Storage Agent Workbench</div>
        <p className="mt-2 text-sm leading-relaxed text-gray-400">
          A local-first agent for diagnosing object storage and S3-compatible systems. Everything runs on your
          machine; secrets stay in the OS keychain.
        </p>
        <ol className="mt-4 space-y-2 text-sm text-gray-300">
          <li>
            <span className="mr-2 text-gray-500">1.</span>
            <span className="text-gray-200">Add a model provider</span> — an LLM API key so the agent can interpret
            evidence and answer questions.
          </li>
          <li>
            <span className="mr-2 text-gray-500">2.</span>
            <span className="text-gray-200">Add a cloud provider</span> — read-only S3 credentials to run live
            diagnostics against a bucket.
          </li>
          <li>
            <span className="mr-2 text-gray-500">3.</span>
            Start an investigation, or paste an S3 error for offline triage — no credentials needed.
          </li>
        </ol>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onDismiss}>Skip for now</Button>
          <Button variant="primary" onClick={onConfigure}>Configure providers</Button>
        </div>
      </div>
    </div>
  );
}
