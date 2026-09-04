# Product model

> **Applies to Storage Agent v1.17.2.** This is the canonical product/UX specification. v1.09 tears down the v1.04–v1.08 web-app chassis and ships the native Agent window: sidebar · title bar · one Task document · one Composer. v1.10 makes the OS shell and the runtime native. v1.11–v1.16 made the transcript and the protocol native. **v1.17.0 is the Codex window;** **v1.17.1** patches queue honesty, Settings field sizing, and title-bar Find; **v1.17.2** puts Codex Search on the left, finishes Settings dialog chrome, and layers context instead of restacking it. Earlier release notes are not current product architecture.

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

Cost simulation, Remediation Plans, baselines, Drift, and revisit schedules remain **Sidecar engines** the Agent may invoke. They are not Settings spreadsheets, slash SKUs, product destinations, or painted Task controls. If prices are missing, the Agent reports a gap or asks in the Task.

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

- **Resume** is a task-area action when the Task is `needs_attention` and the last Execution is `interrupted` or `failed`. It starts a new Execution with the same Direction and follows the new event stream. Since v1.13 a restart also interrupts `waiting` executions (their gated tool died with the process; the pending Decision survives and Resume re-plans/re-raises it). Resuming a user-cancelled execution is labelled a **retry** (`[retry]`), not a recovery. Missing-key and generic error states are not Resume. A Direction queued behind the running execution is editable until it runs (v1.14); once running, steer it instead.
- A **Queued Direction** submitted while another Execution is running is visible in the Task and can be cancelled.
- Stream recovery after a drop is **sequence-only** (`after=<last seq>`). The blocking `/sessions` POST is not a recovery path.

Verify, cost simulation, and revisit remain runtime/engine paths. The user asks in Composer. There is no painted Verify control and no revisit schedule UI.

The UI may summarize or progressively disclose Execution, but must not invent:

- plans/checklists that the runtime did not emit;
- sub-agents or worker processes that do not exist;
- terminal/browser/computer control;
- worktrees/projects borrowed from coding Agents;
- storage mutations that are not implemented.

### Waiting for approval (inline Decision)

Confirmation boundaries in the shipped product are the gated `import_evidence` tool and an over-cap `survey_account` (v1.12). When the model calls it, the Sidecar plans the bounded download, records a first-class durable Decision, and the Execution waits — the transcript shows an **approval card inline** at that point (title, bucket, prefix, files, bytes, scope, why) with **Allow**, **Allow for this task**, and **Deny**. A large-scan card also projects buckets and estimated live calls (v1.13). Allow runs the audited import server-side and the same Execution continues with the result; Deny hands the model a structured refusal and it answers from what it has. The title bar reads *Waiting for approval*. Nothing the model writes in prose raises a Decision, and no second dialog exists.

Approval cards project **bounds and impact** from the real plan: why confirmation is required, scan scope, and how many files/bytes would move. Absence of a count is a gap, not an invented number.

Durable Decision history lives in `task_decisions`. It is not an overview wall.

Read-only investigation is autonomous by default. Confirmation is reserved for meaningful safety boundaries such as managed cloud Evidence Import or materially large/full scanning/data movement.

### Work Result

A Work Result is the durable output object of an Execution — recorded by the Task runtime with its derived grounding (skills opened, evidence read, open questions recorded) and stopped/cut-short state. The model writes plain Markdown; there is no metadata block and no next-step proposal list. It can contain prose, Markdown structure, tables, **deterministic SVG figures** of runtime analysis (cost horizons, inventory distributions, Drift classes, access-log mix), code/config fragments, structured errors, findings, and references to supporting Evidence/Execution.

Figures plot only values the runtime emitted. Gaps render as gap states. Unconfirmed prices withhold the cost axis. Age and storage class are independent series — there is no observed joint. Charts are not a new destination: they sit **inline in the Work Result** like a code block. Wide windows keep a 46rem reading measure; the right half stays quiet.

Findings and key figures are clickable when a provenance chain exists (`GET /agent-tasks/{id}/provenance`). Hover shows tool, time, and coverage; click opens the Artifacts panel and anchors to that Evidence. A missing chain reads **No direct evidence chain** — never a fabricated source.

A Work Result is not a transient chat bubble and should read like technical work output. Streaming work is live Execution in that same record. Once the current turn's Work Result is persisted, the live streaming copy is not also rendered.

### Artifact

Artifacts are durable, reviewable outputs attached to a Task: Markdown Reports, imported Evidence snapshots, completed analyses, and engine outputs such as Remediation Plans, baselines, and Drift reports when the Agent produced them. Persisted Execution detail is also reviewable context associated with the Task.

A Remediation Plan, if drafted, is typed and versioned. The operator applies it outside Storage Agent. There is no Verify button. The user can ask the Agent to re-probe.

