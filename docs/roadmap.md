# Roadmap

> **Baseline: Storage Agent v0.98.0.**
>
> This file describes what comes **after** the current Agent Task architecture. It is not a backlog of old UI concepts and it is not proof that an aspirational capability already exists.

## Current shipped baseline

v0.98.0 is the current baseline: a content-presentation pass on the v0.96 runtime
(figures, provenance, first-run, subtraction) after v0.97's token/motion/keyboard
craft. The Agent Task product model, tools, and migrations are unchanged. v0.96.0
turned that runtime into a quantified storage-optimization copilot and ongoing caretaker:

- the **Agent Task** is the primary application object and work environment;
- one Composer provides **Delegate → Steer + Stop** semantics, plus **Resume** and **Verify** when those runtime states exist;
- Direction, Execution, Decision, Work Result, Artifact, and contextual Review are distinct product concepts;
- queued Directions are visible and cancellable; stream recovery is `after=<last seq>` only;
- Decision cards project bounds/impact and Decline; Review projects Decision history;
- typed Storage Task Context grounds the Agent prompt; deterministic cross-evidence correlation produces bounded findings;
- a deterministic cost/lifecycle simulator projects class mix and labelled cost deltas from bounded inventory aggregates and a local price table — missing data is a gap, never a fabricated number;
- a typed **Remediation Plan** Artifact carries pasteable lifecycle JSON, finding refs, simulator impact with coverage, and a verification checklist; **Verify** is a read-only Execution on the same submit path;
- versioned **baselines** and **Drift** reports classify findings added / resolved / still present;
- optional per-task **revisit** schedules submit read-only Executions through `runtime.submit`; catch-up is labelled; Decisions are never auto-crossed;
- Ready-to-delegate suggestions map to checkup / cost review / drift check plus existing diagnose, attach, and account jobs;
- live execution is real per-task runtime state rather than simulated Agent chrome;
- `/agent-tasks` is the product runtime surface while `/sessions` remains the compatibility persistence/runtime API;
- read-only S3 diagnostics, account discovery, config review, local evidence analysis, error triage, and reports work end to end;
- managed cloud Evidence Import uses plan → explicit Decision → execution;
- secrets remain in the encrypted local vault and out of model context;
- `execution_events` retention is a periodic SQL-set prune (terminal only, dual cap, explicit truncation marker);
- architecture, legacy-contract, documentation-contract, real-Sidecar E2E, visual-review, and desktop-build gates protect the release.

This is the starting point. Future work should deepen the Agent's ability to complete real object-storage jobs inside this model rather than replacing it with another shell.

## Roadmap principles

1. **Capability before chrome.** Add UI only for runtime state/capability that actually exists.
2. **Agent Task remains the organizing object.** New evidence, tools, reports, and execution detail attach to the Task.
3. **Read-only autonomy, explicit mutation/data-movement boundaries.** More autonomy must not weaken the safety floor. Remediation Plans stay operator-applied.
4. **Evidence over confidence.** Improve what the Agent can prove, correlate, and explain; do not hide gaps. Estimates always carry coverage.
5. **Storage depth over generic-Agent breadth.** Prefer real S3/object-storage capabilities over generic terminal/browser/workflow features.
6. **Provider realism matters.** S3-compatible behavior and capability gaps must be tested explicitly rather than assumed from AWS semantics.
7. **Documentation is part of architecture.** Any intentional change to the product model must update code, executable contracts, and canonical docs together.

## Near-term priorities

### P0 — Evidence depth and correctness

#### Broader inventory/log formats

- Improve schema detection and explicit truncation/coverage reporting across large imported evidence.
- Keep model context aggregate-only and bounded.
- ORC inventory support is **out of scope** for current planning.

#### Provider-native evidence sources

Evaluate and add bounded adapters for sources such as:

- CloudTrail-style object-storage API events;
- Storage Lens-style aggregate data;
- provider-native access-log/inventory equivalents.

Each source must define discovery, bounded planning, confirmation, local persistence, sanitization, and analysis before it becomes a first-class Artifact.

