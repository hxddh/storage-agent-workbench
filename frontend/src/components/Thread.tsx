import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  correctSessionMemory,
  forkSession,
  getSession,
  getSessionMessages,
  getSessionOverview,
  getSessionReport,
  getSessionTriage,
  getSessionTurnState,
  listModelProviders,
  prepareSessionAction,
  resolveSessionMemory,
} from "../api";
import type {
  Grounding,
  TokenUsage,
  NextAction,
  SessionDetail,
  SessionMessage,
  SessionTurnState,
  ToolActivity,
  TriageCase,
  TurnMetricsRow,
} from "../types";
import { saveTextFile } from "../config";
import { useSessionRun, patchSessionRun, getSessionRun } from "../sessionRuns";
import { loadDraft, saveDraft } from "../drafts";
import { useTurnRunner, cleanError } from "../hooks/useTurnRunner";
import { Button } from "./ui";
import { Markdown } from "./Markdown";
import { Composer } from "./Composer";
import { EvidenceImportDialog } from "./EvidenceImportDialog";
import { GroundingCard, MessageCard, ProposalCard, RunCard, ThinkingBubble, TriageCard, copyText } from "./ThreadCards";
import { SessionInspector } from "./SessionInspector";
import { TurnFooter } from "./TurnFooter";
import { fmtDuration } from "./TurnMetrics";
import { useI18n } from "../i18n";
import { matches } from "../shortcuts";
import { findInThread, stepHit } from "../threadFind";
import { answerGist } from "../answerGist";
import { inferDatasetType } from "../datasetType";
import { FindBar } from "./FindBar";

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
  reloadKey = 0,
}: {
  sessionId: string | null;
  onSessionCreated: (id: string) => void;
  onOpenSettings: () => void;
  onChanged: () => void;
  sidecarReady: boolean;
  settingsOpen: boolean;
  /** Bumped by the parent to force a thread reload without a session switch —
   * e.g. after the active session is renamed, so the header title refreshes. */
  reloadKey?: number;
}) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [triage, setTriage] = useState<TriageCase[]>([]);
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
  const [report, setReport] = useState<string | null>(null);
  const [reportCopied, setReportCopied] = useState(false);
  const [reportSavedPath, setReportSavedPath] = useState<string | null>(null);
  const [modelName, setModelName] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  // Set when the inspector was opened FROM a turn: the [from, to] window whose
  // rows it highlights and scrolls to. Cleared on close.
  const [inspectorAnchor, setInspectorAnchor] = useState<{ from: string; to: string } | null>(null);
  // The EXACT call ids that turn produced (v0.57.0). v0.55.0 gave every activity
  // record the same id as its persisted row; this is what makes "inspect" land
  // on precisely this turn's calls instead of everything in its wall-clock
  // window, which also catches a concurrently-running inline run.
  const [inspectorAnchorIds, setInspectorAnchorIds] = useState<ReadonlySet<string> | null>(null);
  // Pages fetched by "load earlier", oldest-first, held separately from
  // `detail.messages` (the tail) so a reload can refresh the tail without
  // discarding history the user deliberately pulled in.
  const [earlier, setEarlier] = useState<SessionMessage[]>([]);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // Turns the user has explicitly re-opened. Old turns collapse to one line so
  // scrolling back through a long investigation is scannable rather than a wall
  // of prose; expanding is per-turn and sticky for the session.
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(() => new Set());
  // Persisted per-turn metrics, keyed by the assistant message they belong to,
  // so the footer under an OLD answer still shows what that turn cost.
  const [metrics, setMetrics] = useState<Record<string, TurnMetricsRow>>({});
  // A turn running server-side that THIS client did not start (a reload mid-turn,
  // or a second window). Mirrored into a ref so the poll's closure can tell
  // "ended" from "was never running" without re-subscribing.
  const [remoteTurn, setRemoteTurn] = useState<SessionTurnState | null>(null);
  const remoteTurnRef = useRef<SessionTurnState | null>(null);
  remoteTurnRef.current = remoteTurn;

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
  // Set when loading an EXISTING session fails, so we show an explicit error +
  // retry instead of silently rendering the empty new-chat surface (M6).
  const [loadError, setLoadError] = useState<string | null>(null);
  const localId = useRef<string | null>(sessionId);
  // Tracks which session id the loaded `detail` belongs to, so a failed refresh
  // for the current session doesn't get mistaken for a first-load failure.
  const loadedIdRef = useRef<string | null>(null);
  // Monotonic reload token: a stale in-flight reload must never overwrite a newer
  // one for the same session (F2). Captured at call start, checked after await.
  const reloadSeqRef = useRef(0);
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

  // Returns true iff it actually applied fresh session detail for `id`. Callers
  // (post-turn cleanup) rely on this: a transient failure that keeps the stale
  // thread must NOT be treated as a successful reload, or they'd clear the
  // streamed answer bubble and the just-completed answer would vanish (F1).
  const reload = async (id: string | null): Promise<boolean> => {
    if (id !== loadedIdRef.current) setEarlier([]);
    if (!id) {
      setDetail(null);
      setTriage([]);
      setLoadError(null);
      return false;
    }
    const seq = ++reloadSeqRef.current;
    let d: SessionDetail | null = null;
    let failed: string | null = null;
    const [dRes, tRes] = await Promise.allSettled([getSession(id), getSessionTriage(id)]);
    if (dRes.status === "fulfilled") d = dRes.value;
    // Session-load failures get a NEUTRAL message — the model-provider hints
    // (bad key / model 404) only apply to turn failures (D2).
    else failed = cleanError(String(dRes.reason), t, "load");
    const triageCases = tRes.status === "fulfilled" ? tRes.value.cases : [];
    // Drop the result if the user switched sessions OR a newer reload for this
    // session has since started (F2 last-writer-wins guard).
    if (id !== localId.current || seq !== reloadSeqRef.current) return false;
    if (d) {
      loadedIdRef.current = id;
      setDetail(d);
      setLoadError(null);
      // Best-effort: the thread must still render if the overview call fails.
      void getSessionOverview(id)
        .then((o) => {
          if (id !== localId.current) return;
          const byId: Record<string, TurnMetricsRow> = {};
          for (const row of o.turns) if (row.message_id) byId[row.message_id] = row;
          setMetrics(byId);
        })
        .catch(() => undefined);
      if (tRes.status === "fulfilled") setTriage(triageCases);
      return true;
    }
    if (failed) {
      // A transient refresh blip for the session we're already showing shouldn't
      // wipe the populated thread — keep it. Otherwise (no content for this id)
      // surface an explicit error + retry instead of the empty new-chat surface.
      if (loadedIdRef.current !== id) {
        setDetail(null);
        setLoadError(failed);
      }
    }
    // Only replace triage cards when the fetch actually succeeded — a transient
    // failure used to flash them out of the thread until the next reload.
    if (tRes.status === "fulfilled") setTriage(triageCases);
    return false;
  };

  // How many messages exist above what is currently rendered. `message_total`
  // comes from the server, so this is a fact rather than a guess.
  // Only the most recent exchanges stay open. Anything older is one line until
  // asked for — the same move Codex makes on a long session.
  const OPEN_TAIL = 6;
  const shownCount = (earlier.length + (detail?.messages?.length ?? 0));
  const hiddenCount = Math.max(0, (detail?.message_total ?? shownCount) - shownCount);

  /** Reattach to a turn this client did not start.
   *
   * Run state lives in the client's memory, so reloading the app (or opening the
   * session in a second window) while a turn is generating showed an idle
   * session — while the worker kept running and kept spending. The server knows;
   * this asks it.
   *
   * One check per session switch and per return-to-foreground, then a short poll
   * only WHILE a turn is known to be running: a turn cannot start without this
   * client's knowledge except through those two doors, so idle polling would buy
   * nothing. When it ends, the answer is persisted — reload and show it.
   */
  useEffect(() => {
    if (!sessionId || !sidecarReady) return;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      if (stopped) return;
      // Our own in-flight turn already renders live; never report it twice.
      if (getSessionRun(sessionId).busy) {
        setRemoteTurn(null);
        return;
      }
      let state: SessionTurnState | null = null;
      try {
        state = await getSessionTurnState(sessionId);
      } catch {
        // A sidecar blip is not evidence that nothing is running; try again on
        // the next door rather than clearing a banner that may be true.
        return;
      }
      if (stopped || localId.current !== sessionId) return;
      if (state.running) {
        setRemoteTurn(state);
        timer = window.setTimeout(tick, 3000);
      } else {
        // It ended (or never ran). If we were tracking one, its answer is
        // persisted now.
        if (remoteTurnRef.current) void reload(sessionId);
        setRemoteTurn(null);
      }
    };
    void tick();
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sidecarReady]);

  /** Correct one of the agent's memory items, in place.
   *
   * The agent replays its memory into every later turn, so this is not
   * cosmetic: an uncorrected wrong fact keeps steering the investigation. The
   * server returns the refreshed detail, which is what the panel re-renders
   * from. */
  const correctMemory = async (memId: string, next: string) => {
    const id = localId.current;
    if (!id) return;
    try {
      setDetail(await correctSessionMemory(id, memId, next));
    } catch (e) {
      setViewError(String((e as Error)?.message ?? e));
    }
  };

  const resolveMemory = async (memId: string) => {
    const id = localId.current;
    if (!id) return;
    try {
      setDetail(await resolveSessionMemory(id, memId));
    } catch (e) {
      setViewError(String((e as Error)?.message ?? e));
    }
  };

  /** Pull every remaining older page in one go.
   *
   * A thousand-turn session is ~17 clicks of "load earlier" to reach the start,
   * which is not a scroll — it is a chore. The pages are fetched in sequence
   * (each needs the previous cursor) and bounded by the same server caps.
   */
  const loadAllEarlier = async () => {
    const id = localId.current;
    if (!id || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      let cursor = (earlier[0] ?? detail?.messages?.[0])?.seq;
      const collected: SessionMessage[] = [];
      // Bounded loop: the server page size is fixed, so this terminates on
      // has_more; the cap is a backstop against a pathological cursor.
      for (let i = 0; i < 200 && cursor != null; i++) {
        const page = await getSessionMessages(id, { before: cursor });
        if (id !== localId.current) return;
        if (page.messages.length === 0) break;
        collected.unshift(...page.messages);
        cursor = page.messages[0]?.seq ?? undefined;
        if (!page.has_more) break;
      }
      setEarlier((prev) => [...collected, ...prev]);
      // Land at the top, which is what "jump to start" means.
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" }));
    } catch (e) {
      setViewError(String((e as Error)?.message ?? e));
    } finally {
      setLoadingEarlier(false);
    }
  };

  const loadEarlier = async () => {
    const id = localId.current;
    if (!id || loadingEarlier) return;
    const oldest = (earlier[0] ?? detail?.messages?.[0])?.seq;
    if (oldest == null) return;
    setLoadingEarlier(true);
    try {
      const page = await getSessionMessages(id, { before: oldest });
      // Guard against a session switch mid-fetch.
      if (id !== localId.current) return;
      // Anchor the scroll: prepending content would otherwise yank the reader
      // upward by exactly the height of what was just inserted.
      const el = scrollRef.current;
      const before = el ? el.scrollHeight - el.scrollTop : 0;
      setEarlier((prev) => [...page.messages, ...prev]);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - before;
      });
    } catch (e) {
      setViewError(String((e as Error)?.message ?? e));
    } finally {
      setLoadingEarlier(false);
    }
  };

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

  /** The wall-clock window one turn occupied: from the question that started it
   * to the answer that ended it. Everything the agent did for that turn — every
   * tool call, every audit row — happened inside it, so this is what the
   * inspector highlights when "inspect" is clicked from that turn's footer.
   * Timestamps are fixed-width ISO-8601 Z, so string order IS chronological. */
  const turnWindow = (idx: number): { from: string; to: string } | null => {
    const end = items[idx];
    if (!end || end.kind !== "message") return null;
    for (let i = idx - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "message" && it.role === "user") return { from: it.ts, to: end.ts };
    }
    return null;
  };

  // ⌘I / Ctrl+I opens the inspector — the same "show me the details" reflex as a
  // browser's dev tools. Ignored while the settings drawer owns the screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "i") {
        if (settingsOpen || !localId.current) return;
        e.preventDefault();
        setInspectorOpen((v) => !v);
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
    // Clear the previous session's thread immediately on a real switch so B never
    // briefly renders A's messages/title/findings while B's reload is in flight
    // (FE4). The reload's stale-guard still protects against out-of-order fetches.
    if (sessionId !== loadedIdRef.current) {
      setDetail(null);
      setTriage([]);
    }
    // Restore a message a prior turn FAILED on in this session (possibly while it
    // was off-screen) into the composer, so it's never silently lost (FE2).
    const failed = sessionId ? getSessionRun(sessionId).failedText : null;
    if (failed) {
      setText(failed);
      patchSessionRun(sessionId!, { failedText: null });
    } else {
      // Otherwise restore this session's saved draft (v0.51.0). Switching
      // sessions used to wipe the composer unconditionally, so a half-written
      // question was lost the moment you looked at another investigation.
      setText(loadDraft(sessionId));
    }
    setImportHandoff(null);
    setReport(null);
    setViewError(null);
    setLoadError(null);
    pinnedRef.current = true;
    reload(sessionId);
    refreshModel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Parent-driven reload without a session switch (e.g. the active session was
  // renamed): refresh the thread so its header title matches the rail (FE6).
  useEffect(() => {
    if (reloadKey && sessionId) reload(sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const m of [...earlier, ...(detail?.messages ?? [])])
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
  }, [detail, triage, earlier]);

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
  // Mirrored into state so the "jump to latest" affordance can render. Unpinning
  // used to be invisible: you scrolled up to re-read a tool result, the answer
  // kept growing below, and nothing told you so or offered a way back.
  const [pinned, setPinned] = useState(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    pinnedRef.current = atBottom;
    setPinned((was) => (was === atBottom ? was : atBottom));
  };
  const jumpToLatest = () => {
    pinnedRef.current = true;
    setPinned(true);
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  };

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
  const hits = useMemo(() => findInThread(items, findQuery), [items, findQuery]);
  // A new query starts from the top rather than keeping a cursor that pointed
  // into the previous result set.
  useEffect(() => setFindIdx(0), [findQuery]);
  const activeHitId = hits.length ? hits[Math.min(findIdx, hits.length - 1)]?.id : null;
  useEffect(() => {
    if (!findOpen || !activeHitId) return;
    // A match inside a collapsed old turn has to open it. Finding something the
    // user cannot then see would be worse than not finding it — it would claim
    // the text is there and show them a summary line instead.
    setExpandedTurns((prev) => (prev.has(activeHitId) ? prev : new Set(prev).add(activeHitId)));
    // Let the expansion land before measuring where to scroll.
    const raf = requestAnimationFrame(() => {
      document
        .getElementById(`thread-item-${activeHitId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(raf);
  }, [findOpen, activeHitId]);
  const stepFind = useCallback(
    (delta: number) => setFindIdx((i) => stepHit(i, hits.length, delta)),
    [hits.length],
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
      {needKey && (
        <div className="animate-fade-in-up rounded-xl border border-warn-border bg-warn-bg p-3.5 text-sm text-warn-fg">
          {t("thread.needKey")}
          <div className="mt-2.5">
            <Button variant="primary" size="sm" onClick={onOpenSettings}>{t("thread.needKeyBtn")}</Button>
          </div>
        </div>
      )}
      {error && (
        <div className="animate-fade-in-up rounded-xl border border-danger-border bg-danger-bg p-3.5 text-sm text-danger">
          {error}
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
        /* New chat: a centered, composer-forward "start" view (Codex/Cursor). */
        <div className="flex flex-1 items-center justify-center overflow-auto px-6 py-10">
          <div className="w-full max-w-[44rem] animate-fade-in-up">
            <div className="mb-7 flex flex-col items-center text-center">
              <h1 className="text-2xl font-semibold tracking-[-0.02em] text-gray-100">{t("thread.greeting")}</h1>
              <p className="mt-2.5 max-w-md text-sm leading-relaxed text-gray-500">
                {t("thread.subtitle")}
              </p>
            </div>
            {composer}
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {suggestions.map((s) => (
                <button
                  key={s.key}
                  onClick={() => onSuggestion(s.key, s.prompt)}
                  className="rounded-full border border-edge bg-panel/60 px-3.5 py-1.5 text-xs text-gray-400 transition-colors hover:border-edge-strong hover:bg-hover hover:text-gray-100"
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
            <div className="truncate text-xs font-medium text-gray-200">{detail?.title || t("thread.titleNew")}</div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setInspectorOpen(true)}
                disabled={!sessionId}
                title={t("thread.inspect")}
                aria-label={t("thread.inspect")}
                data-testid="open-inspector"
                className="grid h-7 w-7 place-items-center rounded-md text-gray-500 transition-colors hover:bg-hover hover:text-gray-200 disabled:opacity-40"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                  <line x1="4" y1="7" x2="20" y2="7" />
                  <line x1="4" y1="12" x2="14" y2="12" />
                  <line x1="4" y1="17" x2="17" y2="17" />
                </svg>
              </button>
              <div className="flex items-center gap-1.5 rounded-md border border-edge px-2 py-1 text-2xs text-gray-500">
                <Spark size={11} />
                <span className="text-gray-400">{modelName ?? t("thread.noModel")}</span>
              </div>
            </div>
          </header>

          <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-auto px-6 py-7">
            {findOpen && (
              <FindBar
                query={findQuery}
                onQuery={setFindQuery}
                hits={hits}
                index={findIdx}
                onStep={stepFind}
                onClose={closeFind}
              />
            )}
            <div className="mx-auto max-w-3xl space-y-6">
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
                      className="rounded-full border border-edge px-3 py-1.5 text-2xs text-gray-600 transition-colors hover:border-edge-strong hover:text-gray-200 disabled:opacity-50"
                    >
                      {t("thread.jumpToStart")}
                    </button>
                  </div>
                </div>
              )}
              {items.map((it, idx) => {
                // A turn is "old" once several exchanges have happened after it.
                // Old turns collapse to one line; the user can reopen any of
                // them, and that choice sticks for the session.
                const collapsible =
                  it.kind === "message" &&
                  it.role === "assistant" &&
                  idx < items.length - OPEN_TAIL &&
                  !expandedTurns.has(it.id);
                if (collapsible && it.kind === "message") {
                  // Label the collapsed turn with what it CONCLUDED, not with
                  // the question — collapsing hides only the assistant half, so
                  // the user's message is still rendered in full directly above
                  // and a question label printed the same sentence twice, one
                  // line apart. The answer's opening line is the thing a reader
                  // scans a long investigation for. The question stays as the
                  // fallback for an answer that is empty (a stopped turn).
                  const gist = answerGist(it.content) || questionBefore(idx);
                  const calls = (it.toolActivity ?? []).filter((a) => a.status !== "started").length;
                  return (
                    <div key={it.id} id={`thread-item-${it.id}`} className="thread-item">
                      <button
                        type="button"
                        onClick={() => setExpandedTurns((prev) => new Set(prev).add(it.id))}
                        data-testid="collapsed-turn"
                        className="group flex w-full items-center gap-2 rounded-lg border border-edge/70 px-3 py-2 text-left transition-colors hover:border-edge-strong hover:bg-hover/40"
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             strokeWidth="2.5" className="shrink-0 text-gray-700" aria-hidden>
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                        <span className="min-w-0 flex-1 truncate text-xs text-gray-500 group-hover:text-gray-300">
                          {gist || t("common.untitled")}
                        </span>
                        {calls > 0 && (
                          <span className="shrink-0 tabular-nums text-3xs text-gray-700">
                            {t("turn.checks", { n: calls })}
                          </span>
                        )}
                      </button>
                    </div>
                  );
                }
                return it.kind === "message" ? (
                  <div key={it.id} id={`thread-item-${it.id}`} className="thread-item space-y-3">
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
                    />
                    {/* ONE affordance for the whole turn (v0.49.0): what it ran,
                        how long it took, what it cost, and what it was grounded
                        in — previously three separate expanders, two of which
                        described the same tool calls in different words on
                        opposite sides of the answer. */}
                    {it.role === "assistant" && (
                      <TurnFooter
                        tools={it.toolActivity}
                        grounding={it.grounding}
                        durationMs={metricsFor(it.id)?.duration_ms}
                        usage={metricsFor(it.id)?.usage ?? metricsFor(it.id) ?? undefined}
                        model={metricsFor(it.id)?.model}
                        budgetTokens={metricsFor(it.id)?.budget_tokens}
                        repeatCallsAvoided={metricsFor(it.id)?.repeat_calls_avoided}
                        sessionId={sessionId}
                        onOpenInspector={() => {
                          // Anchored: the inspector highlights and scrolls to
                          // THIS turn's rows. Unanchored it dropped the reader
                          // at the top of a whole session's timeline with no
                          // way to tell which entries were theirs.
                          setInspectorAnchor(turnWindow(idx));
                          setInspectorAnchorIds(
                            new Set((it.toolActivity ?? [])
                              .map((a) => a.id)
                              .filter((x): x is string => Boolean(x))),
                          );
                          setInspectorOpen(true);
                        }}
                      />
                    )}
                    {it.proposals && it.proposals.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2 pt-0.5">
                        <span className="text-2xs text-gray-600">{t("thread.suggestedNext")}</span>
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
                  <MessageCard role="user" content={pending} />
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
                      <span className="text-2xs text-gray-600">{t("thread.suggestedNext")}</span>
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

      <SessionInspector
        sessionId={sessionId}
        open={inspectorOpen && !!sessionId}
        onClose={() => {
          setInspectorOpen(false);
          setInspectorAnchor(null); setInspectorAnchorIds(null);
        }}
        findings={detail?.findings}
        memory={detail?.agent_memory}
        files={detail?.attached_files}
        contextMessages={detail?.context_messages}
        messageTotal={detail?.message_total}
        onCorrectMemory={correctMemory}
        onResolveMemory={resolveMemory}
        anchor={inspectorAnchor}
        anchorIds={inspectorAnchorIds}
      />

      {report !== null && (
        <Overlay onClose={() => setReport(null)}>
          <div className="flex h-full flex-col bg-canvas">
            <header className="flex items-center justify-between border-b border-edge px-6 py-3">
              <span className="text-sm font-semibold text-gray-100">{t("thread.report")}</span>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    void copyText(report).then((ok) => {
                      if (ok) setReportCopied(true);
                      window.setTimeout(() => setReportCopied(false), 1500);
                    });
                  }}
                >
                  {reportCopied ? t("thread.copied") : t("common.copy")}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    void saveTextFile("report.md", report).then((path) => {
                      if (path) {
                        setReportSavedPath(path);
                        window.setTimeout(() => setReportSavedPath(null), 4000);
                        return;
                      }
                      // Not in Tauri (dev/browser): the anchor download works there.
                      const blob = new Blob([report], { type: "text/markdown" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = "report.md";
                      a.click();
                      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                    });
                  }}
                >
                  {reportSavedPath ? t("thread.savedTo", { path: reportSavedPath }) : t("thread.download")}
                </Button>
                <Button variant="ghost" onClick={() => setReport(null)}>{t("common.close")}</Button>
              </div>
            </header>
            <div className="flex-1 overflow-auto p-6">
              <Markdown text={report} />
            </div>
          </div>
        </Overlay>
      )}
    </main>
  );
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  // Escape closes (keyboard users had no way out — only backdrop click/button).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-floating flex bg-scrim backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div
        className="m-auto h-[88vh] w-[min(900px,92vw)] overflow-hidden rounded-2xl border border-edge bg-canvas shadow-pop animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
