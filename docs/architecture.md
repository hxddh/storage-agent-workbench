# Architecture

## Processes

```text
Electron main                              Renderer (sandboxed)
  index.ts    window, menu, dock, links      App.tsx  state + layout
  app.ts      wiring, bootstrap     ⇄ IPC   Sidebar / Home / Conversation /
  ipc.ts      the only IPC surface           Composer, Settings (lazy)
  preload     contextBridge, CJS
  runtime     session · engine · tasks · agent · project · model
  tools       call, query, probe, more, discover, render,
              memory, tool, delegate, ask
  s3/api.ts   read-only calls to 16 bundled services
  memory.ts   separate memory.sqlite
  analysis    one SQLite file per dataset
  updater     GitHub releases
                       │
          storage-agent.db (node:sqlite)
          pi_* tables + host tables
          memory.sqlite (docs)
```

There is no application HTTP server, sidecar, port or token. The renderer
never touches the filesystem, the database or a credential; it calls the
preload surface, which is exactly `AgentApi` in `src/shared/contract.ts`.

## One engine, one log, one projection

```text
        user message (sa.run / sa.steer / sa.resume)
                           │
              pi loop: model ⇄ tool registry
              (every tool but ask through agentTool())
                           │
               durable entries in pi_entries
                           │
                  runtime/project.ts
                  shared/conversation.ts
           (messages, text, thoughts, steps, notices, live)
                           │
                the window, search, export
```

- **One driver.** The model reads with its tools, may ask the user a question,
  delegate a child investigation, compose a view, write a method or recall
  memory, and writes its text. Each tool's description, sent with its schema,
  says what it does; the prompt does not list the tools or prescribe a
  workflow. Every turn starts from a message the user sent.
- **One settlement.** Every turn settles in `Engine.settle()`: the failure
  state, the search index, the memory digest, the task list and the shell
  notification.
- **One projection.** `runtime/project.ts` maps durable entries and the live
  slot to `UiEntry`; `shared/conversation.ts` builds the thread, resolves
  citations and writes search rows. The window renders that thread; it does
  not keep a second model of the run.

The app decides nothing about the storage. `call` (`s3/api.ts`) returns the
service's response or its error; what it means is the agent's to judge and
say. Any read-only operation of a bundled service client is reachable
([tools.md](tools.md)).

## What the harness decides

Nothing about the agent's work. There is no round ceiling, hook, working
budget or fixed output cap. Which calls to make, whether to repeat one, how
much to read, whether to delegate, what to remember and how long to work are
the agent's. **Stop** is the user's control.

Each model's output maximum is learned once per launch (`learnOutputLimit` in
`runtime/model.ts`): a one-word request offers the whole context window, and a
provider that refuses names its maximum, which becomes the limit. A reply that
stops at the limit gets a `cut` notice.

A result longer than one piece (24,000 characters) is kept whole in the task
folder for `more`. An object body streams to the task folder up to
`max_bytes` (default 1 MiB, which protects the disk; the agent raises it or
reads a `Range`), with a 64 KiB preview in the result. The agent reads any
offset with `more`.

There is no answer check. The app does not look for ungrounded names or ask
the model to rewrite its text. A citation link that resolves opens its call; a
link that does not resolve is shown as plain text with a tooltip.

**Prompt sections** (`runtime/agent.ts`): identity, time, policy, compose,
memory, language. The prompt does not list the tools: each describes itself
with its schema, and `discover` lists them from the registry. The memory digest (`buildDigest`)
names each account with its id, endpoint (or AWS), region and scope, and says
how many memory documents exist. It does not inject memory content; the agent
recalls with `memory`; a recalled document carries the task that wrote it.

Each model configuration is its own provider in the shared pi-ai collection
(`providerIdFor()`), so one task's model never replaces another task's.

## Runtime flow

1. `app.whenReady` opens the data directory and SQLite, builds `AppDb`,
   `Settings`, `Vault`, `Providers`, `Staging`, `MemoryStore`, then `Runtime`
   (pi, one extension, the tool registry), `Tasks` and `Engine`, registers IPC
   and creates the window. The vault is not opened at launch.
2. A database at any `user_version` but 19 is cleared and created again;
   `tasks/` and `memory.sqlite` are deleted with it. Nothing is migrated,
   imported or backed up.
3. `Tasks.newTask()` creates one pi conversation per task and writes
   `task_meta` with a title from the first message.