### P0 — Stronger storage reasoning from existing evidence

Shipped through v0.96.0 as deterministic correlation plus the cost/lifecycle simulator, Remediation Plan/Verify, baseline/Drift, and scheduled revisits. Remaining work is more evidence sources and tighter coverage reporting, not a second Agent.

Still open:

- object metadata/config evidence + observed behavior beyond the current bounded joins;
- richer movement estimates when an evidence-import plan is absent (keep absence a gap, never invent counts);
- distinguish expired gated work where the underlying import/report workflow actually expires.

### P1 — Provider-realistic integration coverage

Add reproducible local/CI environments for S3-compatible differences that cannot be modeled reliably with simple mocks:

- signature/addressing differences;
- incomplete API support;
- error-shape/header differences;
- pagination/version/multipart behavior;
- provider-specific config semantics where useful.

CI must still carry no production cloud/model secrets.

### P1 — Better execution/evidence review

Deepen contextual Review without turning it into a separate application:

- stronger provenance links from a Work Result to the exact Evidence/Execution that supports it — **v0.98.0 ships the presentation layer**: `GET /agent-tasks/{id}/provenance` (no migration) plus clickable findings and hover previews. Remaining: richer audit-gap representation and large-task search.
- clearer audit-gap and unsupported-capability representation;
- better large-task search/navigation while preserving the Task as one durable work record.

### P1 — Storage-specific tool coverage

Add only tools that materially improve storage diagnosis or analysis while fitting the read-only/bounded model. Candidate areas should be justified by a real user job and a concrete safety contract, for example additional bucket/object metadata/config probes or provider capability detection.

### P2 — Distribution hardening

When justified by actual users/distribution needs:

- Apple Developer ID signing + notarization;
- Windows Authenticode signing;
- a trusted auto-update chain;
- macOS x64/universal artifacts if demand warrants the extra release matrix.

Distribution hardening must not change runtime/product semantics.

## Known current gaps

### Distribution

- Apple notarization is not configured.
- Windows Authenticode signing is not configured.
- No trusted auto-update chain.
- macOS release is Apple Silicon only.

### Evidence/source coverage

- provider-native event/access-log/aggregate sources are not yet first-class Evidence;
- some S3-compatible capability differences are represented as unsupported without dedicated provider containers in required CI;
- simulator class×age independence is labelled; abort-MPU savings stay a gap without MPU inventory.

### CI realism

Required CI deliberately uses no production model/cloud credentials. The repository has strong deterministic/runtime/E2E coverage but does not prove every public-cloud/provider quirk.

Do not rewrite these gaps as already solved until executable coverage exists.

## Explicit non-directions

The following are **not** roadmap shortcuts and must not be added merely to make the product look like a broader Agent platform:

- multi-agent orchestration without a real runtime need;
- synthetic task plans/checklists unsupported by execution state;
- coding projects/worktrees;
- generic terminal/browser/computer control;
- a workflow canvas;
- a plugin marketplace as a substitute for storage-specific capabilities;
- destructive storage mutation/auto-remediation (including auto-applying a Remediation Plan);
- ORC inventory as a committed near-term deliverable;
- a top-level application destination for every backend table;
- multi-user SaaS/RBAC before there is an explicit product decision to stop being a local-first desktop Agent.

## Safety floor for all future work

Every roadmap item must preserve:

- read-only storage operations in the shipped Agent;
- no generic shell/arbitrary subprocess capability;
- secrets only in the encrypted local vault;
- no secrets in model prompts, SQLite, logs, reports, or browser-readable payloads;
- server-side provider scope enforcement;
- explicit Decisions for gated data movement/materially large scans;
- Decision gates never auto-crossed by revisits;
- bounded/sanitized Tool and model context;
- deterministic handling of raw analytical rows;
- explicit provider/evidence gaps;
- estimates labelled as estimates, with coverage, or withheld as gaps;
- chain-of-thought never persisted or exposed as an Artifact.
