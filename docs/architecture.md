# Architecture

> **Current architecture baseline: Storage Agent v1.10.0.** Native Agent window on a native OS shell. Sidecar engines from v0.96 remain; they have no product UI entry. Product invariant unchanged. Migration head **028**.
>
> Product invariant: **the Agent Task is the application**. See `docs/README.md` for documentation precedence.

## 1. Architectural intent

Storage Agent is a local-first desktop Agent for object-storage work. The frontend is organized around one durable Agent Task, not around persistence tables or independent application surfaces.

Canonical flow:

```text
Direction
   │
   ▼
Agent Task ─────────────── Steer / Stop
   │                           ▲
   ▼                           │
Execution ─────────────────────┘
   │
   ├── safe read-only work ───────────────────┐
   │                                          │
   └── gated tool (import_evidence)           │
           │                                  │
           ▼                                  │
      Waiting for approval (inline card)      │
           │                                  │
           └──── Allow / Allow for task ──────┘
                 Deny → structured refusal
   │
   ▼
Work Result
   │
   ├── Evidence
   ├── Execution detail
   └── Report Artifact
```

No UI may imply a capability, worker, plan, or control path that the runtime does not implement.

## 2. Runtime topology

```text
┌─────────────────────────────────────────────────────────────┐
│ Tauri v2 desktop shell                                      │
│ window lifecycle · packaged resources · Sidecar lifecycle   │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│ React + TypeScript Agent UI                                 │
│ Sidebar · Title bar · AgentShell · AgentTask · Artifacts   │
└──────────────────────────┬──────────────────────────────────┘
                           │ localhost HTTP / SSE
                           │ X-Sidecar-Token / SSE token query
┌──────────────────────────▼──────────────────────────────────┐
│ Python FastAPI Sidecar                                      │
│ persistence · Agent runtime · tools · evidence · executions │
│ reports · provider adapters · encrypted-vault integration   │
└──────────────────────────┬──────────────────────────────────┘
                           │
               explicitly configured endpoints only
               model provider / S3-compatible storage
```

The packaged Tauri launcher chooses a free localhost port, generates a per-launch auth token, launches the Sidecar, exposes URL/token to the webview, and tears the Sidecar down on exit. The UI never receives plaintext provider/model secrets.

## 3. Frontend ownership

### 3.1 `App.tsx`: application composition

`frontend/src/App.tsx` owns global composition rather than task-rendering semantics:

- Sidecar health and reconnect state;
- durable task list refresh;
- active task identity;
- task lifecycle actions (create/rename/delete);
- the window title bar (task name + real task state; the sidebar toggle and New task when the sidebar is collapsed) and the OS window title;
- the Settings dialog, command palette, and shortcuts sheet;
- **one command handler** (`runCommand`) that the keyboard, the palette and the native menu all dispatch through, with a short de-duplication window so a menu accelerator and a keydown for one keypress are one command;
- the shell bridge (`hooks/useNativeAgent.ts` → `useNativeShell`): menu commands, deep links, the summon shortcut, notifications on background settle (`useSettleNotifications`, driven by the per-task run store), and the window title. A plain browser is a no-op.

The window it composes is exactly: `AgentTaskNavigation` (sidebar) · title bar · `AgentShell` → `AgentTask`. There is no activity bar, no status bar, no Details/inspector column. On the packaged macOS shell the overlay title bar leaves room for the native traffic lights (`hasNativeTrafficLights`).

Legacy frontend adapters from earlier releases were physically removed. Do not recreate an intermediate application shell merely to mirror backend entity names.

### 3.2 `AgentTaskNavigation`: the sidebar

`frontend/src/agent/AgentTaskNavigation.tsx` owns the sidebar: a window chrome row (drag region + collapse toggle), **New task**, one chronological task list, and **Settings**.

Each task row combines:

- durable task metadata from the Sidecar task projection;
- current per-task runtime state from the client execution store;
- a state mark (Ready paints nothing; Working pulses; Needs decision / Needs attention are status colours);
- relative time on hover, and Rename / Delete behind one More control.

The list is one chronological sequence by `updated_at`. Section titles, search, pin, duplicate, archive, day buckets and database counters are not painted. The New task control is a button; it does not paint ⌘N. Collapsed, the sidebar has zero width and its toggle + New task move into the title bar.

