# Product model

> **Applies to Storage Agent v2.2.0.** This is the canonical product/UX specification. **v2.2.0 is Native agent depth:** every tool is callable from the first step (tool groups are gated only for context windows ≤ 16k tokens), the Direction is durable the moment its Execution starts, a continuation picks up where it stopped instead of starting over, a survey or import shows real progress on its running tool row, a one-Direction Task has no Work log, and opening a detail row never moves the window. **v2.1.0 was the Native agent:** nothing pauses an Execution for approval and the model keeps no plan — the one data-moving tool runs inside hard server-side bounds, Stop is the brake, and work a restart interrupted continues on its own. **v2.0.0 was the Result-first Task:** a Task opens on its latest Result — the conclusion the model recorded (answer, findings by severity, next steps), then the full answer, figures and detail rows that expand in place — with the Work log below; the Artifacts side panel is gone. v1.09 tears down the v1.04–v1.08 web-app chassis and ships the native Agent window: sidebar · title bar · one Task document · one Composer. v1.10 makes the OS shell and the runtime native. v1.11–v1.16 made the transcript and the protocol native. **v1.17.0 is the Codex window:** UI and UE match Codex's quiet Agent surface. **v1.19.0 is the Document-native window:** a turn is a document section headed by its Direction — no bubbles, no speaker alternation. **v1.18.0 was the native core:** the same window over one submit path, Decision-gated data movement (replaced by server-side bounds in v2.1), and a Steer rendered as the user's own *Steered* line instead of a tool row. Earlier release notes are not current product architecture.

## Product definition

Storage Agent is a local-first desktop Agent for object storage and S3-compatible systems. The user delegates an outcome or problem; the Agent performs real read-only work, remains steerable and stoppable while it executes, keeps its one data-moving tool inside hard server-side bounds, and returns durable technical results backed by reviewable evidence and execution.

The product invariant is:

> **The Agent Task is the application.**

The canonical work model is:

> **Direction → Execution → Work Result → Artifact**

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

Direction is durable task input. Since v2.2 it is persisted the moment its Execution starts (event `direction.recorded`), so a reload mid-run reads it from the document; the answer lands under that same row. A machine-shaped storage error may render as a structured S3 Error Artifact when that representation preserves the useful fields better than raw text.

### Execution

Execution is what the runtime actually did: model/tool work, deterministic analysis, uploads/import preparation, and other real activity.

Since v0.94 an Execution is a durable object with a real lifecycle — `queued`, `running`, `completed`, `failed`, `cancelled`, `interrupted` (a Sidecar restart caught it mid-flight). `waiting` remains in the schema from the approval era (v1.11–v2.0); since v2.1 nothing puts an Execution there. Its progress is an append-only log of structured events, never an inference from Agent prose. UI disconnect, Task switching, and reload never interrupt an Execution.

v0.95 makes that lifecycle operable in the Task:

- **Automatic continuation (v2.1).** After a Sidecar restart, every Execution the restart stamped `interrupted` is continued once on its own: a new `kind=resume` Execution. Since v2.2 a continuation stores the user's Direction exactly as written; only the model's copy carries the continuation note and a bounded digest of the calls that already completed, so it picks up where it stopped rather than starting over. When the original Direction is still the Task's latest, the continuation answers under that same Direction. A continuation that is itself interrupted is not continued again (no crash loop), and nothing continues while no model is usable.
- **Resume** is a task-area action when the Task is `needs_attention` and the last Execution is `interrupted` or `failed` and automatic continuation was not possible; since v2.2 it is a quiet note (no card fill) with Resume as an ordinary (not primary) button and **Open Settings** beside it; its copy says the Agent could not continue on its own, and that Resume picks up where it stopped without starting completed calls over. It starts a new Execution with the same Direction and follows the new event stream. Resuming a user-cancelled execution is labelled a **retry** (`kind=retry`), not a recovery. Missing-key and generic error states are not Resume. A Direction queued behind the running execution is editable until it runs (v1.14); once running, steer it instead.
- A **Queued Direction** submitted while another Execution is running is visible in the Task and can be cancelled.
- Stream recovery after a drop is **sequence-only** (`after=<last seq>`). The blocking `/sessions` POST is not a recovery path.

Verify, cost simulation, and revisit remain runtime/engine paths. The user asks in Composer. There is no painted Verify control and no revisit schedule UI.

The UI may summarize or progressively disclose Execution, but must not invent:

- plans/checklists that the runtime did not emit;
- sub-agents or worker processes that do not exist;
- terminal/browser/computer control;
- worktrees/projects borrowed from coding Agents;
- storage mutations that are not implemented.

### No approval (v2.1)

