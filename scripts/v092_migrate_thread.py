from pathlib import Path

PATH = Path("frontend/src/components/ThreadImplementation.tsx")
text = PATH.read_text()


def replace_once(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    text = text.replace(old, new, 1)


# The first transform mounted useI18n at the intended location, then its generic
# cleanup removed that newly-added occurrence rather than the historical one.
# Move it explicitly above hooks that require the translator.
replace_once(
    '}) {\n  const {\n    scrollRef, contentRef, pinned, onScroll, releaseToUser, scrollToBottom,\n',
    '}) {\n  const { t } = useI18n();\n  const {\n    scrollRef, contentRef, pinned, onScroll, releaseToUser,\n',
    "move translator before session hook and remove unused viewport callback",
)
replace_once(
    '  const { t } = useI18n();\n  const suggestions = SUGGESTION_KEYS.map',
    '  const suggestions = SUGGESTION_KEYS.map',
    "remove late translator declaration",
)

# The legacy header was physically removed, making its decorative mark dead.
start = text.find('const Spark = ({ size = 12 }')
if start < 0:
    raise SystemExit("Spark definition not found")
end = text.find('\n\nexport function Thread', start)
if end < 0:
    raise SystemExit("Spark definition terminator not found")
if text.count('Spark') != 1:
    raise SystemExit(f"Spark unexpectedly still used {text.count('Spark')} times")
text = text[:start] + text[end + 2:]

# Remove comments whose state was moved into useSessionDocument. Leaving comments
# that describe variables no longer present is architectural misinformation.
text = text.replace(
    '  // Pages fetched by "load earlier", oldest-first, held separately from\n'
    '  // `detail.messages` (the tail) so a reload can refresh the tail without\n'
    '  // discarding history the user deliberately pulled in.\n'
    '  // Persisted per-turn metrics, keyed by the assistant message they belong to,\n'
    '  // so the footer under an OLD answer still shows what that turn cost.\n\n',
    '',
    1,
)

for forbidden in [
    "SessionInspector",
    "getSessionReport",
    "setReport(",
    "function Overlay",
    "stepTurn",
    "isEditable",
    "AUTOSCROLL_FRAME_BUDGET",
    "const Spark",
    "scrollToBottom,",
]:
    if forbidden in text:
        raise SystemExit(f"post-migration dead ownership remains: {forbidden}")

PATH.write_text(text)
print(f"audited {PATH}: {len(text.splitlines())} lines")