### Artifacts

Artifacts is a **right split panel** over the active Task (⌘I / Ctrl+I). Under a narrow window it becomes an overlay. It lists Evidence, Reports, Remediation Plans, Baselines/Drift, and Execution detail. It replaces the historical Review sheet. It is not a side-column application, not a document hero, and not a 4-tab destination.

It must not create a second Agent input or a second task lifecycle.

## One Agent control path

There is exactly one primary Agent input.

- **Delegate** when no execution is active.
- **Steer** while the current Task is executing — steering acts on the CURRENT Execution (the direction is delivered into the running work), never by cancelling and restarting it.
- **Stop** while local execution is active.

Opening Artifacts or changing Task navigation state does not create a second composer.

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

The empty start is the Composer. There is no first-run wizard, no slash SKU catalog (`/checkup` `/cost` `/drift`), and no suggestion-card grid. Missing model is a banner plus Open Settings. Typing `/` is ordinary Direction text. The model discovers tools. Typing `@` completes files attached to the Task (v1.13); the model resolves the name via `list_uploaded_files`. Composer history (↑) never stores key material: entries carrying secrets are dropped, credential values masked. Composer input is bounded where the server bounds it (Direction 32 000, steer 8 000): a counter appears past 75 %, sending past 100 % is refused with the reason (v1.14) — a long paste never dies as a bare 422.

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
| Decision | `task_decisions` (`kind=approval`, `scope`) | `approval_events` + evidence-import records |
| Artifact | `task_artifacts` index | evidence/report persistence |
| Task memory | — | summaries/findings/agent-memory records |

Rules:

1. Product-facing UI and new public frontend ownership use Agent Task / Direction / Execution / Decision / Work Result / Artifact vocabulary.
2. Historical names are valid in persistence, API contracts, repositories, and narrow adapters where migration compatibility requires them.
3. A database/API name must never be used as justification for rebuilding old product information architecture.

## First-viewport hierarchy

The primary Task viewport should answer, in order:

1. **What is the Agent working on?** — the task name in the window title bar and the document itself.
2. **What is happening now or what did it produce?** — the Worked group and the Work Result in that same document.
3. **What can I do now?** — Steer, Stop, Resume, Allow/Deny, open Artifacts, or delegate the next Direction.

The empty window is one greeting line and the Composer in the middle band. The sidebar is New task, Search, quiet task titles, Settings. Search opens the command palette. Nothing else is painted.

Provider/model configuration, audit internals, and low-level counters are secondary unless directly relevant to the active work. The model chip on the Composer is the one place the active model shows; it is backed by the real provider list.

## Design rules

v1.17.2 is the current Codex window on a native shell. Visual language is specified in
[`design-tokens.md`](design-tokens.md) and enforced by frontend token tests.

