import { useEffect, useState } from "react";
import { listCloudProviders, listModelProviders } from "../api";
import type { CloudProvider, ModelProvider } from "../types";

/**
 * Right-hand context panel: live setup + safety state. Reflects whether the
 * model and cloud providers are configured so the user always knows what is set
 * up and what the active safety posture is. No secrets are shown.
 */
export function ContextPanel() {
  const [models, setModels] = useState<ModelProvider[]>([]);
  const [clouds, setClouds] = useState<CloudProvider[]>([]);

  useEffect(() => {
    const load = () => {
      listModelProviders().then(setModels).catch(() => undefined);
      listCloudProviders().then(setClouds).catch(() => undefined);
    };
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  const hasModel = models.some((m) => m.has_api_key);
  const cloud = clouds[0];

  const rows: { label: string; value: string; ok?: boolean }[] = [
    { label: "Model provider", value: hasModel ? `${models.length} configured` : "not configured", ok: hasModel },
    { label: "Cloud provider", value: clouds.length ? `${clouds.length} configured` : "not configured", ok: clouds.length > 0 },
    { label: "Endpoint", value: cloud?.endpoint_url || "—" },
    { label: "Region", value: cloud?.region || "—" },
    { label: "Mode", value: cloud?.mode || "readonly", ok: (cloud?.mode || "readonly") === "readonly" },
  ];

  return (
    <aside className="w-72 shrink-0 overflow-auto border-l border-edge bg-panel">
      <div className="border-b border-edge px-4 py-4">
        <div className="text-sm font-semibold text-gray-100">Context</div>
        <div className="text-xs text-gray-500">Setup &amp; safety state</div>
      </div>

      <dl className="px-4 py-3">
        {rows.map((f) => (
          <div key={f.label} className="flex items-center justify-between border-b border-edge/60 py-2">
            <dt className="text-xs text-gray-500">{f.label}</dt>
            <dd className={`text-xs font-medium ${f.ok === undefined ? "text-gray-300" : f.ok ? "text-emerald-400" : "text-amber-400"}`}>
              {f.value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="px-4 py-3 text-xs text-gray-600">
        <p className="mb-2">
          Read-only by default; no destructive S3 operations. Next actions are proposals you confirm.
        </p>
        <p>
          Secrets (model API key, cloud AK/SK) are stored in the OS keychain — never in plaintext, logs, reports,
          or model prompts.
        </p>
      </div>
    </aside>
  );
}