The Sidecar `/agent-tasks` projection provides durable decision truth so a pending confirmation remains visible after reload/restart even when browser-local runtime state is gone.

### 3.3 `AgentShell`: active task environment

`frontend/src/agent/AgentShell.tsx` owns the active task environment:

- Artifacts panel open/close state and selection (`agent-artifacts-panel`, a right split; an overlay only under a narrow window), opened from the document or ⌘I;
- selected Execution inside that sheet.

There is no task header inside the document, no live execution strip, and no second presentation mode.

`AgentShell` receives `taskContent: ReactNode`. Its primary area is always the Agent Task.

Review is subordinate to the Task. Opening Review does not create another task, another lifecycle, or another Agent input.

### 3.4 `AgentTask`: public task boundary

`frontend/src/components/AgentTask.tsx` is the public task component. It exposes Task-native props to `App` and owns semantic task navigation/keyboard behavior. Bare **j** / **k** move one Direction to the reading start by writing the task scroller; they do not animate to an already-visible target.

`AgentTaskImplementation.tsx` owns the large task document implementation:

- durable task document loading and paging;
- task draft state;
- the one Composer, and the empty start (greeting + Composer in the middle band);
- submission/streaming integration;
- steering/stopping/resuming;
- attachments (type inferred from filename);
- Direction and Work Result rendering;
- real tool rows in the document (`LiveTrace`, one *Worked for …* group);
- Next Actions / Decisions that require confirmation;
- find and task viewport behavior.

Historical `sessionId` terminology may appear inside compatibility adapters and API calls. Public product ownership remains `taskId`/Agent Task.

### 3.5 One Composer

`frontend/src/components/Composer.tsx` is the only Agent input. It is `+` attach + textarea + model chip (`ModelChip`, backed by `/model-providers`; switching activates a provider server-side) + Delegate / Steer / Stop. Shortcuts exist; they are not painted as a persistent legend on the input.

```text
no active execution  -> Delegate (round ↑)
active execution     -> Steer (round ↑ when text is present) + Stop (■)
upload preparation   -> preparing/working state
runtime unavailable  -> truthful disabled/actionable state
```

Review or a deep artifact must never mount a hidden second composer.

### 3.6 Presentation layers

`frontend/src/index.css` holds the tokens (achromatic ladder, ink primary, status colours, type/radius/motion). `frontend/src/agent/native-shell.css` styles the window, sidebar, title bar, and Artifacts panel. `frontend/src/agent/native-document.css` styles the Task document: transcript turns (user bubble, commentary, *Worked for …* group, approval card, answer), banners, Composer, empty start. There are no other presentation layers.

## 4. Task document primitives

### Direction

A durable user contribution is rendered as Direction. Direction may be copied. There is no Redirect or Branch chrome on Direction.

A predominantly machine-shaped S3/storage error can render through `S3ErrorArtifact`, preserving the structured error fields and raw payload access without pretending it is ordinary prose.

### Execution

Execution represents real work performed by the runtime — and since v0.94 it is
a DURABLE domain object owned by the Sidecar's task runtime (`task_executions`
with lifecycle `queued` / `running` / `waiting` / `completed` / `failed` /
`cancelled` / `interrupted`), not a conversational turn owned by an HTTP
request.

Durable truth is the execution row plus its append-only structured event log
(`execution_events`): status transitions, tool started/completed, steer
received/applied, decision opened/resolved, work result recorded. Execution
progress is derived from these structured events — never inferred from
assistant prose.

The browser's per-task execution store carries only the LIVE VIEW of that
durable truth: streamed Work Result text, merged tool activity, busy/upload
presentation state. Losing it (reload, task switch, second window) loses
nothing — the client reattaches by replaying the durable event log from any
sequence number.

Tool rows are one collapsed *Worked for …* group between the model's commentary segments (v1.11 transcript turn); its time is the group's wall clock, not a sum of durations (v1.12). The model's plan (`update_plan`) is one quiet checklist card at the position of its first call; a compaction is one muted marker line. The Artifacts panel exposes sanitized Execution detail — built from `task_executions` + the durable `execution_events` log + one sanitized `tool_calls` row on demand, never a `/runs` stream (v1.12) — without turning the Task into a permanent trace console.

