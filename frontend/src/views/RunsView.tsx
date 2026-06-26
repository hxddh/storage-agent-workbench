import { useEffect, useRef, useState } from "react";
import {
  createRun,
  listCloudProviders,
  listRuns,
  postRunMessage,
  uploadDataset,
} from "../api";
import type { CloudProvider, RunSummary, RunType } from "../types";
import { Button, Field, Select, TextInput } from "../components/ui";
import { RunDetail } from "../components/RunDetail";

const STATUS_COLOR: Record<string, string> = {
  pending: "text-gray-400",
  running: "text-amber-400",
  completed: "text-emerald-400",
  failed: "text-red-400",
  not_implemented: "text-gray-500",
};

type Mode = { kind: "list" } | { kind: "new" } | { kind: "detail"; runId: string };

export function RunsView() {
  const [mode, setMode] = useState<Mode>({ kind: "list" });

  if (mode.kind === "detail") {
    return <RunDetail runId={mode.runId} onBack={() => setMode({ kind: "list" })} />;
  }
  if (mode.kind === "new") {
    return (
      <NewRunForm
        onCancel={() => setMode({ kind: "list" })}
        onCreated={(runId) => setMode({ kind: "detail", runId })}
      />
    );
  }
  return <RunsList onNew={() => setMode({ kind: "new" })} onOpen={(runId) => setMode({ kind: "detail", runId })} />;
}

function RunsList({ onNew, onOpen }: { onNew: () => void; onOpen: (id: string) => void }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRuns().then(setRuns).catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="flex flex-1 flex-col overflow-auto bg-canvas">
      <header className="flex items-center justify-between border-b border-edge px-8 py-4">
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Analysis Runs</h1>
          <p className="text-sm text-gray-500">Diagnostic, access-log, inventory, and config runs</p>
        </div>
        <Button variant="primary" onClick={onNew}>+ New Run</Button>
      </header>

      <div className="p-8">
        {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
        <ul className="space-y-2">
          {runs.map((r) => (
            <li
              key={r.id}
              className="cursor-pointer rounded-lg border border-edge bg-panel p-4 hover:border-gray-600"
              onClick={() => onOpen(r.id)}
              data-testid="run-row"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-100">{r.title || r.run_type}</span>
                    <span className="rounded-full border border-edge px-2 py-0.5 text-[11px] text-gray-400">
                      {r.run_type}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    {r.provider_id || "—"} · {r.bucket || "—"} · {r.created_at}
                  </div>
                  {r.final_summary && <div className="mt-1 text-xs text-gray-400">{r.final_summary}</div>}
                </div>
                <span className={`text-xs ${STATUS_COLOR[r.status] ?? "text-gray-400"}`}>{r.status}</span>
              </div>
            </li>
          ))}
          {runs.length === 0 && <li className="text-sm text-gray-600">No runs yet. Create one to get started.</li>}
        </ul>
      </div>
    </div>
  );
}

const RUN_TYPE_OPTIONS: { value: RunType; label: string }[] = [
  { value: "diagnostic", label: "Diagnostic" },
  { value: "access_log_analysis", label: "Access log analysis" },
  { value: "inventory_analysis", label: "Inventory analysis" },
  { value: "bucket_config_review", label: "Bucket config review" },
];

function NewRunForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (runId: string) => void }) {
  const [runType, setRunType] = useState<RunType>("diagnostic");
  const [plannerMode, setPlannerMode] = useState<"deterministic" | "agent">("deterministic");
  const [providers, setProviders] = useState<CloudProvider[]>([]);
  const [providerId, setProviderId] = useState("");
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const isAnalysis = runType === "access_log_analysis" || runType === "inventory_analysis";
  const needsBucket = runType === "diagnostic" || runType === "bucket_config_review";
  // Agent mode: diagnostic + config review (Phase 07, tool-calling planner) and
  // the dataset-analysis types (Phase 13, interpretation-only narrator).
  const agentSupported = needsBucket || isAnalysis;
  const agentUnsupportedHere = plannerMode === "agent" && !agentSupported;
  const datasetType = runType === "access_log_analysis" ? "access_log" : "inventory";
  const accept = runType === "inventory_analysis" ? ".csv,.parquet,.pq" : ".log,.jsonl,.json,.txt,.csv";

  useEffect(() => {
    listCloudProviders()
      .then((p) => {
        setProviders(p);
        if (p[0]) setProviderId(p[0].id);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const submitBucket = async () => {
    if (!providerId || !bucket.trim() || !prompt.trim()) {
      setError("Provider, bucket, and prompt are required.");
      return;
    }
    const label = runType === "bucket_config_review" ? "Config review" : "Diagnostic";
    const created = await createRun({
      run_type: runType,
      provider_id: providerId,
      bucket: bucket.trim(),
      prefix: prefix.trim() || undefined,
      user_prompt: prompt.trim(),
      title: `${label}: ${bucket.trim()}`,
      planner_mode: plannerMode,
    });
    await postRunMessage(created.run_id, prompt.trim());
    onCreated(created.run_id);
  };

  const submitAnalysis = async () => {
    const file = fileRef.current?.files?.[0];
    if (!prompt.trim() || !file) {
      setError("A file upload and a prompt are required.");
      return;
    }
    const created = await createRun({
      run_type: runType,
      user_prompt: prompt.trim(),
      title: `${runType}: ${file.name}`,
      planner_mode: plannerMode,
    });
    await uploadDataset(created.run_id, file, datasetType, file.name);
    await postRunMessage(created.run_id, prompt.trim());
    onCreated(created.run_id);
  };

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      if (isAnalysis) await submitAnalysis();
      else await submitBucket();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-auto bg-canvas">
      <header className="border-b border-edge px-8 py-4">
        <button className="mb-2 text-xs text-gray-500 hover:text-gray-300" onClick={onCancel}>
          ← Back to runs
        </button>
        <h1 className="text-lg font-semibold text-gray-100">New Run</h1>
        <p className="text-sm text-gray-500">Read-only diagnostics or local DuckDB analysis</p>
      </header>

      <div className="max-w-xl p-8">
        {error && <p className="mb-3 text-xs text-red-400">{error}</p>}

        <Field label="Run type">
          <Select value={runType} onChange={(e) => setRunType(e.target.value as RunType)}>
            {RUN_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
        </Field>

        <Field
          label="Planner mode"
          hint={
            plannerMode === "agent"
              ? isAnalysis
                ? "Deterministic analysis runs first; the agent then explains the computed metrics. It gets only sanitized aggregates — no raw logs/rows, no SQL, no model/cloud keys. Requires a model provider key."
                : "Agent can plan and explain, but can only call whitelisted read-only tools. Never enter API keys or secrets in the prompt."
              : "Deterministic uses a fixed rule-based plan (default)."
          }
        >
          <Select value={plannerMode} onChange={(e) => setPlannerMode(e.target.value as "deterministic" | "agent")}>
            <option value="deterministic">Deterministic</option>
            <option value="agent">Agent</option>
          </Select>
        </Field>
        {agentUnsupportedHere && (
          <p className="mb-3 text-xs text-amber-400">
            Agent mode is not supported yet for this run type. Use Deterministic, or pick Diagnostic / Bucket config review.
          </p>
        )}

        {needsBucket && (
          <>
            <Field label="Cloud provider">
              {providers.length === 0 ? (
                <p className="text-xs text-gray-600">No cloud providers configured. Add one under Providers first.</p>
              ) : (
                <Select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>{p.name} ({p.provider_type})</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Bucket">
              <TextInput value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="bucket-alpha" />
            </Field>
            <Field label="Prefix (optional)">
              <TextInput value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="logs/" />
            </Field>
          </>
        )}

        {isAnalysis && (
          <Field
            label={runType === "inventory_analysis" ? "Inventory file (CSV / Parquet)" : "Access log file (JSONL / text / CSV)"}
            hint="Uploaded locally and analyzed with DuckDB. No object bodies are fetched."
          >
            <input
              ref={fileRef}
              type="file"
              accept={accept}
              className="block w-full text-xs text-gray-300 file:mr-3 file:rounded-md file:border file:border-edge file:bg-canvas file:px-3 file:py-1.5 file:text-gray-200"
            />
          </Field>
        )}

        <Field label="What do you want to analyze?">
          <textarea
            className="w-full rounded-md border border-edge bg-canvas px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus:border-gray-500 focus:outline-none"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={isAnalysis ? "Summarize errors and hot prefixes." : "Check that credentials work and the bucket is reachable."}
          />
        </Field>

        <div className="flex gap-2">
          <Button
            variant="primary"
            onClick={submit}
            disabled={busy || agentUnsupportedHere || (needsBucket && providers.length === 0)}
          >
            {busy ? "Creating…" : "Create run"}
          </Button>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
