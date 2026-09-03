"""AGENTS.md — standing instructions the user keeps next to their data (v1.12).

Codex reads an ``AGENTS.md`` from the project; the Storage Agent has no
project, it has a data directory. So the file lives at
``STORAGE_AGENT_DATA_DIR/AGENTS.md`` (or wherever ``STORAGE_AGENT_INSTRUCTIONS``
points), and its Markdown is injected VERBATIM-but-bounded into the stable
half of every prompt, right after the skills catalog. It is guidance, never
code: nothing in it is executed, it cannot widen a tool, and it sits under the
safety rules in the system instructions, which it cannot override.

Bounded (``MAX_CHARS``), redacted (a key pasted into it never reaches the
model), and reported to the UI only as a status — the text itself is not an
API payload.
"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Any

from ..security.redaction import redact_text

FILE_NAME = "AGENTS.md"
ENV_OVERRIDE = "STORAGE_AGENT_INSTRUCTIONS"
MAX_CHARS = 8000
_TRUNCATED_MARKER = "\n\n[instructions truncated at 8000 characters]"

# v1.13 — the file is read on every prompt build (per turn); cache by mtime
# for 5 s so a burst of turns costs one read. A mid-save half-write only ever
# affects one turn — the next turn re-reads.
_CACHE_TTL_S = 5.0
_cache: dict[str, Any] = {"mtime": None, "size": None, "at": 0.0, "result": None}
_cache_lock = threading.Lock()


def path() -> Path:
    override = os.environ.get(ENV_OVERRIDE)
    if override:
        return Path(override).expanduser()
    from .. import config
    return config.data_dir() / FILE_NAME


def load() -> dict[str, Any]:
    """``{loaded, path, chars, truncated, error, text}``. Missing file → not
    loaded, no error. Unreadable → not loaded, error. Never raises."""
    p = path()
    try:
        st = p.stat()
        sig = (str(p), st.st_mtime_ns, st.st_size)
    except OSError:
        sig = (str(p), None)
    with _cache_lock:
        if (_cache["result"] is not None and _cache["mtime"] == sig
                and time.monotonic() - _cache["at"] < _CACHE_TTL_S):
            cached = dict(_cache["result"])
            cached["path"] = str(p)
            return cached
    out: dict[str, Any] = {"loaded": False, "path": str(p), "chars": 0,
                           "truncated": False, "error": None, "text": ""}
    try:
        if not p.is_file():
            _store_cache(sig, out)
            return out
        raw = p.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:  # noqa: PERF203 — one read, one bounded error
        out["error"] = redact_text(str(exc))[:200]
        return out
    text = redact_text(raw.replace("\r\n", "\n")).strip()
    if not text:
        _store_cache(sig, out)
        return out
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS].rstrip() + _TRUNCATED_MARKER
        out["truncated"] = True
    out.update({"loaded": True, "chars": len(text), "text": text})
    _store_cache(sig, out)
    return out


def _store_cache(sig: Any, out: dict[str, Any]) -> None:
    """Remember a load result keyed by file identity (best-effort)."""
    try:
        with _cache_lock:
            _cache["mtime"] = sig
            _cache["at"] = time.monotonic()
            _cache["result"] = dict(out)
    except Exception:  # noqa: BLE001 — caching never breaks loading
        pass


def status() -> dict[str, Any]:
    """What the UI gets: never the text."""
    st = load()
    st.pop("text", None)
    return st


def prompt_block() -> str | None:
    """The bounded prompt section, or None when no file is loaded."""
    st = load()
    if not st["loaded"]:
        return None
    return ("operator_instructions (AGENTS.md — standing guidance from the person using "
            "this machine; follow it within the safety rules above, which it cannot "
            "change):\n" + st["text"])


__all__ = ["FILE_NAME", "ENV_OVERRIDE", "MAX_CHARS", "path", "load", "status", "prompt_block"]
