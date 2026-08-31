# Product model

> **Applies to Storage Agent v0.98.0.** This is the canonical product/UX specification. v0.98 is a content-presentation pass on the v0.96 runtime (figures, provenance, first-run, subtraction). Historical release notes are not current product architecture.

## Product definition

Storage Agent is a local-first desktop Agent for object storage and S3-compatible systems. The user delegates an outcome or problem; the Agent performs real read-only work, remains steerable while it executes, stops at explicit confirmation boundaries, and returns durable technical results backed by reviewable evidence and execution.

The product invariant is:

> **The Agent Task is the application.**

The canonical work model is:

> **Direction → Execution → Decision (when required) → Work Result → Artifact**

Storage Agent is not a generic chat assistant, not an admin dashboard with an AI panel, and not a case/ticket system.

## Primary users

- Object-storage, SRE, and operations engineers.
- Data-infrastructure engineers.
- Developers debugging S3-compatible systems, policies, performance, and access behavior.
- Storage product/support engineers who need a durable, auditable work record rather than an ungrounded answer.

## Core jobs

1. Diagnose S3-compatible connectivity, credential, endpoint, addressing, TLS, object, and request-behavior problems.
2. Discover accounts and inspect visible buckets with bounded read-only calls.
3. Review bucket configuration for security, lifecycle, observability, cost, and performance concerns.
4. Analyze inventory and access-log evidence locally.
5. Triage storage errors, including deterministic offline triage for supported error shapes.
6. Preserve findings, memory, evidence references, execution provenance, and follow-up context across a durable task.
7. Produce evidence-backed Report artifacts.
8. Quantify lifecycle/cost impact from bounded inventory aggregates and a local, user-calibrated price table — every figure is an estimate with coverage, or an explicit gap.
9. Draft a typed Remediation Plan the operator applies in their own console/CLI; Verify with read-only probes.
10. Capture versioned baselines, report Drift, and optionally revisit the same Task on a schedule.

## Product objects

### Agent Task

A Task is a durable goal plus the work already performed toward it. Task navigation is organized around the state and scope of delegated work, not around persistence tables or message history.

A Task may contain multiple Directions and multiple Executions over time. Switching Tasks does not create a new lifecycle for work already in progress.

### Direction

Direction is what the user wants the Agent to do or change: a goal, constraint, correction, follow-up, or mid-execution steering instruction.

Direction is durable task input. A machine-shaped storage error may render as a structured S3 Error Artifact when that representation preserves the useful fields better than raw text.

### Execution

Execution is what the runtime actually did: model/tool work, deterministic analysis, uploads/import preparation, and other real activity.

Since v0.94 an Execution is a durable object with a real lifecycle — `queued`, `running`, `waiting` (blocked on a Decision), `completed`, `failed`, `cancelled`, `interrupted` (a Sidecar restart caught it mid-flight; it can be resumed). Its progress is an append-only log of structured events, never an inference from Agent prose. UI disconnect, Task switching, and reload never interrupt an Execution.

v0.95 makes that lifecycle operable in the Task:

- **Resume** is a task-area action when the Task is `needs_attention` and the last Execution is `interrupted` or `failed`. It starts a new Execution with the same Direction and follows the new event stream. Cancelled, missing-key, and generic error states are not Resume.
- **Verify** is a task-area action when a Remediation Plan Artifact exists. It submits a `kind=verify` Execution through the same runtime path, diffs live read-only configuration against the plan, and writes `proposed` / `verified` / `partially_verified` / `stale` back onto the plan. It never mutates storage.
- A **Queued Direction** submitted while another Execution is running is visible in the Task and can be cancelled. Command-center state stays `working`.
- Stream recovery after a drop is **sequence-only** (`after=<last seq>`). The blocking `/sessions` POST is not a recovery path.

The UI may summarize or progressively disclose Execution, but must not invent:

- plans/checklists that the runtime did not emit;
- sub-agents or worker processes that do not exist;
- terminal/browser/computer control;
- worktrees/projects borrowed from coding Agents;
- storage mutations that are not implemented.

### Decision required

A backend action marked `requires_confirmation=true` that gates data-moving or artifact-producing work is a real blocking state, recorded as a first-class durable Decision. The user must approve or **Decline** before the gated operation proceeds; the resolution is recorded durably, and the Execution that raised it stays `waiting` until the boundary is crossed.

The Decision card must project **bounds and impact** already present on the proposal/prefill and evidence-import plan: why confirmation is required, scan scope, and how many files/bytes would move. Absence of a count is a gap, not an invented number.

Review Overview projects durable **Decision history** (`pending` / `approved` / `declined` / `superseded`) from `task_decisions`. This is a projection, not a new table and not a separate application destination.

Read-only investigation is autonomous by default. Confirmation is reserved for meaningful safety boundaries such as managed cloud Evidence Import or materially large/full scanning/data movement.

### Work Result

