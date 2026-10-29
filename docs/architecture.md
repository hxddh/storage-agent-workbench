# Architecture

## Processes

```text
Electron main                              Renderer (sandboxed)
  index.ts    window, menu, dock, links      App.tsx  state + layout
  app.ts      wiring, bootstrap     ⇄ IPC   Sidebar / Home / Conversation /
  ipc.ts      the only IPC surface           Composer, Settings (lazy)
  preload     contextBridge, CJS
  runtime     session · engine · tasks · agent · project · model
  tools       call, query, probe, more, note, ask
  s3/api.ts   read-only calls to the bundled services
  analysis    one SQLite file per dataset
  updater     GitHub releases
                       │
          storage-agent.db (node:sqlite)
          pi_* tables + host tables
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
  and writes its text. Each tool's description, sent with its schema, says what
  it does; the prompt does not list the tools or prescribe a workflow. Every
  turn starts from a message the user sent.
- **One settlement.** Every turn settles in `Engine.settle()`: the failure
  state, the search index, the memory digest, the task list and the shell
  notification.

The app decides nothing about the storage. `call` (`s3/api.ts`) returns the
service's response or its error; what it means is the agent's to judge and
say. Any read-only operation of a bundled service client is reachable
([tools.md](tools.md)).

## What the harness decides

Nothing about the agent's work. There is no round ceiling, hook, working
budget or fixed output cap. Which calls to make, whether to repeat one, how
much to read and how long to work are the agent's. **Stop** is the user's
control.

Two defaults protect the user's machine, and the agent can change both: the
sandbox's memory (`memory_mb`, 1,024 MB) and how much of a body one `call`
holds (`max_bytes`, 1 MiB). A result longer than one piece (24,000
characters) is kept whole in the task folder for `more`.

**Output limit.** Before a run, `learnOutputLimit()` (`runtime/model.ts`) asks
the model's provider once per model per launch: a one-word request that offers
the whole context window. If the provider accepts, the context window is the
limit; if it refuses, `statedMaximum()` takes the maximum its error names. A
limit is remembered only when the provider answered about it. A reply that
stops at the limit gets a `cut` notice.

There is no answer check. The app does not look for ungrounded names or
unresolved citations, and never asks the model to rewrite its text.

**Prompt sections** (`runtime/agent.ts`): identity, time, policy, compose,
memory, language. The memory digest (`buildDigest`) names each account with
its id, endpoint (or AWS), region and scope, and lists every note, newest
first, with its id, inside a `<memory>` block marked as data. A note older than
the retention set in Settings is left out, as it is in Settings.

Each model configuration is its own provider in the shared pi-ai collection
(`providerIdFor()`), so one task's model never replaces another task's.

## Runtime flow

1. `app.whenReady` opens the data directory and SQLite, builds `AppDb`,
   `Settings`, `Vault`, `Providers`, `Staging`, then `Runtime` (pi, one
   extension, the tool registry), `Tasks` and `Engine`, registers IPC and
   creates the window. The vault is not opened at launch.
2. `Tasks.newTask()` creates one pi conversation per task and writes
   `task_meta` with a title from the first message.
3. `Engine.submit()` installs the task's model for this turn, configures the
   conversation and submits an `sa.run` input. Without a model in Settings it
   throws `Choose a model in Settings first.` A steer is an `sa.steer` input
   that joins a running turn; with no turn going it is a new message. Retry
   sends the last user message again with its files and focus. Continue is an
   `sa.resume` input whose content is `Continue.`
4. `@` focus names accounts and the buckets an account lists now
   (`Tasks.storageRefs`). `sanitizeContext` drops names outside an account's
   scope; the names reach the model in an `<untrusted-data
   source="user-context">` block marked "focus only, not authorization".
5. A running call is projected from `pi.live`. When it settles, the result is
   a `pi.tool-result` entry whose `details` carry target, note, progress,
   argument summary, view, duration, status and evidence id; its text is
   exactly what the model received. `agentTool()` writes the status; result
   text is never parsed for it.
6. The open task streams through `conversation.watch()`; the live slot
   (reasoning, running calls, streaming text) comes through the `live` event.
7. `watchTaskGraph()` supplies working state for the sidebar, dock badge and
   taskbar progress.
8. Stop aborts the turn (pi keeps committed entries) and writes a `stopped`
   notice with **Continue**.
9. pi compacts when the model context fills; the compaction shows as a
   divider. Provider-facing messages never reach the renderer.
10. When a turn settles, `searchRows()` writes the task's user messages and
    agent text to `search_docs`, and the digest is rebuilt so a new note is in
    the next turn.

`project.ts` renders a view for a known view kind (`raw`, `note`, `query`,
`question`). A tool result without `details` (a call pi ended before the tool
ran) shows as a step marked `Did not run`, with what the agent received. A call
to a tool name the registry does not hold shows as a failed step.

## Modules

| Module | Responsibility |
|---|---|
| `main/runtime/session.ts` | pi harness, the one extension, tool registry, durable reads, the task's model, digest |
| `main/runtime/engine.ts` | submit, steer, stop, retry, continue; settlement |
| `main/runtime/tasks.ts` | task list, open task watch, task graph, search index, `@` references, notes |
| `main/runtime/agent.ts` | prompt sections, memory digest |
| `main/runtime/project.ts` | entries → `UiEntry`, live state, reasoning, usage |
| `main/runtime/model.ts` | pi-ai providers (one per model configuration), output limit, model test |
| `main/runtime/search.ts` | sidebar search over titles and index rows |
| `main/tools/policy.ts` | `agentTool()`: audit, envelope, redaction, pieces kept for `more`, status, details, evidence id |
| `main/tools/registry.ts` | the tool names |
| `main/tools/call.ts` | `call` |
| `main/tools/query.ts` | code mode: `call`, `dataset`, `inventory`, `sql` |
| `main/tools/probe.ts` | `probe` |
| `main/tools/more.ts` | `more` |
| `main/tools/note.ts` | `note` |
| `main/tools/control.ts` | `ask` |
| `main/s3/api.ts` | `checkCall`, `callApi`, `scrub`, `describeError` |
| `main/security/scope.ts` | `assertInScope()`, `ScopeError` |
| `main/security/redact.ts` | `redact()`, `bound()`, tag escaping |
| `main/security/vault.ts` | sealing and opening secrets |
| `main/analysis/` | dataset import, formats, tables (`TABLES`) |
| `main/providers.ts` | accounts, credentials, `clientFor` (one client per account, service and region) |
| `main/db.ts` | the host schema and its queries |
| `shared/contract.ts` | the one type contract |
| `shared/conversation.ts` | the thread, citation lookup, search rows, Markdown transcript |
| `renderer/Conversation.tsx` | the thread: messages, steps, results, question, notices, overflow menu, task model |
| `renderer/Composer.tsx` | message, steer, stop, files, `@` focus, the live status strip |
| `renderer/Home.tsx` | accounts list and model setup |
| `renderer/Views.tsx` | views of tool results |

## Storage layout

```text
<userData>/
  storage-agent.db          host tables + pi_* tables
  settings.json             non-secret settings
  window.json               window bounds
  .vault-key                only when no OS keyring (0600)
  staging/<token>/          files waiting for their message
  tasks/<conversation>/
    uploads/                attached logs and inventories
    datasets/<id>.sqlite    one analytical database per import
    results/<evidence>.txt  a result longer than one piece, for `more`
```

`storage-agent.db` is opened with WAL and foreign keys. The `pi_*` tables
belong to pi-durable; the host tables belong to this app
([data-model.md](data-model.md)).

## Deliberate absences

No event store of our own, no second queue, no SSE, no answer tool or report
protocol, no in-memory turn state, no prose classifier, no answer validation,
no rule engine or verdicts, no scripted or scheduled run, no MCP bridge, no
subagents, no follow-up prompts, no background watch, no second window and no
dashboard. pi owns the durable loop; the product owns read-only tools and the
safety boundaries.
