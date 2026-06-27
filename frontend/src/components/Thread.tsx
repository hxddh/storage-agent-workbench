import { useEffect, useMemo, useRef, useState } from "react";
import {
  createSession,
  getSession,
  getSessionReport,
  getSessionTriage,
  listModelProviders,
  postSessionMessage,
  prepareSessionAction,
  previewSessionAction,
  streamSessionMessage,
  submitErrorTriage,
} from "../api";
import type { NextAction, SessionDetail, ToolActivity, TriageCase } from "../types";
import { Button } from "./ui";
import { EvidenceImportDialog } from "./EvidenceImportDialog";
import { NewRunForm } from "../views/RunsView";
import { MessageCard, ProposalCard, RunCard, ThinkingBubble, TriageCard } from "./ThreadCards";

type Item =
  | { kind: "message"; ts: string; role: string; content: string | null; id: string; toolActivity?: ToolActivity[] }
  | { kind: "run"; ts: string; data: SessionDetail["runs"][number] }
  | { kind: "triage"; ts: string; data: TriageCase };

type RunPrefill = { run_type?: string; provider_id?: string; bucket?: string };

const propKey = (p: NextAction) => `${p.action_type}::${p.title}`;

// Turn a raw sidecar/provider error into a short, actionable line.
const cleanError = (raw: string): string => {
  const s = raw.replace(/^Error:\s*/, "").replace(/^Session assistant failed:\s*/, "");
  if (/agents sdk is not available|agent runtime/i.test(s))
    return "The agent runtime isn't available in this build. Update to the latest app version.";
  if (/401|authentication|api key.*invalid|invalid.*api key/i.test(s))
    return "The model provider rejected the request — the API key looks invalid or expired. Update it in Settings.";
  if (/404|not found|model.*exist/i.test(s))
    return "The model provider returned 404 — check the model name and base URL in Settings.";
  if (/timeout|timed out|connection|network/i.test(s))
    return "Couldn't reach the model provider. Check the network or the base URL in Settings.";
  return s.length > 280 ? `${s.slice(0, 280)}…` : s;
};

// Heuristic: does this message look like a raw error to triage offline?
const looksLikeError = (t: string) =>
  /<\?xml|<error>|<code>|accessdenied|signaturedoesnotmatch|nosuchbucket|invalidaccesskey|requesttimeout|slowdown|traceback|botocore|\bhttp\/\d|\b4\d\d\b|\b5\d\d\b/i.test(
    t,
  );

// The agent's full capability surface — not just error triage. Each seeds the
// composer with a natural-language prompt; the agent routes from there.
const SUGGESTIONS: { label: string; prompt: string }[] = [
  { label: "Diagnose an error", prompt: "I'm getting a 403 AccessDenied when uploading to my bucket, but reads work. Help me diagnose it." },
  { label: "Analyze access logs", prompt: "Analyze my S3 access logs for traffic patterns, error rates, and the hottest object keys." },
  { label: "Inventory & capacity", prompt: "Give me an inventory and capacity breakdown of my bucket by object size and storage class." },
  { label: "Review bucket config", prompt: "Review my bucket's configuration for security, lifecycle, cost, and performance issues." },
  { label: "Map account & buckets", prompt: "Discover my account and map out all my buckets, regions, and their configuration." },
  { label: "Optimize storage", prompt: "Find cost and performance optimization opportunities across my object storage." },
];

// Slash commands: "/" in the composer opens this menu. Capability commands seed
// a prompt; "report" runs the session report.
type Slash = { cmd: string; label: string; prompt?: string; action?: "report" };
const SLASH: Slash[] = [
  { cmd: "diagnose", label: "Diagnose an error", prompt: SUGGESTIONS[0].prompt },
  { cmd: "logs", label: "Analyze access logs", prompt: SUGGESTIONS[1].prompt },
  { cmd: "inventory", label: "Inventory & capacity", prompt: SUGGESTIONS[2].prompt },
  { cmd: "config", label: "Review bucket config", prompt: SUGGESTIONS[3].prompt },
  { cmd: "account", label: "Map account & buckets", prompt: SUGGESTIONS[4].prompt },
  { cmd: "optimize", label: "Optimize storage", prompt: SUGGESTIONS[5].prompt },
  { cmd: "report", label: "Generate a report for this chat", action: "report" },
];

