import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  forkSession,
  listModelProviders,
  prepareSessionAction,
} from "../api";
import type {
  Grounding,
  TokenUsage,
  NextAction,
  SessionDetail,
  ToolActivity,
  TriageCase,
  TurnMetricsRow,
} from "../types";
import { useSessionRun, patchSessionRun, getSessionRun } from "../sessionRuns";
import { loadDraft, saveDraft } from "../drafts";
import { useTurnRunner, cleanError } from "../hooks/useTurnRunner";
import { useSessionDocument } from "../hooks/useSessionDocument";
import { useThreadViewport } from "../hooks/useThreadViewport";
import { openWorkbenchRun, openWorkbenchSurface } from "../workbench/commands";
import { Button } from "./ui";
import { Composer } from "./Composer";
import { EvidenceImportDialog } from "./EvidenceImportDialog";
import { GroundingCard, MessageCard, ProposalCard, ThinkingBubble, TriageCard } from "./ThreadCards";
import { TurnFooter } from "./TurnFooter";
import { fmtDuration } from "./TurnMetrics";
import { useI18n } from "../i18n";
import { matches } from "../shortcuts";
import { clearFind, findRanges, paintFind } from "../lib/findHighlight";
import { stepHit } from "../threadFind";
import { inferDatasetType } from "../datasetType";
import { FindBar } from "./FindBar";


/** DOM id of the in-flight question, so the turn-context bar can scroll back to
 * it exactly as it does for a persisted one. Persisted messages use
 * `thread-item-<id>`; the pending question has no message id yet. */
const PENDING_QUESTION_ID = "thread-pending-question";

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
      referencedRunIds?: string[];
      referencedEvidenceIds?: string[];
    }
  | { kind: "run"; ts: string; data: SessionDetail["runs"][number] }
  | { kind: "triage"; ts: string; data: TriageCase };

const propKey = (p: NextAction) => `${p.action_type}::${p.title}`;

// The agent's full capability surface — not just error triage. Each seeds the
// composer with a natural-language prompt (localized); the agent routes from there.
const SUGGESTION_KEYS = ["diagnose", "logs", "inventory", "config", "account", "optimize"] as const;

