import { useEffect, useMemo, useRef, useState } from "react";
import {
  getSession,
  getSessionReport,
  getSessionTriage,
  listModelProviders,
  prepareSessionAction,
} from "../api";
import type { Grounding, NextAction, SessionDetail, ToolActivity, TriageCase } from "../types";
import { useSessionRun } from "../sessionRuns";
import { useTurnRunner, cleanError } from "../hooks/useTurnRunner";
import { Button } from "./ui";
import { Composer } from "./Composer";
import { EvidenceImportDialog } from "./EvidenceImportDialog";
import { FindingsCard, GroundingCard, MessageCard, ProposalCard, RunCard, ThinkingBubble, TriageCard } from "./ThreadCards";
import { useI18n } from "../i18n";

type Item =
  | {
      kind: "message";
      ts: string;
      role: string;
      content: string | null;
      id: string;
      toolActivity?: ToolActivity[];
      grounding?: Grounding | null;
      proposals?: NextAction[];
    }
  | { kind: "run"; ts: string; data: SessionDetail["runs"][number] }
  | { kind: "triage"; ts: string; data: TriageCase };

const propKey = (p: NextAction) => `${p.action_type}::${p.title}`;

// Infer the dataset type for an attached analysis file from its extension.
// null = ambiguous → the composer shows an Inventory/Access-log toggle.
const inferDatasetType = (name: string): "inventory" | "access_log" | null => {
  const n = name.toLowerCase();
  if (/\.(csv|parquet|tsv)$/.test(n)) return "inventory";
  if (/\.(log|txt)(\.gz)?$/.test(n) || n.includes("access") || n.includes("log")) return "access_log";
  return null;
};

