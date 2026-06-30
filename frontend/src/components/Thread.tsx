import { useEffect, useMemo, useRef, useState } from "react";
import {
  createSession,
  getSession,
  getSessionReport,
  getSessionTriage,
  listModelProviders,
  postSessionMessage,
  prepareSessionAction,
  streamSessionMessage,
  submitErrorTriage,
  uploadSessionDataset,
} from "../api";
import type { NextAction, SessionDetail, ToolActivity, TriageCase } from "../types";
import { useSessionRun, patchSessionRun } from "../sessionRuns";
import { Button } from "./ui";
import { EvidenceImportDialog } from "./EvidenceImportDialog";
import { MessageCard, ProposalCard, RunCard, ThinkingBubble, TriageCard } from "./ThreadCards";
import { useI18n, type TFunc } from "../i18n";

type Item =
  | { kind: "message"; ts: string; role: string; content: string | null; id: string; toolActivity?: ToolActivity[] }
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

// Turn a raw sidecar/provider error into a short, actionable, localized line.
const cleanError = (raw: string, t: TFunc): string => {
  const s = raw.replace(/^Error:\s*/, "").replace(/^Session assistant failed:\s*/, "");
  if (/agents sdk is not available|agent runtime/i.test(s)) return t("thread.agentRuntimeUnavailable");
  if (/401|authentication|api key.*invalid|invalid.*api key/i.test(s)) return t("thread.errKey");
  if (/404|not found|model.*exist/i.test(s)) return t("thread.err404");
  if (/timeout|timed out|connection|network/i.test(s)) return t("thread.errNetwork");
  return s.length > 280 ? `${s.slice(0, 280)}…` : s;
};

// Heuristic: does this message look like a raw error to triage offline?
const looksLikeError = (t: string) =>
  /<\?xml|<error>|<code>|accessdenied|signaturedoesnotmatch|nosuchbucket|invalidaccesskey|requesttimeout|slowdown|traceback|botocore|\bhttp\/\d|\b4\d\d\b|\b5\d\d\b/i.test(
    t,
  );

// The agent's full capability surface — not just error triage. Each seeds the
// composer with a natural-language prompt (localized); the agent routes from there.
const SUGGESTION_KEYS = ["diagnose", "logs", "inventory", "config", "account", "optimize"] as const;

