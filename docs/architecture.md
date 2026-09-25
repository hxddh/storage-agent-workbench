# Architecture

> **Current architecture baseline: Storage Agent v2.2.0.** Native agent depth: every tool is callable from the first step (the `load_tools` group gate applies only to context windows ≤ 16k tokens), the Direction is persisted when its execution starts (`direction.recorded`), a resume/retry keeps the Direction as written and gives the model a bounded digest of completed calls (`task_runtime/continuation.py`), and survey/import report real counts as durable `tool.progress` events (`app/progress.py`). It sits on the v2.1.0 Native agent: nothing pauses an Execution for approval and the model keeps no plan — the one data-moving tool (`import_evidence`) runs inside hard server-side bounds, Stop is the brake, and restart recovery continues interrupted work on its own. That sits on the v2.0.0 Result-first Task (a Task opens on its latest Result — the runtime-recorded conclusion, then the full answer and detail rows — with the Work log below), the v1.19.0 document and the v1.18.0 native core: one submit path, reads that never start work, Task vocabulary in product code. Sidecar engines from v0.96 remain; they have no product UI entry. Product invariant unchanged. Migration head **031** (v2.0 conclusion columns; v2.1 and v2.2 add no migration; v1.12–v1.19 stayed at **030**).
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
   ├── safe read-only work
   │
   └── bounded data movement (import_evidence:
         discovered source · ≤ 500 files / 256 MiB per call ·
         disk headroom · audited approved_by=agent · Stop ends it)
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
│ Sidebar · Title bar · AgentShell · AgentTask (Result · log)│
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
- a state mark (Ready paints nothing; Working pulses; Needs attention is warn-coloured);
- relative time on hover, and Rename / Delete behind one More control.

The list is chronological by `updated_at`, grouped by day (`dayGroups()`: Today, Yesterday, then dated headers). Search, pin, duplicate, archive and database counters are not painted. The New task control is a button; it does not paint ⌘N. Collapsed, the sidebar has zero width and its toggle + New task move into the title bar.

The Sidecar `/agent-tasks` projection provides durable lifecycle truth so state survives reload/restart even when browser-local runtime state is gone. Since v2.1 no row carries `requires_decision` and no task is derived *needs decision*.

### 3.3 `AgentShell`: active task environment

`frontend/src/agent/AgentShell.tsx` owns the active task environment:

- which detail row under the Result is expanded, and the document open in it (`TaskDetailsContext`; v2.0 — formerly the `agent-artifacts-panel` right split, now retired), opened from the document or ⌘I;
- the durable outputs those rows list (`useAgentTaskProjection`), re-read when an execution settles.

There is no task header inside the document, no live execution strip, and no second presentation mode.

`AgentShell` receives `taskContent: ReactNode`. Its primary area is always the Agent Task.

The detail rows are part of the Task document. Expanding one does not create another task, another lifecycle, or another Agent input.

### 3.4 `AgentTask`: public task boundary

`frontend/src/components/AgentTask.tsx` is the public task component and, since v1.18, the one composition root of a Task (the historical `AgentTaskImplementation` wrapper is gone). It exposes Task-native props (`taskId`, `onTaskCreated`, `onTaskDiscarded`) to `App` and mounts `hooks/useDirectionStepping`: bare **j** / **k** move one Direction to the reading start by writing the task scroller; they do not animate to an already-visible target.

It composes (through `useTaskDocument`, `useLiveTask`, `useTurnRunner`, `useTaskComposer`, `TaskDocument`, `TaskBanners`, `TaskComposerHost`):

- durable task document loading and paging;
- task draft state;
- the one Composer, and the empty start (greeting + Composer in the middle band);
- submission/streaming integration;
- steering/stopping/resuming;
- attachments (type inferred from filename);
- Direction and Work Result rendering;
- real tool rows in the document (`WorkedGroup`, one *Worked for …* group; each row a localized verb from `lib/toolLabels.ts`, the target quiet in mono, the result muted, status only in the glyph, the raw tool name as `data-tool` and tooltip), and a Steer as its own quiet *Steered* line where the model loop took it (a `steer` turn item, never a tool row);
- find and task viewport behavior.

