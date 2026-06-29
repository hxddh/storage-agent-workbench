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
- Local DuckDB analysis of inventory and access logs (with a bounded-drill-down
  agent narrator).
- Error triage.
- Sessions: a persistent investigation workspace with rename / pin / archive /
  delete / fork.
- A thread-first conversational agent that investigates live with read-only
  tools, keeps working memory across turns, and — per the autonomy setting —
  either runs read-only checks itself or proposes them. Data-moving actions
  always wait for your confirmation.
- Markdown reports.

## Known gaps

- Builds are ad-hoc signed, **not** notarized (macOS) or Authenticode-signed
  (Windows); see [signing.md](signing.md).
- No auto-update.
- macOS x64 / universal builds are not produced.
- Inventory import is CSV / Parquet only (no ORC).
- CloudTrail / Storage Lens / provider-native access-log sources are not yet
  integrated.

## Direction

Likely next steps, in rough priority order: notarization + auto-update, broader
evidence sources, and richer agent-assisted analysis. None of these change the
safety model — read-only (no write/destructive tool), secrets only in the
encrypted local vault, and no data-moving action runs without explicit
confirmation.
