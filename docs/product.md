# Product model

> **Applies to Storage Agent v1.07.0.** This is the canonical product/UX specification. v1.04 keeps the v1.03 native Agent window and adds the Codex/Cursor rebuild (warm editorial, icon bar, Cursor-like Composer). v1.03 kept the v1.02 window and added gated extensions. v1.02 finished the native Agent window: v1.01 removed the workbench shell; v1.02 removes the leftover chat transcript. Historical release notes (including v1.00 header/strip/queues and v0.96 copilot OS) are not current product architecture.

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

Cost simulation, Remediation Plans, baselines, Drift, and revisit schedules remain **Sidecar engines** the Agent may invoke. They are not Settings spreadsheets, slash SKUs, Review destinations, or painted Task controls. If prices are missing, the Agent reports a gap or asks in the Task.

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
- A **Queued Direction** submitted while another Execution is running is visible in the Task and can be cancelled.
- Stream recovery after a drop is **sequence-only** (`after=<last seq>`). The blocking `/sessions` POST is not a recovery path.

Verify, cost simulation, and revisit remain runtime/engine paths. The user asks in Composer. There is no painted Verify control and no revisit schedule UI.

The UI may summarize or progressively disclose Execution, but must not invent:

- plans/checklists that the runtime did not emit;
- sub-agents or worker processes that do not exist;
- terminal/browser/computer control;
- worktrees/projects borrowed from coding Agents;
- storage mutations that are not implemented.

### Decision required

A backend action marked `requires_confirmation=true` that gates data-moving or artifact-producing work is a real blocking state, recorded as a first-class durable Decision. The user must approve or **Decline** before the gated operation proceeds; the resolution is recorded durably, and the Execution that raised it stays `waiting` until the boundary is crossed.

Decision cards in the Task project **bounds and impact** already present on the proposal/prefill and evidence-import plan: why confirmation is required, scan scope, and how many files/bytes would move. Absence of a count is a gap, not an invented number.

Durable Decision history lives in `task_decisions`. It is not a Review Overview wall.

Read-only investigation is autonomous by default. Confirmation is reserved for meaningful safety boundaries such as managed cloud Evidence Import or materially large/full scanning/data movement.

### Work Result

A Work Result is the durable output object of an Execution — recorded by the Task runtime with its grounding, proposals, and stopped/cut-short state. It can contain prose, Markdown structure, tables, **deterministic SVG figures** of runtime analysis (cost horizons, inventory distributions, Drift classes, access-log mix), code/config fragments, structured errors, findings, and references to supporting Evidence/Execution.

Figures plot only values the runtime emitted. Gaps render as gap states. Unconfirmed prices withhold the cost axis. Age and storage class are independent series — there is no observed joint. Charts are not a new destination: they sit **inline in the Work Result** like a code block. Wide windows keep a 46rem reading measure; the right half stays quiet.

Findings and key figures are clickable when a provenance chain exists (`GET /agent-tasks/{id}/provenance`). Hover shows tool, time, and coverage; click opens Review and anchors to that Evidence. A missing chain reads **No direct evidence chain** — never a fabricated source.

A Work Result is not a transient chat bubble and should read like technical work output. Streaming work is live Execution in that same record. Once the current turn's Work Result is persisted, the live streaming copy is not also rendered.

### Artifact

Artifacts are durable, reviewable outputs attached to a Task: Markdown Reports, imported Evidence snapshots, completed analyses, and engine outputs such as Remediation Plans, baselines, and Drift reports when the Agent produced them. Persisted Execution detail is also reviewable context associated with the Task.

A Remediation Plan, if drafted, is typed and versioned. The operator applies it outside Storage Agent. There is no Verify button. The user can ask the Agent to re-probe.

### Review

Review is a **light overlay** over the active Task — title, close, and the requested artifact. It opens from a finding, a Work Result Evidence/Execution/Report link, or ⌘I / Ctrl+I for Evidence. Escape closes it through the same overlay stack as Settings and the command palette. The overlay is not a side-column application, not a document hero, and not a 4-tab Overview / Evidence / Execution / Report destination.

It must not create a second Agent input or a second task lifecycle.

## One Agent control path

There is exactly one primary Agent input.

- **Delegate** when no execution is active.
- **Steer** while the current Task is executing — steering acts on the CURRENT Execution (the direction is delivered into the running work), never by cancelling and restarting it.
- **Stop** while local execution is active.

Opening Review or changing Task navigation state does not create a second composer.

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

An optional per-task revisit schedule may exist as a Sidecar engine. It has no product UI. The desktop app has no background daemon.

The empty start is the Composer. There is no first-run wizard, no slash SKU catalog (`/checkup` `/cost` `/drift`), and no suggestion-card grid. Missing model is a banner plus Open Settings. Typing `/` is ordinary Direction text. The model discovers tools.

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
- deterministic cost/lifecycle simulation (bounded aggregates + local price table **engine** — not a Settings UI);
- typed Remediation Plan + read-only Verify **as Agent tools**;
- versioned baselines and Drift reports **as Agent tools**;
- optional per-task read-only revisit **as a Sidecar engine**;
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

1. **What is the Agent working on?** — the document, not a header title bar.
2. **What is happening now or what did it produce?** — tool rows and Work Result in that same document.
3. **What can I do now?** — Steer, Stop, Resume, decide, open an artifact from the document, or delegate the next Direction.

