from __future__ import annotations

import re
from pathlib import Path

PATH = Path("frontend/src/i18n.tsx")
DROP_PREFIXES = ("rail.", "thread.", "inspector.", "timeline.")
WORD_REPLACEMENTS = (
    (r"\bChats\b", "Tasks"),
    (r"\bchats\b", "tasks"),
    (r"\bChat\b", "Task"),
    (r"\bchat\b", "task"),
    (r"\bConversations\b", "Tasks"),
    (r"\bconversations\b", "tasks"),
    (r"\bConversation\b", "Task"),
    (r"\bconversation\b", "task"),
    (r"\bInvestigations\b", "Tasks"),
    (r"\binvestigations\b", "tasks"),
    (r"\bInvestigation\b", "Task"),
    (r"\binvestigation\b", "task"),
    (r"\bToolTimeline\b", "ExecutionTrace"),
    (r"\bTimelineItem\b", "ExecutionItem"),
)


def remove_legacy_entries(source: str) -> str:
    lines = source.splitlines(keepends=True)
    out: list[str] = []
    skipping = False

    for line in lines:
        if skipping:
            if line.rstrip().endswith(","):
                skipping = False
            continue

        match = re.match(r'^\s*"([^"]+)"\s*:', line)
        if match and match.group(1).startswith(DROP_PREFIXES):
            if not line.rstrip().endswith(","):
                skipping = True
            continue

        out.append(line)

    return "".join(out)


def migrate(source: str) -> str:
    source = remove_legacy_entries(source)
    for pattern, replacement in WORD_REPLACEMENTS:
        source = re.sub(pattern, replacement, source)

    # Camel-case keys were part of the old product model even though word-boundary
    # scans do not catch them. They have no production callers in v0.93.
    source = re.sub(r'^\s*"keys\.groupChat".*\n', "", source, flags=re.MULTILINE)
    source = re.sub(r'^\s*"keys\.newChat".*\n', "", source, flags=re.MULTILINE)
    source = re.sub(r'^\s*"palette\.newChat".*\n', "", source, flags=re.MULTILINE)
    source = re.sub(r'^\s*"palette\.chat".*\n', "", source, flags=re.MULTILINE)

    return source


def main() -> None:
    before = PATH.read_text(encoding="utf-8")
    after = migrate(before)
    if after == before:
        print("i18n already Agent-native")
        return
    PATH.write_text(after, encoding="utf-8")
    print(f"rewrote {PATH}: {len(before)} -> {len(after)} bytes")


if __name__ == "__main__":
    main()
