"""Storage Agent Workbench sidecar package.

Local FastAPI service that backs the desktop app: providers, read-only S3
diagnostics, DuckDB analysis, sessions, and the conversational session agent
(the single tool-calling LLM; runs and triage are deterministic, no LLM).
"""

from importlib import metadata as _metadata

try:
    # Single source of truth: the installed package version (stamped from the
    # release tag). A hardcoded literal here silently rots out of lockstep.
    __version__ = _metadata.version("storage-agent-sidecar")
except _metadata.PackageNotFoundError:  # running from source without an install
    __version__ = "0.0.0+source"