A Work Result is the durable output object of an Execution — recorded by the Task runtime with its grounding, proposals, and stopped/cut-short state. It can contain prose, Markdown structure, tables, **deterministic SVG figures** of runtime analysis (cost horizons, inventory distributions, Drift classes, access-log mix), code/config fragments, structured errors, findings, and references to supporting Evidence/Execution.

Figures plot only values the runtime emitted. Gaps render as gap states. Unconfirmed prices withhold the cost axis. Age and storage class are independent series — there is no observed joint. Charts are not a new destination: they sit in the Work Result and in Review Overview.

Findings and key figures are clickable when a provenance chain exists (`GET /agent-tasks/{id}/provenance`). Hover shows tool, time, and coverage; click opens Review and anchors to that Evidence. A missing chain reads **No direct evidence chain** — never a fabricated source.

A Work Result is not a transient chat bubble and should read like technical work output.

### Artifact

Artifacts are durable, reviewable outputs attached to a Task through one first-class Artifact index: Markdown Reports, imported Evidence snapshots, completed analyses, **Remediation Plans**, **baselines**, and **Drift reports**. Persisted Execution detail is also reviewable context associated with the Task.

A Remediation Plan is typed and versioned. It contains pasteable lifecycle JSON (or equivalent policy corrections), the finding/Evidence it addresses, the simulator's expected impact including coverage, and a verification checklist. The user applies it outside Storage Agent. Verify does not write to the cloud.

A baseline is a versioned bounded snapshot (inventory overview, configuration facts, findings, context version) — never raw rows. Drift classifies findings as added / resolved / still present, diffs configuration, and reports a two-point inventory trend. Missing baseline is the sentence "there is no comparable baseline", never a fabricated trend.

### Review

Review is subordinate to the active Task. It lets the user inspect task overview, Evidence, Execution detail, or Report without changing the primary object of the application. Overview also projects Remediation Plan status, baselines, Drift, and the optional revisit schedule. These are not new destinations.

Review must not create a second Agent input or a second task lifecycle.

## One Agent control path

There is exactly one primary Agent input.

- **Delegate** when no execution is active.
- **Steer** while the current Task is executing — steering acts on the CURRENT Execution (the direction is delivered into the running work), never by cancelling and restarting it.
- **Stop** while local execution is active.

Opening Review, changing Task navigation state, or entering Focus mode does not create a second composer.

## Task states

Product state is derived from live runtime state plus durable Task truth.

| State | Meaning |
| --- | --- |
| **Ready to delegate** | No active Task exists yet. |
| **Ready** | The Task is durable and can accept another Direction. |
| **Working** | Real execution is active. |
| **Needs decision** | Current live/durable work is blocked by a confirmation boundary. |
| **Needs attention** | Runtime/provider/execution state requires user intervention. |
| **Preparing / uploading** | Input/evidence preparation is actively occurring. |

A previously persisted Decision does not outrank a newer live Execution. Conversely, after reload or Task switching, a still-current durable Decision must not disappear merely because browser-local state was lost.

## Background task behavior

Multiple Tasks may independently have real in-flight work because execution state is keyed by durable task/session identity rather than by the currently visible viewport.

This does **not** mean the product has hidden autonomous worker Agents. It means a real execution already started for Task A is not destroyed when the user opens Task B — and since v0.94 that ownership is the Sidecar's durable task runtime, so it also survives closing the stream, reloading the app, and (as an explicit `interrupted` + Resume action) a Sidecar restart. Recovering a Task reads its typed, versioned Storage Task Context — machine state is never rebuilt by replaying messages. Since v0.95 that typed context is also the Agent prompt's stable grounding.

An optional per-task **revisit schedule** (every N days) submits a read-only Execution through the same `runtime.submit` path when the Sidecar is running and the due time has passed. The desktop app has no background daemon: if the app was closed past due, the next open catch-up-submits and labels the Direction as catch-up. Revisits never auto-approve a Decision. Needs-decision / needs-attention from a revisit use the existing AgentTaskNavigation states. The user can turn the schedule off at any time.

Ready-to-delegate suggestions map to real capabilities: storage checkup, cost review (simulator), drift check (baseline), plus diagnose / attach inventory or access logs / account mapping. They must not promise runtime the Sidecar does not expose.

A fresh install follows an inline **60-second path** on the start surface: welcome → connect a model (live `POST /model-providers/{id}/test`) → optionally connect storage (skippable; skip is an explicit gap, not a fake connection) → delegate the first storage checkup. The checkup CTA submits the Direction through the same turn runner as Delegate — it does not only prefill the composer. No demo data, no fake progress. Every step can exit; the empty start then offers a resume entry back to that step.

## Storage-specific capability model

Current capability classes include:

- S3-compatible diagnostics and bounded probes;
- bucket/object metadata inspection;
- account discovery;
- bucket configuration review;
- versions/multipart/object-lock/ACL/tag/attribute inspection;
- bounded preview/range/conditional/latency checks;
- presigned-URL diagnosis;
- local inventory/access-log analysis;
- deterministic cost/lifecycle simulation (bounded aggregates + local price table);
- typed Remediation Plan + read-only Verify;
- versioned baselines and Drift reports;
- optional per-task read-only revisit (catch-up labelled when the app was closed past due);
- managed Evidence Import with explicit confirmation;
- deterministic storage-error triage;
- durable task findings/memory/evidence;
- Markdown Report generation.