Nothing pauses an Execution for the user. The one data-moving tool, `import_evidence`, runs inside the Execution within a hard server-side envelope: the source must be an evidence source the task's account survey discovered; at most 500 files / 256 MiB per call (larger requests are clamped and the result says coverage is partial); refused with nothing downloaded when the data directory would keep less than 1 GiB free; audited as `approved_by=agent`; and Stop ends it between files (v2.2: nothing from a stopped import is kept). `survey_account` runs up to its 500-bucket hard cap and reports coverage (`truncated`). The tool row shows what moved (files, bytes). While a survey or an import runs, its tool row shows real progress (v2.2): *120 of 500 buckets* / *120 / 500 个桶* as the muted note and a 2px hairline meter under the row, from the runtime's durable `tool.progress` counts — never a percentage guessed from time.

The approval card and its waiting state were removed, together with the approval policy, the Safety pane, and the model's plan card. `task_decisions` keeps pre-2.1 Decisions as read-only history; restart recovery withdraws any left pending. Nothing the model writes in prose raises anything, and no import dialog exists.

Read-only investigation is autonomous. The user's brake is **Stop**; the product's brake is the server-side bound.

### Work Result

A Work Result is the durable output object of an Execution — recorded by the Task runtime with its derived grounding (skills opened, evidence read, open questions recorded) and stopped/cut-short state. The model writes plain Markdown; there is no metadata block and no next-step proposal list in the prose.

**Conclusion (v2.0).** For investigative work the model also records the turn's **conclusion** with the `record_conclusion` tool: the direct answer in one or two sentences, the findings that carry it (each `high` / `medium` / `low` / `info`), and up to four next steps. The runtime persists it with the Work Result. The UI renders it as the head of the **Result** under one meta line (*Result · when · Evidence n · Gaps n · Tool calls n*): the answer as a lead paragraph (the same size with or without findings), findings most severe first, each with one status dot, and next steps as a vertical list of asks (arrow + text); a next step fills the Composer and waits for the user to delegate it. A turn without a recorded conclusion shows its answer alone: the UI never guesses a conclusion from prose, and evidence counts come from the tool trace, never from the model. It can contain prose, Markdown structure, tables, **deterministic SVG figures** of runtime analysis (cost horizons, inventory distributions, Drift classes, access-log mix), code/config fragments, structured errors, findings, and references to supporting Evidence/Execution.

Figures plot only values the runtime emitted. Gaps render as gap states. Unconfirmed prices withhold the cost axis. Age and storage class are independent series — there is no observed joint. Charts are not a new destination: they sit **inline in the Result** like a code block. Wide windows keep a 46rem reading measure; the right half stays quiet.

Findings and key figures are clickable when a provenance chain exists (`GET /agent-tasks/{id}/provenance`). Hover shows tool, time, and coverage; click expands the Evidence row under the Result and anchors to that finding. A missing chain reads **No direct evidence chain** — never a fabricated source.

A Work Result is not a transient chat bubble and should read like technical work output. Streaming work is live Execution in that same record. Once the current turn's Work Result is persisted, the live streaming copy is not also rendered.

### Artifact

Artifacts are durable, reviewable outputs attached to a Task: Markdown Reports, imported Evidence snapshots, completed analyses, and engine outputs such as Remediation Plans, baselines, and Drift reports when the Agent produced them. Persisted Execution detail is also reviewable context associated with the Task.

A Remediation Plan, if drafted, is typed and versioned. The operator applies it outside Storage Agent. There is no Verify button. The user can ask the Agent to re-probe.

### Detail rows (v2.0; formerly the Artifacts panel)

The Task's durable outputs are **rows under the Result** that expand in place: Evidence, Report, and Execution detail (⌘I / Ctrl+I opens them; tool rows, provenance marks and the palette open the matching row). A row appears only when something is behind it. Execution detail paints no empty *no findings* section and no default kind label: only Verify, revisit, resume and retry name their kind (v2.2). v2.1 removed the Remediation Plans and Baselines & Drift rows: those engines remain and the Agent narrates what they return. There is no side panel, no overlay, and no tabbed destination; the v1.11–v1.19 right split panel and the historical Review sheet are retired.

It must not create a second Agent input or a second task lifecycle.

## One Agent control path

There is exactly one primary Agent input.

- **Delegate** when no execution is active.
- **Steer** while the current Task is executing — steering acts on the CURRENT Execution (the direction is delivered into the running work), never by cancelling and restarting it.
- **Stop** while local execution is active.

Expanding a detail row or changing Task navigation state does not create a second composer.

## Task states

Product state is derived from live runtime state plus durable Task truth.

