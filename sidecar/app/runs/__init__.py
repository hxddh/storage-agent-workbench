"""Analysis Run orchestration.

Deterministic, rule-based planning only. No LLM call, no OpenAI Agents SDK, no
DuckDB analysis. The diagnostic run drives the existing Phase 03 read-only tool
layer through the shared tool runner so every call is recorded against the run.
"""