// Slash commands: "/" in the composer opens this menu. Capability commands seed
// a prompt; "report" runs the session report.
type Slash = { cmd: string; labelKey: string; promptKey?: string; action?: "report" };
const SLASH: Slash[] = [
  { cmd: "diagnose", labelKey: "sugg.diagnose", promptKey: "prompt.diagnose" },
  { cmd: "logs", labelKey: "sugg.logs", promptKey: "prompt.logs" },
  { cmd: "inventory", labelKey: "sugg.inventory", promptKey: "prompt.inventory" },
  { cmd: "config", labelKey: "sugg.config", promptKey: "prompt.config" },
  { cmd: "account", labelKey: "sugg.account", promptKey: "prompt.account" },
  { cmd: "optimize", labelKey: "sugg.optimize", promptKey: "prompt.optimize" },
  { cmd: "report", labelKey: "slash.report", action: "report" },
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
  const [text, setText] = useState("");
  const [importHandoff, setImportHandoff] = useState<
    { sourceType: "inventory" | "access_log"; accountRunId: string; bucketName: string } | null
  >(null);
  const [report, setReport] = useState<string | null>(null);
  const [modelName, setModelName] = useState<string | null>(null);
  const [slashSel, setSlashSel] = useState(0);

  // Per-session run state lives in a store keyed by session id (see sessionRuns)
  // so an in-flight turn keeps streaming — and keeps its content — when you
  // switch away and come back. `run` is the active session's slice; the run loop
  // writes to the id it started with, never the currently-visible one.
  // proposals: null = this session's turn hasn't answered yet (show the session's
  // default next-steps); [] = the agent answered and proposed nothing.
  const run = useSessionRun(sessionId);
  const { busy, pending, streamText, streamTools, needKey } = run;
  const liveProposals = run.proposals;
  // View-level errors not tied to a turn (e.g. a proposal action failing, or
  // asking for a report before a chat exists). Combined with the run's error.
  const [viewError, setViewError] = useState<string | null>(null);
  const error = run.error ?? viewError;
  const localId = useRef<string | null>(sessionId);
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
      .then((ps) => setModelName(ps.length ? ps[0].model || ps[0].name : null))
      .catch(() => {
        if (attempt < 3) setTimeout(() => refreshModel(attempt + 1), 2000);
      });

  // Fetch the model name once the sidecar is reachable (it isn't during the
  // brief startup, so a single mount-time fetch could miss it).
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
    // Guard against a switch race: if the user moved to another session while
    // this request was in flight, drop the stale result instead of clobbering
    // the now-current session's view.
    if (id !== localId.current) return;
    setDetail(d);
    setTriage(t);
  };

  useEffect(() => {
    // Only VIEW-local state is reset on session change. Run state (busy /
    // pending / streaming text / proposals / errors) lives per-session in the
    // sessionRuns store, so an in-flight turn keeps going and keeps its content
    // when you switch away and back — nothing to reset here.
    localId.current = sessionId;
    setText("");
    setImportHandoff(null);
    setReport(null);
    setSlashSel(0);
    setViewError(null);
    reload(sessionId);
    refreshModel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const m of detail?.messages ?? []) out.push({ kind: "message", ts: m.created_at, role: m.role, content: m.content, id: m.id, toolActivity: m.tool_activity });
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items.length, proposals.length, pending]);

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

  const ensureSession = async (seed: string): Promise<string> => {
    if (localId.current) return localId.current;
    const s = await createSession({ title: (seed || "New chat").slice(0, 80) });
    localId.current = s.id;
    onSessionCreated(s.id);
    return s.id;
  };

  // The blocking turn (also the streaming fallback). Returns true on a clean
  // answer; surfaces needKey / offline triage / error as the blocking path did.
  const sendBlocking = async (id: string, q: string, turnId?: string) => {
    try {
      const r = await postSessionMessage(id, q, turnId);
      patchSessionRun(id, { proposals: r.proposed_actions || [] });
    } catch (e) {
      const msg = String(e);
      if (/no model provider configured|no api key stored/i.test(msg)) {
        if (looksLikeError(q)) {
          await submitErrorTriage({ content: q, input_kind: "mixed", session_id: id });
        } else {
          patchSessionRun(id, { needKey: true });
        }
      } else {
        patchSessionRun(id, { error: cleanError(msg, t) });
      }
    }
  };

  // Send one turn (from the composer or programmatically). Streams the agent's
  // turn (live tool traces + token deltas); if the stream fails (provider
  // tool-call streaming is flaky, or no model → 422) it falls back to the
  // reliable blocking turn, which also handles the no-key / offline-triage cases.
  //
  // All run state is written to the sessionRuns store keyed by the id the turn
  // STARTED with — not the currently-visible session — so the turn keeps
  // streaming (and keeps its content) if the user switches sessions mid-run.
  const submit = async (q: string) => {
    if (!q || busy) return;
    setText("");
    let id: string;
    try {
      id = await ensureSession(q);
    } catch (e) {
      // Surface the failure (e.g. sidecar not ready) instead of silently dropping
      // the message, and keep the user's text so they can retry.
      setViewError(cleanError(String(e), t));
      setText(q);
      return;
    }
    // One turn id for this submit; the blocking fallback reuses it so the server
    // dedups (no duplicate turn or inline run if the stream broke mid-work).
    const turnId =
      (typeof crypto !== "undefined" && "randomUUID" in crypto)
        ? crypto.randomUUID()
        : `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    patchSessionRun(id, { busy: true, error: null, needKey: false, pending: q, streamText: null, streamTools: [] });
    try {
      try {
        const r = await streamSessionMessage(id, q, {
          onDelta: (chunk) => patchSessionRun(id, (s) => ({ streamText: (s.streamText ?? "") + chunk })),
          onTool: (rec) => patchSessionRun(id, (s) => ({ streamTools: [...s.streamTools, rec] })),
        }, undefined, turnId);
        patchSessionRun(id, { proposals: r.proposed_actions || [] });
      } catch {
        // Stream broke (or 422). Re-run via the blocking turn with the SAME turn
        // id; the server dedups, so this never duplicates the turn or an inline
        // run the failed stream had already started.
        await sendBlocking(id, q, turnId);
      }
      // Refresh the just-run session's thread only if it's the one on screen;
      // otherwise its persisted answer loads when the user switches back to it.
      if (localId.current === id) await reload(id);
      patchSessionRun(id, { pending: null, streamText: null, streamTools: [] });
      onChanged();
    } finally {
      patchSessionRun(id, { busy: false });
    }
  };

  // Composer file upload → agent-native analysis. The file is attached to the
  // SESSION, then the user's message is sent as a NORMAL agent turn. The agent
  // discovers the upload and analyzes it with its read-only analyze_uploaded_file
  // tool, then answers conversationally — no fixed deterministic analysis run, no
  // canned plan. (Codex/Cursor-style: attach a file, ask, the agent reasons.)
  const submitWithDataset = async (message: string, file: File, type: "inventory" | "access_log") => {
    let id: string;
    try {
      id = await ensureSession(message || file.name);
    } catch (e) {
      setViewError(cleanError(String(e), t));
      return;
    }
    const prompt = message || (type === "inventory"
      ? "Analyze this inventory file."
      : "Analyze this log file.");
    // Upload FIRST; only clear the composer once the file is safely stored, so a
    // failed upload doesn't lose the user's selected file.
    try {
      await uploadSessionDataset(id, file, type);
    } catch (e) {
      patchSessionRun(id, { error: cleanError(String(e), t) });
      return;  // keep the attachment + text so the user can retry
    }
    setText("");
    setAttached(null);
    setAttachType(null);
    // Hand the turn to the conversational agent (streams + falls back like any turn).
    await submit(prompt);
  };

  const send = () => {
    if (busy) return;
    if (attached) {
      const type = attachType ?? inferDatasetType(attached.name);
      if (!type) {
        // Ambiguous file type and not yet picked — tell the user to choose a
        // type (the picker chip is shown) instead of silently doing nothing.
        setViewError(t("attach.pickTypeHint"));
        return;
      }
      void submitWithDataset(text.trim(), attached, type);
      return;
    }
    submit(text.trim());
  };

  const onPickFile = (f: File | null) => {
    if (!f) return;
    const preset = presetTypeRef.current;
    presetTypeRef.current = null;
    setAttached(f);
    setAttachType(preset ?? inferDatasetType(f.name));
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
      submit(t(inlineKey));
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
        submit(p.title);
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

  // Slash commands: open when the composer is exactly "/" + word chars.
  const slashQ = /^\/(\w*)$/.exec(text)?.[1];
  const slashItems = slashQ !== undefined ? SLASH.filter((c) => c.cmd.startsWith(slashQ.toLowerCase())) : [];
  const slashOpen = slashItems.length > 0;
  const slashIdx = Math.min(slashSel, slashItems.length - 1);

  const selectSlash = (c: Slash) => {
    if (c.action === "report") {
      setText("");
      if (localId.current) getSessionReport(localId.current).then((r) => setReport(r.content)).catch((e) => setViewError(cleanError(String(e), t)));
      else setViewError(t("thread.startChatFirst"));
    } else if (c.cmd === "logs" || c.cmd === "inventory") {
      // Log/inventory analysis needs a local file → open the picker (same as the
      // empty-state chips), not just seed a prompt the agent has no file for.
      setText("");
      presetTypeRef.current = c.cmd === "logs" ? "access_log" : "inventory";
      fileRef.current?.click();
    } else if (c.promptKey) {
      setText(t(c.promptKey));
      requestAnimationFrame(() => taRef.current?.focus());
    }
    setSlashSel(0);
  };

  const isEmpty = items.length === 0 && !pending;

  const modelChip = (
    <button
      onClick={onOpenSettings}
      className={`group/chip flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11.5px] transition-colors ${
        modelName
          ? "border-edge text-gray-400 hover:border-edge-strong hover:text-gray-200"
          : "border-amber-800/40 text-amber-300/90 hover:border-amber-700/60 hover:text-amber-200"
      }`}
    >
      <Spark size={11} />
      <span className="max-w-[14rem] truncate">{modelName ?? t("thread.addModel")}</span>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-600 group-hover/chip:text-gray-400">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  );

  const composer = (
    <div className="relative rounded-[22px] border border-edge bg-panel px-3.5 pb-2.5 pt-3 shadow-elev transition-all duration-150 focus-within:border-edge-strong focus-within:shadow-pop focus-within:ring-4 focus-within:ring-accent/10">
      {slashOpen && (
        <div className="absolute bottom-full left-1 right-1 mb-2 overflow-hidden rounded-xl border border-edge bg-panel shadow-pop animate-fade-in">
          <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-gray-600">{t("thread.commands")}</div>
          {slashItems.map((c, i) => (
            <button
              key={c.cmd}
              onMouseEnter={() => setSlashSel(i)}
              onClick={() => selectSlash(c)}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${i === slashIdx ? "bg-hover" : "hover:bg-hover/50"}`}
            >
              <span className="font-mono text-[12px] text-accent-soft">/{c.cmd}</span>
              <span className="text-[13px] text-gray-300">{t(c.labelKey)}</span>
            </button>
          ))}
        </div>
      )}
      {attached && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-edge bg-elevated px-2.5 py-1.5 text-xs">
          <span className="text-gray-300">📎 {attached.name}</span>
          {attachType ? (
            <span className="rounded-full border border-edge px-2 py-0.5 text-[11px] text-gray-400">
              {attachType === "inventory" ? t("attach.inventory") : t("attach.accessLog")}
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <span className="text-gray-500">{t("attach.pickType")}</span>
              <button className="rounded-full border border-edge px-2 py-0.5 text-[11px] text-gray-300 hover:bg-hover"
                onClick={() => setAttachType("inventory")}>{t("attach.inventory")}</button>
              <button className="rounded-full border border-edge px-2 py-0.5 text-[11px] text-gray-300 hover:bg-hover"
                onClick={() => setAttachType("access_log")}>{t("attach.accessLog")}</button>
            </span>
          )}
          <button className="ml-auto text-gray-500 hover:text-gray-300"
            onClick={() => { setAttached(null); setAttachType(null); }} aria-label={t("common.cancel")}>✕</button>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept=".csv,.parquet,.tsv,.log,.txt,.gz"
        className="hidden"
        onChange={(e) => { onPickFile(e.target.files?.[0] ?? null); e.target.value = ""; }}
      />
      <textarea
        ref={taRef}
        className="block max-h-[220px] h-[22px] w-full resize-none bg-transparent px-1 text-[14px] leading-relaxed text-gray-100 placeholder:text-gray-600 focus:outline-none focus-visible:shadow-none"
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
        placeholder={t("thread.placeholder")}
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => { presetTypeRef.current = null; fileRef.current?.click(); }}
          disabled={busy}
          aria-label={t("attach.button")}
          title={t("attach.button")}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-gray-500 transition-colors hover:bg-hover hover:text-gray-300 disabled:cursor-default disabled:opacity-50"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        {modelChip}
        <span className="ml-auto hidden text-[11px] text-gray-600 sm:inline">
          <kbd className="font-sans">⏎</kbd> {t("thread.send")} · <kbd className="font-sans">⇧⏎</kbd> {t("thread.newline")}
        </span>
        <button
          onClick={send}
          disabled={busy || !text.trim()}
          aria-label={t("thread.send")}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent text-white transition-all hover:bg-accent-soft active:scale-95 disabled:cursor-default disabled:bg-elevated disabled:text-gray-600"
        >
          {busy ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          )}
        </button>
      </div>
    </div>
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
      {isEmpty ? (
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

          <div className="flex-1 overflow-auto px-6 py-7">
            <div className="mx-auto max-w-3xl space-y-6">
              {items.map((it) =>
                it.kind === "message" ? (
                  <MessageCard key={it.id} role={it.role} content={it.content} toolActivity={it.toolActivity} />
                ) : it.kind === "run" ? (
                  <RunCard key={it.data.run_id} run={it.data} />
                ) : (
                  <TriageCard key={it.data.id} c={it.data} onRun={runProposal} />
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

              {banners}

              {proposals.length > 0 && !pending && (
                <div className="flex flex-wrap items-center gap-2 pt-1.5">
                  <span className="text-[11.5px] text-gray-600">{t("thread.suggestedNext")}</span>
                  {proposals.map((p, i) => (
                    <ProposalCard key={`${propKey(p)}-${i}`} proposal={p} onRun={runProposal} />
                  ))}
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