// The agent's full capability surface — not just error triage. Each seeds the
// composer with a natural-language prompt (localized); the agent routes from there.
const SUGGESTION_KEYS = ["diagnose", "logs", "inventory", "config", "account", "optimize"] as const;

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
  settingsOpen,
}: {
  sessionId: string | null;
  onSessionCreated: (id: string) => void;
  onOpenSettings: () => void;
  onChanged: () => void;
  sidecarReady: boolean;
  settingsOpen: boolean;
}) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [triage, setTriage] = useState<TriageCase[]>([]);
  const [text, setText] = useState("");
  const [importHandoff, setImportHandoff] = useState<
    { sourceType: "inventory" | "access_log"; accountRunId: string; bucketName: string } | null
  >(null);
  const [report, setReport] = useState<string | null>(null);
  const [modelName, setModelName] = useState<string | null>(null);

  // Per-session run state lives in a store keyed by session id (see sessionRuns)
  // so an in-flight turn keeps streaming — and keeps its content — when you
  // switch away and come back. `run` is the active session's slice; the run loop
  // writes to the id it started with, never the currently-visible one.
  // proposals: null = this session's turn hasn't answered yet (show the session's
  // default next-steps); [] = the agent answered and proposed nothing.
  const run = useSessionRun(sessionId);
  const { busy, uploading, pending, streamText, streamTools, needKey } = run;
  const liveProposals = run.proposals;
  // View-level errors not tied to a turn (e.g. a proposal action failing, or
  // asking for a report before a chat exists). Combined with the run's error.
  const [viewError, setViewError] = useState<string | null>(null);
  const error = run.error ?? viewError;
  // Set when loading an EXISTING session fails, so we show an explicit error +
  // retry instead of silently rendering the empty new-chat surface (M6).
  const [loadError, setLoadError] = useState<string | null>(null);
  const localId = useRef<string | null>(sessionId);
  // Tracks which session id the loaded `detail` belongs to, so a failed refresh
  // for the current session doesn't get mistaken for a first-load failure.
  const loadedIdRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // Composer file attachment (dataset for inventory/access-log analysis). type is
  // auto-inferred from the extension; null means "ask" (show the 2-option chip).
  const [attached, setAttached] = useState<File | null>(null);
  const [attachType, setAttachType] = useState<"inventory" | "access_log" | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // One-shot: when a proposal opens the picker it presets the type; a plain 📎
  // attach leaves this null and the type is inferred from the filename.
  const presetTypeRef = useRef<"inventory" | "access_log" | null>(null);
  const { t } = useI18n();
  const suggestions = SUGGESTION_KEYS.map((k) => ({ key: k, label: t(`sugg.${k}`), prompt: t(`prompt.${k}`) }));

  // Fetch the configured model name, retrying a few times on a transient sidecar
  // blip so the composer chip doesn't get stuck on "Add model" until a refresh.
  const refreshModel = (attempt = 0) =>
    listModelProviders()
      .then((ps) => {
        // The list is newest-first while the agent uses the explicitly-activated
        // provider (`active` flag) — never assume ps[0] is the one in use (M2).
        const activeP = ps.find((p) => p.active) ?? ps[0];
        setModelName(activeP ? activeP.model || activeP.name : null);
      })
      .catch(() => {
        if (attempt < 3) setTimeout(() => refreshModel(attempt + 1), 2000);
      });

  // Fetch the model name once the sidecar is reachable (it isn't during the
  // brief startup, so a single mount-time fetch could miss it).
  useEffect(() => {
    if (sidecarReady) refreshModel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidecarReady]);

  // Re-fetch when the Settings drawer CLOSES: adding the first model provider
  // there (e.g. via the first-run wizard) changes neither sidecarReady nor
  // sessionId, so the composer chip would otherwise stay on "Add model" until a
  // session switch — even though chat already works (the backend resolves the
  // provider per turn). Refetching on close keeps the chip in sync.
  useEffect(() => {
    if (!settingsOpen && sidecarReady) refreshModel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen]);

  const reload = async (id: string | null) => {
    if (!id) {
      setDetail(null);
      setTriage([]);
      setLoadError(null);
      return;
    }
    let d: SessionDetail | null = null;
    let failed: string | null = null;
    const [dRes, tRes] = await Promise.allSettled([getSession(id), getSessionTriage(id)]);
    if (dRes.status === "fulfilled") d = dRes.value;
    // Session-load failures get a NEUTRAL message — the model-provider hints
    // (bad key / model 404) only apply to turn failures (D2).
    else failed = cleanError(String(dRes.reason), t, "load");
    const triageCases = tRes.status === "fulfilled" ? tRes.value.cases : [];
    // Guard against a switch race: if the user moved to another session while
    // this request was in flight, drop the stale result instead of clobbering
    // the now-current session's view.
    if (id !== localId.current) return;
    if (d) {
      loadedIdRef.current = id;
      setDetail(d);
      setLoadError(null);
    } else if (failed) {
      // A transient refresh blip for the session we're already showing shouldn't
      // wipe the populated thread — keep it. Otherwise (no content for this id)
      // surface an explicit error + retry instead of the empty new-chat surface.
      if (loadedIdRef.current !== id) {
        setDetail(null);
        setLoadError(failed);
      }
    }
    setTriage(triageCases);
  };

  // The turn runner owns ensureSession / submit / dataset upload / stop; all
  // run state goes into the sessionRuns store keyed by the starting session id.
  const runner = useTurnRunner({
    localId,
    onSessionCreated,
    reload,
    onChanged,
    setText,
    setViewError,
    onUploaded: () => {
      setText("");
      setAttached(null);
      setAttachType(null);
    },
  });

  useEffect(() => {
    // Only VIEW-local state is reset on session change. Run state (busy /
    // pending / streaming text / proposals / errors) lives per-session in the
    // sessionRuns store, so an in-flight turn keeps going and keeps its content
    // when you switch away and back — nothing to reset here.
    localId.current = sessionId;
    setText("");
    setImportHandoff(null);
    setReport(null);
    setViewError(null);
    setLoadError(null);
    pinnedRef.current = true;
    reload(sessionId);
    refreshModel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const m of detail?.messages ?? [])
      out.push({
        kind: "message", ts: m.created_at, role: m.role, content: m.content, id: m.id,
        toolActivity: m.tool_activity, grounding: m.grounding, proposals: m.proposed_actions,
      });
    // Agent-initiated surveys/reviews (origin 'agent') are internal compute the
    // agent narrates inline — never a standalone run card. Only explicit
    // user-requested auditable reports surface as cards.
    for (const r of detail?.runs ?? []) {
      if (r.origin === "agent") continue;
      out.push({ kind: "run", ts: r.created_at, data: r });
    }
    for (const c of triage) out.push({ kind: "triage", ts: c.created_at || "", data: c });
    return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }, [detail, triage]);

  // Proposals come ONLY from the agent's own answer (liveProposals). We no longer
  // fall back to the deterministic summary.next_actions menu — before the agent
  // has spoken the user sees capability chips, not a rule-engine menu. This keeps
  // the agent the sole source of suggested next steps.
  const proposals = liveProposals ?? [];

  // Follow the conversation while the user is "pinned" to the bottom. The flag
  // is updated in the scroll handler — BEFORE the DOM grows — so a fast stream
  // can't outrun the measurement and detach auto-scroll (UX2): scrolling up
  // unpins; scrolling back to the bottom re-pins.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useEffect(() => {
    if (pinnedRef.current) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items.length, proposals.length, pending, streamText?.length, streamTools.length]);

  const send = () => {
    if (busy || uploading) return;
    if (attached) {
      const type = attachType ?? inferDatasetType(attached.name);
      if (!type) {
        // Ambiguous file type and not yet picked — tell the user to choose a
        // type (the picker chip is shown) instead of silently doing nothing.
        setViewError(t("attach.pickTypeHint"));
        return;
      }
      void runner.submitWithDataset(text.trim(), attached, type);
      return;
    }
    void runner.submit(text.trim());
  };

  const onPickFile = (f: File | null) => {
    if (!f) return;
    const preset = presetTypeRef.current;
    presetTypeRef.current = null;
    setAttached(f);
    setAttachType(preset ?? inferDatasetType(f.name));
  };

  const openReport = () => {
    if (localId.current)
      getSessionReport(localId.current)
        .then((r) => setReport(r.content))
        .catch((e) => setViewError(cleanError(String(e), t)));
    else setViewError(t("thread.startChatFirst"));
  };

  // Agent-native next steps. Anything the agent can do with its read-only tools
  // is handed straight back to the conversation (one click → the agent does it
  // and answers inline) — no configuration modal. Only steps that genuinely need
  // an external file (evidence imports) open a purpose-built dialog; the report
  // just renders. This replaces the old "preview → prepare → New Run form".
  const INLINE_ACTION_PROMPT: Record<string, string> = {
    run_account_discovery: "act.run_account_discovery",
    run_bucket_config_review: "act.run_bucket_config_review",
    run_diagnostic: "act.run_diagnostic",
  };

  const runProposal = async (p: NextAction) => {
    const inlineKey = INLINE_ACTION_PROMPT[p.action_type];
    if (inlineKey) {
      void runner.submit(t(inlineKey));
      return;
    }
    // Dataset analysis needs a local file — open the composer's file picker with
    // the type preset, rather than the old form handoff.
    if (p.action_type === "run_inventory_analysis" || p.action_type === "run_access_log_analysis") {
      presetTypeRef.current = p.action_type === "run_inventory_analysis" ? "inventory" : "access_log";
      fileRef.current?.click();
      return;
    }
    if (!localId.current) return;
    try {
      const r = await prepareSessionAction(localId.current, p);
      if (r.open === "evidence_import" && r.status === "ready") {
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
      } else {
        // Anything else (incl. needs-input or a would-be run form): just ask the
        // agent to do it conversationally rather than popping a form.
        void runner.submit(p.title);
      }
    } catch (e) {
      setViewError(cleanError(String(e), t));
    }
  };

  const seed = (prompt: string) => {
    setText(prompt);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  // Capability chip → action. Log/inventory analysis needs a local file, so those
  // chips open the file picker (preset type) just like an analysis proposal —
  // rather than seeding a prompt the agent has no file to act on. The rest seed
  // a starter prompt for the agent.
  const onSuggestion = (key: string, prompt: string) => {
    if (key === "logs" || key === "inventory") {
      presetTypeRef.current = key === "logs" ? "access_log" : "inventory";
      fileRef.current?.click();
      return;
    }
    seed(prompt);
  };

  const isEmpty = items.length === 0 && !pending && !loadError;

  // Live-store fallback for the just-completed turn (H1): the SSE `done` event
  // writes proposals/grounding into the run store, so we can show the chips +
  // "why this answer" card immediately — before the reload persists them onto
  // the message. Once the reloaded assistant message carries persisted
  // grounding/proposals, the per-message render takes over and we suppress this
  // live block to avoid a duplicate.
  const lastAssistant = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "message" && it.role === "assistant") return it;
      if (it.kind === "message" && it.role === "user") break;
    }
    return undefined;
  }, [items]);
  const lastPersisted = !!(
    lastAssistant &&
    (lastAssistant.grounding ||
      (lastAssistant.proposals && lastAssistant.proposals.length > 0))
  );
  const showLiveGrounding =
    !pending && !lastPersisted && (!!run.grounding || proposals.length > 0);

  const composer = (
    <Composer
      text={text}
      setText={setText}
      attached={attached}
      attachType={attachType}
      setAttachType={setAttachType}
      onClearAttachment={() => { setAttached(null); setAttachType(null); }}
      onPickFile={onPickFile}
      onOpenFilePicker={() => { presetTypeRef.current = null; fileRef.current?.click(); }}
      fileRef={fileRef}
      taRef={taRef}
      busy={busy}
      uploading={uploading}
      onSend={send}
      onStop={runner.stop}
      modelName={modelName}
      onOpenSettings={onOpenSettings}
      onSlashReport={openReport}
      onSlashPickFile={(type) => {
        presetTypeRef.current = type;
        fileRef.current?.click();
      }}
    />
  );

  const banners = (
    <>
      {needKey && (
        <div className="animate-fade-in-up rounded-xl border border-amber-800/50 bg-amber-950/20 p-3.5 text-[13px] text-amber-200">
          {t("thread.needKey")}
          <div className="mt-2.5">
            <Button variant="primary" size="sm" onClick={onOpenSettings}>{t("thread.needKeyBtn")}</Button>
          </div>
        </div>
      )}
      {error && (
        <div className="animate-fade-in-up rounded-xl border border-red-900/50 bg-red-950/20 p-3.5 text-[13px] text-red-300">
          {error}
          <div className="mt-2.5">
            <Button variant="default" size="sm" onClick={onOpenSettings}>{t("common.openSettings")}</Button>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="flex h-full flex-1 flex-col bg-canvas">
      {loadError ? (
        /* Loading an existing session failed — show an explicit error + retry
           instead of silently presenting the empty new-chat surface (M6). */
        <div className="flex flex-1 items-center justify-center px-6 py-10">
          <div className="w-full max-w-md animate-fade-in-up rounded-xl border border-red-900/50 bg-red-950/20 p-5 text-center">
            <div className="text-[14px] font-medium text-red-200">{t("thread.loadFailed")}</div>
            <div className="mt-1.5 text-[12.5px] text-red-300/80">{loadError}</div>
            <div className="mt-3.5 flex justify-center">
              <Button variant="primary" size="sm" onClick={() => reload(localId.current)}>
                {t("thread.retry")}
              </Button>
            </div>
          </div>
        </div>
      ) : isEmpty ? (
        /* New chat: a centered, composer-forward "start" view (Codex/Cursor). */
        <div className="flex flex-1 items-center justify-center overflow-auto px-6 py-10">
          <div className="w-full max-w-[44rem] animate-fade-in-up">
            <div className="mb-7 flex flex-col items-center text-center">
              <h1 className="text-[23px] font-semibold tracking-[-0.02em] text-gray-100">{t("thread.greeting")}</h1>
              <p className="mt-2.5 max-w-md text-[13.5px] leading-relaxed text-gray-500">
                {t("thread.subtitle")}
              </p>
            </div>
            {composer}
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {suggestions.map((s) => (
                <button
                  key={s.key}
                  onClick={() => onSuggestion(s.key, s.prompt)}
                  className="rounded-full border border-edge bg-panel/60 px-3.5 py-1.5 text-[12px] text-gray-400 transition-colors hover:border-edge-strong hover:bg-hover hover:text-gray-100"
                >
                  {s.label}
                </button>
              ))}
            </div>
            <div className="mt-4 space-y-2">{banners}</div>
          </div>
        </div>
      ) : (
        <>
          <header className="flex items-center gap-3 border-b border-edge px-6 py-2.5">
            <div className="truncate text-[12.5px] font-medium text-gray-200">{detail?.title || t("thread.titleNew")}</div>
            <div className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md border border-edge px-2 py-1 text-[11px] text-gray-500">
              <Spark size={11} />
              <span className="text-gray-400">{modelName ?? t("thread.noModel")}</span>
            </div>
          </header>

          <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-auto px-6 py-7">
            <div className="mx-auto max-w-3xl space-y-6">
              {items.map((it) =>
                it.kind === "message" ? (
                  <div key={it.id} className="thread-item space-y-3">
                    <MessageCard role={it.role} content={it.content} toolActivity={it.toolActivity} />
                    {/* Persisted grounding + proposals (v0.21.0) — survive reload,
                        so a historical assistant turn still shows why it said that
                        and what it proposed next. */}
                    {it.grounding && <GroundingCard g={it.grounding} />}
                    {it.proposals && it.proposals.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2 pt-0.5">
                        <span className="text-[11.5px] text-gray-600">{t("thread.suggestedNext")}</span>
                        {it.proposals.map((p, i) => (
                          <ProposalCard key={`${propKey(p)}-${i}`} proposal={p} onRun={runProposal} />
                        ))}
                      </div>
                    )}
                  </div>
                ) : it.kind === "run" ? (
                  <div key={it.data.run_id} className="thread-item">
                    <RunCard run={it.data} />
                  </div>
                ) : (
                  <div key={it.data.id} className="thread-item">
                    <TriageCard c={it.data} onRun={runProposal} />
                  </div>
                ),
              )}

              {pending && (
                <>
                  <MessageCard role="user" content={pending} />
                  {streamText !== null || streamTools.length ? (
                    <>
                      <MessageCard
                        role="assistant"
                        content={streamText ?? ""}
                        toolActivity={streamTools}
                        streaming={!run.stopped}
                      />
                      {run.stopped && (
                        <div className="flex items-center gap-1.5 text-[11.5px] text-gray-500">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <rect x="6" y="6" width="12" height="12" rx="2" />
                          </svg>
                          {t("thread.stoppedByUser")}
                        </div>
                      )}
                    </>
                  ) : run.stopped ? (
                    <div className="flex items-center gap-1.5 text-[11.5px] text-gray-500">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <rect x="6" y="6" width="12" height="12" rx="2" />
                      </svg>
                      {t("thread.stoppedByUser")}
                    </div>
                  ) : (
                    <ThinkingBubble />
                  )}
                </>
              )}

              {banners}

              {/* Persisted deterministic session findings (read-only) — surfaced
                  in-thread, not just in the report. */}
              {detail?.findings && detail.findings.length > 0 && !pending && (
                <FindingsCard findings={detail.findings} />
              )}

              {/* Grounding + proposals normally render per assistant message
                  (above), sourced from the persisted turn so they survive a
                  reload. This live block covers the just-completed turn before
                  the reload persists those fields onto the message (H1). */}
              {showLiveGrounding && (
                <div className="space-y-3">
                  {run.grounding && <GroundingCard g={run.grounding} />}
                  {proposals.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 pt-0.5">
                      <span className="text-[11.5px] text-gray-600">{t("thread.suggestedNext")}</span>
                      {proposals.map((p, i) => (
                        <ProposalCard key={`${propKey(p)}-${i}`} proposal={p} onRun={runProposal} />
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          </div>

          <div className="px-6 pb-5 pt-1">
            <div className="mx-auto max-w-3xl">{composer}</div>
          </div>
        </>
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
              <span className="text-sm font-semibold text-gray-100">{t("thread.report")}</span>
              <Button variant="ghost" onClick={() => setReport(null)}>{t("common.close")}</Button>
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
