# Architecture

## 1. Architectural intent

Storage Agent is a local-first desktop Agent for object-storage work. The
architecture must preserve one product invariant:

> **The Agent Task is the application.**

The frontend is therefore not organized around a conversation shell, run pages,
provider tabs, an inspector, or an investigation record. The user delegates and
steers one durable Task; the runtime performs real Execution; confirmation
boundaries become Decisions; completed work becomes Work Results; Evidence,
Execution detail and Reports are contextual Artifacts that can be reviewed
without leaving the Task.

Canonical product flow:

```text
Direction
   │
   ▼
Agent Task ─────── Steer / Stop
   │                   ▲
   ▼                   │
Execution ──────────────┘
   │
   ├── safe read-only work ───────────────┐
   │                                      │
   └── confirmation-gated work            │
           │                              │
           ▼                              │
       Decision required                  │
           │                              │
           └──────── approved ────────────┘
   │
   ▼
Work Result
   │
   ├── Evidence
   ├── Execution detail
   └── Report Artifact
```

No UI may imply a capability that the runtime does not implement.

## 2. Runtime topology

The desktop application has three main layers:

```text
┌─────────────────────────────────────────────────────────────┐
│ Tauri desktop shell                                         │
│ window lifecycle · packaged resources · local process host  │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│ React Agent UI                                              │
│ AgentShell · AgentTask · AgentTaskNavigation · Review       │
└──────────────────────────┬──────────────────────────────────┘
                           │ localhost HTTP / SSE
┌──────────────────────────▼──────────────────────────────────┐
│ Python Sidecar                                              │
│ task persistence · Agent runtime · tools · evidence · runs  │
│ reports · provider adapters · encrypted-vault integration   │
└──────────────────────────┬──────────────────────────────────┘
                           │
             configured external providers only
             model endpoints / S3-compatible storage
```

The UI never receives secret values from the vault. Cloud and model credentials
are resolved inside the Sidecar.

## 3. Frontend ownership

### 3.1 `App.tsx`: composition, not product semantics

`App.tsx` owns application composition and global overlays:

- Sidecar health.
- list/refresh of durable Agent Tasks.
- active Task identity.
- settings drawer.
- command palette.
- shortcuts sheet.
- first-run configuration.
- task CRUD actions such as rename, pin, duplicate, archive and delete.

It composes three first-class product boundaries directly:

- `AgentTaskNavigation`
- `AgentShell`
- `AgentTask`

There is intentionally no SessionRail/Workbench/Surface adapter between App and
those components.

### 3.2 `AgentShell`: task environment

`frontend/src/agent/AgentShell.tsx` owns the visual task environment:

- task identity and scope;
- live Agent state;
- connection state;
- Focus mode;
- contextual Review open/close state;
- selected Execution inside Review;
- live execution strip derived from actual runtime state.

It does **not** own a second Agent input. The Composer belongs to the Task and
remains available while Review is open.

`AgentShell` accepts `taskContent: ReactNode`, not a Timeline/Surface abstraction.
This keeps the primary area semantically fixed as the Agent Task.

### 3.3 `AgentTaskNavigation`: task command center

`frontend/src/agent/AgentTaskNavigation.tsx` owns global Task navigation.
Each row projects durable Task metadata plus live runtime state into a product
state such as:

- Working
- Needs decision
- Needs attention
- Ready

The row shows meaningful scope/output context instead of database-oriented
counters. It may expose lifecycle actions (rename, pin, duplicate, archive,
delete), but it is not a ticket/CRM navigation model.

### 3.4 `AgentTask`: public task boundary

`frontend/src/components/AgentTask.tsx` is the public Task component. It exposes
Task-native props to App while adapting to historical persistence names required
by the current Sidecar API.

The large implementation module owns:

- durable task document loading/paging;
- drafts;
- task Composer;
- runtime submission/steering/stopping;
- attachment handoff;
- Work Result rendering;
- Execution summaries;
- Next Actions and Decisions;
- find/history viewport behavior.

Persistence/API terms such as `sessionId` may exist **inside this adapter layer**
while the public product boundary remains `taskId`.

### 3.5 one Composer

`frontend/src/components/Composer.tsx` is the only Agent steering input.

