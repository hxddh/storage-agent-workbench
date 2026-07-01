"""StorageOps skill context injection — skills-only, guidance-only.

This package vendors the StorageOps ``skill-registry.yaml`` + ``skills/*/SKILL.md``
as PROFESSIONAL DIAGNOSTIC METHOD context for the existing Agent. It is NOT a
skills platform: there are no StorageOps tools, helper scripts, CLI, Pi runtime,
subprocess, MCP, multi-agent runtime, skill API, skill UI, skill DB tables, or
RAG. ``recommended_tools`` and any script/tool mentions inside SKILL.md text are
treated as conceptual guidance only — the Workbench never registers, exposes, or
executes them.

Flow (progressive disclosure): `context` injects an always-in-context CATALOG
(skill name + description) and exposes a read-only `read_skill` tool; the single
conversational session agent loads a SKILL.md body on demand — frontmatter-
stripped and length-bounded (no wrapper preamble) — and reasons with session
evidence + that skill context.
"""
