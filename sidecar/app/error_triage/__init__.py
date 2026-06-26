"""Session-centered S3 / object-storage error triage (Phase 18).

A deterministic parser extracts structured signals from a redacted error blob
(error code / HTTP status / region / endpoint / operation / ...), rule-based
playbooks map those signals to candidate causes + safe next checks, and an
optional interpretation-only Agent explains the sanitized triage context. No raw
sensitive log, secret, or chain-of-thought is ever persisted or sent to the
model; triage itself performs NO S3 call, run, download, or mutation. Suggested
next actions are proposals that flow through the Phase 17 review/prepare hand-off.
"""