State semantics:

```text
no active execution  -> Delegate
active execution     -> Steer + Stop
upload preparation   -> working/preparing state
runtime unavailable  -> input/actions truthfully disabled
```

There must never be a hidden second input mounted by Review or another deep
surface. Architecture tests enforce this physically.

## 4. Task content primitives

### 4.1 Direction

A persisted user contribution is rendered as **Direction** by
`AgentTaskResult`. It is not styled or described as a chat bubble.

Direction may support:

- copy;
- revise/redirect;
- branch task;
- long-content expansion.

A pasted storage error may instead render as a structured `S3ErrorArtifact` when
it is predominantly a machine error payload.

### 4.2 Execution

Execution represents actual work performed by the runtime.

Live execution truth comes from the per-task run store:

- `busy`
- `uploading`
- pending Direction
- streaming Work Result text
- streaming Tool activity
- stop/stall/error state
- Next Actions

Persisted execution truth comes from Sidecar records and sanitized Tool calls.

`ExecutionSummary` is progressive disclosure attached to a Work Result. It can
show measured duration/token/tool-call information and real call detail without
turning the entire Task into an observability trace wall.

### 4.3 Work Result

A completed assistant-side task event is rendered as **Work Result**.

`AgentTaskResult` distinguishes:

- streaming result → Execution
- persisted result → Work Result

The Work Result can contain prose, Markdown structure, tables and code/config
fragments. Provenance links open contextual Evidence or Execution Review.

### 4.4 Next Action vs Decision

A backend proposal is normalized into a Task next action.

If `requires_confirmation=false`, it may render as a normal next action.

If `requires_confirmation=true`, it renders through `AgentDecisionCard` and the
Task state becomes **Needs decision**. The decision is therefore visible at both
local content level and global Task state level.

The frontend does not convert a confirmation-gated operation into a regular
button merely to make the UI feel more autonomous.

## 5. Contextual Review

`frontend/src/agent/AgentReviewPanel.tsx` is subordinate to the active Task.
Review modes are:

```ts
"overview" | "evidence" | "execution" | "report"
```

They are not application work surfaces or tabs.

### Overview

Shows durable task state: summary, findings, memory and Execution references.

### Evidence

Shows task findings, memory/evidence references and an ordered activity/audit
record. Evidence truth comes from persisted Sidecar data; missing evidence is not
filled with guessed content.

### Execution

Shows explicit persisted analysis executions and their sanitized details.
Historical backend `run` records are adapted into the UI concept Execution.

### Report

Shows the durable Report artifact generated from the Task. It remains an
artifact beside the Task rather than replacing the task workspace.

Review is opened through semantic Agent commands (`openAgentReview`,
`openAgentExecution`) so Work Results and execution rows do not know how the
Shell visually presents Review.

## 6. State stores and task execution

### 6.1 per-task runtime state

`sessionRuns.ts` remains a historical persistence-oriented module name, but its
store is keyed by the durable task identifier and preserves in-flight execution
state while the user switches Tasks.

This enables a critical Agent behavior:

> Task A can continue executing while the user views or works in Task B, then
> Task A is still running when selected again.

The store does not invent background workers; it reflects real server execution.

### 6.2 turn runner

The turn runner owns the real submission lifecycle:

1. acquire the execution latch for the target Task;
2. send Direction / optional local dataset;
3. consume Sidecar SSE;
4. update real Tool activity and streamed Work Result;
5. handle steer/stop/error conditions;
6. wait for durable completion;
7. reload the persisted task document.

The UI must not bypass this lifecycle with a second submit path.

### 6.3 task document

The task-document hook owns persistence paging and reload sequencing. Long Tasks
load the recent tail first and can prepend durable earlier history without losing
scroll ownership or current Execution state.

## 7. Sidecar persistence compatibility

The current SQLite/API schema predates the Agent-native shell. Renaming every
persisted entity in one release would add migration risk without user value, so
an explicit adapter boundary is maintained.

| Agent product | Historical persistence/API |
| --- | --- |
| Task | `sessions`, `/sessions/...` |
| Direction / Work Result | `session_messages` |
| Execution | `runs`, `session_runs`, `tool_calls` |
| Task summary/memory | `session_summaries`, agent-memory tables |
| Evidence | evidence/session-evidence tables |
| Report Artifact | report endpoints/files |

