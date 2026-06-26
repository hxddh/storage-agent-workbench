import { useEffect, useState } from "react";
import {
  createSession,
  getSession,
  getSessionReport,
  listCloudProviders,
  listSessions,
  postSessionMessage,
  prepareSessionAction,
  previewSessionAction,
  refreshSessionSummary,
  type ActionPreviewResult,
} from "../api";
import type { CloudProvider, NextAction, RunType, SessionDetail, SessionSummaryRow } from "../types";
import { Button, Field, Select, TextInput } from "../components/ui";
import { RunDetail } from "../components/RunDetail";
import { EvidenceImportDialog } from "../components/EvidenceImportDialog";
import { ErrorTriagePanel } from "../components/ErrorTriagePanel";
import { NewRunForm } from "./RunsView";

type RunPrefill = { run_type?: RunType; provider_id?: string; bucket?: string };

const STATUS_COLOR: Record<string, string> = {
  pending: "text-gray-400",
  running: "text-amber-400",
  completed: "text-emerald-400",
  failed: "text-red-400",
  not_implemented: "text-gray-500",
};

type Mode =
  | { kind: "list" }
  | { kind: "new" }
  | { kind: "detail"; id: string }
  | { kind: "newRun"; id: string; prefill?: RunPrefill }
  | { kind: "run"; id: string; runId: string };

export function SessionsView() {
  const [mode, setMode] = useState<Mode>({ kind: "list" });

  if (mode.kind === "new") {
    return <NewSessionForm onCancel={() => setMode({ kind: "list" })} onCreated={(id) => setMode({ kind: "detail", id })} />;
  }
  if (mode.kind === "newRun") {
    return (
      <NewRunForm
        sessionId={mode.id}
        initialRunType={mode.prefill?.run_type}
        initialProviderId={mode.prefill?.provider_id}
        initialBucket={mode.prefill?.bucket}
        onCancel={() => setMode({ kind: "detail", id: mode.id })}
        onCreated={(runId) => setMode({ kind: "run", id: mode.id, runId })}
      />
    );
  }
  if (mode.kind === "run") {
    return <RunDetail runId={mode.runId} onBack={() => setMode({ kind: "detail", id: mode.id })} />;
  }
  if (mode.kind === "detail") {
    return (
      <SessionDetailView
        sessionId={mode.id}
        onBack={() => setMode({ kind: "list" })}
        onStartRun={(prefill) => setMode({ kind: "newRun", id: mode.id, prefill })}
        onOpenRun={(runId) => setMode({ kind: "run", id: mode.id, runId })}
      />
    );
  }
  return <SessionsList onNew={() => setMode({ kind: "new" })} onOpen={(id) => setMode({ kind: "detail", id })} />;
}

function SessionsList({ onNew, onOpen }: { onNew: () => void; onOpen: (id: string) => void }) {
  const [sessions, setSessions] = useState<SessionSummaryRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listSessions().then(setSessions).catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="flex flex-1 flex-col overflow-auto bg-canvas">
      <header className="flex items-center justify-between border-b border-edge px-8 py-4">
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Sessions</h1>
          <p className="text-sm text-gray-500">A session is your persistent investigation context — goal, evidence, runs, findings.</p>
        </div>
        <Button variant="primary" onClick={onNew}>+ New Session</Button>
      </header>
      <div className="p-8">
        {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
        <ul className="space-y-2">
          {sessions.map((s) => (
            <li
              key={s.id}
              className="cursor-pointer rounded-lg border border-edge bg-panel p-4 hover:border-gray-600"
              onClick={() => onOpen(s.id)}
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-100">{s.title}</span>
                    <span className="rounded-full border border-edge px-2 py-0.5 text-[11px] text-gray-400">{s.status}</span>
                  </div>
                  {s.goal && <div className="mt-1 text-xs text-gray-500">{s.goal}</div>}
                  <div className="mt-1 text-xs text-gray-600">
                    {s.run_count} run(s) · {s.finding_count} finding(s) · {s.updated_at}
                  </div>
                </div>
              </div>
            </li>
          ))}
          {sessions.length === 0 && <li className="text-sm text-gray-600">No sessions yet. Create one to start an investigation.</li>}
        </ul>
      </div>
    </div>
  );
}

function NewSessionForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [providers, setProviders] = useState<CloudProvider[]>([]);
  const [providerId, setProviderId] = useState("");
  const [bucket, setBucket] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listCloudProviders().then(setProviders).catch(() => undefined);
  }, []);

  const submit = async () => {
    if (!title.trim()) {
      setError("A title is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const s = await createSession({
        title: title.trim(),
        goal: goal.trim() || undefined,
        provider_id: providerId || undefined,
        primary_bucket: bucket.trim() || undefined,
      });
      onCreated(s.id);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-auto bg-canvas">
      <header className="border-b border-edge px-8 py-4">
        <button className="mb-2 text-xs text-gray-500 hover:text-gray-300" onClick={onCancel}>← Back to sessions</button>
        <h1 className="text-lg font-semibold text-gray-100">New Session</h1>
      </header>
      <div className="max-w-xl p-8">
        {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
        <Field label="Title">
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Customer A slow training reads" />
        </Field>
        <Field label="Goal" hint="What are you trying to find out?">
          <textarea
            className="w-full rounded-md border border-edge bg-canvas px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus:border-gray-500 focus:outline-none"
            rows={3}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Diagnose why training data reads from bucket X are slow."
          />
        </Field>
        <Field label="Cloud provider (optional)">
          {providers.length === 0 ? (
            <p className="text-xs text-gray-600">No cloud providers configured.</p>
          ) : (
            <Select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              <option value="">(none)</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({p.provider_type})</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Primary bucket (optional)">
          <TextInput value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="bucket-alpha" />
        </Field>
        <div className="flex gap-2">
          <Button variant="primary" onClick={submit} disabled={busy}>{busy ? "Creating…" : "Create session"}</Button>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

function SessionDetailView({
  sessionId,
  onBack,
  onStartRun,
  onOpenRun,
}: {
  sessionId: string;
  onBack: () => void;
  onStartRun: (prefill?: RunPrefill) => void;
  onOpenRun: (runId: string) => void;
}) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ index: number; result: ActionPreviewResult } | null>(null);
  const [importHandoff, setImportHandoff] = useState<
    { sourceType: "inventory" | "access_log"; accountRunId: string; bucketName: string } | null
  >(null);

  const reload = () => getSession(sessionId).then(setDetail).catch((e) => setError(String(e)));
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const refresh = async () => {
    setBusy(true);
    try {
      await refreshSessionSummary(sessionId);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await postSessionMessage(sessionId, draft.trim());
      setDraft("");
      await reload();
    } catch (e) {
      setError(String(e)); // e.g. clean failure when no model key is configured
    } finally {
      setBusy(false);
    }
  };

  const showReport = async () => {
    const r = await getSessionReport(sessionId);
    setReport(r.content);
  };

  const review = async (index: number, proposal: NextAction) => {
    setError(null);
    try {
      const result = await previewSessionAction(sessionId, proposal);
      setPreview({ index, result });
    } catch (e) {
      setError(String(e));
    }
  };

  const prepareAndOpen = async (proposal: NextAction) => {
    setError(null);
    try {
      const r = await prepareSessionAction(sessionId, proposal);
      if (r.status !== "ready") {
        setError(`Needs input: ${r.missing_inputs.join(", ") || "more context"}`);
        return;
      }
      if (r.open === "new_run") {
        onStartRun({
          run_type: r.prefill.run_type as RunType | undefined,
          provider_id: r.prefill.provider_id,
          bucket: r.prefill.bucket,
        });
      } else if (r.open === "evidence_import") {
        setImportHandoff({
          sourceType: r.prefill.source_type as "inventory" | "access_log",
          accountRunId: r.prefill.account_run_id,
          bucketName: r.prefill.bucket_name,
        });
      } else if (r.open === "session_report") {
        await showReport();
      } else if (r.open === "message_composer") {
        setDraft(r.prefill.question || "");
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const summary = detail?.summary;
  const nextActions = summary?.next_actions ?? [];

  return (
    <div className="flex flex-1 flex-col overflow-auto bg-canvas">
      <header className="border-b border-edge px-8 py-4">
        <button className="mb-2 text-xs text-gray-500 hover:text-gray-300" onClick={onBack}>← Back to sessions</button>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-gray-100">{detail?.title || "Session"}</h1>
            <p className="text-sm text-gray-500">{detail?.goal || "—"}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => onStartRun()}>Start run in this session</Button>
            <Button onClick={refresh} disabled={busy}>Refresh summary</Button>
            <Button variant="ghost" onClick={showReport}>Report</Button>
          </div>
        </div>
      </header>

      <div className="grid flex-1 grid-cols-2 gap-6 p-8">
        <section>
          <h2 className="mb-2 text-sm font-semibold text-gray-200">Session summary</h2>
          <div className="mb-6 rounded-md border border-edge bg-panel p-3 text-xs text-gray-300">
            {summary?.known_facts?.length ? (
              <ul className="space-y-1">
                {summary.known_facts.map((f, i) => (
                  <li key={i}>• {(f.text as string) || ""} <span className="text-gray-600">({String(f.confidence ?? "")})</span></li>
                ))}
              </ul>
            ) : (
              <span className="text-gray-600">No facts yet. Link or run something, then Refresh summary.</span>
            )}
          </div>

          <h2 className="mb-2 text-sm font-semibold text-gray-200">Key findings</h2>
          <ul className="mb-6 space-y-1">
            {(detail?.findings ?? []).map((f) => (
              <li key={f.id} className="text-xs">
                <span className="text-amber-400">[{f.severity}]</span> <span className="text-gray-200">{f.title}</span>{" "}
                <span className="text-gray-500">— {f.interpretation}</span>{" "}
                <span className="text-gray-600">({f.confidence}, run {String(f.source_run_id ?? "").slice(0, 8)})</span>
              </li>
            ))}
            {(detail?.findings ?? []).length === 0 && <li className="text-xs text-gray-600">No findings yet.</li>}
          </ul>

          <h2 className="mb-1 text-sm font-semibold text-gray-200">Next actions (proposals)</h2>
          <p className="mb-2 text-[11px] text-gray-600">These are proposed next steps. Review before starting — nothing runs automatically.</p>
          <ul className="space-y-1">
            {nextActions.map((a, i) => (
              <li key={i} className="rounded-md border border-edge bg-panel p-2 text-xs">
                <div className="text-gray-200">{a.title} <span className="text-gray-600">({a.action_type}, {a.confidence})</span></div>
                {a.reason && <div className="text-gray-500">{a.reason}</div>}
                <div className="mt-1 flex gap-2">
                  <button className="rounded border border-edge px-1.5 py-0.5 text-[10px] text-gray-300 hover:text-gray-100" onClick={() => review(i, a)}>Review</button>
                  <button className="rounded border border-edge px-1.5 py-0.5 text-[10px] text-violet-300 hover:text-violet-200" onClick={() => prepareAndOpen(a)}>Prepare &amp; open</button>
                </div>
                {preview?.index === i && (
                  <div className="mt-2 rounded border border-edge bg-canvas p-2 text-[11px] text-gray-400">
                    <div>action: <span className="text-gray-300">{preview.result.action_type}</span> · {preview.result.ready ? <span className="text-emerald-400">ready</span> : <span className="text-amber-400">needs input</span>}</div>
                    {preview.result.missing_inputs.length > 0 && <div>missing: {preview.result.missing_inputs.join(", ")}</div>}
                    {preview.result.will_create && <div>will open a prefilled run: {String((preview.result.will_create as Record<string, unknown>).run_type ?? "")}</div>}
                    {preview.result.safety_notes.map((n, k) => <div key={k} className="text-gray-500">• {n}</div>)}
                  </div>
                )}
              </li>
            ))}
            {nextActions.length === 0 && <li className="text-xs text-gray-600">No suggestions yet.</li>}
          </ul>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-gray-200">Evidence / Runs timeline</h2>
          <ul className="mb-6 space-y-1">
            {(detail?.runs ?? []).map((r) => (
              <li
                key={r.run_id}
                className="cursor-pointer rounded-md border border-edge bg-panel p-2 text-xs hover:border-gray-600"
                onClick={() => onOpenRun(r.run_id)}
              >
                <span className="font-mono text-gray-300">{r.run_type}</span>{" "}
                <span className={STATUS_COLOR[r.status] ?? "text-gray-400"}>{r.status}</span>
                {r.final_summary && <span className="text-gray-500"> — {r.final_summary}</span>}
              </li>
            ))}
            {(detail?.runs ?? []).length === 0 && <li className="text-xs text-gray-600">No runs yet. Start one in this session.</li>}
          </ul>

          <ErrorTriagePanel
            sessionId={sessionId}
            providerId={detail?.provider_id}
            primaryBucket={detail?.primary_bucket}
            onPrepareProposal={prepareAndOpen}
            onCaseCreated={reload}
          />

          <h2 className="mb-2 text-sm font-semibold text-gray-200">Ask about this session</h2>
          {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
          <div className="mb-3 max-h-64 space-y-2 overflow-auto rounded-md border border-edge bg-sidebar p-3">
            {(detail?.messages ?? []).map((m) => (
              <div key={m.id} className="text-xs">
                <span className={m.role === "user" ? "text-violet-300" : "text-emerald-300"}>{m.role}:</span>{" "}
                <span className="text-gray-300">{m.content}</span>
              </div>
            ))}
            {(detail?.messages ?? []).length === 0 && (
              <div className="text-xs text-gray-600">No messages. Ask the assistant about progress, attribution, or next steps.</div>
            )}
          </div>
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-md border border-edge bg-canvas px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus:border-gray-500 focus:outline-none"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder="Ask about this session…"
            />
            <Button variant="primary" onClick={send} disabled={busy}>Send</Button>
          </div>

          {report && (
            <div className="mt-6">
              <h2 className="mb-2 text-sm font-semibold text-gray-200">Session report</h2>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-edge bg-sidebar p-3 text-[11px] text-gray-300">
                {report}
              </pre>
            </div>
          )}
        </section>
      </div>

      {importHandoff && (
        <EvidenceImportDialog
          accountRunId={importHandoff.accountRunId}
          bucketName={importHandoff.bucketName}
          sourceType={importHandoff.sourceType}
          sessionId={sessionId}
          onClose={() => setImportHandoff(null)}
          onImported={(runId) => {
            setImportHandoff(null);
            onOpenRun(runId);
          }}
        />
      )}
    </div>
  );
}
