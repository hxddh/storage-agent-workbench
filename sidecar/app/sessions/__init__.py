"""Session-centered workspace context.

A Session ties together the auditable runs, the evidence behind them, the
evidence-driven findings, a deterministic sanitized summary, and a lightweight
message thread — the persistent working context of an investigation. The
summary is built deterministically from already-sanitized run artifacts; the
session Agent (separate module) interprets that summary only.
"""
