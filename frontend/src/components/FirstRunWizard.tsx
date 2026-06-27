import { Button } from "./ui";

const STEPS = [
  {
    title: "Add a model provider",
    body: "An LLM API key so the agent can interpret evidence and answer questions.",
  },
  {
    title: "Add a cloud provider",
    body: "Read-only S3 credentials to run live diagnostics against a bucket.",
  },
  {
    title: "Start investigating",
    body: "Describe an issue, or paste an S3 error for offline triage — no credentials needed.",
  },
];

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
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm animate-fade-in">
      <div className="w-[min(540px,94vw)] overflow-hidden rounded-2xl border border-edge bg-panel shadow-pop animate-scale-in">
        <div className="border-b border-edge bg-gradient-to-b from-elevated to-panel px-7 pb-5 pt-7">
          <div className="mb-3 grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-accent to-emerald-700 text-lg font-bold text-white shadow-glow">
            S
          </div>
          <div className="text-lg font-semibold text-gray-100">Welcome to Storage Agent Workbench</div>
          <p className="mt-1.5 text-sm leading-relaxed text-gray-400">
            A local-first agent for diagnosing object storage and S3-compatible systems. Everything runs on your
            machine; secrets stay in the OS keychain.
          </p>
        </div>

        <ol className="space-y-1 px-5 py-5">
          {STEPS.map((s, i) => (
            <li key={i} className="flex gap-3 rounded-xl px-2 py-2">
              <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border border-accent/40 bg-accent/10 text-xs font-semibold text-accent-soft">
                {i + 1}
              </span>
              <div>
                <div className="text-sm font-medium text-gray-100">{s.title}</div>
                <div className="text-[13px] leading-relaxed text-gray-500">{s.body}</div>
              </div>
            </li>
          ))}
        </ol>

        <div className="flex justify-end gap-2 border-t border-edge px-5 py-4">
          <Button variant="ghost" onClick={onDismiss}>Skip for now</Button>
          <Button variant="primary" onClick={onConfigure}>Configure providers</Button>
        </div>
      </div>
    </div>
  );
}
