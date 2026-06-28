# Status & direction

## Where it is now

The workbench is feature-complete for its core loop and ships installers for
macOS (arm64), Linux (x64), and Windows (x64) on every tagged release.

Working end to end:

- Model + cloud (S3-compatible) provider configuration; secrets in the OS keychain.
- Read-only S3 diagnostics and account discovery.
- Bucket configuration review (security / lifecycle / observability / cost).
- Managed evidence import (plan → confirm → run) for inventory and access logs.
- Local DuckDB analysis of inventory and access logs.
- Error triage.
- Sessions: a persistent investigation workspace with rename / pin / archive /
  delete / fork.
- Interpretation-only agent that explains findings and *proposes* next actions
  for you to confirm — it never runs anything on its own.
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
safety model — read-only by default, secrets only in the keychain, and no action
runs without explicit confirmation.
