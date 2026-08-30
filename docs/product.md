# Product model

> **Applies to Storage Agent v0.93.0.** This is the canonical product/UX specification. Historical release notes are not current product architecture.

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

## Product objects

### Agent Task

A Task is a durable goal plus the work already performed toward it. Task navigation is organized around the state and scope of delegated work, not around persistence tables or message history.

A Task may contain multiple Directions and multiple Executions over time. Switching Tasks does not create a new lifecycle for work already in progress.

### Direction

Direction is what the user wants the Agent to do or change: a goal, constraint, correction, follow-up, or mid-execution steering instruction.

Direction is durable task input. A machine-shaped storage error may render as a structured S3 Error Artifact when that representation preserves the useful fields better than raw text.

### Execution

Execution is what the runtime actually did: model/tool work, deterministic analysis, uploads/import preparation, and other real activity.

The UI may summarize or progressively disclose Execution, but must not invent:

- plans/checklists that the runtime did not emit;
- sub-agents or worker processes that do not exist;
- terminal/browser/computer control;
- worktrees/projects borrowed from coding Agents;
- storage mutations that are not implemented.

### Decision required

A backend action marked `requires_confirmation=true` is a real blocking state. The user must approve/cancel before the gated operation proceeds.

Read-only investigation is autonomous by default. Confirmation is reserved for meaningful safety boundaries such as managed cloud Evidence Import or materially large/full scanning/data movement.

### Work Result

A Work Result is durable Agent output produced by completed work. It can contain prose, Markdown structure, tables, code/config fragments, structured errors, findings, and references to supporting Evidence/Execution.

A Work Result is not a transient chat bubble and should read like technical work output.

### Artifact

Artifacts are durable, reviewable outputs attached to a Task, currently including Evidence and Markdown Reports. Persisted Execution detail is also reviewable context associated with the Task.

### Review

Review is subordinate to the active Task. It lets the user inspect task overview, Evidence, Execution detail, or Report without changing the primary object of the application.

Review must not create a second Agent input or a second task lifecycle.

## One Agent control path

There is exactly one primary Agent input.

- **Delegate** when no execution is active.
- **Steer** while the current Task is executing.
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

This does **not** mean the product has hidden autonomous worker Agents. It means a real execution already started for Task A is not destroyed when the user opens Task B.

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

| Product concept | Compatibility implementation |
| --- | --- |
| Agent Task | `sessions`, `/sessions/...`; `/agent-tasks` task-list projection |
| Direction / Work Result | `session_messages` |
| Execution | `runs`, `session_runs`, `tool_calls`, turn metrics |
| Decision | proposed actions + approval/evidence-import records |
| Task memory | summaries/findings/agent-memory records |
| Artifact | evidence/report persistence |

Rules:

1. Product-facing UI and new public frontend ownership use Agent Task / Direction / Execution / Decision / Work Result / Artifact / Review vocabulary.
2. Historical names are valid in persistence, API contracts, repositories, and narrow adapters where migration compatibility requires them.
3. A database/API name must never be used as justification for rebuilding old product information architecture.

## First-viewport hierarchy

The primary Task viewport should answer, in order:

1. **What is the Agent working on?**
2. **What is happening now or what did it produce?**
3. **What can I do now?** — Steer, Stop, decide, review, or delegate the next Direction.

Provider/model configuration, audit internals, and low-level counters are secondary unless directly relevant to the active work.

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
