import { useEffect, useState } from "react";
import { listCloudProviders, listModelProviders } from "../api";
import type { CloudProvider, ModelProvider } from "../types";
import type { NavItem } from "./Sidebar";
import { Button } from "./ui";

/**
 * Settings / About page. Summarizes current setup and the safety model. This is
 * a supporting view — the primary entry point is the agent-first Home.
 */
export function MainArea({ onNavigate }: { onNavigate?: (item: NavItem) => void }) {
  const [models, setModels] = useState<ModelProvider[]>([]);
  const [clouds, setClouds] = useState<CloudProvider[]>([]);

  useEffect(() => {
    listModelProviders().then(setModels).catch(() => undefined);
    listCloudProviders().then(setClouds).catch(() => undefined);
  }, []);

  return (
    <main className="flex flex-1 flex-col overflow-auto bg-canvas">
      <header className="border-b border-edge px-8 py-4">
        <h1 className="text-lg font-semibold text-gray-100">Settings</h1>
        <p className="text-sm text-gray-500">Setup status, data location, and the safety model.</p>
      </header>

      <div className="max-w-2xl space-y-6 p-8">
        <section>
          <h2 className="mb-2 text-sm font-semibold text-gray-200">Providers</h2>
          <div className="rounded-md border border-edge bg-panel p-4 text-xs text-gray-400">
            <div className="mb-1">
              Model providers (LLM): <span className="text-gray-200">{models.length}</span>
              {models.some((m) => m.has_api_key) ? "" : " — no API key configured"}
            </div>
            <div className="mb-3">
              Cloud providers (S3-compatible): <span className="text-gray-200">{clouds.length}</span>
            </div>
            {onNavigate && <Button onClick={() => onNavigate("Providers")}>Manage providers</Button>}
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-gray-200">Data &amp; secrets</h2>
          <ul className="list-inside list-disc space-y-1 text-xs text-gray-400">
            <li>App data lives in the OS application-support directory, not the install directory.</li>
            <li>Secrets (model API keys, cloud AK/SK, session tokens) are stored only in the OS keychain.</li>
            <li>SQLite stores only sanitized metadata and <code>keyring://</code> references — never plaintext secrets.</li>
          </ul>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-gray-200">Safety model</h2>
          <ul className="list-inside list-disc space-y-1 text-xs text-gray-400">
            <li>Read-only diagnostics by default; no destructive or mutating S3 operations.</li>
            <li>No generic shell or arbitrary subprocess.</li>
            <li>Next actions are proposals — nothing runs, downloads, or changes config until you confirm.</li>
            <li>No raw logs / inventory rows / secrets are sent to the model; agent context is bounded and sanitized.</li>
            <li>Bundled StorageOps skills are guidance text only — their tools/scripts are never executed.</li>
          </ul>
        </section>

        <p className="text-xs text-gray-600">
          Pre-release build (unsigned). See the project README and docs for install and release notes.
        </p>
      </div>
    </main>
  );
}