| State | Meaning |
| --- | --- |
| **Ready to delegate** | No active Task exists yet. |
| **Ready** | The Task is durable and can accept another Direction. |
| **Working** | Real execution is active. |
| **Needs attention** | Runtime/provider/execution state requires user intervention. |
| **Preparing / uploading** | Input/evidence preparation is actively occurring. |

Since v2.1 no state is derived from a Decision: *Needs decision* and the waiting state are gone (`needs_decision` is a legacy constant only). *Needs attention* paints a warn-coloured mark. After reload or Task switching, the state is re-derived from durable runtime truth, never from browser-local state.

## Background task behavior

Multiple Tasks may independently have real in-flight work because execution state is keyed by durable task/session identity rather than by the currently visible viewport.

This does **not** mean the product has hidden autonomous worker Agents. It means a real execution already started for Task A is not destroyed when the user opens Task B — and since v0.94 that ownership is the Sidecar's durable task runtime, so it also survives closing the stream, reloading the app, and a Sidecar restart (interrupted work continues automatically since v2.1; the explicit Resume action remains when it cannot). Recovering a Task reads its typed, versioned Storage Task Context — machine state is never rebuilt by replaying messages. Since v0.95 that typed context is also the Agent prompt's stable grounding.

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
- managed Evidence Import, bounded server-side (no confirmation since v2.1);
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
- data-moving or materially large/full-scan operations run inside hard server-side bounds (discovered source only, ≤ 500 files / 256 MiB per import call, disk headroom, audited, stoppable; a survey never exceeds 500 buckets and reports coverage);
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
| Decision (history only since v2.1) | `task_decisions` (`kind=approval`, `scope`) | `approval_events` + evidence-import records |
| Artifact | `task_artifacts` index | evidence/report persistence |
| Task memory | — | summaries/findings/agent-memory records |

Rules:

1. Product-facing UI and new public frontend ownership use Agent Task / Direction / Execution / Work Result / Artifact vocabulary.
2. Historical names are valid in persistence, API contracts, repositories, and narrow adapters where migration compatibility requires them.
3. A database/API name must never be used as justification for rebuilding old product information architecture.

## First-viewport hierarchy

The primary Task viewport should answer, in order:

1. **What is the Agent working on?** — the task name and its state, centred as one group in the window title bar, and the document itself.
2. **What did it conclude, and what is happening now?** — the work in progress at the top when an Execution runs, then the **Result** — one meta line (*Result · when · Evidence n · Gaps n · Tool calls n*; a calendar date after a week), the conclusion first (the answer as a lead paragraph, findings by severity, next steps as a list of asks), then the full answer. The Task opens at its top; nothing scrolls the reader to the end.
3. **What can I do now?** — Steer, Stop, Resume, put a next step in the Composer, open a detail row, or delegate the next Direction.

The empty window is one greeting line and the Composer in the middle band. The sidebar is New task, quiet task titles, Settings. Nothing else is painted.

Provider/model configuration, audit internals, and low-level counters are secondary unless directly relevant to the active work. The model chip on the Composer is the one place the active model shows; it is backed by the real provider list.

## Design rules

v1.17.0 is the Codex window on a native shell. Visual language is specified in
[`design-tokens.md`](design-tokens.md) and enforced by frontend token tests.

