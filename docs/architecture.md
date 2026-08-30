# Architecture

> **Current architecture baseline: Storage Agent v0.93.0.**
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
   └── confirmation-gated work                │
           │                                  │
           ▼                                  │
      Decision required                       │
           │                                  │
           └──────── approved ────────────────┘
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
│ Task navigation · AgentShell · AgentTask · contextual Review│
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
- task lifecycle actions (create/rename/pin/duplicate/archive/delete);
- settings drawer;
- command palette;
- shortcuts sheet;
- first-run configuration.

It composes the current public product boundaries directly:

- `AgentTaskNavigation`;
- `AgentShell`;
- `AgentTask`.

Legacy frontend adapters from earlier releases were physically removed. Do not recreate an intermediate application shell merely to mirror backend entity names.

### 3.2 `AgentTaskNavigation`: global task command center

`frontend/src/agent/AgentTaskNavigation.tsx` owns global Task navigation.

Each task row combines:

- durable task metadata from the Sidecar task projection;
- current per-task runtime state from the client execution store;
- meaningful scope/output context;
- lifecycle controls.

Visible state is product state such as Working, Needs decision, Needs attention, or Ready. Database counters are not the navigation model.

The Sidecar `/agent-tasks` projection provides durable decision truth so a pending confirmation remains visible after reload/restart even when browser-local runtime state is gone.

### 3.3 `AgentShell`: active task environment

`frontend/src/agent/AgentShell.tsx` owns the active task environment:

- task identity/scope;
- live product state;
- connection state;
- Focus presentation state;
- contextual Review open/close state;
- selected Execution inside Review;
- live execution status derived from real task runtime state.

`AgentShell` receives `taskContent: ReactNode`. Its primary area is always the Agent Task.

Review is subordinate to the Task. Opening Review does not create another task, another lifecycle, or another Agent input.

### 3.4 `AgentTask`: public task boundary

`frontend/src/components/AgentTask.tsx` is the public task component. It exposes Task-native props to `App` and owns semantic task navigation/keyboard behavior.

`AgentTaskImplementation.tsx` owns the large task document implementation:

- durable task document loading and paging;
- task draft state;
- the one Composer;
- submission/streaming integration;
- steering/stopping;
- attachments;
- Direction and Work Result rendering;
- Execution summaries and step details;
- Next Actions / Decisions;
- find and task viewport behavior.

Historical `sessionId` terminology may appear inside compatibility adapters and API calls. Public product ownership remains `taskId`/Agent Task.

### 3.5 One Composer

`frontend/src/components/Composer.tsx` is the only Agent input.

```text
no active execution  -> Delegate
active execution     -> Steer + Stop
upload preparation   -> preparing/working state
runtime unavailable  -> truthful disabled/actionable state
```

Review or a deep artifact must never mount a hidden second composer.

## 4. Task document primitives

### Direction

A durable user contribution is rendered as Direction. Direction may be copied, revised/redirected, or used to branch work according to the existing task contracts.

A predominantly machine-shaped S3/storage error can render through `S3ErrorArtifact`, preserving the structured error fields and raw payload access without pretending it is ordinary prose.

### Execution

Execution represents real work performed by the runtime.

Live truth is derived from the per-task execution store, including:

- busy/upload/preparation state;
- pending Direction;
- streamed Work Result text;
- live Tool activity;
- stop/stall/error state;
- proposals/next actions.

Persisted truth comes from sanitized Sidecar Tool calls, runs/executions, turn metrics, audit/evidence records, and messages.

`ExecutionSummary` provides progressive disclosure attached to the result that produced it. `ExecutionSteps` and Execution Review expose real sanitized detail without turning the Task into a permanent trace console.

### Decision

A current action with `requires_confirmation=true` is promoted to a first-class Decision. It affects both local content rendering and global task state.

The frontend must not downgrade a real confirmation boundary into an ordinary suggestion for visual simplicity.

### Work Result

A completed assistant-side task event is rendered as Work Result.

Streaming work is Execution; persisted completed output is Work Result. Work Results can contain structured Markdown, tables, code/config fragments, storage-specific artifacts, metrics, and provenance links into contextual Review.

### Artifact / Review

`frontend/src/agent/AgentReviewPanel.tsx` owns contextual Review modes:

```ts
"overview" | "evidence" | "execution" | "report"
```

