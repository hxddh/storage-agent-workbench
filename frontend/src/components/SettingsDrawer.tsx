import { ProvidersView } from "../views/ProvidersView";
import { Button } from "./ui";

/**
 * Right slide-over for setup. Embeds the existing model + cloud provider CRUD
 * (Providers view) so credential management lives in one place, inline with the
 * thread rather than as a separate top-level page.
 */
export function SettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="flex h-full w-[min(860px,96vw)] flex-col border-l border-edge bg-canvas shadow-pop animate-slide-in-right"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge px-6 py-3.5">
          <span className="text-sm font-semibold text-gray-100">Settings &amp; providers</span>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <ProvidersView onRunCreated={() => onClose()} />
          <div className="border-t border-edge px-8 py-5 text-xs leading-relaxed text-gray-500">
            <div className="mb-1 font-medium text-gray-400">Safety</div>
            Secrets are stored only in the OS keychain — never in the database, logs, reports, or model prompts.
            Cloud access is read-only by default; the agent proposes next actions but never runs anything without
            your confirmation.
          </div>
        </div>
      </div>
    </div>
  );
}