- The window is **sidebar · title bar · one document**. No activity bar, no status bar, no inspector column, no marketing copy anywhere in chrome.
- One achromatic surface ladder (`--canvas` … `--hover`), an ink primary (near-white on dark, near-black on light), hairline depth. Status (`danger` / `warn` / `success`) is the only colour, and it lives in a dot — never in prose, a border, or a number (v1.19). Dark and light are first-class.
- Type, radius, motion, and elevation come from tokens. No ad-hoc px type, no raw z-index, no `transition-all`.
- The Task is a **result-first document** (v2.0): banners · work in progress · the Result (conclusion · full answer · figures · detail rows) · the **Work log**. Long tables preview their first rows and expand and sort in place; folded rows stay findable. The Work log is a document, not a message exchange (v1.19): each turn is a section, and older answers fold to one line (the latest points up to the Result): its **Direction** is the section heading, left-aligned in the user's own words, one step below the Result's lead (no bubble, no grey Direction block, copy on hover); later turns open with a hairline. **Execution** is one *Worked for …* group of real tool rows (collapsed to wall-clock once settled — in the live work in progress every group stays open until the turn settles; failures never fold away). A tool row reads as what the Agent did (v2.1): a localized verb (*Checked bucket*), the target quiet in mono, the result muted, status only in the glyph; the raw tool name stays as `data-tool` and tooltip. **Work Result** is plain Markdown on the 46rem measure. No data track, no chip row under the answer, no metrics footer. There is no approval card and no plan card (v2.1). The latest Result stays while a newer Direction is at work; that Direction heads the work in progress and joins the Work log when its answer lands. **A one-Direction Task has no Work log** (v2.2): its commentary and the collapsed *Worked for …* line sit under the Result, just above the detail rows (Find still renders the ordinary log). A running survey or import row shows its count and a hairline meter. Opening a detail row or a new live item reveals it inside the document's own scroller; the window and the docked Composer never move (v2.2). Detail rows, finding details, folded answers, worked rows and new live items ease in with one short reveal that `prefers-reduced-motion` removes.
- Figures use `--viz-*` tokens and SVG/CSS only. No chart library. Never interpolate, extrapolate, or invent a horizon the runtime did not emit.
- Findings carry provenance. Missing chain is labelled, never implied.
- Composer is the Agent input and the empty-start surface: `+` attach, textarea, model chip, and a round send (↑) at rest; Steer (↑) + Stop (■) while working. No ContextMeter on the bar (usage lives in the model menu and Execution detail). No wizard, no `/` SKU menu, no attach-type chips, no persistent keyboard legend, no mode chip.
- The title bar carries the task name and its real state, centred as one group. Find (⌘F) and the command palette (⌘K) are keyboard. Detail rows open in place under the Result (⌘I). New task is a button; the shortcut is not painted on it.
- Task navigation is one chronological title list grouped by day. State is a row mark; Ready paints nothing. Rename and Delete only.
- Settings is a centered dialog: General · Model Providers · Cloud Providers · Skills & bridges. General holds theme, language, and the read-only safety floor as a statement (including the 500 files / 256 MiB import bound); Skills & bridges has **Open instructions file** (`AGENTS.md` in the data directory). The v1.12 Safety section and its approval policy control were removed in v2.1.
- A context compaction is one muted line *Context compacted · 48k → 9k tokens*. ⌘K offers **Compact context** for an idle task. The transcript paints no plan: the v1.12 plan card and its tool were removed in v2.1.
- Every non-ideal state (empty list, no Evidence, offline, interrupted, load earlier) is designed. Copy is restrained, specific, and bilingual.
- Keyboard: ⌘K/Ctrl+K command overlay maps only to runtime-true actions, grouped as Actions vs Tasks, with tasks fuzzy-ranked as you type (v1.13). It is not a destination menu.
- A steer acts on the running (else queued) execution; since v2.1 nothing waits, so there is no waiting execution to steer.
- Figures, evidence states, triage, and coverage read localized (v1.14). The empty start is one static greeting line plus the Composer (v1.15) — no glyph, no suggestion grid; engine discoverability is the palette (⌘K), and the model never pitches engines in prose.
- A stalled stream heals itself with a quiet reconnecting line and auto-retry (v1.15) — there is no Resync button. Earlier history loads as the reader nears the top.
- Tables render whole in the page flow (v1.16.1): no inner scroller, no pagination, `table-layout: fixed`, cells wrap at word boundaries.
- Copy lives in dictionaries with zh/en parity (v1.16); engines and shortcuts are palette entries that prefill the Composer; usage names the governor, memory reuse and window source; one Escape closes one layer; errors dismiss; reconnects back off. Usage renders from one vocabulary (v1.15): cached as a subset, partial reports as `~` floors, silence named, compaction marked estimated.
- A live turn running past ~90 s says the Execution is still working and that Steer/Stop remain (v1.17); the *Worked for …* clock is the group's wall clock throughout.
- Perceived latency: cached task documents render instantly on switch; never flash an empty canvas while the durable document is already known.
- First Work Result on a new install is real delegated work, not a demo or a wizard checkup.

## Quality contract

The product model is protected by:

- frontend architecture tests that assert current ownership boundaries and physical deletion of retired UI contracts;
- negative legacy-contract scans over production frontend source;
- documentation-contract tests over normative docs;
- real-Sidecar Playwright tests for delegation, durable results, execution disclosure, Stop/Steer, task switching/concurrency, bounded evidence import, evidence/file analysis, detail rows/Reports, localization, accessibility, contrast, narrow layouts, and credential sanitization;
- real-state visual-review captures.

## Modern native-agent extensions (opt-in, additive)

v1.10 is the native Agent window on a native shell. The following are **additive, bounded
and opt-in** extensions that deepen the same window without replacing it. Each
reuses the durable runtime, the read-only tool floor, and the same redaction
and server-side bounds; none introduces a second Agent or a new top-level
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
  ⌘\ sidebar, ⌘F Find, ⌘I Show Details, ⌘K palette, ⌘L Composer), deep links
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
secrets only in the encrypted vault, server-side provider scope, hard
server-side bounds on data movement, bounded/sanitized context, and no chain-of-thought
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
