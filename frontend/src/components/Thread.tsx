import { useEffect, useMemo, useRef, useState } from "react";
import {
  createSession,
  getSession,
  getSessionReport,
  getSessionTriage,
  postSessionMessage,
  prepareSessionAction,
  previewSessionAction,
  submitErrorTriage,
} from "../api";
import type {
  ErrorInputKind,
  NextAction,
  SessionDetail,
  TriageCase,
} from "../types";
import { Button, Select } from "./ui";
import { EvidenceImportDialog } from "./EvidenceImportDialog";
import { NewRunForm } from "../views/RunsView";
import { MessageCard, ProposalCard, RunCard, TriageCard } from "./ThreadCards";

type Item =
  | { kind: "message"; ts: string; role: string; content: string | null; id: string }
  | { kind: "run"; ts: string; data: SessionDetail["runs"][number] }
  | { kind: "triage"; ts: string; data: TriageCase };

type RunPrefill = { run_type?: string; provider_id?: string; bucket?: string };

const propKey = (p: NextAction) => `${p.action_type}::${p.title}`;

const INPUT_KINDS: { value: ErrorInputKind; label: string }[] = [
  { value: "mixed", label: "Paste anything" },
  { value: "error_code", label: "S3 error / XML" },
  { value: "http_response", label: "HTTP response" },
  { value: "sdk_stack_trace", label: "SDK stack trace" },
  { value: "cli_output", label: "CLI output" },
];