### Decision (inline approval)

Since v1.11 a Decision is raised by a **gated tool inside the running Execution** (`import_evidence`): the Sidecar plans the bounded download, opens a `task_decisions` row (`kind=approval`) with the projected impact, appends `approval.opened`, and the Execution goes `waiting` while its worker blocks. The transcript shows the approval card inline at that point with **Allow · Allow for this task · Deny**. Allow runs the audited import server-side and returns its bounded result to the model; Deny returns a structured refusal; "Allow for this task" (`scope=task`) lets later calls of the same `action_type` in that Task proceed as recorded, already-approved Decisions. Model prose never raises a Decision, and there is no separate confirmation dialog.

The frontend must not downgrade a real confirmation boundary into an ordinary suggestion for visual simplicity, and must not paint one the runtime did not raise.

### Work Result

A completed assistant-side task event is rendered as Work Result.

Streaming work is Execution; persisted completed output is Work Result. Once the current turn's Work Result is persisted, the live streaming copy is not also rendered — the Task shows one readable record. Work Results can contain structured Markdown, tables, code/config fragments, storage-specific artifacts, metrics, and provenance links into contextual Review.

### Artifacts

`frontend/src/agent/ArtifactsPanel.tsx` is a right split (`agent-artifacts-panel`) beside the Task document (an overlay only under a narrow window), toggled by ⌘I and opened from the document:

```ts
"evidence" | "report" | "plan" | "baseline" | "execution"
```

- **Evidence** — persisted evidence/finding/activity truth, with provenance marks.
- **Reports** — the durable Markdown Report artifact.
- **Plans** — read-only Remediation Plan documents.
- **Baselines & Drift** — versioned baselines and Drift reports.
- **Execution** — persisted executions; one opens as a document (header · *Worked for …* rows · findings · result).

There is no Overview surface, no tabbed Review application, and no engine walls: the panel lists durable referents and shows one document at a time, with a back control. It is not an independent application destination.

## 5. Runtime state and task concurrency

### 5.1 Per-task client execution state

`frontend/src/sessionRuns.ts` retains a historical filename, but the store is keyed by durable task/session identity and preserves real in-flight state independently of which Task is visible.

Therefore:

> Task A may continue a real already-started execution while the user views Task B; selecting Task A again reconnects to that same work.

This must not be represented as a fleet of hidden autonomous Agent workers. It is per-task ownership of real execution.

### 5.2 Execution runner

The execution runner is the single submission lifecycle, and since v0.94 the
Sidecar's task runtime OWNS the execution — the client only submits and
observes:

1. acquire the submit latch for the target Task;
2. submit the Direction: `POST /agent-tasks/{id}/executions` creates a durable
   queued execution (idempotent on the client turn id);
3. follow the execution's durable structured event stream (resumable by
   sequence number). A dropped stream reconnects with `after=<last seq>`
   only — there is no blocking POST fallback and no assistant-id poll; while
   the stream is open the client reads `task.status` frames instead of
   polling `/state` (v1.12);
4. update real Tool activity and streamed Work Result from those events;
5. Steer posts into the CURRENT execution (`POST /agent-tasks/{id}/steer`) —
   never cancel-and-resend; Stop cancels the durable execution (including a
   queued one) and the partial Work Result persists;
6. Resume (`POST .../executions/{eid}/resume`) starts a NEW execution for an
   `interrupted` / `failed` last Execution and the client follows that new
   stream; Queued Directions are projected from task state;
7. Verify and scheduled revisits remain Sidecar `runtime.submit` kinds with
   no painted UI controls; the user asks in Composer;
8. completion, waiting-on-Decision, failure, and interruption are durable
   execution states, not inferences;
9. reload the persisted task document.

UI disconnect, task switching, and reload never interrupt an execution; a
Sidecar restart stamps in-flight executions `interrupted` — including
`waiting` ones (v1.13: their gated tool died with the process, so no worker
remains to continue it; the pending Decision survives and Resume re-plans and
re-raises it) — which the Task surfaces with an explicit Resume action
(`retry` when the prior execution was user-cancelled). Do not bypass this
lifecycle with another submit/steer path. The `/sessions` message endpoints remain
compatibility shims and are not the frontend recovery means.