4. `Engine.submit()` installs the task's model for this turn, configures the
   conversation and submits an `sa.run` input. Without a model in Settings it
   throws `Choose a model in Settings first.` A steer is an `sa.steer` input
   that joins a running turn; with no turn going it is a new message. Retry
   sends the last user message again with its files and focus. Continue is an
   `sa.resume` input whose content is `Continue.`
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
11. When a turn settles, `searchRows()` writes the task's user messages and
    agent text to `search_docs`, and the digest is rebuilt so a new memory
    count is in the next turn.

`project.ts` renders a view for a known view kind (`raw`, `note`, `query`,
`question`, `render`, `delegate`, `memory`). A tool result without `details`
(a call pi ended before the tool ran) shows as a step marked `Did not run`,
with what the agent received. A call to a tool name the registry does not hold
shows as a failed step.

## Modules

| Module | Responsibility |
|---|---|
| `main/runtime/session.ts` | pi harness, the one extension, tool registry, durable reads, the task's model, digest |
| `main/runtime/engine.ts` | submit, steer, stop, retry, continue; settlement |
| `main/runtime/tasks.ts` | task list, open task watch, task graph, search index, `@` references, memory and methods |
| `main/runtime/agent.ts` | prompt sections, memory digest |
| `main/runtime/project.ts` | entries → `UiEntry`, live state, reasoning, usage |
| `main/runtime/model.ts` | pi-ai providers (one per model configuration), model test |
| `main/runtime/search.ts` | sidebar search over titles and index rows |
| `main/tools/policy.ts` | `agentTool()`: audit, envelope, redaction, pieces kept for `more`, status, details, evidence id |
| `main/tools/registry.ts` | the tool names |
| `main/tools/call.ts` | `call` |
| `main/tools/query.ts` | code mode: `call`, `discover`, `memory`, `render`, `dataset`, `inventory`, `sql` |
| `main/tools/probe.ts` | `probe` |
| `main/tools/more.ts` | `more` |
| `main/tools/discover.ts` | `discover` |
| `main/tools/render.ts` | `render` |
| `main/tools/memory.ts` | `memory` |
| `main/tools/tool.ts` | `tool` (agent-authored methods) |
| `main/tools/delegate.ts` | `delegate` (child agent) |
| `main/tools/control.ts` | `ask` |
| `main/memory.ts` | `MemoryStore` over `memory.sqlite` |
| `main/s3/api.ts` | `checkCall`, `callApi`, `scrub`, `describeError` |
| `main/security/scope.ts` | `assertInScope()`, `ScopeError` |
| `main/security/redact.ts` | `redact()`, `bound()`, tag escaping |
| `main/security/vault.ts` | sealing and opening secrets |
| `main/analysis/` | dataset import, formats, tables (`TABLES`) |
| `main/providers.ts` | accounts, credentials, `clientFor` (one client per account, service and region) |
| `main/db.ts` | the host schema and its queries |
| `shared/contract.ts` | the one type contract |
| `shared/view.ts` | view document validation and limits |
| `shared/conversation.ts` | the thread, citation lookup, search rows, Markdown transcript |
| `renderer/Conversation.tsx` | the thread: messages, steps, results, question, notices, overflow menu, task model |
| `renderer/Blocks.tsx` | view document renderer |
| `renderer/Composer.tsx` | message, steer, stop, files, `@` focus, the live status strip |
| `renderer/Home.tsx` | accounts list and model setup |
| `renderer/Views.tsx` | views of tool results |

## Storage layout

```text
<userData>/
  storage-agent.db          host tables + pi_* tables
  memory.sqlite             the agent's JSON documents
  settings.json             non-secret settings
  window.json               window bounds
  .vault-key                only when no OS keyring (0600)
  staging/<token>/          files waiting for their message
  tasks/<conversation>/
    uploads/                attached logs and inventories
    datasets/<id>.sqlite    one analytical database per import
    results/<evidence>.txt  a result longer than one piece, for `more`
    objects/<id>.bin        a streamed object body, for `more`
```

`storage-agent.db` is opened with WAL and foreign keys. The `pi_*` tables
belong to pi-durable; the host tables belong to this app
([data-model.md](data-model.md)).

## Deliberate absences

No event store of our own, no second queue, no SSE, no answer tool or report
protocol, no in-memory turn state, no prose classifier, no answer validation,
no rule engine or verdicts, no scripted or scheduled run, no MCP bridge, no
follow-up prompts, no background watch, no second window and no dashboard.
Delegation is a foreground child conversation, not a second queue; its steps
show inside the parent's `delegate` step, and stopping the parent stops it.
No migration, import or backup of an earlier layout. pi owns the
durable loop; the product owns read-only tools and the safety boundaries.