- The window is **sidebar · title bar · one document**. No activity bar, no status bar, no inspector column, no marketing copy anywhere in chrome.
- One achromatic surface ladder (`--canvas` … `--hover`), an ink primary (near-white on dark, near-black on light), hairline depth. Status (`danger` / `warn` / `success`) is the only colour. Dark and light are first-class.
- Type, radius, motion, and elevation come from tokens. No ad-hoc px type, no raw z-index, no `transition-all`.
- The Task is a transcript. **Direction** is copy-only — a right-aligned user bubble, no grey Direction block. **Execution** is one *Worked for …* group of real tool rows (collapsed to wall-clock; rows visible when opened; failures never fold away). **Work Result** is plain Markdown on the 46rem measure. No data track, no chip row under the answer, no metrics footer. **Approval** is an inline card: sentence-case *Waiting for approval*, why, impact, Allow / Allow for this task / Deny.
- Figures use `--viz-*` tokens and SVG/CSS only. No chart library. Never interpolate, extrapolate, or invent a horizon the runtime did not emit.
- Findings carry provenance. Missing chain is labelled, never implied.
- Composer is the Agent input and the empty-start surface: `+` attach, textarea, model chip, and a round send (↑) at rest; Steer (↑) + Stop (■) while working. No ContextMeter on the bar (usage lives in the model menu and Execution detail). The Composer is a hairline slot, not an elevated card. No wizard, no `/` SKU menu, no attach-type chips, no persistent keyboard legend, no approval-mode chip.
- The title bar carries the task name and its real state (⌘F / ⌘K remain). The sidebar paints a labeled **Search** under New task — lighter than New task — that opens the same command palette as ⌘K (Codex). ⌘F opens a find strip under the title bar on the reading column — search field, n/n, previous/next, close; Enter / Shift+Enter (and ⌘G) step; a second ⌘F re-selects the query. Artifacts open from the document in the Artifacts panel beside it (⌘I). New task is a button; the shortcut is not painted on it.
- Task navigation is one chronological title list grouped by day. State is a row mark; Ready paints nothing. Rename and Delete only.
- Settings is a centered dialog: General · Model Providers · Cloud Providers · Skills & bridges · Safety. The dialog is a container: the nav does not wrap CJK labels, the close control does not overlap the heading, and a narrow pane stacks the nav into a tab strip. Provider editors size fields to the pane (`@container`), not the viewport. Safety (v1.12) holds the read-only floor statement, the **Approvals** policy control (Ask every time · Allow for this session · Always allow) with the list of gated tools, and nothing else; Skills & bridges gains **Open instructions file** (`AGENTS.md` in the data directory).
- The transcript shows the model's own plan as one quiet checklist card (`update_plan`, v1.12) that updates in place and folds to *Plan · n/n* when done; a context compaction is one muted line *Context compacted · 48k → 9k tokens*; an approval the policy answered says so on the card. ⌘K offers **Compact context** for an idle task.
- Every non-ideal state (empty list, no Evidence, offline, interrupted, load earlier) is designed. Copy is restrained, specific, and bilingual.
- Keyboard: ⌘K/Ctrl+K command overlay maps only to runtime-true actions, grouped as Actions vs Tasks, with tasks fuzzy-ranked as you type (v1.13). It is not an Artifacts destination menu.
- A steer raised while an approval is open acts on the waiting execution (v1.14): it is delivered after the decision resolves, or carried into the follow-up on decline — never silently re-queued as new work.
- Figures, evidence states, triage, and coverage read localized (v1.14). The empty start is one static greeting line plus the Composer (v1.15) — no glyph, no suggestion grid; engine discoverability is the palette (⌘K), and the model never pitches engines in prose.
- A stalled stream heals itself with a quiet reconnecting line and auto-retry (v1.15) — there is no Resync button. Earlier history loads as the reader nears the top.
- Tables render whole in the page flow (v1.16.1): no inner scroller, no pagination, `table-layout: fixed`, cells wrap at word boundaries.
- Copy lives in dictionaries with zh/en parity (v1.16); engines and shortcuts are palette entries that prefill the Composer; usage names the governor, memory reuse and window source; approvals name their scope; one Escape closes one layer; errors dismiss; reconnects back off. Usage renders from one vocabulary (v1.15): cached as a subset, partial reports as `~` floors, silence named, compaction marked estimated.
- A live turn running past ~90 s says the Execution is still working and that Steer/Stop remain (v1.17); the *Worked for …* clock is the group's wall clock throughout.
- Perceived latency: cached task documents render instantly on switch; never flash an empty canvas while the durable document is already known.
- First Work Result on a new install is real delegated work, not a demo or a wizard checkup.

## Quality contract

The product model is protected by:

- frontend architecture tests that assert current ownership boundaries and physical deletion of retired UI contracts;
- negative legacy-contract scans over production frontend source;
- documentation-contract tests over normative docs;
- real-Sidecar Playwright tests for delegation, durable results, execution disclosure, Stop/Steer, task switching/concurrency, decisions, evidence/file analysis, Artifacts/Reports, localization, accessibility, contrast, narrow layouts, and credential sanitization;
- real-state visual-review captures.

## Modern native-agent extensions (opt-in, additive)

v1.10 is the native Agent window on a native shell. The following are **additive, bounded
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
- **OS-native shell** (real since v1.10.0) — a native menu bar (App ·
  Edit · Task · View · Window · Help with ⌘, Settings, ⌘N New task, ⌘. Stop,
  ⌘\ sidebar, ⌘F Find, ⌘I Artifacts, ⌘K palette, ⌘L Composer), deep links
  (`storage-agent://task/<id>` opens the Task, on cold start and from a
  second launch), one OS notification when an Execution settles while its
  Task is not on screen, a global summon shortcut (⌘⇧S / Ctrl+Shift+S) that
  focuses the Composer, and the OS window title `<task> — Storage Agent`.
  Every menu item dispatches the same command the keyboard and the palette
  use; in a browser the bridge is a no-op. Signed auto-updates stay inert
  until the distribution chain provides a pubkey/endpoints.
- **Runtime task titles** — after the first Work Result the runtime names the
  task from the Direction and the bounded Work Result text (never tool
  payloads or evidence rows); the sidebar and window title follow. A user
  rename wins forever. When the model is unavailable the seed title stays.
- **Reasoning effort** — a provider whose model is known-reasoning shows
  `model · effort` in the Composer chip with Default / Low / Medium / High;
  other models paint nothing and receive nothing.
- **Drag-and-drop attach** — a file dropped on the Composer takes the same
  bounded attach path as the `+` button.

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
