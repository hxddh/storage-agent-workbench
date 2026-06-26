"""StorageOps skill context injection (Phase 19) — skills-only, guidance-only.

This package vendors the StorageOps ``skill-registry.yaml`` + ``skills/*/SKILL.md``
as PROFESSIONAL DIAGNOSTIC METHOD context for the existing Agent. It is NOT a
skills platform: there are no StorageOps tools, helper scripts, CLI, Pi runtime,
subprocess, MCP, multi-agent runtime, skill API, skill UI, skill DB tables, or
RAG. ``recommended_tools`` and any script/tool mentions inside SKILL.md text are
treated as conceptual guidance only — the Workbench never registers, exposes, or
executes them.

Flow: a lightweight selector (`selection`) picks 1–3 candidate skills from
registry metadata; `context` wraps the selected SKILL.md docs in a bounded,
tools-disabled wrapper; the existing session / triage Agents reason with session
evidence + that skill context.
"""
