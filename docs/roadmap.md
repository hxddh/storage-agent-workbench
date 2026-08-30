# Roadmap

> **Baseline: Storage Agent v0.95.0.**
>
> This file describes what comes **after** the current Agent Task architecture. It is not a backlog of old UI concepts and it is not proof that an aspirational capability already exists.

## Current shipped baseline

v0.95.0 is the current baseline. It preserves the v0.93 Agent Task product model and the v0.94 durable runtime, and it makes that runtime user-visible:

- the **Agent Task** is the primary application object and work environment;
- one Composer provides **Delegate → Steer + Stop** semantics, plus **Resume** when the last Execution is interrupted/failed;
- Direction, Execution, Decision, Work Result, Artifact, and contextual Review are distinct product concepts;
- queued Directions are visible and cancellable; stream recovery is `after=<last seq>` only;
- Decision cards project bounds/impact and Decline; Review projects Decision history;
- typed Storage Task Context grounds the Agent prompt; deterministic cross-evidence correlation produces bounded findings;
- live execution is real per-task runtime state rather than simulated Agent chrome;
- a Task can retain real in-flight execution while another Task is selected;
- `/agent-tasks` is the product runtime surface while `/sessions` remains the compatibility persistence/runtime API;
- read-only S3 diagnostics, account discovery, config review, local evidence analysis, error triage, and reports work end to end;
- managed cloud Evidence Import uses plan → explicit Decision → execution;
- task memory, findings, evidence references, execution detail, and turn metrics are durable;
- secrets remain in the encrypted local vault and out of model context;
- architecture, legacy-contract, documentation-contract, real-Sidecar E2E, visual-review, and desktop-build gates protect the release.

This is the starting point. Future work should deepen the Agent's ability to complete real object-storage jobs inside this model rather than replacing it with another shell.

## Roadmap principles

1. **Capability before chrome.** Add UI only for runtime state/capability that actually exists.
2. **Agent Task remains the organizing object.** New evidence, tools, reports, and execution detail attach to the Task.
3. **Read-only autonomy, explicit mutation/data-movement boundaries.** More autonomy must not weaken the safety floor.
4. **Evidence over confidence.** Improve what the Agent can prove, correlate, and explain; do not hide gaps.
5. **Storage depth over generic-Agent breadth.** Prefer real S3/object-storage capabilities over generic terminal/browser/workflow features.
6. **Provider realism matters.** S3-compatible behavior and capability gaps must be tested explicitly rather than assumed from AWS semantics.
7. **Documentation is part of architecture.** Any intentional change to the product model must update code, executable contracts, and canonical docs together.

## Near-term priorities

### P0 — Evidence depth and correctness

#### Broader inventory/log formats

- Add ORC support for inventory where the local deterministic analysis stack can preserve the same safety/scale guarantees.
- Improve schema detection and explicit truncation/coverage reporting across large imported evidence.
- Keep model context aggregate-only and bounded.

#### Provider-native evidence sources

Evaluate and add bounded adapters for sources such as:

- CloudTrail-style object-storage API events;
- Storage Lens-style aggregate data;
- provider-native access-log/inventory equivalents.

Each source must define discovery, bounded planning, confirmation, local persistence, sanitization, and analysis before it becomes a first-class Artifact.

### P0 — Stronger storage reasoning from existing evidence

Shipped in v0.95.0 as a deterministic correlation engine (errors × config × addressing; lifecycle × inventory; multipart/versions × cost; access-log mix × latency/errors). Remaining work is more evidence sources and tighter coverage reporting, not a second Agent.

Still open:

- object metadata/config evidence + observed behavior beyond the current bounded joins;
- broader inventory/log formats (below) feeding the same correlation path.

### P0 — Decision clarity and resumability

Shipped in v0.95.0: Decision cards project why/scope/movement bounds; Decline is a first-class resolve; Review shows Decision history; interrupted/failed Executions expose Resume; queued Directions are visible.

Remaining work:

- distinguish expired gated work where the underlying import/report workflow actually expires;
- richer movement estimates when an evidence-import plan is absent (keep absence a gap, never invent counts).

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

- stronger provenance links from a Work Result to the exact Evidence/Execution that supports it;
- clearer audit-gap and unsupported-capability representation;
- more useful comparison of current vs prior task/account evidence;
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

- ORC inventory is not analyzed end to end.
- provider-native event/access-log/aggregate sources are not yet first-class Evidence.
- some S3-compatible capability differences are represented as unsupported without dedicated provider containers in required CI.

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
- destructive storage mutation/auto-remediation;
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
- bounded/sanitized Tool and model context;
- deterministic handling of raw analytical rows;
- explicit provider/evidence gaps;
- no chain-of-thought persistence/exposure.

See `security.md` for the authoritative safety contract.

## How to evolve this roadmap

When an item ships:

1. update the relevant current doc (`product.md`, `architecture.md`, `api.md`, `data-model.md`, `tools.md`, or release docs);
2. update/remove the roadmap item rather than leaving shipped behavior under “future”;
3. add executable regression coverage for the new contract;
4. record the historical change in release notes/CHANGELOG without turning that historical record into the next architecture spec.