const Spark = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2z" />
  </svg>
);

export function Thread({
  sessionId,
  onSessionCreated,
  onOpenSettings,
  onChanged,
  sidecarReady,
}: {
  sessionId: string | null;
  onSessionCreated: (id: string) => void;
  onOpenSettings: () => void;
  onChanged: () => void;
  sidecarReady: boolean;
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
  const [modelName, setModelName] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [streamText, setStreamText] = useState<string | null>(null);
  const [streamTools, setStreamTools] = useState<ToolActivity[]>([]);
  const [slashSel, setSlashSel] = useState(0);
  const localId = useRef<string | null>(sessionId);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const refreshModel = () =>
    listModelProviders()
      .then((ps) => setModelName(ps.length ? ps[0].model || ps[0].name : null))
      .catch(() => undefined);

  // Fetch the model name once the sidecar is reachable (it isn't during the
  // ~1 min first-launch cold start, so a single mount-time fetch would miss it).
  useEffect(() => {
    if (sidecarReady) refreshModel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidecarReady]);

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
    // per-session UI state here when the active session changes.
    //
    // Exception: when we create a session mid-send, ensureSession sets
    // localId.current to the new id BEFORE the prop catches up. So if the
    // incoming sessionId already equals localId.current, this is our own
    // just-created session — don't wipe the in-flight optimistic state
    // (pending / streaming text / proposals), just sync and reload.
    const isOwnNewSession = sessionId !== null && sessionId === localId.current;
    localId.current = sessionId;
    if (!isOwnNewSession) {
      setLiveProposals([]);
      setPreviews({});
      setNeedKey(false);
      setError(null);
      setText("");
      setRunStarter(null);
      setImportHandoff(null);
      setReport(null);
      setPending(null);
      setStreamText(null);
      setStreamTools([]);
    }
    reload(sessionId);
    refreshModel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const m of detail?.messages ?? []) out.push({ kind: "message", ts: m.created_at, role: m.role, content: m.content, id: m.id, toolActivity: m.tool_activity });
    for (const r of detail?.runs ?? []) out.push({ kind: "run", ts: r.created_at, data: r });
    for (const c of triage) out.push({ kind: "triage", ts: c.created_at || "", data: c });
    return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }, [detail, triage]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items.length, liveProposals.length, pending]);

  // Auto-grow the composer (pin one line when empty so the wrapping placeholder
  // doesn't inflate scrollHeight).
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (!text) {
      ta.style.height = "22px";
      return;
    }
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [text]);

  const proposals = liveProposals.length ? liveProposals : detail?.summary?.next_actions ?? [];

  const ensureSession = async (seed: string): Promise<string> => {
    if (localId.current) return localId.current;
    const s = await createSession({ title: (seed || "New chat").slice(0, 80) });
    localId.current = s.id;
    onSessionCreated(s.id);
    return s.id;
  };

  // The blocking turn (also the streaming fallback). Returns true on a clean
  // answer; surfaces needKey / offline triage / error as the blocking path did.
  const sendBlocking = async (id: string, t: string) => {
    try {
      const r = await postSessionMessage(id, t);
      setLiveProposals(r.proposed_actions || []);
    } catch (e) {
      const msg = String(e);
      if (/no model provider configured|no api key stored/i.test(msg)) {
        if (looksLikeError(t)) {
          await submitErrorTriage({ content: t, input_kind: "mixed", session_id: id, planner_mode: "deterministic" });
        } else {
          setNeedKey(true);
        }
      } else {
        setError(cleanError(msg));
      }
    }
  };

  // One input. Stream the agent's turn (live tool traces + token deltas); if the
  // stream fails (e.g. the provider's tool-call streaming is flaky, or no model
  // is configured → 422), fall back to the reliable blocking turn, which also
  // handles the no-key / offline-triage cases.
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    setNeedKey(false);
    setText("");
    setPending(t); // show the user's turn immediately
    setStreamText(null);
    setStreamTools([]);
    try {
      const id = await ensureSession(t);
      try {
        const r = await streamSessionMessage(id, t, {
          onDelta: (chunk) => setStreamText((s) => (s ?? "") + chunk),
          onTool: (rec) => setStreamTools((a) => [...a, rec]),
        });
        setLiveProposals(r.proposed_actions || []);
      } catch {
        // Stream broke (or 422). The endpoint persists nothing until it
        // completes, so the blocking turn re-runs cleanly without duplicating.
        await sendBlocking(id, t);
      }
      await reload(id);
      setPending(null);
      setStreamText(null);
      setStreamTools([]);
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
      // Run proposals always open the run form — it collects any missing
      // provider/bucket/dataset, so "needs input" is never a dead end.
      if (r.open === "new_run") {
        setRunStarter({ run_type: r.prefill.run_type, provider_id: r.prefill.provider_id, bucket: r.prefill.bucket });
        return;
      }
      if (r.status !== "ready") {
        setPreviews((m) => ({ ...m, [propKey(p)]: `Needs input: ${r.missing_inputs.join(", ") || "more context"}.` }));
        return;
      }
      if (r.open === "evidence_import") {
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

  // Slash commands: open when the composer is exactly "/" + word chars.
  const slashQ = /^\/(\w*)$/.exec(text)?.[1];
  const slashItems = slashQ !== undefined ? SLASH.filter((c) => c.cmd.startsWith(slashQ.toLowerCase())) : [];
  const slashOpen = slashItems.length > 0;
  const slashIdx = Math.min(slashSel, slashItems.length - 1);

  const selectSlash = (c: Slash) => {
    if (c.action === "report") {
      setText("");
      if (localId.current) getSessionReport(localId.current).then((r) => setReport(r.content)).catch((e) => setError(cleanError(String(e))));
      else setError("Start a chat first, then generate a report.");
    } else if (c.prompt) {
      setText(c.prompt);
      requestAnimationFrame(() => taRef.current?.focus());
    }
    setSlashSel(0);
  };

  const isEmpty = items.length === 0 && !pending;

  const modelChip = (
    <button
      onClick={onOpenSettings}
      className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11.5px] transition-colors hover:bg-hover ${
        modelName ? "text-gray-500 hover:text-gray-300" : "text-amber-300/80 hover:text-amber-200"
      }`}
    >
      <Spark size={11} />
      {modelName ?? "Add a model"}
    </button>
  );

  return (
    <div className="flex h-full flex-1 flex-col bg-canvas">
      {/* A real conversation gets a slim header; a fresh chat shows just the
          canvas + composer (Codex/Cursor). */}
      {!isEmpty && (
        <header className="flex items-center gap-3 border-b border-edge px-6 py-2.5">
          <div className="truncate text-[12.5px] font-medium text-gray-200">{detail?.title || "New chat"}</div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md border border-edge px-2 py-1 text-[11px] text-gray-500">
            <Spark size={11} />
            <span className="text-gray-400">{modelName ?? "No model"}</span>
          </div>
        </header>
      )}

      <div className="flex-1 overflow-auto px-6 py-6">
        <div className="mx-auto max-w-3xl space-y-5">
          {isEmpty && (
            <div className="flex flex-col items-center pt-[12vh] animate-fade-in-up">
              <div className="mb-5 grid h-11 w-11 place-items-center rounded-xl border border-edge-strong bg-elevated text-accent-soft">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
                  <path d="M12 2 2 7l10 5 10-5-10-5z" />
                  <path d="M2 17l10 5 10-5" />
                  <path d="M2 12l10 5 10-5" />
                </svg>
              </div>
              <div className="text-[19px] font-medium tracking-[-0.01em] text-gray-100">How can I help with your storage?</div>
              <p className="mt-2 max-w-md text-center text-[13px] leading-relaxed text-gray-500">
                Ask about an issue, an access pattern, or your bucket setup. I ground answers in evidence and confirm
                with you before running anything.
              </p>
              <div className="mt-6 flex max-w-2xl flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.label}
                    onClick={() => seed(s.prompt)}
                    className="rounded-full border border-edge bg-panel px-3 py-1.5 text-[12px] text-gray-300 transition-colors hover:border-edge-strong hover:bg-hover hover:text-gray-100"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {items.map((it) =>
            it.kind === "message" ? (
              <MessageCard key={it.id} role={it.role} content={it.content} toolActivity={it.toolActivity} />
            ) : it.kind === "run" ? (
              <RunCard key={it.data.run_id} run={it.data} />
            ) : (
              <TriageCard key={it.data.id} c={it.data} />
            ),
          )}

          {pending && (
            <>
              <MessageCard role="user" content={pending} />
              {streamText !== null || streamTools.length ? (
                <MessageCard role="assistant" content={streamText ?? ""} toolActivity={streamTools} streaming />
              ) : (
                <ThinkingBubble />
              )}
            </>
          )}

          {needKey && (
            <div className="animate-fade-in-up rounded-xl border border-amber-800/50 bg-amber-950/20 p-3.5 text-[13px] text-amber-200">
              Add a model API key for full agent answers. Pasted S3 errors are still triaged offline without one.
              <div className="mt-2.5">
                <Button variant="primary" size="sm" onClick={onOpenSettings}>Add a model API key</Button>
              </div>
            </div>
          )}
          {error && (
            <div className="animate-fade-in-up rounded-xl border border-red-900/50 bg-red-950/20 p-3.5 text-[13px] text-red-300">
              {error}
              <div className="mt-2.5">
                <Button variant="default" size="sm" onClick={onOpenSettings}>Open settings</Button>
              </div>
            </div>
          )}

          {proposals.length > 0 && !pending && (
            <div className="space-y-2 pt-1">
              <div className="px-0.5 text-[11px] font-medium uppercase tracking-wider text-gray-600">Suggested next steps</div>
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

      {/* One composer (Cursor-style): textarea + a row with the model chip and send. */}
      <div className="px-6 pb-5 pt-1">
        <div className="mx-auto max-w-3xl">
          <div className="relative rounded-2xl border border-edge bg-panel px-3 pb-2 pt-3 shadow-elev transition-colors focus-within:border-accent/50 focus-within:ring-2 focus-within:ring-accent/15">
            {slashOpen && (
              <div className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-xl border border-edge bg-panel shadow-pop animate-fade-in">
                <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-gray-600">Commands</div>
                {slashItems.map((c, i) => (
                  <button
                    key={c.cmd}
                    onMouseEnter={() => setSlashSel(i)}
                    onClick={() => selectSlash(c)}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${i === slashIdx ? "bg-hover" : ""}`}
                  >
                    <span className="font-mono text-[12px] text-accent-soft">/{c.cmd}</span>
                    <span className="text-[13px] text-gray-300">{c.label}</span>
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={taRef}
              className="block max-h-[200px] h-[22px] w-full resize-none bg-transparent px-1 text-[13.5px] leading-relaxed text-gray-100 placeholder:text-gray-600 focus:outline-none focus-visible:shadow-none"
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (slashOpen) {
                  if (e.key === "ArrowDown") { e.preventDefault(); setSlashSel((s) => Math.min(slashItems.length - 1, s + 1)); return; }
                  if (e.key === "ArrowUp") { e.preventDefault(); setSlashSel((s) => Math.max(0, s - 1)); return; }
                  if (e.key === "Enter") { e.preventDefault(); selectSlash(slashItems[slashIdx]); return; }
                  if (e.key === "Escape") { e.preventDefault(); setText(""); return; }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Ask Storage Agent…  (/ for commands)"
            />
            <div className="mt-2 flex items-center gap-1">
              {modelChip}
              <span className="ml-auto text-[11px] text-gray-600">↵ to send</span>
              <button
                onClick={send}
                disabled={busy || !text.trim()}
                aria-label="Send"
                className="ml-2 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent text-white transition-all hover:bg-accent-soft active:scale-95 disabled:opacity-40"
              >
                {busy ? (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                )}
              </button>
            </div>
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
              <span className="text-sm font-semibold text-gray-100">Report</span>
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
