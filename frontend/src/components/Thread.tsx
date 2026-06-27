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
import type { NextAction, SessionDetail, TriageCase } from "../types";
import { Button } from "./ui";
import { EvidenceImportDialog } from "./EvidenceImportDialog";
import { NewRunForm } from "../views/RunsView";
import { MessageCard, ProposalCard, RunCard, TriageCard } from "./ThreadCards";

type Item =
  | { kind: "message"; ts: string; role: string; content: string | null; id: string }
  | { kind: "run"; ts: string; data: SessionDetail["runs"][number] }
  | { kind: "triage"; ts: string; data: TriageCase };

type RunPrefill = { run_type?: string; provider_id?: string; bucket?: string };

const propKey = (p: NextAction) => `${p.action_type}::${p.title}`;

// Heuristic: does this message look like a raw error to triage offline?
const looksLikeError = (t: string) =>
  /<\?xml|<error>|<code>|accessdenied|signaturedoesnotmatch|nosuchbucket|invalidaccesskey|requesttimeout|slowdown|traceback|botocore|\bhttp\/\d|\b4\d\d\b|\b5\d\d\b/i.test(
    t,
  );

const icon = (d: string) => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {d.split("|").map((p, i) => <path key={i} d={p} />)}
  </svg>
);

// The agent's full capability surface — not just error triage. Each seeds the
// single composer with a natural-language prompt; the agent routes from there.
const CAPABILITIES: { label: string; hint: string; prompt: string; svg: React.ReactNode }[] = [
  {
    label: "Diagnose an error",
    hint: "403, signature, endpoint, timeouts",
    prompt: "I'm getting a 403 AccessDenied when uploading to my bucket, but reads work. Help me diagnose it.",
    svg: icon("M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z|M12 9v4|M12 17h.01"),
  },
  {
    label: "Analyze access logs",
    hint: "Traffic, hot and cold objects",
    prompt: "Analyze my S3 access logs for traffic patterns, error rates, and the hottest object keys.",
    svg: icon("M3 3v18h18|M7 15l4-4 3 3 5-6"),
  },
  {
    label: "Inventory & capacity",
    hint: "Counts, sizes, storage classes",
    prompt: "Give me an inventory and capacity breakdown of my bucket by object size and storage class.",
    svg: icon("M3 5a9 3 0 1 0 18 0a9 3 0 1 0-18 0|M3 5v14a9 3 0 0 0 18 0V5|M3 12a9 3 0 0 0 18 0"),
  },
  {
    label: "Review bucket config",
    hint: "Security, lifecycle, cost, perf",
    prompt: "Review my bucket's configuration for security, lifecycle, cost, and performance issues.",
    svg: icon("M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"),
  },
  {
    label: "Map account & buckets",
    hint: "Discover the account layout",
    prompt: "Discover my account and map out all my buckets, regions, and their configuration.",
    svg: icon("M9 20 3 17V4l6 3 6-3 6 3v13l-6 3-6-3z|M9 7v13|M15 4v13"),
  },
  {
    label: "Optimize storage",
    hint: "Find cost & performance wins",
    prompt: "Find cost and performance optimization opportunities across my object storage.",
    svg: icon("M13 2 3 14h9l-1 8 10-12h-9l1-8z"),
  },
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
    // Thread is not remounted per session (App does not key it by id), so reset
    // all per-session UI state here when the active session changes.
    localId.current = sessionId;
    setLiveProposals([]);
    setPreviews({});
    setNeedKey(false);
    setError(null);
    setText("");
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

  // Auto-grow the composer (pin one line when empty so the wrapping placeholder
  // doesn't inflate scrollHeight).
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (!text) {
      ta.style.height = "24px";
      return;
    }
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [text]);

  const proposals = liveProposals.length ? liveProposals : detail?.summary?.next_actions ?? [];

  const ensureSession = async (seed: string): Promise<string> => {
    if (localId.current) return localId.current;
    const s = await createSession({ title: (seed || "Investigation").slice(0, 80) });
    localId.current = s.id;
    onSessionCreated(s.id);
    return s.id;
  };

  // One input. The agent answers; if no model key is configured and the message
  // looks like an error, fall back to deterministic offline triage so the user
  // still gets value without credentials.
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
        if (/model provider|model key|api key/i.test(msg)) {
          if (looksLikeError(t)) {
            await submitErrorTriage({ content: t, input_kind: "mixed", session_id: id, planner_mode: "deterministic" });
          } else {
            setNeedKey(true);
          }
        } else {
          setError(msg);
        }
      }
      setText("");
      await reload(id);
      onChanged();
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
        setText(r.prefill.question || "");
        taRef.current?.focus();
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const seed = (prompt: string) => {
    setText(prompt);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const isEmpty = items.length === 0;

  return (
    <div className="flex h-full flex-1 flex-col bg-canvas">
      {/* Only a real, non-empty session gets a header — a fresh thread shows just
          the canvas + composer, like Codex/Cursor. */}
      {detail && items.length > 0 && (
        <header className="flex items-center gap-3 border-b border-edge px-6 py-3">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-gray-100">{detail.title || "Investigation"}</div>
            {detail.goal ? <div className="truncate text-[11px] text-gray-500">{detail.goal}</div> : null}
          </div>
        </header>
      )}

      <div className="flex-1 overflow-auto px-6 py-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {isEmpty && (
            <div className="flex flex-col items-center py-10 animate-fade-in-up">
              <div className="mb-4 grid h-12 w-12 place-items-center rounded-2xl border border-edge-strong bg-elevated text-accent">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
                  <path d="M12 2 2 7l10 5 10-5-10-5z" />
                  <path d="M2 17l10 5 10-5" />
                  <path d="M2 12l10 5 10-5" />
                </svg>
              </div>
              <div className="text-lg font-medium text-gray-100">What can I help with?</div>
              <p className="mt-1.5 max-w-md text-center text-[13px] leading-relaxed text-gray-500">
                Your object-storage agent — diagnose issues, analyze logs and inventory, review configuration, and find
                optimizations. It grounds answers in evidence and asks before running anything.
              </p>
              <div className="mt-6 grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
                {CAPABILITIES.map((c) => (
                  <button
                    key={c.label}
                    onClick={() => seed(c.prompt)}
                    className="group flex items-start gap-3 rounded-xl border border-edge bg-panel px-3.5 py-3 text-left transition-all duration-150 hover:border-edge-strong hover:bg-elevated active:scale-[0.99]"
                  >
                    <span className="mt-0.5 text-gray-500 transition-colors group-hover:text-accent-soft">{c.svg}</span>
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium text-gray-200">{c.label}</span>
                      <span className="block text-[11.5px] text-gray-500">{c.hint}</span>
                    </span>
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
              Add a model API key to get full agent answers. You can still triage pasted S3 errors offline without one.
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
                Suggested next steps
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

      {/* One composer. The agent routes intent. */}
      <div className="border-t border-edge bg-sidebar/80 px-6 py-4">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-end gap-2 rounded-2xl border border-edge bg-canvas px-3 py-2.5 transition-colors focus-within:border-accent/50 focus-within:ring-2 focus-within:ring-accent/20">
            <textarea
              ref={taRef}
              className="max-h-[200px] h-6 flex-1 resize-none bg-transparent text-sm leading-relaxed text-gray-100 placeholder:text-gray-600 focus:outline-none"
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Message the agent — describe an issue, ask a question, or paste an error…"
            />
            <Button
              variant="primary"
              onClick={send}
              disabled={busy || !text.trim()}
              className="h-8 w-8 shrink-0 !px-0"
              aria-label="Send"
            >
              {busy ? (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="19" x2="12" y2="5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
              )}
            </Button>
          </div>
          <div className="mt-1.5 px-1 text-[11px] text-gray-600">
            <kbd className="rounded bg-elevated px-1 py-0.5 font-sans text-gray-400">↵</kbd>
            <span className="ml-1.5">to send · review and confirm before anything runs</span>
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