Historical `session` terminology stays inside the `api/` adapters' URLs and wire types only. The adapters export Task names (`createTask`, `getTaskRecord`, `updateTask`, `deleteTask`, `getTaskMessages`, `getTaskCall`, `uploadTaskDataset`, `TaskRecord`, `TaskMessage`, …) and product code speaks `taskId`.

### 3.5 One Composer

`frontend/src/components/Composer.tsx` is the only Agent input. It is `+` attach + textarea + model chip (`ModelChip`, backed by `/model-providers`; switching activates a provider server-side) + Delegate / Steer / Stop. Usage (`ContextMeter`) lives in the model menu, not on the Composer bar. Shortcuts exist; they are not painted as a persistent legend on the input. Attachments are keyed by task id. While busy, a present file labels the primary action Delegate (queued Direction), never Steer.

```text
no active execution  -> Delegate (round ↑)
active execution     -> Steer (round ↑ when text is present) + Stop (■)
upload preparation   -> preparing/working state
runtime unavailable  -> truthful disabled/actionable state
```

A detail row or a deep artifact must never mount a hidden second composer.

### 3.6 Presentation layers

`frontend/src/index.css` holds the tokens (achromatic ladder, ink primary, status colours, type/radius/motion). `frontend/src/agent/native-shell.css` styles the window, sidebar and title bar. `frontend/src/agent/native-document.css` styles the Task document: the Result (conclusion, findings, next steps, detail rows), Work log turns (Direction heading, commentary, *Worked for …* group, folded answers), banners, Composer, empty start; things that open in place ease in with the `reveal-in` keyframe (removed under `prefers-reduced-motion`). There are no other presentation layers.

## 4. Task document primitives

### Direction

A durable user contribution is rendered as Direction. Direction may be copied. There is no Redirect or Branch chrome on Direction.

A predominantly machine-shaped S3/storage error can render through `S3ErrorArtifact`, preserving the structured error fields and raw payload access without pretending it is ordinary prose.

### Execution

Execution represents real work performed by the runtime — and since v0.94 it is
a DURABLE domain object owned by the Sidecar's task runtime (`task_executions`
with lifecycle `queued` / `running` / `completed` / `failed` /
`cancelled` / `interrupted`; `waiting` stays in the schema but nothing enters
it since v2.1), not a conversational turn owned by an HTTP request.

Durable truth is the execution row plus its append-only structured event log
(`execution_events`): status transitions, direction recorded (v2.2), tool
started/progress/completed (`tool.progress`, v2.2), steer received/applied,
conclusion recorded, work result recorded (pre-2.1 logs may
also hold `approval.*`, `decision.resolved` and `plan.updated`; they are
ignored on read and replay). Execution
progress is derived from these structured events — never inferred from
assistant prose.

The browser's per-task execution store carries only the LIVE VIEW of that
durable truth: streamed Work Result text, merged tool activity, busy/upload
presentation state. Losing it (reload, task switch, second window) loses
nothing — the client reattaches by replaying the durable event log from any
sequence number.

Tool rows are one collapsed *Worked for …* group between the model's commentary segments (v1.11 transcript turn); its time is the group's wall clock, not a sum of durations (v1.12). In the live work in progress every group stays open until the turn settles (v2.1). A compaction is one muted marker line. There is no plan card (the `update_plan` tool was removed in v2.1). The Execution detail row exposes sanitized Execution detail — built from `task_executions` + the durable `execution_events` log + one sanitized `tool_calls` row on demand, never a `/runs` stream (v1.12) — without turning the Task into a permanent trace console.

### No approval (v2.1)

Nothing pauses an Execution for the user. `import_evidence` (`agent_runtime/import_tools.py`, formerly `gated_tools.py`) plans and runs the import inside the running Execution without a Decision: the target must be an evidence source the task's account survey discovered; each call is clamped server-side to `AGENT_MAX_FILES` (500) / `AGENT_MAX_BYTES` (256 MiB) and the result says when coverage is partial; the call is refused with nothing downloaded when the data directory would keep less than 1 GiB free; the plan is confirmed and audited as `approved_by="agent"` (`approval_events` + `audit_logs`); the tool checks Stop before downloading and, since v2.2, between files (`ImportStopped`; nothing is kept). `survey_account` runs up to its 500-bucket hard cap (default 100) and reports coverage through `truncated`; the `survey_account_large` gate is gone.

