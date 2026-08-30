# Product

## Product definition

Storage Agent is a local-first desktop Agent for object storage and
S3-compatible systems. The user delegates an outcome or problem; the Agent uses
real read-only capabilities to investigate, remains steerable while it works,
stops for explicit decisions when required, and produces durable Work Results
backed by Evidence and Execution records.

The canonical product loop is:

> **Direction → Execution → Decision (when required) → Work Result → Artifacts**

The application is not a generic chat assistant, not an admin dashboard with an
AI panel, and not a case-management system. **The active Agent Task is the main
work environment.**

## Primary users

- Object-storage / SRE / operations engineers.
- Data-infrastructure engineers.
- Developers debugging S3-compatible systems, policies, performance and access
  patterns.
- Storage product and support engineers who need an auditable investigation
  record rather than an ungrounded answer.

## Core jobs

1. Diagnose S3-compatible access and behavior issues.
2. Discover accounts and review bucket configuration.
3. Analyze access logs.
4. Analyze inventory, capacity and object distribution.
5. Triage object-storage errors.
6. Identify cost, lifecycle, observability and performance opportunities.
7. Produce durable, evidence-backed Report artifacts.

## Agent-native interaction contract

### 1. Agent Task is the primary object

A Task represents a durable goal plus the work already performed toward that
goal. Navigation is organized around active/recent Tasks and their live state,
not around message history or backend records.

Useful task states include:

- **Working** — execution is in progress.
- **Needs decision** — the Agent cannot proceed through a confirmation boundary
  without explicit user action.
- **Needs attention** — execution failed, a model/provider is unavailable, or
  another blocking problem requires user intervention.
- **Ready** — the durable task is available for another Direction.
- **Ready to delegate** — no task exists yet.

### 2. One input, two modes

There is exactly one primary Agent input.

- At rest it is **Delegate**: give the Agent a goal, problem, constraint or job.
- During execution it becomes **Steer**: add direction or constraints to the same
  running Task.
- **Stop** is available while local execution is active.

A second hidden/deep-page steering input is forbidden. Opening an Artifact or
Review does not remove control of the active Task.

### 3. Direction, not user chat bubbles

User input is represented as **Direction** in the durable task record. A follow-up
Direction changes or extends the goal; steering during active execution redirects
that work through the real runtime contract.

Large pasted storage errors may render as structured Error Artifacts because
recognizing the input is more useful than displaying a wall of raw text.

### 4. Execution is runtime truth

Execution UI is derived from actual runtime state such as active Tool calls,
busy/uploading state, persisted execution records and failures. The interface
must not invent a plan, checklist, sub-agent, terminal/browser, worktree or
background process that the runtime does not implement.

Tool activity is progressively disclosed so normal task reading remains clean,
but the real sanitized input/output and audit state stay reviewable.

### 5. Decision required is blocking state

A Next Action with the backend contract `requires_confirmation=true` is promoted
to a first-class **Decision required** state. It is not rendered as an ordinary
suggestion.

The Agent waits before confirmation-gated data movement such as bounded Evidence
Import. Read-only investigation does not require repetitive approval clicks.

### 6. Work Result is a product artifact

Completed Agent output is a **Work Result**, not a generic assistant bubble. It
can contain technical prose, tables, code/config fragments and references to the
Evidence and Execution that support it.

The UI must clearly distinguish:

- Direction — what the user asked or changed.
- Execution — what the Agent actually did.
- Work Result — the durable result of that work.
- Artifact — persistent reviewable output such as Evidence or a Report.

### 7. Review is contextual

Evidence, Execution and Report are contextual review modes attached to the same
Task. They open beside the task and do not become application-level tabs or
replace the primary Agent workspace.

Review may contain:

- current task summary and durable memory;
- findings and Evidence references;
- sanitized Execution details;
- generated Report artifacts.

## Storage-specific capabilities

The product can currently use or produce:

- S3-compatible credential/reachability checks;
- bounded bucket/object inspection;
- account/bucket discovery;
- bucket configuration review;
- access-log analysis;
- inventory/capacity analysis;
- error triage;
- Evidence Import with confirmation boundaries;
- durable task memory/findings;
- Markdown Report artifacts.

Historical backend `run_type` values remain implementation/API vocabulary:

- `diagnostic`
- `access_log_analysis`
- `inventory_analysis`
- `bucket_config_review`
- `account_discovery`

They are Execution implementation details, not top-level product navigation.

## Safety and trust

The Agent product contract includes the following non-negotiable guarantees:

- storage provider access is read-only;
- no destructive S3 tool exists;
- no generic shell/arbitrary subprocess tool is exposed to the Agent;
- secrets remain in the encrypted local vault;
- secrets/raw credentials never enter model prompts, logs, SQLite or reports;
- cloud data movement is confirmation-gated;
- tool/evidence records are sanitized and auditable;
- chain-of-thought is neither persisted nor rendered;
- missing evidence is represented as uncertainty/gaps, not guessed facts.

## Persistence vocabulary vs product vocabulary

Some shipped database/API names predate the Agent-native product shell and remain
for compatibility. They are adapter-layer terms, not UX concepts.

| Product concept | Current persistence/API term |
| --- | --- |
| Agent Task | session |
| Direction / Work Result | session message |
| Execution | run / tool call |
| Task memory | session summary / agent memory |
| Artifact Review | evidence/report endpoints |

Frontend public ownership boundaries must expose Task / Execution / Review. New
UI components must not reintroduce a Session/Run/Conversation-centered shell
simply because those words still exist in storage schemas.

## Visual hierarchy

The first viewport should answer three questions without opening another page:

1. **What is the Agent working on?**
2. **What has it done or produced?**
3. **What can I do now — Steer, Stop, decide, review, or delegate next work?**

Internal counters, provider/model configuration and audit metadata are secondary
unless they are relevant to the current execution.

## Quality gates

The Agent product model is protected by automated architecture tests that reject
old Chat-era production UI contracts, plus real-Sidecar browser tests for:

- delegation and durable Work Results;
- real execution/tool disclosure;
- Stop and mid-execution steering;
- task concurrency;
- decisions/confirmation boundaries;
- task navigation and persistence;
- contextual Review and Report artifacts;
- English/Chinese localization;
- accessibility/contrast/layout;
- credential sanitization.

A real-state visual gallery is also generated in CI for human review; it captures
Agent states rather than using a pixel-diff threshold as a substitute for design
judgment.

## Non-goals

Until the runtime actually supports them, the product must not pretend to be:

- a multi-agent orchestrator;
- a worktree/project coding environment;
- a generic computer-use Agent;
- a terminal or browser automation shell;
- a full S3 file manager;
- a multi-user SaaS/RBAC product;
- a workflow canvas;
- an automatic repair/mutation system.

Adding any of those requires a real capability and safety model first, then a UI.
