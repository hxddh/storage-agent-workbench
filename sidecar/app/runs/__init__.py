"""Analysis Run orchestration.

Pure deterministic compute — no LLM, no planner, no canned step plans. Each
executor drives the whitelisted read-only tool layer through the shared tool
runner (every call recorded against the run) and publishes only its real tool
trace, findings, and summary.
"""