`runtime.request_approval`, `runtime.on_decision_resolved`, `settle_waiting_executions` and `task_runtime/approval_policy.py` were removed. `task_decisions` rows are read-only history (`GET /agent-tasks/{id}/decisions`); restart recovery withdraws any left pending (`superseded`). The frontend has no approval card, no approval policy UI and paints nothing the runtime did not do.

### Work Result

A completed assistant-side task event is rendered as Work Result.

Streaming work is Execution; persisted completed output is Work Result. Once the current turn's Work Result is persisted, the live streaming copy is not also rendered — the Task shows one readable record. Work Results can contain structured Markdown, tables (long ones preview 8 rows, expand and sort in place; folded rows stay findable), code/config fragments, storage-specific artifacts, metrics, and provenance links into the detail rows.

**v2.0 — result-first.** The latest Work Result is the **Result** at the top of the Task (`components/TaskResult.tsx`): the conclusion the model recorded with `record_conclusion` (`lib/conclusion.ts` accepts only the recorded shape; findings sort most severe first; the answer is one lead paragraph; next steps are a vertical list of asks that prefill the Composer) under one meta line derived from the trace (*Result · when · Evidence n · Gaps n · Tool calls n*; a calendar date after a week), the full answer, figures, and the detail rows (`components/TaskDetails.tsx`). The **Work log** below holds every turn; older answers fold to one line and the latest points up to the Result. Work-log Direction headings sit one step below the Result lead. The live turn (Direction · Execution · its conclusion from `conclusion.recorded`) renders above the Result. Since v2.2 the latest Result stays while a newer Direction is at work (`lastWorkResult` returns the latest assistant message even when an unanswered Direction follows); the persisted Direction heads the work in progress (`liveDirectionRow`) and joins the Work log when its answer lands. A one-Direction Task has no Work log: its commentary and collapsed *Worked for …* line render under the Result, above the detail rows (`task-result-work`); Find still renders the ordinary log. Reveals go through `lib/scroll.ts` `revealInScroller()` — never `scrollIntoView`, which also scrolled the overflow-hidden window columns and left the Composer floating. The Task opens at scrollTop 0 and never follows the end; *Jump to latest* is gone.

### Detail rows (formerly Artifacts)

`frontend/src/components/TaskDetails.tsx` renders the Task's durable outputs as rows under the Result (v2.0; the `agent-artifacts-panel` right split is retired). Each row expands in place; ⌘I opens the first available one; tool rows, provenance marks and the palette open the matching row:

```ts
"evidence" | "report" | "execution"
```

- **Evidence** — persisted evidence/finding/activity truth, with provenance marks.
- **Reports** — the durable Markdown Report artifact.
- **Execution** — persisted executions; one opens as a document (header · *Worked for …* rows · findings · result). No empty findings section and no default kind label: only Verify / revisit / resume / retry name their kind (v2.2).

A row appears only when something is behind it (no empty placeholders). v2.1 removed the Plans and Baselines & Drift rows; those engines remain in the Sidecar and the Agent narrates what they return. There is no Overview surface, no tabbed application, no side panel or overlay, and no engine walls. It replaced the historical Review sheet and the v1.11–v1.19 Artifacts panel.

## 5. Runtime state and task concurrency

### 5.1 Per-task client execution state

`frontend/src/liveTasks.ts` (`LiveTask`, `useLiveTask`, `patchLiveTask`) is keyed by durable task identity and preserves real in-flight state independently of which Task is visible.

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
   `interrupted` / `failed` last Execution that could not continue
   automatically, and the client follows that new stream; Queued Directions are projected from task state;
7. Verify and scheduled revisits remain Sidecar `runtime.submit` kinds with
   no painted UI controls; the user asks in Composer;
8. completion, failure, cancellation and interruption are durable
   execution states, not inferences;
9. reload the persisted task document.