- **Overview** — durable task summary, findings, memory, and execution references.
- **Evidence** — persisted evidence/finding/activity truth.
- **Execution** — persisted analysis execution and sanitized call detail.
- **Report** — durable Markdown Report artifact.

These are review modes of the active Task, not independent application destinations.

## 5. Runtime state and task concurrency

### 5.1 Per-task client execution state

`frontend/src/sessionRuns.ts` retains a historical filename, but the store is keyed by durable task/session identity and preserves real in-flight state independently of which Task is visible.

Therefore:

> Task A may continue a real already-started execution while the user views Task B; selecting Task A again reconnects to that same work.

This must not be represented as a fleet of hidden autonomous Agent workers. It is per-task ownership of real execution.

### 5.2 Turn runner

The turn runner is the single submission lifecycle:

1. acquire the execution latch for the target Task;
2. submit Direction and optional local attachment context;
3. consume Sidecar SSE;
4. update real Tool activity and streamed Work Result;
5. process Steer / Stop / error / stall conditions;
6. wait for durable completion;
7. reload the persisted task document.

Do not bypass this lifecycle with another submit/steer path.

### 5.3 Durable task document

Task document loading is paged. Recent durable content is loaded first and earlier content can be prepended without losing current Execution state or viewport ownership.

Long-task scalability is therefore a persistence/paging concern, not a reason to collapse the product back into message-history navigation.

## 6. Sidecar architecture

The Sidecar owns:

- SQLite migrations/repositories;
- the one model-driven Agent runtime;
- whitelisted storage tools;
- deterministic run/analysis engines;
- account/config discovery;
- Evidence Import plan/confirmation/execution;
- local DuckDB analysis;
- task memory/findings/summary;
- reports;
- audit/turn metrics;
- provider adapters and secret resolution.

There is exactly one model-driven Agent loop. Deterministic engines remain beneath it as security/reproducibility mechanisms; they are not a second product Agent.

## 7. Persistence compatibility boundary

The database/API schema predates v0.93. Renaming every stored entity would add migration risk without changing the product, so Storage Agent intentionally keeps a **persistence compatibility** layer.

| Product | Compatibility persistence/API |
| --- | --- |
| Agent Task | `sessions`, `/sessions/...`; `/agent-tasks` list projection |
| Direction / Work Result | `session_messages` |
| Execution | `runs`, `session_runs`, `tool_calls`, `turn_metrics` |
| Task memory | `session_summaries`, `session_findings`, `session_agent_memory` |
| Evidence | evidence refs/sources/import tables |
| Report Artifact | report endpoints/files |
| Decision | message proposals + approval/evidence-import state |

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

## 9. Desktop packaging

The production React bundle and PyInstaller one-dir Sidecar are packaged by Tauri.

Current release targets:

- macOS Apple Silicon: `.app.zip` and `.dmg`;
- Linux x64: `.deb`;
- Windows x64: NSIS setup executable.

The Sidecar is embedded as a resource, not exposed as a shell capability. Runtime-verification scripts confirm packaged startup, Sidecar health, and cleanup.

Signing/notarization is a distribution concern documented in `signing.md`; CI does not require private signing credentials.

## 10. Executable architecture contracts

### Positive ownership guard

`frontend/src/agent/architecture.test.ts` asserts v0.93 ownership, including:

- one Agent input;
- Agent Task as primary work area;
- contextual Review;
- Direction / Work Result primitives;
- explicit Decision boundaries;
- Execution Summary/Steps/Detail rather than legacy renderers;
- task-native DOM/keyboard/style contracts;
- physical deletion of retired component boundaries.

### Negative production-source guard

`frontend/src/agent/legacy-ui-contracts.test.ts` scans production frontend source and rejects retired product vocabulary/component contracts that could compile successfully while semantically rebuilding an old shell.

### Documentation guard

`frontend/src/agent/documentation-contract.test.ts` anchors normative documentation to v0.93 and prevents current product docs from drifting back toward retired information architecture.

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

## 11. Explicit non-architecture

The following concepts must not enter the product until a real runtime + safety contract exists:

- fake multi-agent delegation;
- synthetic plans/checklists unsupported by runtime state;
- coding worktrees/projects;
- generic terminal/browser/computer control;
- hidden worker processes represented as autonomous Agents;
- destructive storage mutation;
- page-per-persistence-table navigation.

The goal is a trustworthy delegated-work loop: the user sets Direction, watches real Execution, can Steer/Stop, crosses only real Decisions, and receives reviewable durable results.
