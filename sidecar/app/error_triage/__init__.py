"""Session-centered S3 / object-storage error triage.

A deterministic parser extracts structured signals from a redacted error blob
(error code / HTTP status / region / endpoint / operation / ...), rule-based
playbooks map those signals to candidate causes + safe next checks. Triage is
purely deterministic — there is NO interpretation-only triage Agent (it was
removed); interpretation, when wanted, comes from the conversational session
agent in-thread over the already-sanitized triage context. No raw sensitive log,
secret, or chain-of-thought is ever persisted or sent to the model; triage itself
performs NO S3 call, run, download, or mutation. Suggested next actions are
proposals that flow through the review/prepare hand-off.
"""