The empty window is the Composer. The sidebar is quiet task titles. Settings is hidden behind an icon.

Provider/model configuration, audit internals, and low-level counters are secondary unless directly relevant to the active work.

## Design rules

v1.02.0 is a thorough native Agent reconstruction on the v0.97 token system. Visual language is specified in
[`design-tokens.md`](design-tokens.md) and enforced by frontend token tests.

- Dark and light are first-class. Do not ship a surface that only works in one.
- Type, radius, motion, and elevation come from tokens. No ad-hoc px type, no
  raw z-index, no `transition-all`.
- The Task is a document. Direction and Work Result are distinguished by
  typography, not painted labels. Work Result is a publication: heading
  hierarchy, paragraph rhythm, tables, labelled code with copy, structured
  errors, and **deterministic figures** of runtime analysis inline in the prose.
  Wide windows keep a 46rem reading measure; there is no third-column figures rail.
- Figures use `--viz-*` tokens and SVG/CSS only. No chart library. Never
  interpolate, extrapolate, or invent a horizon the runtime did not emit.
- Findings carry provenance. Missing chain is labelled, never implied.
- Execution rows show real tool name, argument summary, duration, and
  success/fail **in the Work Result**. Streaming must not jump layout. Once the
  current turn is persisted, do not keep a live duplicate of that Work Result on
  screen. No invented step/progress chrome. No token/budget wall under every result.
- Composer is the Agent input and the empty-start surface: Delegate at rest, Steer + Stop while working. Attach, textarea, and those actions. No wizard, no `/` SKU menu, no attach-type chips, no persistent keyboard legend.
- There is no task header and no live status strip. Artifacts open from the document as an overlay. Working state lives on Composer and in the document. ⌘K works; it is not painted. New task is a button; the shortcut is not painted on it.
- Task navigation is one chronological title list. State is a row mark. Rename and Delete only.
- Every non-ideal state (empty list, no Evidence, offline, interrupted, load earlier) is designed. Copy is restrained, specific, and bilingual.
- Keyboard: ⌘K/Ctrl+K command overlay maps only to runtime-true actions, grouped as Actions vs Tasks. It is not a Review destination menu.
- Perceived latency: cached task documents render instantly on switch; never
  flash an empty canvas while the durable document is already known.
- First Work Result on a new install is real delegated work, not a demo or a wizard checkup.

## Quality contract

The product model is protected by:

- frontend architecture tests that assert current ownership boundaries and physical deletion of retired UI contracts;
- negative legacy-contract scans over production frontend source;
- documentation-contract tests over normative docs;
- real-Sidecar Playwright tests for delegation, durable results, execution disclosure, Stop/Steer, task switching/concurrency, decisions, evidence/file analysis, Review/Reports, localization, accessibility, contrast, narrow layouts, and credential sanitization;
- real-state visual-review captures.

## Modern native-agent extensions (opt-in, additive)

v1.02 is a thorough native Agent window. The following are **additive, bounded
and opt-in** extensions that deepen the same window without replacing it. Each
reuses the durable runtime, the read-only tool floor, and the same redaction
and Decision gates; none introduces a second Agent or a new top-level
navigation surface.

- **Local model providers** — `ollama`, `lmstudio`, `vllm`, `llama.cpp` and other
  OpenAI-compatible local endpoints. They run without a stored API key (the
  client sends `not-needed`), carry a localhost default `base_url`, and are tested
  through the same `testModelProvider` probe as cloud models. Model budgeting
  (`model_budget.py`) already scales to their windows, and `agent_service` keeps
  secrets out of context. Settings shows them as *Local model — key not
  required*.
- **User skills** — operators may drop a `SKILL.md` into
  `STORAGE_AGENT_DATA_DIR/skills/<name>/SKILL.md` (or
  `STORAGE_AGENT_SKILLS_DIR`) and it appears in the catalog next to the 20
  bundled StorageOps skills. A user skill shadows a bundled one by name. No
  code is executed; only guidance text is loaded via `read_skill` and bounded
  to `MAX_CHARS_PER_SKILL`. `GET /skills` lists bundled + user skills; the
  Agent still self-routes via the catalog.
- **Read-only MCP bridge** — `GET /mcp/status`, `GET /mcp/tools`,
  `POST /mcp/tools/call` expose the whitelisted read-only storage tools to a
  *local* MCP client. Disabled by default; `STORAGE_AGENT_ENABLE_MCP=1` enables
  it. The bridge reuses the same tool allowlist, scope enforcement, and
  redaction as the Agent; it never adds shell, raw boto3, or filesystem tools.
- **Observability export** — `GET /agent-tasks/{id}/export/otel` and
  `GET /observability/export` project the durable execution log, tool calls,
  turn metrics, and artifact index as OTel-inspired JSON (bounded,
  sanitized). Settings surfaces it under *Observability*; the Task can copy it
  via the same path the agent uses. No new tables.
- **OS-native shell** — Tauri `dialog`, `notification`, `opener`, `deep-link`,
  `global-shortcut`, and `updater` plugins. Tray, global hotkey, deep links
  (`storage-agent://task/<id>`), and signed auto-updates are inert until the
  distribution chain provides a pubkey/endpoints, but the capability gate is in
  place.

All extensions preserve: read-only storage tools, no generic shell/subprocess,
secrets only in the encrypted vault, server-side provider scope, explicit
Decisions for data movement, bounded/sanitized context, and no chain-of-thought
persistence.

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
