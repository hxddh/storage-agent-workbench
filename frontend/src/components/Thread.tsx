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

const EXAMPLES = [
  "Reads from my bucket are slow",
  "Getting 403 AccessDenied on uploads",
  "SignatureDoesNotMatch errors",
  "Review my bucket's security & lifecycle",
];

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
  const taRef = useRef<HTMLTextAreaElement | null>(null);

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
    // Thread is no longer remounted per session (App does not key it by id), so
    // reset all per-session UI state here when the active session changes.
    localId.current = sessionId;
    setLiveProposals([]);
    setPreviews({});
    setNeedKey(false);
    setError(null);
    setText("");
    setMode("chat");
    setRunStarter(null);
    setImportHandoff(null);
    setReport(null);
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

  // Auto-grow the composer (and shrink back when cleared). When empty we pin a
  // single line — measuring scrollHeight would otherwise include the wrapping
  // placeholder (Chrome counts it) and leave the box several lines tall.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (!text) {
      ta.style.height = "36px";
      return;
    }
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [text, mode]);

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
      <header className="flex items-center justify-between border-b border-edge px-6 py-3.5">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-gray-100">
            {detail?.title || "New investigation"}
          </div>
          <div className="truncate text-xs text-gray-500">{detail?.goal || "Describe a storage issue to begin."}</div>
        </div>
      </header>

      <div className="flex-1 overflow-auto px-6 py-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {isEmpty && (
            <div className="flex flex-col items-center py-12 text-center animate-fade-in-up">
              <div className="mb-4 grid h-12 w-12 place-items-center rounded-2xl border border-edge-strong bg-elevated text-accent">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round">
                  <path d="M12 2 2 7l10 5 10-5-10-5z" />
                  <path d="M2 17l10 5 10-5" />
                  <path d="M2 12l10 5 10-5" />
                </svg>
              </div>
              <div className="text-base font-medium text-gray-100">Start an investigation</div>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-gray-500">
                Describe a storage problem and the agent grounds its answer in evidence, then proposes safe next steps —
                you review and confirm before anything runs. Or paste an S3 error for offline triage, no credentials needed.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => {
                      setMode("chat");
                      setText(ex);
                      taRef.current?.focus();
                    }}
                    className="rounded-full border border-edge bg-panel px-3 py-1.5 text-xs text-gray-300 transition-colors hover:border-edge-strong hover:bg-hover hover:text-gray-100"
                  >
                    {ex}
                  </button>
                ))}
              </div>
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
            <div className="animate-fade-in-up rounded-xl border border-amber-800/50 bg-amber-950/20 p-3.5 text-sm text-amber-200">
              No model API key is configured, so the agent can't interpret yet. Deterministic results still work.
              <div className="mt-2.5">
                <Button variant="primary" size="sm" onClick={onOpenSettings}>Add a model API key</Button>
              </div>
            </div>
          )}
          {error && (
            <div className="animate-fade-in-up rounded-xl border border-red-900/50 bg-red-950/20 p-3.5 text-sm text-red-300">
              {error}
            </div>
          )}

          {proposals.length > 0 && (
            <div className="space-y-2 pt-1">
              <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-gray-500">
                <span className="h-px flex-1 bg-edge" />
                Suggested next actions
                <span className="h-px flex-1 bg-edge" />
              </div>
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
      <div className="border-t border-edge bg-sidebar/80 px-6 py-3.5">
        <div className="mx-auto max-w-3xl">
          <div className="mb-2.5 flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border border-edge bg-canvas p-0.5 text-xs">
              <button
                onClick={() => setMode("chat")}
                className={`rounded-md px-2.5 py-1 transition-colors ${mode === "chat" ? "bg-elevated text-gray-100 shadow-sm" : "text-gray-500 hover:text-gray-300"}`}
              >
                Ask the agent
              </button>
              <button
                onClick={() => setMode("triage")}
                className={`rounded-md px-2.5 py-1 transition-colors ${mode === "triage" ? "bg-elevated text-gray-100 shadow-sm" : "text-gray-500 hover:text-gray-300"}`}
              >
                Triage an error
              </button>
            </div>
            {mode === "triage" && (
              <>
                <Select value={triageKind} onChange={(e) => setTriageKind(e.target.value as ErrorInputKind)} className="!w-auto py-1 text-xs">
                  {INPUT_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                </Select>
                <Select value={planner} onChange={(e) => setPlanner(e.target.value as "deterministic" | "agent")} className="!w-auto py-1 text-xs">
                  <option value="deterministic">Deterministic</option>
                  <option value="agent">Agent</option>
                </Select>
              </>
            )}
          </div>
          <div className="flex items-end gap-2 rounded-2xl border border-edge bg-canvas p-2 transition-colors focus-within:border-accent/50 focus-within:ring-2 focus-within:ring-accent/20">
            <textarea
              ref={taRef}
              className="max-h-[200px] h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm leading-relaxed text-gray-100 placeholder:text-gray-600 focus:outline-none"
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  mode === "chat" ? send() : sendTriage();
                }
              }}
              placeholder={mode === "chat" ? "Describe the storage issue, or ask about this investigation…" : "Paste an S3 error / HTTP response / stack trace…"}
            />
            <Button
              variant="primary"
              onClick={mode === "chat" ? send : sendTriage}
              disabled={busy || !text.trim()}
              className="h-9 w-9 !px-0"
              aria-label={mode === "chat" ? "Send" : "Triage"}
            >
              {busy ? (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="19" x2="12" y2="5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
              )}
            </Button>
          </div>
          <div className="mt-1.5 px-1 text-[11px] text-gray-600">
            <kbd className="rounded bg-elevated px-1 py-0.5 font-sans text-gray-400">⌘</kbd>
            <kbd className="ml-0.5 rounded bg-elevated px-1 py-0.5 font-sans text-gray-400">↵</kbd>
            <span className="ml-1.5">to {mode === "chat" ? "send" : "triage"}</span>
            {mode === "triage" && <span className="ml-1">· runs offline, no cloud credentials</span>}
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
    <div className="fixed inset-0 z-40 flex bg-black/60 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div
        className="m-auto h-[88vh] w-[min(900px,92vw)] overflow-hidden rounded-2xl border border-edge bg-canvas shadow-pop animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
