from __future__ import annotations

import re
from pathlib import Path

PATH = Path("frontend/src/components/ThreadImplementation.tsx")
text = PATH.read_text()


def replace_once(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one literal match, found {count}")
    text = text.replace(old, new, 1)


def regex_once(pattern: str, new: str, label: str) -> None:
    global text
    text, count = re.subn(pattern, new, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one regex match, found {count}")


# Public ownership now lives in Workbench/hooks, so remove Thread-local imports.
for old in [
    'import { useDismissOnEscape } from "../hooks/useDismissOnEscape";\n',
    '  correctSessionMemory,\n',
    '  getSession,\n',
    '  getSessionMessages,\n',
    '  getSessionOverview,\n',
    '  getSessionReport,\n',
    '  getSessionTriage,\n',
    '  getSessionTurnState,\n',
    '  resolveSessionMemory,\n',
    '  SessionMessage,\n',
    '  SessionTurnState,\n',
    'import { saveTextFile } from "../config";\n',
    'import { Markdown } from "./Markdown";\n',
    'import { SessionInspector } from "./SessionInspector";\n',
    'import { isEditable } from "../shortcuts";\n',
]:
    if old not in text:
        raise SystemExit(f"missing import fragment: {old!r}")
    text = text.replace(old, "", 1)

replace_once(
    'import { useTurnRunner, cleanError } from "../hooks/useTurnRunner";\n',
    'import { useTurnRunner, cleanError } from "../hooks/useTurnRunner";\n'
    'import { useSessionDocument } from "../hooks/useSessionDocument";\n'
    'import { useThreadViewport } from "../hooks/useThreadViewport";\n'
    'import { openWorkbenchRun, openWorkbenchSurface } from "../workbench/commands";\n',
    "add extracted ownership imports",
)
replace_once(
    'import { GroundingCard, MessageCard, ProposalCard, RunCard, ThinkingBubble, TriageCard, copyText } from "./ThreadCards";\n',
    'import { GroundingCard, MessageCard, ProposalCard, ThinkingBubble, TriageCard } from "./ThreadCards";\n',
    "trim ThreadCards imports",
)

regex_once(
    r'/\*\* Frames a scroll-to-bottom run may spend chasing a thread that is still.*?const AUTOSCROLL_SETTLED_FRAMES = 3;\n',
    "",
    "remove viewport constants",
)

replace_once(
    '      grounding?: Grounding | null;\n      proposals?: NextAction[];\n',
    '      grounding?: Grounding | null;\n      proposals?: NextAction[];\n'
    '      referencedRunIds?: string[];\n      referencedEvidenceIds?: string[];\n',
    "add answer reference fields",
)

replace_once(
    '  reloadKey?: number;\n}) {\n',
    '  reloadKey?: number;\n}) {\n'
    '  const { t } = useI18n();\n'
    '  const {\n'
    '    scrollRef, contentRef, pinned, onScroll, releaseToUser, scrollToBottom,\n'
    '    jumpToLatest, resetPinned, followLatest,\n'
    '  } = useThreadViewport();\n',
    "mount viewport hook",
)

for old in [
    '  const [detail, setDetail] = useState<SessionDetail | null>(null);\n',
    '  const [triage, setTriage] = useState<TriageCase[]>([]);\n',
    '  const [report, setReport] = useState<string | null>(null);\n',
    '  const [reportCopied, setReportCopied] = useState(false);\n',
    '  const [reportSavedPath, setReportSavedPath] = useState<string | null>(null);\n',
    '  const [earlier, setEarlier] = useState<SessionMessage[]>([]);\n',
    '  const [loadingEarlier, setLoadingEarlier] = useState(false);\n',
    '  const [metrics, setMetrics] = useState<Record<string, TurnMetricsRow>>({});\n',
    '  const { t } = useI18n();\n',
]:
    if old not in text:
        raise SystemExit(f"missing state/import fragment: {old!r}")
    text = text.replace(old, "", 1)

regex_once(
    r'  const \[inspectorOpen, setInspectorOpen\] = useState\(false\);.*?  const \[inspectorAnchorIds, setInspectorAnchorIds\] = useState<ReadonlySet<string> \| null>\(null\);\n',
    "",
    "remove inspector state",
)
regex_once(
    r'  // A turn running server-side that THIS client did not start.*?  remoteTurnRef\.current = remoteTurn;\n',
    "",
    "remove remote turn state",
)

# Replace the old load-error/local-id/reload-token ownership with the persisted
# session document hook. The large reload/recovery/history implementation below
# is deleted in a second asserted transform.
regex_once(
    r'  // Set when loading an EXISTING session fails.*?  const reloadSeqRef = useRef\(0\);\n',
    '  const {\n'
    '    detail, triage, earlier, loadingEarlier, metrics, remoteTurn, loadError,\n'
    '    localId, reload, loadEarlier, loadAllEarlier, hiddenCount,\n'
    '  } = useSessionDocument({\n'
    '    sessionId, sidecarReady, reloadKey, t, scrollRef, setViewError,\n'
    '  });\n',
    "mount persisted session hook",
)

regex_once(
    r'  // Returns true iff it actually applied fresh session detail for `id`\..*?  // Persisted metrics win once the reload has them; until then the live `done`',
    '  // Persisted metrics win once the reload has them; until then the live `done`',
    "remove legacy session/recovery/history ownership",
)

# Inspector hotkey now opens the first-class Evidence surface; no time-window or
# call-id state remains in Timeline.
regex_once(
    r'  /\*\* The wall-clock window one turn occupied:.*?  \}, \[settingsOpen\]\);\n',
    '  // ⌘I / Ctrl+I is now a semantic Workbench navigation command.\n'
    '  useEffect(() => {\n'
    '    const onKey = (event: KeyboardEvent) => {\n'
    '      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "i") {\n'
    '        if (settingsOpen || !localId.current) return;\n'
    '        event.preventDefault();\n'
    '        openWorkbenchSurface("evidence");\n'
    '      }\n'
    '    };\n'
    '    window.addEventListener("keydown", onKey);\n'
    '    return () => window.removeEventListener("keydown", onKey);\n'
    '  }, [settingsOpen]);\n',
    "replace legacy inspector ownership",
)

# Session-document loading now lives in useSessionDocument. Timeline still owns
# draft restoration, temporary import handoff and visual errors.
regex_once(
    r'  useEffect\(\(\) => \{\n    // Only VIEW-local state is reset on session change\..*?\n  const items = useMemo<Item\[]>\(\(\) => \{',
    '  useEffect(() => {\n'
    '    const failed = sessionId ? getSessionRun(sessionId).failedText : null;\n'
    '    if (failed) {\n'
    '      setText(failed);\n'
    '      patchSessionRun(sessionId!, { failedText: null });\n'
    '    } else {\n'
    '      setText(loadDraft(sessionId));\n'
    '    }\n'
    '    setImportHandoff(null);\n'
    '    setViewError(null);\n'
    '    resetPinned();\n'
    '    refreshModel();\n'
    '    // eslint-disable-next-line react-hooks/exhaustive-deps\n'
    '  }, [sessionId]);\n\n'
    '  const items = useMemo<Item[]>(() => {',
    "replace session switch/recheck ownership",
)

replace_once(
    '        toolActivity: m.tool_activity, grounding: m.grounding, proposals: m.proposed_actions,\n',
    '        toolActivity: m.tool_activity, grounding: m.grounding, proposals: m.proposed_actions,\n'
    '        referencedRunIds: m.referenced_run_ids ?? [],\n'
    '        referencedEvidenceIds: m.referenced_evidence_ids ?? [],\n',
    "wire persisted answer references",
)

# Viewport implementation is now a dedicated hook.
regex_once(
    r'  // Follow the conversation while the user is "pinned" to the bottom\..*?  // Branch a new investigation from one message',
    '  // Branch a new investigation from one message',
    "remove legacy viewport implementation",
)

# Public Thread.tsx is the sole j/k owner; remove the historical duplicate rather
# than intercepting it forever at capture phase.
regex_once(
    r'  /\* Move through the conversation without the mouse\..*?  \}, \[stepTurn\]\);\n\n',
    "",
    "remove duplicate j/k listener",
)

replace_once(
    '  useEffect(() => {\n    if (pinnedRef.current) scrollToBottom();\n  }, [items.length, proposals.length, pending, streamText?.length, streamTools.length, scrollToBottom]);\n',
    '  useEffect(() => {\n    followLatest();\n  }, [items.length, proposals.length, pending, streamText?.length, streamTools.length, followLatest]);\n',
    "delegate follow-latest",
)

regex_once(
    r'  const openReport = \(\) => \{.*?\n  \};\n\n  // Agent-native next steps\.',
    '  const openReport = () => {\n'
    '    if (localId.current) openWorkbenchSurface("report");\n'
    '    else setViewError(t("thread.startChatFirst"));\n'
    '  };\n\n'
    '  // Agent-native next steps.',
    "route slash report to Workbench",
)
replace_once(
    '      } else if (r.open === "session_report") {\n        const rep = await getSessionReport(localId.current);\n        setReport(rep.content);\n',
    '      } else if (r.open === "session_report") {\n        openWorkbenchSurface("report");\n',
    "route proposal report to Workbench",
)

# The global command bar owns investigation identity; remove the hidden duplicate
# header instead of relying on CSS to conceal it.
regex_once(
    r'          <header className="flex items-center gap-3 border-b border-edge px-6 py-2\.5">.*?          </header>\n\n',
    "",
    "remove hidden Timeline header",
)

replace_once(
    '                      onRegenerate={\n                        it.role === "assistant" && !busy && questionBefore(idx)\n                          ? () => seedComposer(questionBefore(idx) as string)\n                          : undefined\n                      }\n                    />\n',
    '                      onRegenerate={\n                        it.role === "assistant" && !busy && questionBefore(idx)\n                          ? () => seedComposer(questionBefore(idx) as string)\n                          : undefined\n                      }\n'
    '                      referencedRunIds={it.referencedRunIds}\n'
    '                      referencedEvidenceIds={it.referencedEvidenceIds}\n'
    '                    />\n',
    "pass answer references",
)

regex_once(
    r'                        onOpenInspector=\{\(\) => \{.*?                        \}\}\n',
    '                        onOpenInspector={() => openWorkbenchSurface("evidence")}\n',
    "route turn footer inspect to Evidence",
)

# Explicit run records in Timeline link into the first-class Runs workspace; they
# no longer mount a nested RunDetail accordion in the conversation.
replace_once(
    '                ) : it.kind === "run" ? (\n                  <div key={it.data.run_id} className="thread-item">\n                    <RunCard run={it.data} />\n                  </div>\n',
    '                ) : it.kind === "run" ? (\n'
    '                  <button\n'
    '                    key={it.data.run_id}\n'
    '                    type="button"\n'
    '                    data-testid="timeline-run-link"\n'
    '                    onClick={() => openWorkbenchRun(it.data.run_id)}\n'
    '                    className="thread-item flex w-full items-center gap-3 border-y border-edge/70 py-3 text-left text-xs transition-colors hover:bg-hover/30"\n'
    '                  >\n'
    '                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-gray-500" aria-hidden />\n'
    '                    <span className="min-w-0 flex-1 truncate text-gray-300">{it.data.title || it.data.run_type}</span>\n'
    '                    <span className="font-mono text-2xs uppercase text-gray-500">{it.data.status}</span>\n'
    '                    <span className="text-gray-500" aria-hidden>→</span>\n'
    '                  </button>\n',
    "route timeline run record to Runs workspace",
)

# Keep the purpose-built evidence import handoff; everything after it was legacy
# Inspector/Report overlay ownership and is removed wholesale.
regex_once(
    r'\n      <SessionInspector.*?\n    </main>',
    '\n    </main>',
    "remove legacy inspector/report overlays",
)
regex_once(
    r'\nfunction Overlay\(\{ children, onClose \}:.*\Z',
    '\n',
    "remove legacy generic report overlay",
)

# There must be no legacy ownership tokens left. Fail the migration rather than
# silently shipping a half-decomposed Thread.
for forbidden in [
    "SessionInspector",
    "setInspectorOpen",
    "inspectorAnchor",
    "getSessionReport",
    "setReport(",
    "function Overlay",
    "stepTurn",
    "isEditable",
    "correctSessionMemory",
    "resolveSessionMemory",
    "AUTOSCROLL_FRAME_BUDGET",
]:
    if forbidden in text:
        raise SystemExit(f"legacy ownership still present after migration: {forbidden}")

PATH.write_text(text)
print(f"migrated {PATH}: {len(text.splitlines())} lines")