Historical backend `run_type` values such as `diagnostic`, `access_log_analysis`, `inventory_analysis`, `bucket_config_review`, and `account_discovery` remain implementation vocabulary. They are not top-level product navigation.

## Safety and trust contract

The product must preserve these guarantees:

- cloud/model secrets stay in the encrypted local vault and never enter model prompts, SQLite, logs, reports, or browser-readable secret payloads;
- storage tools are read-only;
- no generic shell/arbitrary subprocess capability is exposed to the Agent;
- provider bucket/prefix scopes are enforced server-side;
- data-moving or materially large/full-scan operations cross an explicit Decision boundary;
- tool/evidence/model context is sanitized and bounded;
- raw analytical rows are processed deterministically rather than streamed into model context;
- Evidence gaps remain explicit gaps;
- chain-of-thought is neither persisted nor rendered.

See `security.md` for the normative security specification.

## Product vocabulary vs compatibility vocabulary

Some database/API names predate v0.93 and remain for compatibility.

| Product concept | Durable runtime (v0.94) | Compatibility implementation |
| --- | --- | --- |
| Agent Task | `agent_tasks` | `sessions`, `/sessions/...`; `/agent-tasks` surface |
| Direction | execution direction + steer events | `session_messages` (user rows) |
| Execution | `task_executions` + structured event log | `runs`, `session_runs`, `tool_calls`, turn metrics |
| Work Result | `work_results` | `session_messages` (assistant rows) |
| Decision | `task_decisions` | proposed actions + approval/evidence-import records |
| Artifact | `task_artifacts` index | evidence/report persistence |
| Task memory | — | summaries/findings/agent-memory records |

Rules:

1. Product-facing UI and new public frontend ownership use Agent Task / Direction / Execution / Decision / Work Result / Artifact / Review vocabulary.
2. Historical names are valid in persistence, API contracts, repositories, and narrow adapters where migration compatibility requires them.
3. A database/API name must never be used as justification for rebuilding old product information architecture.

## First-viewport hierarchy

The primary Task viewport should answer, in order:

1. **What is the Agent working on?**
2. **What is happening now or what did it produce?**
3. **What can I do now?** — Steer, Stop, Resume, Verify, decide, review, schedule a revisit, or delegate the next Direction.

Provider/model configuration, audit internals, and low-level counters are secondary unless directly relevant to the active work.

## Design rules

v0.98.0 is a content-presentation pass on the v0.97 token system. Visual language is specified in
[`design-tokens.md`](design-tokens.md) and enforced by frontend token tests.

- Dark and light are first-class. Do not ship a surface that only works in one.
- Type, radius, motion, and elevation come from tokens. No ad-hoc px type, no
  raw z-index, no `transition-all`.
- Work Result is a publication: heading hierarchy, paragraph rhythm, tables,
  labelled code with copy, structured errors, and **deterministic figures** of
  runtime analysis. Wide windows keep a 46rem reading measure and put figures
  in the remaining column — the right half is not empty space.
- Figures use `--viz-*` tokens and SVG/CSS only. No chart library. Never
  interpolate, extrapolate, or invent a horizon the runtime did not emit.
- Findings carry provenance. Missing chain is labelled, never implied.
- Execution rows show real tool name, argument summary, duration, and
  success/fail. Streaming must not jump layout. No invented step/progress chrome.
- Composer is the product card: Delegate at rest, Steer + Stop while working,
  with discoverable shortcuts.
- Every non-ideal state (empty list, no Evidence, offline, interrupted, load
  earlier, first-run skip) is designed. Copy is restrained, specific, and bilingual.
- Keyboard: ⌘K/Ctrl+K command overlay maps only to runtime-true actions, grouped
  as Actions vs Tasks.
- Perceived latency: cached task documents render instantly on switch; never
  flash an empty canvas while the durable document is already known.
- First Work Result on a new install is a real checkup, not a demo.

## Quality contract

The product model is protected by:

- frontend architecture tests that assert current ownership boundaries and physical deletion of retired UI contracts;
- negative legacy-contract scans over production frontend source;
- documentation-contract tests over normative docs;
- real-Sidecar Playwright tests for delegation, durable results, execution disclosure, Stop/Steer, task switching/concurrency, decisions, evidence/file analysis, Review/Reports, localization, accessibility, contrast, narrow layouts, and credential sanitization;
- real-state visual-review captures.

## Non-goals

Until a real runtime and safety contract exists, Storage Agent is not:

- a multi-agent orchestrator;
- a coding project/worktree environment;
- a generic computer-use/terminal/browser Agent;
- a full S3 file manager;
- a destructive repair/mutation system;
- a workflow canvas;
- a plugin marketplace;
- a multi-user SaaS/RBAC product;
- a page-per-table admin console.

Runtime capability comes first; UI representation follows it.
