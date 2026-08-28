from pathlib import Path
import re

ROOT = Path("frontend/src")
CARDS = ROOT / "components/ThreadCardsImplementation.tsx"
PUBLIC_CARDS = ROOT / "components/ThreadCards.tsx"
WORKSPACE_CSS = ROOT / "workspace-overhaul.css"
RUN_CSS = ROOT / "run-workspace.css"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def regex_once(text: str, pattern: str, new: str, label: str) -> str:
    changed, count = re.subn(pattern, new, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one regex match, found {count}")
    return changed


# Conversation content no longer owns auditable RunDetail. Runs are global work
# surfaces; Timeline keeps only a semantic link into that surface.
cards = CARDS.read_text()
cards = replace_once(
    cards,
    'import type { Grounding, NextAction, SessionFinding, SessionRunLink, ToolActivity, TriageCase } from "../types";\n',
    'import type { Grounding, NextAction, SessionFinding, ToolActivity, TriageCase } from "../types";\n',
    "remove dead SessionRunLink type",
)
cards = replace_once(cards, 'import { RunDetail } from "./RunDetail";\n', '', "remove dead RunDetail import")
cards = regex_once(
    cards,
    r'const RUN_STATUS: Record<string, \{ cls: string; key: string \}> = \{.*?\};\n\n',
    '',
    "remove dead inline run status vocabulary",
)
cards = regex_once(
    cards,
    r'/\*\* A run rendered as a collapsible tool-call block \(embeds the full transcript\)\. \*/\nexport function RunCard\(.*?\n\}\n\n(?=/\*\* An error-triage case)',
    '',
    "remove dead inline RunCard",
)
for forbidden in ["SessionRunLink", "RunDetail", "RUN_STATUS", "export function RunCard"]:
    if forbidden in cards:
        raise SystemExit(f"legacy inline run ownership remains in ThreadCardsImplementation: {forbidden}")
CARDS.write_text(cards)

public_cards = PUBLIC_CARDS.read_text()
public_cards = replace_once(public_cards, '  RunCard,\n', '', "remove RunCard public export")
PUBLIC_CARDS.write_text(public_cards)

# Everything after this marker was a v0.91 compatibility shim that stretched the
# old Inspector and Report modals to viewport size. v0.92 has native Evidence and
# Report surfaces, so retaining these selectors risks styling unrelated overlays.
workspace = WORKSPACE_CSS.read_text()
marker = "/* -------------------------------------------------------------------------\n * Full investigation workspace\n * ---------------------------------------------------------------------- */\n"
if workspace.count(marker) != 1:
    raise SystemExit(f"workspace legacy marker expected once, found {workspace.count(marker)}")
workspace = workspace.split(marker, 1)[0].rstrip() + "\n"
for forbidden in ["session-inspector", ".fixed.inset-0.z-floating", "workspace-enter"]:
    if forbidden in workspace:
        raise SystemExit(f"legacy modal selector remains in workspace-overhaul.css: {forbidden}")
WORKSPACE_CSS.write_text(workspace)

# RunDetail remains the Runs surface document, but it is no longer an inline
# accordion that needs to escape Thread via position:fixed. Keep document/metrics
# shaping scoped to run-workspace-root and let Agent OS stage own geometry.
run_css = RUN_CSS.read_text()
run_css = regex_once(
    run_css,
    r'/\* Explicit runs are review tasks, not accordion details inside a chat card\. \*/\n\.thread-item div:has\(> \[data-testid="run-workspace-root"\]\) \{.*?\}\n\n',
    '/* Explicit runs are first-class review documents inside the Runs work surface. */\n',
    "remove Thread escape hatch",
)
run_css = replace_once(
    run_css,
    '[data-testid="run-workspace-root"] {\n  position: absolute;\n  inset: 0;\n  overflow: hidden;\n',
    '[data-testid="run-workspace-root"] {\n  position: relative;\n  min-height: 100%;\n  overflow: visible;\n',
    "contain RunDetail in Runs surface",
)
run_css = regex_once(
    run_css,
    r'\n@keyframes workspace-run-enter \{.*?\}\n',
    '\n',
    "remove obsolete fullscreen animation",
)
run_css = regex_once(
    run_css,
    r'\n@media \(prefers-reduced-motion: reduce\) \{\n  \.thread-item div:has\(> \[data-testid="run-workspace-root"\]\) \{\n    animation: none !important;\n  \}\n\}\n?',
    '\n',
    "remove obsolete fullscreen reduced-motion rule",
)
for forbidden in [".thread-item div:has", "position: fixed", "workspace-run-enter"]:
    if forbidden in run_css:
        raise SystemExit(f"legacy inline-run escape hatch remains in run-workspace.css: {forbidden}")
RUN_CSS.write_text(run_css)

print("removed final legacy conversation/modal ownership")
