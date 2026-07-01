"""Storage Agent Workbench sidecar package.

Local FastAPI service that backs the desktop app: providers, read-only S3
diagnostics, DuckDB analysis, sessions, and the conversational session agent
(the single tool-calling LLM; runs and triage are deterministic, no LLM).
"""

__version__ = "0.1.0"