Rules for this boundary:

1. Historical names are valid inside Sidecar persistence and narrowly-scoped
   frontend adapters.
2. New public React boundaries use Task / Execution / Review vocabulary.
3. A persistence name may never justify rebuilding Session/Run/Conversation
   navigation in the UI.
4. Future backend migrations may rename storage entities, but product semantics
   do not wait on that migration.

## 8. Tool and evidence safety

The runtime is intentionally constrained.

### Secrets

- provider/model secret values live only in the encrypted local vault;
- API responses expose presence/reference metadata, not secret values;
- secret values are excluded from model context, logs, SQLite, reports and audit
  payloads.

### Cloud access

- object-storage tools are read-only;
- there is no destructive generic S3 action tool;
- there is no generic shell/arbitrary subprocess capability exposed to the Agent;
- provider allowlists/bounds are enforced before calls leave the Sidecar.

### Data movement

Actions that move or substantially scan cloud data use explicit confirmation
contracts. The frontend surfaces them as Decision required and the Sidecar
remains authoritative for preparation/confirmation.

### Evidence truth

- Tool inputs/outputs persisted for review are sanitized.
- Evidence references identify actual persisted sources.
- Failed audit persistence can be surfaced as an audit gap rather than silently
  pretending complete evidence.
- No chain-of-thought is persisted or rendered.

## 9. Desktop packaging

Tauri packages the production React bundle and the Python Sidecar resource.
Release/CI build paths cover:

- macOS Apple Silicon `.app` / release packaging;
- Linux x64 `.deb`;
- Windows x64 NSIS installer.

Runtime-verification scripts check the packaged structure and Sidecar health.
Signing/notarization is a distribution concern and documented separately; CI does
not require private signing credentials.

## 10. Quality architecture

### Frontend contract tests

`frontend/src/agent/architecture.test.ts` protects positive ownership rules:

- one Agent input;
- Task is the primary work area;
- Review is contextual;
- Direction and Work Result are first-class primitives;
- Decisions are first-class;
- Execution summary/steps are separate from task content;
- old adapter files remain physically deleted.

`frontend/src/agent/legacy-ui-contracts.test.ts` protects negative rules by
scanning production frontend source and rejecting deleted Chat-era concepts such
as old conversation/inspector/rail/timeline/work-surface contracts.

These tests exist because semantic regressions can compile perfectly.

### Real-Sidecar E2E

Playwright tests run against the real Python Sidecar and cover, among other
contracts:

- task delegation and durable Work Results;
- multi-step/multi-turn persistence;
- real Tool execution disclosure;
- Stop;
- mid-execution Steer;
- task concurrency;
- evidence/file analysis;
- Decision/confirmation paths;
- task navigation and drafts;
- contextual Review and Report artifacts;
- localization, accessibility, contrast and narrow layouts;
- credential sanitization.

### Visual review

`npm run shots` captures asserted real Agent states and builds a contact sheet.
The visual gallery covers:

- Delegate;
- Work Result;
- Execution;
- contextual Review;
- collapsed task navigation;
- Working + Steer;
- Decision required;
- runtime unavailable;
- narrow task workspace;
- Chinese UI;
- settings as secondary configuration.

CI uploads this artifact after the real E2E suite passes. We intentionally do not
use tolerant screenshot pixel diffs as a substitute for design judgment; the
states are executable gates, and the rendered artifact is reviewed by humans.

## 11. Explicit non-architecture

The following concepts must not appear in product UI unless a real runtime and
safety contract is implemented first:

- fake multi-agent delegation;
- worktrees/projects borrowed from coding Agents;
- synthetic plans/checklists that the runtime never emitted;
- generic terminal or browser control;
- hidden background jobs represented as if they were durable Agent workers;
- destructive storage mutation;
- a page/tab for every backend table.

The goal is not to imitate the visual chrome of another Agent product. The goal
is to adopt the same modern principle: **the user delegates work to a runtime
that visibly acts, remains steerable, stops at real decisions, and returns
reviewable artifacts.**