UI disconnect, task switching, and reload never interrupt an execution; a
Sidecar restart stamps in-flight executions `interrupted` (including any
pre-2.1 `waiting` row, whose pending Decision is withdrawn as `superseded`) and,
since v2.1, continues them automatically:
`recovery.reconcile_interrupted_executions()` returns the ids it stamped and
`recovery.resume_interrupted(ids)` submits one continuation each
(`runtime.resume` → a new `kind=resume` execution; since v2.2 its stored
Direction is the user's text as written, and `task_runtime/continuation.py`
adds the continuation note plus a bounded digest of completed calls to the
model's copy only) —
never for an execution that was itself a continuation of interrupted work (no
crash loop), and not while no model is usable. Only then does the Task show the
explicit Resume action (`retry` when the prior execution was user-cancelled). Do not bypass this
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
  durable event log, first-class Work Results/Artifacts (Decisions as
  read-only history since v2.1), typed task context, and restart recovery with
  automatic continuation (`continuation.py` builds the model's continuation
  Direction, v2.2);
- the live-progress bridge (`app/progress.py`, v2.2) from long bounded engines
  to durable `tool.progress` events;
- whitelisted storage tools;
- deterministic run/analysis engines, including cost/lifecycle simulation,
  remediation-plan verify diffs, and baseline/Drift comparison
  (`app/analysis/`);
- optional per-task revisit scheduling (`app/task_runtime/revisit.py`), submitted by the Sidecar's own revisit clock (`STORAGE_AGENT_REVISIT_TICK_SECONDS`, default 60 s) and at startup — never by a read (v1.18);
- account/config discovery;
- bounded Evidence Import (plan, agent-confirmed and audited, executed inside the Execution);
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
  `task.status` (status, active execution, bounded queue, last execution;
  `pending_decisions` was dropped in v2.1) to the running execution's log whenever
  the derived task status or queue changes, so a following client never polls
  `/state`.
- **One protocol.** The `/sessions` message, stream, cancel, turn, and
  action-prepare endpoints, the `legacy_frames` translation, and
  `proposed_actions` are gone; `sessions/next_actions.py` keeps only the
  deterministic proposal normaliser the summary/triage engines use.
- **Plan tool and approval policy (removed in v2.1).** v1.12 added
  `update_plan` (`plan_tools.py`, `plan.updated`, one `plan` turn item) and an
  approval policy (`approval_policy.py`, consulted in
  `runtime.request_approval`). v2.1 removed both; pre-2.1 `plan` turn items are
  dropped on read.
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

### 6.x Native agent depth (v2.2.0)

- **Every tool from the first step.** `limits.tools_gated(model, explicit_window)` is true only when the resolved context window is ≤ 16,384 tokens (`_GATED_WINDOW_MAX`). Otherwise every group is open, `load_tools` is not registered, and `prompt.INSTRUCTIONS` says every tool is callable from the first step; a small-window model gets `prompt.INSTRUCTIONS_GATED` and the grouped `load_tools` disclosure. The runtime decides, never the model.
- **Direction durable at start.** `task_runtime/runtime._record_direction` writes the user's `session_messages` row when the execution starts (after model credentials resolve) and appends `direction.recorded` {`message_id`, `continued?`}; `_finish` answers under that row instead of writing it. A reload mid-run reads the Direction from the document.
- **Continuations pick up where they stopped.** `kind=resume` / `kind=retry` store the Direction clean. `task_runtime/continuation.py`: `prompt_direction()` adds the continuation note and a digest of completed calls from the stopped execution's durable `tool.completed` events (up to 3 links of its chain, ≤ 24 lines, ≤ 2 400 chars, oldest dropped first with an "… N earlier call(s) not listed" line, redacted) to the model's copy only; `clean_direction()` strips a legacy pre-2.2 note. A continuation whose original Direction row is still the task's latest message answers under it (`direction.recorded` with `continued: true`); otherwise it writes its own clean row.
- **Live progress.** `app/progress.py` binds a key (a run id or tool call id) to the running call (`bind` / `unbind` / `report`; `attach_turn` / `detach_turn` / `for_call`). The survey engine (`runs/account_discovery_run._probe_buckets`) reports each finished bucket keyed by run id (`survey_account` binds it via `_execute_run(on_progress=...)` only while the call waits); `evidence/managed_import.download_and_combine(on_file=..., cancel_event=...)`, threaded through `import_service.run`, reports each downloaded file and raises `ImportStopped` on Stop between files. The runtime writes a durable, throttled `tool.progress` {`id`, `tool`, `done`, `total`, `unit`} (`buckets` | `files`) on a private connection: at most one per call per second plus the final one, ≤ 120 per call. Counts only. The frontend reducer `applyToolProgress` sets `ToolActivity.progress`; the running row shows the count and a 2px hairline meter (`role=progressbar`).
- **Task report vocabulary.** `sessions/session_report.py` reads *Task report* · *Goal* · *Analyses* and Directions; the duplicate linked-runs appendix is gone.
- **Streamed contracts.** `sidecar/tests/test_v220_streamed_agent.py` pins these on the streamed path (the real OpenAI Agents SDK against `tests/fake_model.py`); the v2.0 conclusion, v2.1 recovery, v1.12 compaction-before-the-loop and prose-never-a-Decision contracts moved there too. `SESSION_LOOP` remains for persistence/unit tests. Frontend: `frontend/src/components/v220.test.tsx`.

### 6.x Native agent (v2.1.0)

- **No approval.** `agent_runtime/import_tools.py` replaces `gated_tools.py`: `import_evidence` runs without a Decision inside hard bounds (discovered source only; `AGENT_MAX_FILES` 500 / `AGENT_MAX_BYTES` 256 MiB per call, clamped; refused below 1 GiB free disk; audited `approved_by="agent"`; checks Stop before downloading). `survey_account` runs to its 500-bucket hard cap. `runtime.request_approval`, `on_decision_resolved`, `settle_waiting_executions`, `approval_policy.py`, the approval-policy and decision resolve routes, `pending_decisions`, `requires_decision`, `open_decisions` and the `needs_decision` derivation are gone.
- **No plan.** `update_plan`, `plan_tools.py`, `plan.updated` and `plan` turn items are gone.
- **Work resumes itself.** Restart recovery continues each interrupted execution once (`recovery.resume_interrupted`), never a continuation of a continuation, and falls back to the manual Resume banner when no model is usable.
- **Native reading.** Tool rows are localized verbs (`lib/toolLabels.ts`); the Result has one meta line and a lead-paragraph answer; next steps are a list of asks; live groups stay open until the turn settles; the title bar centres name and state as one group; reveals use `reveal-in` and honour `prefers-reduced-motion`; the native menu's ⌘I item reads *Show Details*. Pinned by `sidecar/tests/test_v210_native_agent.py` and the frontend architecture test "never pauses the Task for approval and never paints a plan (v2.1)".

### 6.x Result-first Task (v2.0.0)

- **Runtime-recorded conclusion.** `agent_runtime/conclusion_tools.py` — the core, budget-exempt `record_conclusion(answer, findings, next_steps)` tool; bounded and redacted, last call wins, never a tool row. `finalize` carries it as `contract["conclusion"]`; `task_runtime/runtime.py` appends `conclusion.recorded` and persists it on the assistant message and the durable Work Result (migration 031).
- **Result first.** The Task page is banners → work in progress → Result (conclusion · grounding · full answer · figures · detail rows) → Work log. It opens at the top; nothing follows the end.
- **Details in place.** The Artifacts side panel is retired; `TaskDetailsContext` (AgentShell) + `TaskDetails` render Evidence · Report · Execution (v2.0 also had Plans · Baselines; v2.1 removed them) as rows that expand in place.
- **Tables that read.** Long tables preview 8 rows and expand; headers sort (sizes and numbers numerically); folded rows stay in the DOM and an open Find shows them.

### 6.x Document-native window (v1.19.0)

- **A document, not a message exchange.** Each turn is a section: the Direction is its left-aligned heading (`.turn-direction-text`, no fill, no radius), later turns open with a hairline, and the Agent's work and Work Result follow in the same 46rem column.
- **Native type.** The platform UI face first (SF / Segoe UI Variable), vendored Inter as the fallback.
- **Status in one dot.** Title-bar state, banners, the model chip ("No model"), Execution-detail status and drift cells carry colour only in a dot; text stays ink.
- **Fewer, truer details.** Tool rows drop arguments equal to their target; scan scope renders localized with human sizes (`formatScanScope`); provenance previews name the tool once, in words; the palette is an opaque sheet (transform-only entry) with key caps; sidebar rows carry no time; Execution detail has one Back (the panel's), a Direction block only when it adds to the title, and usage on its own line; figures are ink-first with legends above the plot.

### 6.x Codex window (v1.17.0)

- **Quiet chrome.** ContextMeter lives in the model menu; the title bar is name + state (⌘F / ⌘K stay); the empty start is greeting + Composer with no glyph; Find is the keyboard bar only.
- **Transcript craft.** User bubble is a quiet fill (no border, no shadow; a heading since v1.19); the approval card was sentence-case with a hairline (removed in v2.1); *Worked for {t}* carries no tool-call count on the head.
- **Work language.** Artifacts says Execution, not Runs; empty fallback and prompt frame a Direction, not a question; aria is Direction / Work Result.
- **Composer honesty.** Attachments are per-task; a file while busy is labeled Delegate, never Steer.

### 6.x True native agent, finished (v1.16.0)

- **Dict-owned copy; palette engines.** `palette/chip/triage/shortcuts` keys plus `NAV_DAY_LABELS`; engine group prefills the Composer via `prefill`, window-owned `shortcuts` via base actions.
- **Usage end to end.** `budget_tokens` + `repeat_calls_avoided` render; additive `context_window_source` (`declared`/`inferred`) from `task_runtime/runtime.py`; title-step exclusion disclosed.
- **Isolated Escape, honest banners, retried reconnects.** Per-layer `stopPropagation`; Dismiss for view errors; offline suppresses needKey; 2/4/8 s backoff with clear-on-success.

### 6.x True Native Agent (v1.15.0)

- **Work language, painted search, self-healing transport.** Static greeting;
  delegate/steer placeholders; sidebar footer is Settings alone; stalled is a
  reconnecting status with auto-retry (no Resync); title-bar Find/palette +
  document Find entry; `minQueryFor`/`meetsMinQuery` (CJK 1, Latin 2).
- **Tables fit first.** Fluid tables with wrapping cells; `wide` heuristic
  with scroll hint; > 30 rows paginate with expand.
- **One usage vocabulary** (`frontend/src/lib/usage.ts`): `fmtTokensUnified`,
  `formatUsageLine` (cached-as-subset), `contextReading`
  (none/unreported/measured + estimated/floor). Meter and detail share it.
- **Copy in the dict; elevated craft.** `task/find/exec/usage/table/skills`
  keys; Composer card and user bubble above the canvas; kinsoku + stacked
  settings grids. Prompt no longer pitches engines in prose.

### 6.x Interaction truth and content craft (v1.14.0)

- **Steer reaches the current execution.** In v1.14 `runtime.steerable_execution`
  preferred running/queued, else a live `waiting` execution. Since v2.1 nothing
  waits: it is the running (else queued) execution; the text lands in its steer
  queue (plus a `steer.received` event) and injects at the next tool boundary.
  No 409-then-silent-requeue.
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
| Decision (history only since v2.1) | `task_decisions` (`kind=approval`, `scope`) | `approval_events` + evidence-import state |
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
- Data-moving or materially large/full-scan operations run inside hard server-side bounds instead of a confirmation (v2.1): evidence import only from a discovered source, ≤ 500 files / 256 MiB per call (clamped), refused without disk headroom, audited, stoppable; a survey never exceeds 500 buckets and reports coverage.
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
- no approval pause and no plan card (v2.1);
- detail rows under the Result limited to Evidence / Report / Execution detail — never a side panel;
- Settings as a dialog of general (with the read-only safety floor statement) + model + storage + skills & bridges;
- sequence-only stream recovery and settled-execution catch-up;
- task-native keyboard contracts;
- deterministic figures from provenance;
- tokens: achromatic ladder, ink primary, hairline depth, measure/track.

### Negative production-source guard

`frontend/src/agent/legacy-ui-contracts.test.ts` scans production frontend source and rejects retired product vocabulary/component contracts that could compile successfully while semantically rebuilding an old shell.

### Documentation guard

`frontend/src/agent/documentation-contract.test.ts` anchors normative documentation to the current release and prevents current product docs from drifting back toward retired information architecture (Approve/Decline, Review-as-sheet, tinted Direction, architecture banner `v1.10.0` / `028`).

### Real-Sidecar E2E

Playwright validates real Sidecar-backed behavior including:

- delegation and durable Work Results;
- streaming and persisted Tool execution disclosure;
- Stop and mid-execution Steer;
- task switching/concurrency;
- evidence/file analysis;
- bounded evidence import without an approval pause, and automatic continuation after restart;
- task navigation/drafts/paging;
- the result-first page (conclusion, detail rows, Report) and landing at the top;
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

The goal is a trustworthy delegated-work loop: the user sets Direction, watches real Execution, can Steer/Stop, relies on hard server-side bounds for data movement, and receives reviewable durable results.