### 5.3 Durable task document

Task document loading is paged. Recent durable content is loaded first and earlier content can be prepended without losing current Execution state or viewport ownership. The browser document cache keeps at most 24 tasks and truncates cached transcripts to the latest 200 messages (v1.13) — earlier pages re-fetch from `message_total`, so the bound costs a re-fetch, never content.

Long-task scalability is therefore a persistence/paging concern, not a reason to collapse the product back into message-history navigation.

## 6. Sidecar architecture

The Sidecar owns:

- SQLite migrations/repositories;
- the one model-driven Agent runtime;
- the durable task runtime (`app/task_runtime/`): the execution supervisor,
  durable event log, first-class Decisions/Work Results/Artifacts, typed task
  context, and restart recovery;
- whitelisted storage tools;
- deterministic run/analysis engines, including cost/lifecycle simulation,
  remediation-plan verify diffs, and baseline/Drift comparison
  (`app/analysis/`);
- optional per-task revisit scheduling (`app/task_runtime/revisit.py`);
- account/config discovery;
- Evidence Import plan/confirmation/execution;
- local DuckDB analysis;
- task memory/findings/summary;
- reports;
- audit/turn metrics;
- provider adapters and secret resolution.

There is exactly one model-driven Agent loop. Deterministic engines remain beneath it as security/reproducibility mechanisms; they are not a second product Agent.

### 6.x Native runtime additions (v1.12.0)

- **Push transport.** `task_runtime/hub.py` keeps one entry per live
  execution; a follower (`event_stream.execution_frames`) registers an
  `asyncio.Event` and is woken from the worker thread on every delta, marker,
  and durable append (`loop.call_soon_threadsafe`). There is no SQLite poll
  loop; an idle stream sends a heartbeat comment every 15 s. The store appends
  `task.status` (status, active execution, bounded queue, pending decisions
  with impact, last execution) to the running/waiting execution's log whenever
  the derived task status or queue changes, so a following client never polls
  `/state`.
- **One protocol.** The `/sessions` message, stream, cancel, turn, and
  action-prepare endpoints, the `legacy_frames` translation, and
  `proposed_actions` are gone; `sessions/next_actions.py` keeps only the
  deterministic proposal normaliser the summary/triage engines use.
- **Plan tool.** `agent_runtime/plan_tools.py` registers `update_plan`
  (≤ 12 steps × 160 chars, redacted, CoT-stripped, budget-exempt). Each call
  is a `plan.updated` event; `stream._Segments` folds all calls of a turn into
  ONE `plan` turn item at the first call's position; the record is never a
  tool row and never in the Work Result's `tool_activity`.
- **Approval policy.** `task_runtime/approval_policy.py` (`ask` ·
  `allow_session` in process memory · `allow_always` in `app_settings`) is
  consulted only in `runtime.request_approval`; an auto-approval is a durable
  approved Decision (`scope = session | always`) plus `approval.granted
  {policy}`. `survey_account(max_buckets > 100)` raises
  `survey_account_large` through the same gate.
- **Compaction.** `agent_runtime/compaction.py`: when the last turn's reported
  input usage ≥ 80 % of `model_budget.context_window`, `_run_execution` runs
  one tool-less streamed call (marker `[[storage-agent:compact]]`, private
  loop, 60 s ceiling, seam `COMPACT_STEP`) that summarises the sanitized
  replay into ≤ 2 000 redacted chars, stored as a new context version
  (`summary_sanitized`, `summary_through_seq`, migration 030). The prompt
  builder puts `conversation_summary` in the stable half and replays only
  later messages; `context.compacted` is appended and the turn starts with a
  `compacted` item. `POST /agent-tasks/{id}/compact` runs the same step on
  demand (idle task only). The overflow cut marker stays as the last resort.
- **Instructions file.** `agent_runtime/instructions.py` loads
  `STORAGE_AGENT_DATA_DIR/AGENTS.md` (or `STORAGE_AGENT_INSTRUCTIONS`):
  Markdown only, ≤ 8 000 chars, redacted, injected after the skills catalog in
  the stable prompt half, never executed; `GET /settings/instructions` reports
  status only.