export function Thread({
  sessionId,
  onSessionCreated,
  onOpenSettings,
  onChanged,
}: {
  sessionId: string | null;
  onSessionCreated: (id: string) => void;
  onOpenSettings: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [triage, setTriage] = useState<TriageCase[]>([]);
  const [liveProposals, setLiveProposals] = useState<NextAction[]>([]);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"chat" | "triage">("chat");
  const [triageKind, setTriageKind] = useState<ErrorInputKind>("mixed");
  const [planner, setPlanner] = useState<"deterministic" | "agent">("deterministic");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needKey, setNeedKey] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [runStarter, setRunStarter] = useState<RunPrefill | null>(null);
  const [importHandoff, setImportHandoff] = useState<
    { sourceType: "inventory" | "access_log"; accountRunId: string; bucketName: string } | null
  >(null);
  const [report, setReport] = useState<string | null>(null);
  const localId = useRef<string | null>(sessionId);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const reload = async (id: string | null) => {
    if (!id) {
      setDetail(null);
      setTriage([]);
      return;
    }
    const [d, t] = await Promise.all([
      getSession(id).catch(() => null),
      getSessionTriage(id).then((r) => r.cases).catch(() => []),
    ]);
    setDetail(d);
    setTriage(t);
  };

  useEffect(() => {
    localId.current = sessionId;
    setLiveProposals([]);
    setPreviews({});
    setNeedKey(false);
    setError(null);
    reload(sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const m of detail?.messages ?? []) out.push({ kind: "message", ts: m.created_at, role: m.role, content: m.content, id: m.id });
    for (const r of detail?.runs ?? []) out.push({ kind: "run", ts: r.created_at, data: r });
    for (const c of triage) out.push({ kind: "triage", ts: c.created_at || "", data: c });
    return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }, [detail, triage]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items.length, liveProposals.length]);

  const proposals = liveProposals.length ? liveProposals : detail?.summary?.next_actions ?? [];

  const ensureSession = async (seed: string): Promise<string> => {
    if (localId.current) return localId.current;
    const s = await createSession({ title: (seed || "New investigation").slice(0, 80), goal: seed || undefined });
    localId.current = s.id;
    onSessionCreated(s.id);
    return s.id;
  };

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setError(null);
    setNeedKey(false);
    try {
      const id = await ensureSession(t);
      try {
        const r = await postSessionMessage(id, t);
        setLiveProposals(r.proposed_actions || []);
      } catch (e) {
        const msg = String(e);
        if (/model provider|model key|api key/i.test(msg)) setNeedKey(true);
        else setError(msg);
      }
      setText("");
      await reload(id);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const sendTriage = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setError(null);
    try {
      const id = await ensureSession("Error triage");
      await submitErrorTriage({ content: t, input_kind: triageKind, session_id: id, planner_mode: planner });
      setText("");
      await reload(id);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const review = async (p: NextAction) => {
    if (!localId.current) return;
    try {
      const r = await previewSessionAction(localId.current, p);
      const txt = r.ready
        ? `Ready — opens ${r.will_create ? "a new run" : "a flow"}. ${r.safety_notes?.[0] ?? ""}`
        : `Needs input: ${r.missing_inputs.join(", ") || "more context"}.`;
      setPreviews((m) => ({ ...m, [propKey(p)]: txt }));
    } catch (e) {
      setPreviews((m) => ({ ...m, [propKey(p)]: String(e) }));
    }
  };

  const prepare = async (p: NextAction) => {
    if (!localId.current) return;
    try {
      const r = await prepareSessionAction(localId.current, p);
      if (r.status !== "ready") {
        setPreviews((m) => ({ ...m, [propKey(p)]: `Needs input: ${r.missing_inputs.join(", ") || "more context"}.` }));
        return;
      }
      if (r.open === "new_run") {
        setRunStarter({ run_type: r.prefill.run_type, provider_id: r.prefill.provider_id, bucket: r.prefill.bucket });
      } else if (r.open === "evidence_import") {
        setImportHandoff({
          sourceType: r.prefill.source_type as "inventory" | "access_log",
          accountRunId: r.prefill.account_run_id,
          bucketName: r.prefill.bucket_name,
        });
      } else if (r.open === "session_report") {
        const rep = await getSessionReport(localId.current);
        setReport(rep.content);
      } else if (r.open === "message_composer") {
        setMode("chat");
        setText(r.prefill.question || "");
      }
    } catch (e) {
      setError(String(e));
    }
  };

  // --- empty / new thread ---------------------------------------------------
  const isEmpty = !sessionId && items.length === 0;

  return (
    <div className="flex h-full flex-1 flex-col bg-canvas">
      <header className="flex items-center justify-between border-b border-edge px-6 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-gray-100">
            {detail?.title || "New investigation"}
          </div>
          <div className="truncate text-xs text-gray-500">{detail?.goal || "Describe a storage issue to begin."}</div>
        </div>
      </header>

      <div className="flex-1 overflow-auto px-6 py-5">
        <div className="mx-auto max-w-3xl space-y-3">
          {isEmpty && (
            <div className="rounded-xl border border-edge bg-panel p-5 text-sm text-gray-400">
              <div className="mb-1 text-gray-200">Start an investigation</div>
              Describe a storage problem below (e.g. slow reads, 403s, signature errors). The agent will ground its
              answer in evidence and propose safe next steps — you review and confirm before anything runs. You can
              also paste an S3 error for offline triage without any cloud credentials.
            </div>
          )}

          {items.map((it) =>
            it.kind === "message" ? (
              <MessageCard key={it.id} role={it.role} content={it.content} />
            ) : it.kind === "run" ? (
              <RunCard key={it.data.run_id} run={it.data} />
            ) : (
              <TriageCard key={it.data.id} c={it.data} />
            ),
          )}

          {needKey && (
            <div className="rounded-xl border border-amber-900/50 bg-amber-950/20 p-3 text-sm text-amber-200">
              No model API key is configured, so the agent can't interpret yet. Deterministic results still work.
              <div className="mt-2">
                <Button onClick={onOpenSettings}>Add a model API key</Button>
              </div>
            </div>
          )}
          {error && <div className="rounded-xl border border-red-900/50 bg-red-950/20 p-3 text-sm text-red-300">{error}</div>}

          {proposals.length > 0 && (
            <div className="space-y-2 pt-1">
              <div className="text-[11px] uppercase tracking-wide text-gray-500">Suggested next actions</div>
              {proposals.map((p, i) => (
                <ProposalCard
                  key={`${propKey(p)}-${i}`}
                  proposal={p}
                  preview={previews[propKey(p)]}
                  onReview={review}
                  onPrepare={prepare}
                />
              ))}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Composer */}
      <div className="border-t border-edge bg-sidebar px-6 py-3">
        <div className="mx-auto max-w-3xl">
          <div className="mb-2 flex items-center gap-2 text-xs">
            <button
              onClick={() => setMode("chat")}
              className={`rounded-full px-2 py-0.5 ${mode === "chat" ? "bg-canvas text-gray-100" : "text-gray-500 hover:text-gray-300"}`}
            >
              Ask the agent
            </button>
            <button
              onClick={() => setMode("triage")}
              className={`rounded-full px-2 py-0.5 ${mode === "triage" ? "bg-canvas text-gray-100" : "text-gray-500 hover:text-gray-300"}`}
            >
              Triage an error
            </button>
            {mode === "triage" && (
              <>
                <Select value={triageKind} onChange={(e) => setTriageKind(e.target.value as ErrorInputKind)} style={{ width: "auto" }}>
                  {INPUT_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                </Select>
                <Select value={planner} onChange={(e) => setPlanner(e.target.value as "deterministic" | "agent")} style={{ width: "auto" }}>
                  <option value="deterministic">Deterministic</option>
                  <option value="agent">Agent</option>
                </Select>
              </>
            )}
          </div>
          <div className="flex items-end gap-2">
            <textarea
              className="max-h-40 min-h-[44px] flex-1 resize-y rounded-xl border border-edge bg-canvas px-3 py-2.5 text-sm text-gray-100 placeholder:text-gray-600 focus:border-gray-500 focus:outline-none"
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  mode === "chat" ? send() : sendTriage();
                }
              }}
              placeholder={mode === "chat" ? "Describe the storage issue, or ask about this investigation…  (⌘/Ctrl+Enter)" : "Paste an S3 error / HTTP response / stack trace…"}
            />
            <Button variant="primary" onClick={mode === "chat" ? send : sendTriage} disabled={busy}>
              {busy ? "…" : mode === "chat" ? "Send" : "Triage"}
            </Button>
          </div>
        </div>
      </div>

      {/* Run starter (reuses the existing run form, prefilled by the proposal) */}
      {runStarter && (
        <Overlay onClose={() => setRunStarter(null)}>
          <NewRunForm
            sessionId={localId.current ?? undefined}
            initialRunType={runStarter.run_type as never}
            initialProviderId={runStarter.provider_id}
            initialBucket={runStarter.bucket}
            onCancel={() => setRunStarter(null)}
            onCreated={async () => {
              setRunStarter(null);
              await reload(localId.current);
              onChanged();
            }}
          />
        </Overlay>
      )}

      {importHandoff && (
        <EvidenceImportDialog
          accountRunId={importHandoff.accountRunId}
          bucketName={importHandoff.bucketName}
          sourceType={importHandoff.sourceType}
          sessionId={localId.current ?? undefined}
          onClose={() => setImportHandoff(null)}
          onImported={async () => {
            setImportHandoff(null);
            await reload(localId.current);
            onChanged();
          }}
        />
      )}

      {report !== null && (
        <Overlay onClose={() => setReport(null)}>
          <div className="flex h-full flex-col bg-canvas">
            <header className="flex items-center justify-between border-b border-edge px-6 py-3">
              <span className="text-sm font-semibold text-gray-100">Session report</span>
              <Button variant="ghost" onClick={() => setReport(null)}>Close</Button>
            </header>
            <pre className="flex-1 overflow-auto whitespace-pre-wrap p-6 text-[11px] text-gray-300">{report}</pre>
          </div>
        </Overlay>
      )}
    </div>
  );
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex bg-black/50" onClick={onClose}>
      <div className="m-auto h-[88vh] w-[min(900px,92vw)] overflow-hidden rounded-xl border border-edge shadow-xl" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
