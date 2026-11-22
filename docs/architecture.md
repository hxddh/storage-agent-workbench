# Architecture

## Processes

```text
Electron main                              Renderer (sandboxed)
  index.ts    window, menu, dock, links,     App.tsx  state + layout
              notifications, --mcp  ⇄ IPC   Sidebar / Home (AgentSurface) /
  app.ts      wiring, agent host            Conversation (ChangeCard) /
  ipc.ts      the only IPC surface           Composer, Settings (lazy)
  preload     contextBridge, CJS
  runtime     session · engine · tasks · agent · project · model ·
              scheduler · schedules · approvals
  tools       call, query, probe, more, workspace, self,
              schedule, notify, change, delegate, ask
  s3/api.ts   read-only calls to 16 bundled services
  changes.ts  the write allowlist, snapshots, inverses
  workspace.ts  the agent's folder and db.sqlite
  analysis    one SQLite file per dataset
  mcp.ts      the read tools over stdio (storage-agent --mcp)
  legacy.ts   42.0.0's stores, imported once
  updater     GitHub releases
                       │
          storage-agent.db (node:sqlite)
          pi_* tables + host tables
          workspace/ (files + db.sqlite)
```

There is no application HTTP server, sidecar, port or token. The renderer
never touches the filesystem, the database or a credential; it calls the
preload surface, which is exactly `AgentApi` in `src/shared/contract.ts`.

## One engine, one log, one projection

```text
   user message (sa.run / sa.steer / sa.resume), a schedule's run,
   or a decision on a change (as the user's message)
                           │
              pi loop: model ⇄ tool registry
       (every tool but delegate and ask through agentTool())
                           │
               durable entries in pi_entries
                           │
                  runtime/project.ts
                  shared/conversation.ts
           (messages, text, thoughts, steps, notices, live)
                           │
                the window, search, export
```

- **One driver.** The model reads with its tools, keeps what lasts in its
  workspace, may ask the user a question, delegate a child investigation,
  schedule work, notify the user or propose a change, and writes its text.
  Each tool's description, sent with its schema, says what it does; the prompt
  does not list the tools or prescribe a workflow. Every turn starts from a
  message the user sent, a schedule that fell due, or the user's decision on a
  proposal, which reaches the agent as the user's message.
- **One settlement.** Every turn settles in `Engine.settle()`: the failure
  state, the digest, the task list and the shell notification. Search rows are
  written by the extension's `afterRun` hook as a run's entries commit; a
  failed or stopped run is completed at settlement.
- **One projection.** `runtime/project.ts` maps durable entries and the live
  slot to `UiEntry`; `shared/conversation.ts` builds the thread, resolves
  citations and writes search rows. The window renders that thread; it does
  not keep a second model of the run.

The app decides nothing about the storage. `call` (`s3/api.ts`) returns the
service's response or its error; what it means is the agent's to judge and
say. Any read-only operation of a bundled service client is reachable
([tools.md](tools.md)). A write is a proposal the user decides
(`runtime/approvals.ts`).

## What the harness decides

Nothing about the agent's work while someone is watching. There is no round
ceiling, no hook that blocks a call, no working budget and no fixed output
cap. Which calls to make, whether to repeat one, how much to read, whether to
delegate, what to keep and how long to work are the agent's. **Stop** is the
user's control.

