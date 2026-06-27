import { useEffect, useState } from "react";
import { createSession, listCloudProviders, listModelProviders } from "../api";
import type { CloudProvider, ModelProvider } from "../types";
import type { NavItem } from "../components/Sidebar";
import { Button } from "../components/ui";

/**
 * Agent-first home / investigation workspace. This is the primary entry point:
 * the user states what they want to investigate (which starts a Session), and
 * the setup they need (model + cloud providers) is surfaced inline rather than
 * hidden behind admin tabs. Runs / Datasets / Reports are supporting views.
 */
export function HomeView({
  onNavigate,
  onOpenSession,
}: {
  onNavigate: (item: NavItem) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [goal, setGoal] = useState("");
  const [models, setModels] = useState<ModelProvider[]>([]);
  const [clouds, setClouds] = useState<CloudProvider[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = () => {
    listModelProviders().then(setModels).catch(() => undefined);
    listCloudProviders().then(setClouds).catch(() => undefined);
  };
  useEffect(reload, []);

  const hasModel = models.some((m) => m.has_api_key);
  const hasCloud = clouds.length > 0;

  const startSession = async (title: string, goalText: string) => {
    setBusy(true);
    setError(null);
    try {
      const s = await createSession({ title: title.slice(0, 80), goal: goalText || undefined });
      onOpenSession(s.id);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const investigate = () => {
    const g = goal.trim();
    if (!g) {
      setError("Describe the storage issue you want to investigate, or start an offline error triage.");
      return;
    }
    startSession(g, g);
  };

  const offlineTriage = () =>
    startSession("Error triage", "Triage a pasted S3 / object-storage error (offline, no cloud credentials needed).");

  return (
    <div className="flex flex-1 flex-col overflow-auto bg-canvas">
      <header className="border-b border-edge px-8 py-5">
        <h1 className="text-lg font-semibold text-gray-100">Storage Agent Workbench</h1>
        <p className="text-sm text-gray-500">
          An agent workbench for object-storage / S3-compatible diagnostics. Describe a problem to start an
          evidence-driven investigation — the agent proposes safe next steps; you review and confirm.
        </p>
      </header>

      <div className="mx-auto w-full max-w-3xl p-8">
        {error && <p className="mb-3 text-xs text-red-400">{error}</p>}

        {/* Task composer */}
        <label className="mb-2 block text-sm font-medium text-gray-200">
          What do you want to investigate?
        </label>
        <textarea
          className="w-full rounded-lg border border-edge bg-panel px-3 py-3 text-sm text-gray-100 placeholder:text-gray-600 focus:border-gray-500 focus:outline-none"
          rows={4}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="e.g. Reads from our training-data bucket are slow and we see intermittent 403s — help me find the cause."
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" onClick={investigate} disabled={busy}>
            {busy ? "Starting…" : "Start investigation"}
          </Button>
          <Button onClick={offlineTriage} disabled={busy}>Start offline error triage</Button>
          <Button variant="ghost" onClick={() => onNavigate("Sessions")}>View sessions</Button>
        </div>
        <p className="mt-2 text-xs text-gray-600">
          Offline error triage works without any cloud credentials — paste an S3 error and get deterministic
          candidate causes and safe next checks.
        </p>

        {/* Setup status */}
        <h2 className="mb-3 mt-8 text-sm font-semibold text-gray-200">Setup</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SetupCard
            title="Model provider (LLM)"
            ok={hasModel}
            okText={`${models.length} configured`}
            todoText="No model API key yet"
            detail="Needed for agent interpretation. The API key is stored in your OS keychain — never in plaintext, logs, or prompts."
            actionLabel={hasModel ? "Manage model providers" : "Configure model provider"}
            onAction={() => onNavigate("Providers")}
          />
          <SetupCard
            title="Cloud provider (S3-compatible)"
            ok={hasCloud}
            okText={`${clouds.length} configured`}
            todoText="No cloud provider yet"
            detail="Needed for account discovery / config review / evidence import. AK/SK stay in your OS keychain; readonly by default."
            actionLabel={hasCloud ? "Manage cloud providers" : "Configure cloud provider"}
            onAction={() => onNavigate("Providers")}
          />
        </div>

        {/* Supporting views */}
        <h2 className="mb-2 mt-8 text-sm font-semibold text-gray-200">Supporting artifacts</h2>
        <div className="flex flex-wrap gap-2 text-xs">
          {(["Runs", "Datasets", "Reports", "Providers"] as NavItem[]).map((n) => (
            <button
              key={n}
              onClick={() => onNavigate(n)}
              className="rounded-full border border-edge px-3 py-1 text-gray-400 hover:border-gray-600 hover:text-gray-200"
            >
              {n}
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs text-gray-600">
          Runs, datasets, and reports are produced by your investigations — they are supporting artifacts, not the
          starting point.
        </p>
      </div>
    </div>
  );
}

function SetupCard({
  title,
  ok,
  okText,
  todoText,
  detail,
  actionLabel,
  onAction,
}: {
  title: string;
  ok: boolean;
  okText: string;
  todoText: string;
  detail: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="rounded-lg border border-edge bg-panel p-4">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm font-medium text-gray-100">{title}</span>
        <span className={`text-[11px] ${ok ? "text-emerald-400" : "text-amber-400"}`}>
          {ok ? `✓ ${okText}` : `• ${todoText}`}
        </span>
      </div>
      <p className="mb-3 text-xs text-gray-500">{detail}</p>
      <Button onClick={onAction}>{actionLabel}</Button>
    </div>
  );
}