- **Tool timing.** Tool records and `tool.*` events carry `started_at` /
  `finished_at` / `duration_ms`; *Worked for …* is the group's wall clock.

### 6.x Interaction truth and content craft (v1.14.0)

- **Steer reaches waiting executions.** `runtime.steerable_execution`
  prefers running/queued, else a live `waiting` execution: the text lands in
  its steer queue (plus a `steer.received` event) and injects at the next
  tool boundary after the decision resolves — or rides the follow-up on
  decline. No more 409-then-silent-requeue.
- **Editable queue.** `PATCH .../executions/{eid}` rewrites a queued
  Direction (`store.update_queued_direction`, 409 past the queue), audited.
- **Usage rows.** Execution detail matches the Work Result's message to
  `turn_metrics` and renders only reported fields.
- **One clipboard path** (`hooks/useCopy.ts`), yaml/toml/ini highlighting,
  per-execution detail pages (v1.13) unchanged.

### 6.x Honesty and completeness (v1.13.0)

- **Real MCP dispatch.** `routers/mcp.py` executes the stateless allowlist
  through the S3 layer with the same scope/redaction/bounds, recorded via
  `tool_runner` (sanitized `tool_calls` + audit rows). Session-bound tools
  (surveys, profiles, uploads) are not exposed — the bridge is stateless by
  design. `GET /mcp/client/status` reports the consuming-client non-goal.
- **OTel spans.** `routers/observability.py` projects durable events as
  OTel-inspired spans (deterministic `trace_id`/`span_id`, W3C
  `traceparent`), no migration; the events column bug (wrong column name
  swallowed by a bare except) is fixed and the failure path logs.
- **Per-execution event pages.** `GET
  /agent-tasks/{id}/executions/{eid}/events-page` serves one execution's JSON
  pages; Execution detail reads here instead of scanning the whole task log.
- **Strict kinds.** Unknown execution `kind` is 422, never a silent downgrade.
- **Compaction without usage.** The trigger falls back to a character
  estimate when the endpoint reports no usage; token estimates are
  CJK-weighted; each step folds the prior summary (chained); `AGENTS.md`
  reads are mtime-cached for 5 s.
- **Capability memories clear** on a green `POST /model-providers/{id}/test`.
- **Bounded fanout, named.** The account survey's `_PROBE_WORKERS = 4`
  thread pool is the product's single-agent fanout (shards in parallel,
  merged as one `survey_account` tool row, `fanout_workers` in the result).
  Pinned by `test_v113_native_fanout.py`.

### 6.x Title step and reasoning effort (v1.10.0)

`task_runtime/titling.py` runs once per task, after the first Work Result
persists and before the execution's terminal status event: one tool-less,
streamed model call on the same per-run client as the session Agent
(`build_agent`), prompt = redacted Direction (≤ 600 chars) + redacted Work
Result text (≤ 1200 chars) + a marker test doubles recognise, ≤ 32 output
tokens, hard 15 s ceiling. The answer is sanitized (one line, ≤ 8 words,
≤ 64 chars, redacted, no URLs) and stored on `sessions.title` with
`title_source = 'agent'`; `agent_tasks.title` is synced; the event log gets
`task.titled`. A `PATCH /sessions/{id}` rename sets `title_source = 'user'`
and the step never runs again for that task. Failures keep the seed title
and never fail the turn. The legacy blocking seam (`SESSION_LOOP` fakes)
does not run the step.

`model_providers.reasoning_effort` is forwarded as `ModelSettings.reasoning`
(Chat Completions `reasoning_effort`) only when
`model_budget.is_reasoning_model(model)` is true; `get_model_credentials`
drops it otherwise, so an endpoint that would reject the parameter never
sees it. `ModelProviderOut.reasoning_capable` is the projection the Composer
chip paints against.

## 7. Persistence compatibility boundary

The database/API schema predates v0.93. Renaming every stored entity would add migration risk without changing the product, so Storage Agent intentionally keeps a **persistence compatibility** layer.

