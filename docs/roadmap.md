# Status & direction

## Where it is now

Storage Agent ships a local-first desktop runtime for object-storage work and
builds installers for macOS Apple Silicon, Linux x64 and Windows x64.

Working end to end:

- Model and S3-compatible Storage Provider configuration; secrets live only in
  the encrypted local vault.
- Durable **Agent Tasks** with rename / pin / archive / delete / duplicate /
  branch / search.
- One Agent Composer that delegates at rest and becomes **Steer + Stop** during
  active Execution.
- Per-task live state including Working, Needs decision, Needs attention and
  Ready.
- Read-only S3 diagnostics and account discovery.
- Bucket configuration review for security, lifecycle, observability, cost and
  performance.
- Managed Evidence Import with plan → explicit Decision → execution for bounded
  inventory/access-log data movement.
- Local DuckDB analysis of inventory and access logs; the model receives only the
  bounded/sanitized analysis context allowed by the runtime.
- Deterministic object-storage error triage.
- Durable Directions, Work Results, findings, task memory and Execution records.
- Contextual Review for Evidence, Execution and Report Artifacts without leaving
  the active Task.
- Markdown Report Artifacts.
- Concurrent task execution: a real in-flight Task can continue while another
  Task is selected, and returns with its runtime state intact.

The current product is deliberately **not** presented as a conversation shell or
an admin console with AI attached. The Agent Task is the primary work environment
and runtime truth drives the visible execution state.

## Quality floor

Every pull request is checked by multiple independent layers:

- Sidecar pytest coverage for engines, repositories, tool semantics, safety and
  shipped regressions.
- Frontend unit, architecture and legacy-contract guards.
- Real-Sidecar Playwright E2E for Agent delegation, Execution, durable Work
  Results, Stop/Steer, task concurrency, Decisions, Review, localization,
  accessibility and secret sanitization.
- A real-state visual-review contact sheet generated from the same Sidecar-backed
  application states; it captures Delegate, Working+Steer, Decision, Work Result,
  Execution, Review, narrow layout and localized UI for human design review.
- Desktop build/runtime verification on macOS, Linux and Windows.

The frontend architecture guards explicitly reject the removed Chat-era
production contracts so old Session/Rail/Inspector/Timeline UI cannot quietly
return through incremental changes.

## Known gaps

### Distribution

- Builds are not distributed with Apple notarization or Windows Authenticode
  signing; see [signing.md](signing.md).
- No auto-update because a trusted update-signing/distribution chain has not been
  provisioned.
- macOS x64 / universal builds are not produced.

### Evidence sources

- Inventory import is CSV / Parquet only; no ORC.
- CloudTrail, Storage Lens and provider-native access-log sources are not yet
  integrated as first-class Evidence sources.

### Provider realism in CI

CI deliberately carries no live cloud/model credentials. Model-backed E2E uses a
scripted local OpenAI-compatible endpoint; storage-tool behavior is tested
against both hostile socket-level doubles and a real stateful local S3 server
where appropriate.

Still not covered by required CI:

- real provider signature verification with production credentials;
- provider-specific quirks that require dedicated MinIO/Ceph/etc. containers;
- a live public-cloud account/bucket.

These gaps should be described precisely rather than hidden behind a generic
“integration tests exist” claim.

## Direction

The next work should deepen the Agent's ability to complete real storage tasks,
not add Agent-looking chrome unsupported by the runtime.

1. **Broader Evidence sources.** Add ORC inventory, then provider-native logs /
   CloudTrail / Storage Lens through bounded, confirmation-gated import flows.
2. **Richer evidence-backed Agent analysis.** Improve what the runtime can infer
   and correlate from already-imported Evidence while retaining deterministic
   auditability and explicit gaps.
3. **Stronger Decision UX and resumability.** Keep confirmation-gated operations
   first-class and make it increasingly clear what will happen, why it blocks and
   what resumes after approval/cancel.
4. **More provider-realistic test infrastructure.** Add dedicated S3-compatible
   containers for signature and provider-quirk coverage without putting cloud
   credentials into CI.
5. **macOS x64 / universal builds** only if real user demand justifies the extra
   release matrix.

## Things we will not fake

Do not add these as UI concepts before the runtime genuinely supports them:

- multi-agent orchestration;
- coding-Agent projects/worktrees;
- generated plans/checklists that are not runtime state;
- generic terminal/browser/computer control;
- hidden background workers represented as autonomous Agent processes;
- destructive storage repair/mutation;
- a page/tab for every persistence table.

A top-tier Agent product is not defined by copying another product's chrome. It
is defined by a trustworthy loop where the user delegates work, can see real
Execution, can Steer/Stop it, is interrupted only for real Decisions, and receives
reviewable artifacts.

## Safety remains non-negotiable

Future capability work must preserve the current safety floor:

- storage access is read-only;
- no destructive/general shell tool;
- secrets only in the encrypted local vault;
- data-moving cloud actions require explicit Decision;
- model/tool context is sanitized and bounded;
- Evidence gaps stay gaps rather than being converted into guesses;
- chain-of-thought is neither persisted nor exposed.

See [security.md](security.md) for the authoritative security model and the
CHANGELOG for release-by-release hardening history.