The one limit is on unattended work: a scheduled run stops when it has used
its token budget (the schedule's own, else 100,000), checked every three
seconds while its task is not the one open in the window. Opening the task
lifts it.

Each model's output maximum is learned once per launch (`learnOutputLimit` in
`runtime/model.ts`): a one-word request offers the whole context window; a
provider that refuses names its maximum, which becomes the limit, and one that
refuses without a number is asked again with half as much until it accepts.
Nothing is guessed. A reply may then use at most a quarter of the window
(`outputCap`, at least 1,024 tokens), so the context always has room. A reply
that stops at the limit gets a `cut` notice. The context window is what the
provider's model list states (`statedContext`), else the catalog's figure,
else 128k; Settings can set it. A window under 16,384 tokens is refused before
the turn starts, with how to load the model with more (`windowRefusal`).
Compaction is sized to the window (`compactionFor`: reserve a fifth of it and
keep the latest three tenths, each between 2,048 tokens and pi's defaults).

Every result is redacted whole and kept in the task folder under its evidence
id; the model gets one piece (`pieceFor`: about a fifth of the window, at most
24,000 characters) at a time and `more` reads any stretch again, after a
compaction too. An object body streams to the task folder up to `max_bytes`
(default 1 MiB, which protects the disk; the agent raises it or reads a
`Range`), with a 64 KiB preview in the result; a script's `call()` gets it
whole. `more` and `read()` also read attachments (`attachment:<name>`),
workspace files (`workspace:<path>`) and bundled skills (`skill:<name>`); an
image comes back as an image to a model that takes images (Anthropic and
OpenAI models; an OpenAI-compatible model is told an image was attached).

A delegated child works in the task it was given: `rootConversation()`
follows the child's owner up to the task, and every tool uses that task's
folder, attachments, results and datasets. A child's evidence ids carry its
own conversation id, so they never collide with the parent's.

There is no answer check. The app does not look for ungrounded names or ask
the model to rewrite its text. A citation link that resolves opens its call; a
link that does not resolve is shown as plain text with a tooltip.

**Prompt sections** (`runtime/agent.ts`): identity, time, policy (the hard
rules), work (how an expert works), compose, skills, context, language. The
prompt does not list the tools: each describes itself with its schema. The
skills section lists bundled skills by name and description as trusted text,
and workspace skills inside an `<untrusted-data-…>` block (`skillIndex`). The
context section (`buildDigest`) names each account with its id, endpoint (or
AWS), region, scope and whether changes are allowed, and says which workspace
folders hold how many files. It injects no file's content.

Each model configuration is its own provider in the shared pi-ai collection
(`providerIdFor()`), so one task's model never replaces another task's. A
saved key is used only for the provider and base URL it was saved for
(`Settings.keyFor`).

## Runtime flow

1. `app.whenReady` opens the data directory and SQLite, builds `AppDb`,
   `Settings`, `Vault`, `Providers`, `Staging`, then `Runtime` (pi, one
   extension, the tool registry, the workspace and the `sa.schedule` task),
   imports 42.0.0's stores into the workspace (`importLegacy`), builds
   `Tasks`, `Engine`, `Scheduler` and `Approvals`, registers IPC and creates
   the window. Started at login with `--background`, it creates no window. The
   vault is not opened at launch.
2. `AppDb.open` migrates the host schema forward from its `user_version` to
   `HOST_SCHEMA_VERSION`, one transaction per step. A database newer than this
   build is refused with a message and left untouched; one older than the
   baseline (22) is cleared and created again, with `tasks/` and `datasets/`.
3. `Tasks.newTask()` creates one pi conversation per task and writes
   `task_meta` with a title from the first message.
4. `Engine.submit()` installs the task's model for this turn, configures the
   conversation (model, thinking, compaction) and submits an `sa.run` input.
   Without a model in Settings it throws `Choose a model in Settings first.` A
   steer is an `sa.steer` input that joins a running turn; with no turn going
   it is a new message. Retry sends the last user message again with its files
   and focus. Continue is an `sa.resume` input whose content is `Continue.`
5. `@` focus names accounts and the buckets an account lists now
   (`Tasks.storageRefs`). `sanitizeContext` drops names outside an account's
   scope; the names reach the model in an `<untrusted-data
   source="user-context">` block marked "focus only, not authorization".
6. A running call is projected from `pi.live`. When it settles, the result is
   a `pi.tool-result` entry whose `details` carry target, note, progress,
   argument summary, view, duration, status and evidence id; its text is
   exactly what the model received. `agentTool()` writes the status; result
   text is never parsed for it.
7. The open task streams through `conversation.watch()`; the live slot
   (reasoning, running calls, streaming text) comes through the `live` event.
8. `watchTaskGraph()` supplies working state for the sidebar, dock badge and
   taskbar progress.
9. Stop aborts the turn (pi keeps committed entries) and writes a `stopped`
   notice with **Continue**.
10. pi compacts when the model context fills; the compaction shows as a
    divider. Provider-facing messages never reach the renderer.
11. The extension's `afterRun` hook writes each committed run's user messages
    and agent text to `search_docs`; a failed or stopped run is completed by
    `searchRows()` at settlement. The digest is rebuilt then, so a new
    workspace file or account setting is in the next turn.

`project.ts` renders a view for a known view kind (`raw`, `note`, `query`,
`question`, `render`, `delegate`, `memory`, `export`, `change`). A tool result
without `details` (a call pi ended before the tool ran) shows as a step marked
`Did not run`, with what the agent received. A call to a tool name the
registry does not hold shows as a failed step.

## Schedules

`schedule create` (`runtime/scheduler.ts`) writes a `schedules` row, creates
the schedule's task (`Scheduled: <name>`) and, in that conversation, a
background pi task `sa.schedule` (`runtime/schedules.ts`). The pi task sleeps
until the run is due (`sleepUntil`), calls `Scheduler.fire`, and sleeps until
the next run; a one-off schedule ends after its run and its row is deleted. pi
owns the timing and survives restarts: a run that fell due while the app was
closed runs once when it opens, and the next is counted from then. There is no
second queue.

`Engine.runScheduled()` submits the turn with the schedule's prompt, prefixed
for the model with `[Scheduled run of "<name>", due <time>. Nobody is
watching: use notify to tell the user what they need to know.]`, and a
`requestId` per due time so a run is never submitted twice. The entry is an
`sa.run` with `scheduled: <name>`. The budget monitor aborts the run when it
passes its budget while the task is not watched, and the turn settles with a
`budget` notice. `fire` records the last run, its outcome (`started`, or why it
could not start) and the next due time. `schedule cancel` aborts the pi task
and deletes the row; the task stays.

On Windows and Linux, closing the last window quits the app unless a schedule
exists or Settings opens the app at login (`App.hasScheduledWork`); then it
keeps running with no window. Launching the app again or clicking a
notification opens the window.

## Notifications

`notify` calls the agent host in `app.ts`: it writes an `inbox` row, tells the
window, and, unless Settings turns notifications off, asks the shell to show a
system notification that opens the task (creating the window if needed). One
notification per run: the host remembers, per task, the last user input it
notified for, and refuses a second notification until a new one. A turn that
settles while the window is unfocused gets the shell's own "finished"
notification, except in a schedule's task.

## Changes

`change` and `self propose` call `Approvals.propose` / `proposeSetting`
(`runtime/approvals.ts`). A storage proposal is checked (`checkChange` in
`changes.ts`: the allowlist `WRITABLE`, `checkInput`, scope), its snapshot is
read with the account's read credentials, and a `changes` row is written with
status `proposed`. The tool returns a `change` view and ends the turn
(`terminate`).

The window's `ChangeCard` reads the row over IPC (`agent:change`) and offers
**Approve** and **Reject** for a proposal and **Roll back** for an applied
storage change. Only `agent:approveChange`, `agent:rejectChange` and
`agent:rollbackChange` decide; no tool can. Approve checks again and runs
exactly the stored call through `applyChange`, which uses
`Providers.writeConfig` (the account's write profile, else its own
credentials, as a separate client). A settings proposal updates the account
(`Providers.updateSettings`) and the digest. Each decision is stored on the
row and submitted to the task as the user's message. Roll back computes the
inverse from the snapshot (`inverseOf`), runs it at once, stores it as a
`rollback` row and marks the original `rolled_back`.

## MCP

`storage-agent --mcp` (`index.ts`, `mcp.ts`) starts the Electron binary
headless: no window, no single-instance lock, no model. It opens the same
database, vault and workspace and serves `call`, `query`, `probe`, `more` and
`workspace` over stdio with the MCP SDK, built from the same tool definitions,
so scope, redaction, the envelope and the audit log apply. Over MCP the
workspace runs only `list`, `read` and `search`. `change`, `schedule`,
`notify`, `self`, `delegate` and `ask` are not served.

## Modules

| Module | Responsibility |
|---|---|
| `main/runtime/session.ts` | pi harness, the one extension, tool registry, `sa.schedule` task, durable reads, the task's model, digest |
| `main/runtime/engine.ts` | submit, steer, stop, retry, continue, `runScheduled`; settlement; the unattended budget |
| `main/runtime/tasks.ts` | task list, open task watch, task graph, usage, search index, `@` references, workspace and board for the window |
| `main/runtime/agent.ts` | prompt sections, skill index, digest |
| `main/runtime/project.ts` | entries → `UiEntry`, live state, reasoning, usage |
| `main/runtime/model.ts` | pi-ai providers (one per model configuration), model test, `windowRefusal`, `compactionFor`, `outputCap` |
| `main/runtime/search.ts` | sidebar search over titles and index rows |
| `main/runtime/schedules.ts` | cadences, next run, the `sa.schedule` durable task |
| `main/runtime/scheduler.ts` | create, list, cancel and fire schedules |
| `main/runtime/approvals.ts` | proposals, approve, reject, roll back |
| `main/tools/policy.ts` | `agentTool()`: audit, envelope, redaction, pieces kept for `more`, status, details, evidence id |
| `main/tools/registry.ts` | the tool names |
| `main/tools/call.ts` | `call` |
| `main/tools/query.ts` | code mode: `call`, `read`, `dataset`, `inventory`, `sql`, `datasets`, `history`, `discover`, `workspace`, `run`, `render` |
| `main/tools/probe.ts` | `probe` |
| `main/tools/more.ts` | `more` |
| `main/tools/workspace.ts` | `workspace` |
| `main/tools/self.ts` | `self` |
| `main/tools/schedule.ts` | `schedule` |
| `main/tools/notify.ts` | `notify` |
| `main/tools/change.ts` | `change` |
| `main/tools/delegate.ts` | `delegate` (child agent) |
| `main/tools/control.ts` | `ask` |
| `main/workspace.ts` | `Workspace`: paths, files, search, `db.sqlite`, board |
| `main/changes.ts` | `WRITABLE`, `checkChange`, `snapshotOf`, `inverseOf`, `applyChange` |
| `main/legacy.ts` | `importLegacy`: 42.0.0's memory, methods and skills into the workspace |
| `main/memory.ts` | `MemoryStore`, read only by the legacy import |
| `main/mcp.ts` | the MCP server |
| `main/s3/api.ts` | `checkCall`, `checkInput`, `callApi`, `shape`, `describeError` |
| `main/skills.ts`, `main/skills/*.md` | bundled and workspace skills |
| `main/security/scope.ts` | `assertInScope()`, `ScopeError` |
| `main/security/redact.ts` | `redact()`, `redactView()`, `wrapUntrusted()`, `bound()`, `maskKey()` |
| `main/security/vault.ts` | sealing and opening secrets |
| `main/analysis/` | dataset import, formats, tables (`TABLES`) |
| `main/providers.ts` | accounts, credentials, `clientFor` (one client per account, service and region), `writeConfig` |
| `main/settings.ts` | non-secret settings, saved models, `keyFor` |
| `main/db.ts` | the host schema, its migrations and queries |
| `shared/contract.ts` | the one type contract |
| `shared/view.ts` | view document validation and limits |
| `shared/conversation.ts` | the thread, citation lookup, search rows, Markdown transcript |
| `renderer/Conversation.tsx` | the thread: messages, steps, results, question, change cards, export links, notices, overflow menu, task model |
| `renderer/ChangeCard.tsx` | a proposal with Approve, Reject and Roll back |
| `renderer/AgentSurface.tsx` | Home's inbox, board and schedules |
| `renderer/Blocks.tsx` | view document renderer |
| `renderer/Composer.tsx` | message, steer, stop, files, `@` focus, the live status strip |
| `renderer/Home.tsx` | accounts list, model setup and the agent surface |
| `renderer/Views.tsx` | views of tool results |

## Storage layout

```text
<userData>/
  storage-agent.db          host tables + pi_* tables
  settings.json             non-secret settings
  window.json               window bounds
  .vault-key                only when no OS keyring (0600)
  staging/<token>/          files waiting for their message
  bundled-skills/<name>.md  the bundled skills, written at launch for `more`
  workspace/                the agent's folder (never cleared by the app)
    notes/ skills/ scripts/ board/ exports/ …
    data/<id>.sqlite        datasets kept for the user
    db.sqlite               the agent's own SQL database
  datasets/<id>.sqlite      datasets kept by 42.0.0, still read in place
  memory.sqlite.imported    42.0.0's memory, renamed after its import
  tasks/<conversation>/
    uploads/                attached logs and inventories
    datasets/<id>.sqlite    one analytical database per import
    results/<evidence>.txt  every result, kept whole for `more`
    objects/<id>.bin        a streamed object body, for `more`
```

`storage-agent.db` is opened with WAL and foreign keys. The `pi_*` tables
belong to pi-durable; the host tables belong to this app
([data-model.md](data-model.md)).

## Deliberate absences

No event store of our own, no second queue, no SSE, no HTTP server, no answer
tool or report protocol, no in-memory turn state, no prose classifier, no
answer validation, no rule engine or verdicts, no follow-up prompts, no second
window and no feature written for one request: a watch, a board or a
remediation is the agent composing `schedule`, `workspace`, `notify` and
`change`. Delegation is a foreground child conversation, not a second queue;
its steps show inside the parent's `delegate` step, and stopping the parent
stops it. Schedules are pi durable tasks, not a queue of the app's own. The
app never writes to storage except to run a change the user approved. pi owns
the durable loop; the product owns the tools and the safety boundaries.
