# Status & direction

## Where it is now

The workbench is feature-complete for its core loop and ships installers for
macOS (arm64), Linux (x64), and Windows (x64) on every tagged release.

Working end to end:

- Model + cloud (S3-compatible) provider configuration; secrets in an encrypted
  local vault (no system prompts).
- Read-only S3 diagnostics and account discovery.
- Bucket configuration review (security / lifecycle / observability / cost).
- Managed evidence import (plan → confirm → run) for inventory and access logs.
- Local DuckDB analysis of inventory and access logs (deterministic engine; the
  conversational agent narrates the sanitized result).
- Error triage (deterministic).
- Sessions: a persistent investigation workspace with rename / pin / archive /
  delete / fork.
- A thread-first conversational agent — the single LLM in the product — that
  investigates live with read-only tools, keeps working memory across turns, and
  runs read-only checks (S3 probes, account survey, config review, uploaded-file
  analysis) itself. Data-moving actions always wait for your confirmation.
- Markdown reports.

Verified by three test layers — a pytest suite over the sidecar (engines,
repositories, tool semantics, the security floor, plus a per-release regression
file for every shipped fix), Vitest over the frontend's state machine, and a
Playwright E2E smoke suite that drives a real sidecar plus the production bundle.
CI runs all three on every PR, alongside desktop builds for the three platforms.

## Known gaps

- Builds are ad-hoc signed, **not** notarized (macOS) or Authenticode-signed
  (Windows); see [signing.md](signing.md). Both need paid/managed signing
  credentials, so they are a decision before they are an implementation.
- No auto-update (it needs a signing key and an update manifest — same
  precondition as above).
- macOS x64 / universal builds are not produced.
- Inventory import is CSV / Parquet only (no ORC).
- CloudTrail / Storage Lens / provider-native access-log sources are not yet
  integrated.
- The E2E suite covers the credential-free paths only; a model-backed turn is
  deliberately out of scope there, since it would need a live provider key and
  would make the gate flaky.

## Direction

Likely next steps, in rough priority order: notarization + auto-update (blocked
on signing credentials, not on code), broader evidence sources (ORC inventory is
the small one; CloudTrail / Storage Lens each need their own confirmed-import
flow), and richer agent-assisted analysis.

None of these change the safety model — read-only (no write/destructive tool),
secrets only in the encrypted local vault, no data-moving action without
explicit confirmation, and every tool result treated as untrusted data. Recent
releases have mostly *deepened* that model rather than extending the feature
surface: see [security.md](security.md) for the current state of the floor and
the CHANGELOG for what each release hardened.
