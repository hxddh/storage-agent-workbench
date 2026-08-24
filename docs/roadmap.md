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
- Nothing is tested against a **real** model provider, a **signature-checking**
  S3 server, or a **live** bucket. What IS covered, precisely: 11 of the 22 E2E
  specs drive a full model-backed turn against a scripted local
  OpenAI-compatible endpoint (`e2e/fake-model.ts`); v0.76.0 drives every
  read-only tool against a real socket answering the way a *hostile* endpoint
  answers; and v0.84.0 drives them against a real *stateful* S3 server
  (`tests/live_s3.py`, moto) for the success half — pagination that continues,
  versions and delete markers, 206, 304, multipart parts, and keys that need URL
  encoding.

  What remains uncovered is narrower than it was, and worth naming exactly:
  **signature verification** (moto accepts a wrong secret — verified, not
  assumed), **provider-specific quirks** (MinIO's 501s on config sub-resources,
  Ceph's pagination edges), and **a live provider key or bucket**. The last is
  deliberate — credentials in CI, and a flaky gate. The first two are not
  deliberate, just unbuilt: they need a container, not a pip install.

  (v0.78.0 is the standing example of what a double can hide: the scripted model
  emitted one tool-call ID for every call, which no real model does, and that
  alone was read as an SDK regression for a whole release. The v0.84.0 gate was
  itself checked the same way — a mutation that mangles key encoding fails it
  while all 1520 other tests pass.)

## Direction

This list is what is *actionable*, in order. It is deliberately not led by the
biggest-sounding item.

1. **Broader evidence sources.** ORC inventory is the small one. CloudTrail and
   Storage Lens each need their own confirmed-import flow, so each is a release
   of its own.
2. **Richer agent-assisted analysis** over what is already imported.
3. **macOS x64 / universal builds**, if anyone is actually on Intel.

**Signing, notarization and auto-update are not on this list, and that is a
change.** They used to head it, which misread the situation: they are blocked on
somebody buying an Apple Developer ID and a Windows code-signing certificate, so
listing them as the next engineering step made a purchasing decision look like a
backlog item and pushed the things that *can* be built down the page. They stay
in Known gaps until that decision is made. When it is, the payoff is larger than
just signed installers: auto-update becomes possible, and macOS could move
secrets back to the system keychain without the update-time re-prompt that ruled
it out (see the vault rationale in `CLAUDE.md`).

A note on sequencing, learned the hard way. Recent releases have mostly deepened
the safety and correctness floor rather than widening the feature surface, and
that has been the right call more often than not — v0.78.0 fixed a concurrency
defect that had been making CI red for several releases and was mis-diagnosed
three times before the evidence was captured properly. Feature work on top of a
floor that is still moving costs more than it looks like it will.

None of these change the safety model — read-only (no write/destructive tool),
secrets only in the encrypted local vault, no data-moving action without
explicit confirmation, and every tool result treated as untrusted data. See
[security.md](security.md) for the current state of that floor, and the
CHANGELOG for what each release hardened.