export function Thread({
  sessionId,
  onSessionCreated,
  onSessionDiscarded,
  sidecarStatus,
  onOpenSettings,
  onChanged,
  sidecarReady,
  settingsOpen,
  reloadKey = 0,
}: {
  sessionId: string | null;
  onSessionCreated: (id: string) => void;
  onSessionDiscarded: (id: string) => void;
  /** Whether the backend is reachable. Everything the composer offers goes
   * through it, so a thread that does not know this cannot tell the truth. */
  sidecarStatus: "starting" | "connected" | "disconnected" | "error";
  onOpenSettings: () => void;
  onChanged: () => void;
  sidecarReady: boolean;
  settingsOpen: boolean;
  /** Bumped by the parent to force a thread reload without a session switch —
   * e.g. after the active session is renamed, so the header title refreshes. */
  reloadKey?: number;
}) {
  const { t } = useI18n();
  const {
    scrollRef, contentRef, pinned, onScroll, releaseToUser,
    jumpToLatest, resetPinned, followLatest,
  } = useThreadViewport();
  const [text, setTextState] = useState("");
  // Every composer write persists the draft for the session it belongs to
  // (v0.51.0). Done here rather than in an effect on purpose: an effect keyed on
  // [sessionId, text] fires once with the NEW session id and the OLD text on the
  // render where the switch lands, filing one session's draft under another's.
  // `localId.current` is updated at the top of the switch effect, before the
  // composer is repopulated, so it is always the session this text is for.
  const setText = (next: string) => {
    setTextState(next);
    saveDraft(localId.current, next);
  };
  const [importHandoff, setImportHandoff] = useState<
    { sourceType: "inventory" | "access_log"; accountRunId: string; bucketName: string } | null
  >(null);
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
  // A stale view-local error (failed proposal click / report open) must not
  // outlive the next turn: clear it whenever a new turn starts. (run.error is
  // already reset per turn; viewError previously persisted until session switch.)
  useEffect(() => {
    if (run.busy) setViewError(null);
  }, [run.busy]);
  const error = run.error ?? viewError;
  const {
    detail, triage, earlier, loadingEarlier, metrics, remoteTurn, loadError,
    localId, reload, loadEarlier, loadAllEarlier, hiddenCount,
  } = useSessionDocument({
    sessionId, sidecarReady, reloadKey, t, scrollRef, setViewError,
  });
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // Composer file attachment (dataset for inventory/access-log analysis). type is
  // auto-inferred from the extension; null means "ask" (show the 2-option chip).
  const [attached, setAttached] = useState<File | null>(null);
  const [attachType, setAttachType] = useState<"inventory" | "access_log" | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // One-shot: when a proposal opens the picker it presets the type; a plain 📎
  // attach leaves this null and the type is inferred from the filename.
  const presetTypeRef = useRef<"inventory" | "access_log" | null>(null);
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

  // Persisted metrics win once the reload has them; until then the live `done`
  // event's copy fills the gap, so the footer never lags the answer it describes.
  const metricsFor = (messageId: string): (TurnMetricsRow & { usage?: TokenUsage }) | null => {
    const persisted = metrics[messageId];
    if (persisted) return persisted;
    const live = run.lastMetrics;
    if (live && live.messageId === messageId) {
      const m = live.metrics;
      return {
        turn_id: null, message_id: messageId, model: m.model ?? null,
        duration_ms: m.duration_ms ?? null, tool_calls: m.tool_calls ?? null,
        budget_tokens: m.budget_tokens ?? null,
        repeat_calls_avoided: m.repeat_calls_avoided ?? null,
        created_at: "", usage: m.usage,
        ...(m.usage ?? {}),
      };
    }
    return null;
  };

  // Message actions. Both are deliberately ADDITIVE: they seed the composer and
  // start a NEW turn rather than rewriting or deleting a persisted message. The
  // thread is an audit record of what was actually asked and answered — an
  // "edit" that silently rewrote history would make the session inspector and
  // the turn metrics describe a conversation that never happened.
  const seedComposer = (text: string) => {
    setText(text);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  };
  /** The user question that produced the assistant message at `idx`. */
  const questionBefore = (idx: number): string | null => {
    for (let i = idx - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "message" && it.role === "user") return it.content ?? null;
    }
    return null;
  };

  // ⌘I / Ctrl+I is now a semantic Workbench navigation command.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "i") {
        if (settingsOpen || !localId.current) return;
        event.preventDefault();
        openWorkbenchSurface("evidence");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

  // The turn runner owns ensureSession / submit / dataset upload / stop; all
  // run state goes into the sessionRuns store keyed by the starting session id.
  const runner = useTurnRunner({
    getText: () => taRef.current?.value ?? "",
    localId,
    onSessionCreated,
    onSessionDiscarded,
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
    const failed = sessionId ? getSessionRun(sessionId).failedText : null;
    if (failed) {
      setText(failed);
      patchSessionRun(sessionId!, { failedText: null });
    } else {
      setText(loadDraft(sessionId));
    }
    setImportHandoff(null);
    setViewError(null);
    resetPinned();
    refreshModel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const m of [...earlier, ...(detail?.messages ?? [])])
      out.push({
        kind: "message", ts: m.created_at, role: m.role, content: m.content, id: m.id,
        toolActivity: m.tool_activity, grounding: m.grounding, proposals: m.proposed_actions,
        referencedRunIds: m.referenced_run_ids ?? [],
        referencedEvidenceIds: m.referenced_evidence_ids ?? [],
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
  }, [detail, triage, earlier]);

  // Proposals come ONLY from the agent's own answer (liveProposals). We no longer
  // fall back to the deterministic summary.next_actions menu — before the agent
  // has spoken the user sees capability chips, not a rule-engine menu. This keeps
  // the agent the sole source of suggested next steps.
  const proposals = liveProposals ?? [];

  // Branch a new investigation from one message (v0.61.0). The whole-session
  // fork has existed since v0.28.0; what was missing is the Cursor-style "take
  // it from here" — an investigation that went wrong at exchange 30 could only
  // be duplicated whole and unwound by hand. Both threads survive, which is the
  // point: the original is evidence, not a draft.
  const branchFrom = useCallback(
    async (messageId: string) => {
      if (!sessionId) return;
      try {
        const forked = await forkSession(sessionId, messageId);
        onSessionCreated(forked.id);
        onChanged();
      } catch (e) {
        setViewError(cleanError(String(e), t));
      }
    },
    [sessionId, onSessionCreated, onChanged, t],
  );

  // --- find in thread (v0.58.0) ---------------------------------------------
  // The command palette searches session titles; nothing searched what was
  // actually said. Eighty turns into an investigation that is the difference
  // between a record and a wall of text.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIdx, setFindIdx] = useState(0);
  // A new query starts from the top rather than keeping a cursor that pointed
  // into the previous result set.
  useEffect(() => setFindIdx(0), [findQuery]);

  /* Every occurrence, not every message that has one.
   *
   * The counter summed occurrences while the cursor stepped messages, so an
   * answer with twelve mentions was one stop out of eight and next/previous
   * wrapped long before reaching the total the bar was displaying. `findRanges`
   * produces the unit the counter always claimed to use, and painting them is
   * what makes stepping mean anything on a two-thousand-word answer.
   *
   * Recomputed when the query changes and when the thread's own content does —
   * a streamed delta, a loaded earlier page — because a Range holds a text node
   * that a re-render can replace. */
  const [ranges, setRanges] = useState<Range[]>([]);
  const matchTotal = ranges.length;
  useEffect(() => {
    if (!findOpen) {
      clearFind();
      setRanges([]);
      return;
    }
    const root = scrollRef.current;
    if (!root) return;
    const found = findQuery.trim().length >= 2 ? findRanges(root, findQuery) : [];
    setRanges(found);
    return () => clearFind();
  }, [findOpen, findQuery, items, earlier.length, streamText]);

  const activeRange = matchTotal ? ranges[Math.min(findIdx, matchTotal - 1)] : null;
  useEffect(() => {
    if (!findOpen) return;
    paintFind(ranges, Math.min(findIdx, Math.max(0, matchTotal - 1)));
  }, [findOpen, ranges, findIdx, matchTotal]);
  useEffect(() => {
    if (!findOpen || !activeRange) return;
    const raf = requestAnimationFrame(() => {
      // A Range cannot be scrolled to directly; its first client rect can, via
      // the element that owns it. `center` keeps the match clear of the find
      // bar, which floats over the top of the thread.
      const el = activeRange.startContainer.parentElement;
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(raf);
  }, [findOpen, activeRange]);

  const stepFind = useCallback(
    (delta: number) => setFindIdx((i) => stepHit(i, matchTotal, delta)),
    [matchTotal],
  );
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery("");
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matches(e, "find")) return;
      e.preventDefault();
      // Re-pressing the chord while open re-focuses the field rather than
      // toggling it shut — the browser behaviour every user already has.
      setFindOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    followLatest();
  }, [items.length, proposals.length, pending, streamText?.length, streamTools.length, followLatest]);

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
    if (localId.current) openWorkbenchSurface("report");
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
    // Cut-short-turn continuation (server injects this proposal): one click
    // sends a localized "carry on where you left off" prompt to the agent.
    continue_investigation: "act.continueInvestigation",
  };

  const runProposal = async (p: NextAction) => {
    // A chip click during a running turn used to silently no-op at the submit
    // latch. For prompt-shaped proposals, steer instead (the click becomes a
    // redirect of the running turn); for picker/report proposals, wait it out.
    if (run.busy) {
      const key = INLINE_ACTION_PROMPT[p.action_type];
      if (key) void runner.steer(t(key));
      return;
    }
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
        openWorkbenchSurface("report");
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

  // A session is OPEN but its content has not arrived yet. That is not an empty
  // chat, and rendering the start surface for it told a returning user "there is
  // nothing here" about an investigation that was right there — the exact
  // sentence to avoid showing someone who just reopened the app. The thread
  // shell (header + composer) renders instead, and the messages appear in it.
  const loadingSession = Boolean(sessionId) && detail?.id !== sessionId && !loadError;
  const isEmpty = items.length === 0 && !pending && !loadError && !loadingSession;

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

  // The backend is gone, and the interface must stop implying otherwise.
  //
  // Measured before this: with `/health` failing, the ONLY signal anywhere on
  // screen was an 8px dot at the bottom of the rail reading "Disconnected".
  // The composer still invited a question, the starting points still invited a
  // click, and the send button was still the accent colour. Every one of those
  // actions goes through the sidecar; every one of them would have failed.
  const offline = sidecarStatus === "disconnected" || sidecarStatus === "error";

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
      offline={offline}
      uploading={uploading}
      onSend={send}
      // Called, not passed: `stop` takes an optional session id, and handing it
      // straight to onClick fed it the click EVENT, which is not a session id —
      // so it looked up a turn that could not exist and returned silently.
      onStop={() => runner.stop()}
      onSteer={() => {
        // A pending attachment rides along on a redirect (via the dataset-upload
        // path) instead of being silently dropped — same rules as send().
        if (attached) {
          const type = attachType ?? inferDatasetType(attached.name);
          if (!type) {
            setViewError(t("attach.pickTypeHint"));
            return;
          }
          void runner.steer(text.trim(), () => runner.submitWithDataset(text.trim(), attached, type));
          return;
        }
        if (text.trim()) void runner.steer(text.trim());
      }}
      modelName={modelName}
      onOpenSettings={onOpenSettings}
      onSlashReport={openReport}
      onSlashPickFile={(type) => {
        presetTypeRef.current = type;
        fileRef.current?.click();
      }}
    />
  );

  /* Screen-reader narration for a surface that is otherwise entirely visual
   * (v0.51.0). A streaming answer, a finished turn and a failed turn produced no
   * announcement at all before this — the only aria-live region in the app was
   * the toast host. The region reports STATE TRANSITIONS, not the answer text:
   * announcing a token stream character by character is worse than silence, and
   * the finished answer is already reachable in the normal reading order. */
  const liveStatus = needKey
    ? t("a11y.needKey")
    : error
      ? t("a11y.turnFailed")
      : run.stopped
        ? t("thread.stoppedByUser")
        : busy
          ? t("a11y.working")
          : lastPersisted
            ? t("a11y.answerReady")
            : "";

  const banners = (
    <>
      {offline && (
        <div
          data-testid="offline-banner"
          className="animate-fade-in-up rounded-xl border border-danger-border bg-danger-bg p-3.5 text-sm text-danger"
        >
          {t("thread.offline")}
          <div className="mt-1 text-xs text-gray-400">{t("thread.offlineHint")}</div>
        </div>
      )}
      {needKey && (
        <div className="animate-fade-in-up rounded-xl border border-warn-border bg-warn-bg p-3.5 text-sm text-warn-fg">
          {t("thread.needKey")}
          <div className="mt-2.5">
            <Button variant="primary" size="sm" onClick={onOpenSettings}>{t("thread.needKeyBtn")}</Button>
          </div>
        </div>
      )}
      {error && (
        <div className="animate-fade-in-up rounded-xl border border-danger-border bg-danger-bg p-3.5 text-sm">
          {/* What failed, then what the service said.
            *
            * `cleanError` turns the shapes it recognises into an actionable
            * sentence and passes everything else through verbatim — so an
            * unrecognised failure reached the user as the raw `detail` and
            * nothing else. Captured from a 500: the entire message on screen
            * was the word "boom", above two buttons. The detail is worth
            * keeping (it is what you would paste into a bug report); it is not
            * worth being the whole explanation. */}
          <div className="font-medium text-danger">{t("thread.errTitle")}</div>
          <div className="mt-1 break-words text-xs text-gray-300">{error}</div>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {/* Retry re-sends the message (the failed turn restored it into the
                composer), so a transient/network error isn't a dead-end whose
                only action is the often-irrelevant "Open settings". */}
            {text.trim() && (
              <Button variant="primary" size="sm" onClick={send}>{t("thread.retry")}</Button>
            )}
            <Button variant="default" size="sm" onClick={onOpenSettings}>{t("common.openSettings")}</Button>
          </div>
        </div>
      )}
    </>
  );

  return (
    /* The conversation is the app's main landmark. It had none: the whole shell
       was anonymous <div>s, so a screen reader offered no way to skip the rail
       and jump to what was actually said — and a test asserting "in the thread"
       had nothing to scope to and silently matched the rail instead. */
    <main aria-label={t("a11y.conversation")} className="flex h-full flex-1 flex-col bg-canvas">
      {loadError ? (
        /* Loading an existing session failed — show an explicit error + retry
           instead of silently presenting the empty new-chat surface (M6). */
        <div className="flex flex-1 items-center justify-center px-6 py-10">
          <div className="w-full max-w-md animate-fade-in-up rounded-xl border border-danger-border bg-danger-bg p-5 text-center">
            <div className="text-base font-medium text-danger">{t("thread.loadFailed")}</div>
            <div className="mt-1.5 text-xs text-danger/80">{loadError}</div>
            <div className="mt-3.5 flex justify-center">
              <Button variant="primary" size="sm" onClick={() => reload(localId.current)}>
                {t("thread.retry")}
              </Button>
            </div>
          </div>
        </div>
      ) : isEmpty ? (
        /* New chat is a work surface, not a poster: keep the action cluster in
           the upper reading band so the composer is where the eye starts, while
           leaving one spacing-scale step of deliberate air above it. Vertical
           centring made this ~300px block float between two large empty regions
           on a 900px window — the final known gap from the v0.90 visual pass. */
        <div className="flex flex-1 items-start justify-center overflow-auto px-6 pb-10 pt-20">
          <div className="w-full max-w-[44rem] animate-fade-in-up">
            <div className="mb-7 flex flex-col items-center text-center">
              <h1 className="text-2xl font-semibold tracking-[-0.02em] text-gray-100">{t("thread.greeting")}</h1>
              <p className="mt-2.5 max-w-md text-sm leading-relaxed text-gray-500">
                {t("thread.subtitle")}
              </p>
            </div>
            {composer}
            {/* Starting points, not a button bar.
              *
              * Six identical pills in a centred cloud give six things equal
              * weight and none of them a shape — the eye has nowhere to land,
              * which is why an empty state built from them reads as unfinished
              * however carefully the pills are styled. A left-aligned list under
              * the composer, each row a verb with a quiet arrow, is scannable in
              * one pass and puts the first one where reading already starts. */}
            <div className="mt-5">
              <div className="mb-1.5 px-1 text-2xs font-medium uppercase tracking-[0.08em] text-gray-500">
                {t("thread.startWith")}
              </div>
              {/* A list, which is what the note above says it is — it was drawn
                * as a table. `gap-px` over a `bg-edge` ground with an outer
                * border puts a rule between all six cells and a box around the
                * lot, so six suggestions read as a spreadsheet with the
                * gridlines left on. Rows, hover, nothing else. */}
              <div className="grid sm:grid-cols-2">
                {suggestions.map((s) => (
                  <button
                    key={s.key}
                    onClick={() => onSuggestion(s.key, s.prompt)}
                    disabled={offline}
                    className="group flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-gray-300 transition-colors hover:bg-hover hover:text-gray-100 disabled:cursor-default disabled:text-gray-500 disabled:hover:bg-transparent"
                  >
                    {/* The arrow belongs to the words, not to the far edge of
                      * the cell: `flex-1` on the label parked it 320px to the
                      * right of the phrase it points at, which reads as two
                      * unrelated things on one row. It also only appears on
                      * hover — six permanent arrows are six pieces of chrome
                      * saying what a row already says. */}
                    <span className="min-w-0 truncate">{s.label}</span>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden
                         className="shrink-0 text-gray-400 opacity-0 transition-opacity group-hover:opacity-100">
                      <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                    </svg>
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-4 space-y-2">{banners}</div>
          </div>
        </div>
      ) : (
        <>
          {/* The scroller and the things that float OVER it, in a positioned
            * box of its own. The bar below must not live inside the scroller:
            * everything in there — even a zero-height sticky element — is part
            * of the content whose height the thread's convergence run measures,
            * and that run re-jumps to the bottom every frame until the height
            * holds still. A bar that mounts and unmounts as a function of
            * scroll position is therefore a height that changes as a function
            * of scroll position, which is a feedback loop with the one piece of
            * machinery this file warns hardest about. Out here it cannot touch
            * `scrollHeight` at all — the same reason "jump to latest" has always
            * been rendered next to the composer rather than in the thread. */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              ref={scrollRef}
              data-testid="thread-scroll"
              onScroll={onScroll}
              onWheel={releaseToUser}
              onTouchMove={releaseToUser}
              onKeyDown={releaseToUser}
              className="flex-1 overflow-auto px-6 py-7"
            >
            {findOpen && (
              <FindBar
                query={findQuery}
                onQuery={setFindQuery}
                total={matchTotal}
                index={findIdx}
                onStep={stepFind}
                onClose={closeFind}
              />
            )}
            {/* Wider than the reading measure on purpose. The column is what a
              * TABLE gets; prose inside an answer is capped separately by
              * `.thread-prose` (index.css), so a paragraph stays at a readable
              * line length while a twelve-column table can use the room that
              * was previously empty margin. */}
            <div ref={contentRef} className="mx-auto max-w-[min(64rem,100%)] space-y-6">
              {hiddenCount > 0 && (
                <div className="flex justify-center">
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={loadEarlier}
                      disabled={loadingEarlier}
                      data-testid="load-earlier"
                      className="rounded-full border border-edge px-3 py-1.5 text-2xs text-gray-500 transition-colors hover:border-edge-strong hover:text-gray-200 disabled:opacity-50"
                    >
                      {loadingEarlier ? t("thread.loadingEarlier") : t("thread.loadEarlier", { n: hiddenCount })}
                    </button>
                    <button
                      type="button"
                      onClick={loadAllEarlier}
                      disabled={loadingEarlier}
                      data-testid="jump-to-start"
                      className="rounded-full border border-edge px-3 py-1.5 text-2xs text-gray-500 transition-colors hover:border-edge-strong hover:text-gray-200 disabled:opacity-50"
                    >
                      {t("thread.jumpToStart")}
                    </button>
                  </div>
                </div>
              )}
              {items.map((it, idx) => {
                return it.kind === "message" ? (
                  <div
                    key={it.id}
                    id={`thread-item-${it.id}`}
                    // A turn is a question and its answer. The thread used to
                    // space every item the same 24px, so a new question read as
                    // no more of a break than the paragraph above it and a long
                    // investigation became one undifferentiated column. Padding
                    // rather than margin: the container's `space-y` already owns
                    // margins, and two rules fighting over the same box is how
                    // spacing bugs start.
                    className={`thread-item space-y-3 ${
                      it.role === "user" && idx > 0 ? "pt-6" : ""
                    }`}
                    // The sticky turn-context bar finds questions by this
                    // attribute rather than by walking the item list, so it does
                    // not need to know the list's shape — which is what keeps it
                    // additive to a thread whose scroll behaviour has been hard
                    // won (see e2e/landing.spec.ts).
                    data-question={it.role === "user" ? (it.content ?? "") : undefined}
                  >
                    <MessageCard
                      role={it.role}
                      content={it.content}
                      toolActivity={it.toolActivity}
                      onEdit={it.role === "user" && !busy ? seedComposer : undefined}
                      onBranch={
                        it.role === "user" && !busy && sessionId
                          ? () => void branchFrom(it.id)
                          : undefined
                      }
                      onRegenerate={
                        it.role === "assistant" && !busy && questionBefore(idx)
                          ? () => seedComposer(questionBefore(idx) as string)
                          : undefined
                      }
                      referencedRunIds={it.referencedRunIds}
                      referencedEvidenceIds={it.referencedEvidenceIds}
                    />
                    {/* ONE affordance for the whole turn (v0.49.0): what it ran,
                        how long it took, what it cost, and what it was grounded
                        in — previously three separate expanders, two of which
                        described the same tool calls in different words on
                        opposite sides of the answer. */}
                    {/* Capped to the same reading measure as the answer above
                      * it. The footer sits outside `.thread-prose`, so it was
                      * laid out across the full 64rem column while the answer
                      * used 46rem: a trace row put `head_bucket · bucket-2` on
                      * the left and its `200` at x=1340, with 800px of nothing
                      * between a call and its own result. */}
                    {it.role === "assistant" && (
                      <div className="max-w-[min(46rem,100%)]">
                      <TurnFooter
                        latest={it.id === lastAssistant?.id}
                        tools={it.toolActivity}
                        grounding={it.grounding}
                        durationMs={metricsFor(it.id)?.duration_ms}
                        usage={metricsFor(it.id)?.usage ?? metricsFor(it.id) ?? undefined}
                        model={metricsFor(it.id)?.model}
                        budgetTokens={metricsFor(it.id)?.budget_tokens}
                        repeatCallsAvoided={metricsFor(it.id)?.repeat_calls_avoided}
                        sessionId={sessionId}
                        onOpenInspector={() => openWorkbenchSurface("evidence")}
                      />
                      </div>
                    )}
                    {it.proposals && it.proposals.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2 pt-0.5">
                        <span className="text-2xs text-gray-500">{t("thread.suggestedNext")}</span>
                        {it.proposals.map((p, i) => (
                          <ProposalCard key={`${propKey(p)}-${i}`} proposal={p} onRun={runProposal} />
                        ))}
                      </div>
                    )}
                  </div>
                ) : it.kind === "run" ? (
                  <button
                    key={it.data.run_id}
                    type="button"
                    data-testid="timeline-run-link"
                    onClick={() => openWorkbenchRun(it.data.run_id)}
                    className="thread-item flex w-full items-center gap-3 border-y border-edge/70 py-3 text-left text-xs transition-colors hover:bg-hover/30"
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-gray-500" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-gray-300">{it.data.title || it.data.run_type}</span>
                    <span className="font-mono text-2xs uppercase text-gray-500">{it.data.status}</span>
                    <span className="text-gray-500" aria-hidden>→</span>
                  </button>
                ) : (
                  <div key={it.data.id} className="thread-item">
                    <TriageCard c={it.data} onRun={runProposal} />
                  </div>
                );
              })}

              {/* A turn this client did not start is still running server-side
                  (v0.51.0). Not the local "thinking" bubble: there is no stream
                  to attach to and no partial text to show — only the honest
                  fact that work is in flight, and the answer when it lands. */}
              {!pending && remoteTurn?.running && (
                <div
                  data-testid="remote-turn"
                  className="animate-fade-in flex items-center gap-2 rounded-lg border border-edge bg-panel/60 px-3 py-2 text-xs text-gray-400"
                >
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
                  {t("thread.remoteTurn", {
                    age: fmtDuration(remoteTurn.age_ms ?? null) ?? "—",
                  })}
                </div>
              )}

              {pending && (
                <>
                  {/* Tagged the same way a persisted question is, and for the
                    * same reason. This branch renders the question of the turn
                    * that is CURRENTLY STREAMING — the longest an answer is ever
                    * left unread, and the one case the first version of the
                    * turn-context bar missed: with no `data-question` here, a
                    * first turn showed no bar at all, and a later turn showed
                    * the PREVIOUS question, labelling the answer you are
                    * reading with someone else's question. Caught in review on
                    * this PR. */}
                  <div id={PENDING_QUESTION_ID} data-question={pending}>
                    <MessageCard role="user" content={pending} />
                  </div>
                  {streamText !== null || streamTools.length ? (
                    <>
                      <MessageCard
                        role="assistant"
                        content={streamText ?? ""}
                        toolActivity={streamTools}
                        streaming={!run.stopped}
                        sessionId={sessionId}
                      />
                      {run.stopped && (
                        <div className="flex items-center gap-1.5 text-2xs text-gray-500">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <rect x="6" y="6" width="12" height="12" rx="2" />
                          </svg>
                          {t("thread.stoppedByUser")}
                        </div>
                      )}
                    </>
                  ) : run.stopped ? (
                    <div className="flex items-center gap-1.5 text-2xs text-gray-500">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <rect x="6" y="6" width="12" height="12" rx="2" />
                      </svg>
                      {t("thread.stoppedByUser")}
                    </div>
                  ) : run.stalled ? (
                    /* Gave up polling a still-running turn — offer a reload
                       instead of an eternal "thinking" spinner (the answer may
                       already be persisted server-side). */
                    <div className="animate-fade-in rounded-lg border border-edge bg-panel/60 p-3 text-xs text-gray-400">
                      {t("thread.stalled")}
                      <div className="mt-2">
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => {
                            const id = localId.current;
                            if (!id) return;
                            patchSessionRun(id, { pending: null, stalled: false, streamText: null, streamTools: [] });
                            void reload(id);
                          }}
                        >
                          {t("thread.reload")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <ThinkingBubble />
                  )}
                </>
              )}

              {/* Visually hidden, announced. */}
              <p className="sr-only" role="status" aria-live="polite" data-testid="turn-status">
                {liveStatus}
              </p>

              {banners}

              {/* Session-level findings used to render here, at the BOTTOM of a
                  time-ordered thread — where they read as the newest event
                  rather than as standing session state. They live in the
                  inspector now (v0.49.0), next to the rest of the session's
                  cross-cutting record. */}

              {/* Grounding + proposals normally render per assistant message
                  (above), sourced from the persisted turn so they survive a
                  reload. This live block covers the just-completed turn before
                  the reload persists those fields onto the message (H1). */}
              {showLiveGrounding && (
                <div className="space-y-3">
                  {run.grounding && <GroundingCard g={run.grounding} />}
                  {proposals.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 pt-0.5">
                      <span className="text-2xs text-gray-500">{t("thread.suggestedNext")}</span>
                      {proposals.map((p, i) => (
                        <ProposalCard key={`${propKey(p)}-${i}`} proposal={p} onRun={runProposal} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            </div>

          </div>

          <div className="relative px-6 pb-5 pt-1">
            {/* Jump to latest. Sits just above the composer, appears only when
                you have scrolled away, and says whether the agent is still
                writing — so leaving the bottom is a choice, not a trap. */}
            {!pinned && (
              <div className="pointer-events-none absolute -top-11 left-0 right-0 flex justify-center">
                <button
                  type="button"
                  onClick={jumpToLatest}
                  data-testid="jump-to-latest"
                  className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-edge bg-elevated/95 px-3 py-1.5 text-2xs text-gray-300 shadow-elev backdrop-blur transition-colors hover:border-edge-strong hover:text-gray-100 animate-fade-in-up"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <polyline points="19 12 12 19 5 12" />
                  </svg>
                  {busy ? t("thread.jumpWriting") : t("thread.jumpLatest")}
                </button>
              </div>
            )}
            {/* The composer is the same width as the answers it produces.
              *
              * It spanned the full 64rem column while prose is capped at the
              * 46rem reading measure, so what you typed was 1024px wide and
              * what came back was 736px — the input and the output of the same
              * conversation set to two different measures, with the composer
              * running 290px further right than every answer above it. The
              * wider track exists for DATA (a table, a chart) to bleed into,
              * not for the text column to wander in. */}
            <div className="mx-auto max-w-[min(64rem,100%)]">
              <div className="max-w-[min(46rem,100%)]">{composer}</div>
            </div>
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

    </main>
  );
}