| Product | Durable runtime (v0.94) | Compatibility persistence/API |
| --- | --- | --- |
| Agent Task | `agent_tasks` | `sessions`, `/sessions/...`; `/agent-tasks` surface |
| Direction | `task_executions.direction` + steer events | `session_messages` (user rows) |
| Execution | `task_executions` + `execution_events` | `runs`, `session_runs`, `tool_calls`, `turn_metrics` |
| Work Result | `work_results` | `session_messages` (assistant rows) |
| Decision | `task_decisions` (`kind=approval`, `scope`) | `approval_events` + evidence-import state |
| Artifact | `task_artifacts` index | report endpoints/files, evidence-import tables |
| Storage Task Context | `task_context_versions` | — |
| Task memory | — | `session_summaries`, `session_findings`, `session_agent_memory` |
| Evidence | — | evidence refs/sources/import tables |

Boundary rules:

1. Historical names are valid inside Sidecar persistence/API and narrowly scoped frontend adapters.
2. New public frontend ownership uses current product vocabulary.
3. Compatibility names never justify rebuilding a Session/Run-centered product shell.
4. If backend entities are renamed later, product semantics remain unchanged unless an explicit product change says otherwise.

## 8. Security architecture

### Secrets

- Secret values live only in the encrypted local vault.
- SQLite stores `keyring://...` references.
- API responses expose presence/reference metadata, not plaintext secrets.
- Secret values are excluded from model context, logs, reports, audit payloads, and browser state.

### Storage capabilities

- Agent storage operations are typed and read-only.
- Provider bucket/prefix allowlists are enforced server-side.
- No generic shell, arbitrary subprocess, unrestricted filesystem, or raw S3 client is exposed to the Agent.
- No destructive/mutating S3 action is shipped.

### Data movement and analysis

- Bounded safe read-only investigation may proceed autonomously.
- Data-moving or materially large/full-scan operations require a real confirmation boundary.
- Raw inventory/access-log rows remain in local deterministic analysis paths; model context receives bounded sanitized aggregates/findings.

### Evidence truth

- persisted Tool input/output and Evidence are sanitized;
- audit gaps are represented as gaps;
- missing provider capability is explicit;
- chain-of-thought is neither persisted nor rendered.

See `security.md`.

## 9. Modern native-agent extensions

Additive, bounded, and gated. They sit on the same durable runtime and the
same security floor; none adds a second Agent, a second submit path, or a
new top-level navigation surface.

- **User skills** — `sidecar/app/skills/loader.py` now merges the 20 bundled
  `StorageOps` skills with `STORAGE_AGENT_DATA_DIR/skills/*/SKILL.md` and
  `STORAGE_AGENT_SKILLS_DIR`. User skills shadow bundled ones by name, are
  read via `read_skill` only, never executed, and bounded to
  `MAX_CHARS_PER_SKILL`. `GET /skills` lists the merged catalog; the prompt
  still carries only the catalog, not bodies.
- **Local model providers** — `agent_service.LOCAL_PROVIDER_TYPES`
  (`ollama`, `lmstudio`, `vllm`, …) may omit an API key; the client sends
  `not-needed` and falls back to a localhost default `base_url`
  (`11434/v1`, `1234/v1`, `8000/v1`). `POST /model-providers/{id}/test`
  probes `GET {base}/models` with a dummy bearer for locals, so a local
  model tests green without a key. `model_budget` adds conservative windows
  for local families so budgeting scales rather than throttles.
- **Observability export** — `GET /agent-tasks/{id}/export/otel` (bounded
  `execution_events` + `tool_calls` + `turn_metrics` + `task_artifacts`) and
  `GET /observability/export` (global task/execution counts + sanitized provider
  presence) project already-sanitized rows as OTel-inspired JSON. No new
  tables. Frontend `NativeAgentPanel` and future Task affordances call the
  same endpoint the agent could.
- **Read-only MCP bridge** — `sidecar/app/routers/mcp.py` (`/mcp/status`,
  `/mcp/tools`, `POST /mcp/tools/call`) re-exports the whitelisted read-only
  storage tools. Disabled by default; `STORAGE_AGENT_ENABLE_MCP=1` enables it.
  The allowlist is the source of truth — no shell, no raw boto3, no
  filesystem escape. The bridge reuses the same scope/redaction/bounds as
  `tool_runner`.
- **OS-native desktop** — `src-tauri/src/lib.rs` builds the menu bar
  (`build_menu`: App · Edit · Task · View · Window · Help; every custom item
  is one of `MENU_COMMANDS` and is emitted as `menu-command {id}`), handles
  deep links through the plugin's `on_open_url` plus argv on a second launch
  (`single-instance`) and cold start, emitting `deep-link-request {urls}`
  after validating `storage-agent://task/<id>`, registers the global summon
  shortcut (`shortcut-event`), and exposes three commands: `notify`
  (title + body), `set_window_title`, and `open_app_folder` (named
  subfolders of the app data dir only — today `skills`; not a filesystem
  tool). `tauri.conf.json` registers the `storage-agent` scheme. The
  frontend mirrors `MENU_COMMANDS` in `useNativeAgent.ts`; an architecture
  test keeps both lists and every event name in step. `updater` stays
  inert until a pubkey is configured. `singleInstance` remains the first
  plugin.

## 10. Desktop packaging

The production React bundle and PyInstaller one-dir Sidecar are packaged by Tauri.

Current release targets:

- macOS Apple Silicon: `.app.zip` and `.dmg`;
- Linux x64: `.deb`;
- Windows x64: NSIS setup executable.

The Sidecar is embedded as a resource, not exposed as a shell capability. Runtime-verification scripts confirm packaged startup, Sidecar health, and cleanup.

Signing/notarization is a distribution concern documented in `signing.md`; CI does not require private signing credentials.

## 11. Executable architecture contracts

### Positive ownership guard

`frontend/src/agent/architecture.test.ts` asserts v1.09 ownership, including:

- physical removal of every earlier shell and CSS layer (v0.92 surfaces, v1.0x activity bar / inspector / drawer, six retired stylesheets);
- window composition: sidebar · title bar · task document, nothing else;
- the sidebar as one chronological title list with Rename / Delete only;
- one Agent input: attach + text + model chip + Delegate / Steer / Stop, with the contract placeholders;
- Direction / Execution (*Worked for …* group) / Work Result as one document without chat chrome;
- the empty start as greeting + Composer, no wizard or SKU catalog;
- explicit Decision boundaries with impact and Decline;
- the Artifacts panel limited to Evidence / Reports / Plans / Baselines & Drift / Execution detail;
- Settings as a dialog of model + storage + general + safety;
- sequence-only stream recovery and settled-execution catch-up;
- task-native keyboard contracts;
- deterministic figures from provenance;
- tokens: achromatic ladder, ink primary, hairline depth, measure/track.

### Negative production-source guard

`frontend/src/agent/legacy-ui-contracts.test.ts` scans production frontend source and rejects retired product vocabulary/component contracts that could compile successfully while semantically rebuilding an old shell.

### Documentation guard

`frontend/src/agent/documentation-contract.test.ts` anchors normative documentation to v1.09 and prevents current product docs from drifting back toward retired information architecture.

### Real-Sidecar E2E

Playwright validates real Sidecar-backed behavior including:

- delegation and durable Work Results;
- streaming and persisted Tool execution disclosure;
- Stop and mid-execution Steer;
- task switching/concurrency;
- evidence/file analysis;
- Decisions and confirmation flows;
- task navigation/drafts/paging;
- contextual Review and Report artifacts;
- localization, accessibility, contrast, narrow layouts;
- credential sanitization.

### Visual review

`npm run shots` captures asserted real states for human review. It is not a tolerant pixel-diff substitute for design judgment.

## 12. Explicit non-architecture

The following concepts must not enter the product until a real runtime + safety contract exists:

- fake multi-agent delegation;
- synthetic plans/checklists unsupported by runtime state;
- coding worktrees/projects;
- generic terminal/browser/computer control;
- hidden worker processes represented as autonomous Agents;
- destructive storage mutation;
- page-per-persistence-table navigation;
- realtime collaboration, multi-user SaaS/RBAC, or Postgres/Redis for the
  local desktop product (v1.13: local-first SQLite/DuckDB + single-user vault
  is the design, not a missing feature — see also §9 gated extensions).

The goal is a trustworthy delegated-work loop: the user sets Direction, watches real Execution, can Steer/Stop, crosses only real Decisions, and receives reviewable durable results.
