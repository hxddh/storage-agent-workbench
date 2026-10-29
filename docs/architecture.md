# Architecture

## Processes

```text
Electron main                              Renderer (sandboxed)
  index.ts    window, menu, dock, links      App.tsx  state + layout
  app.ts      wiring, bootstrap     ⇄ IPC   Sidebar / Home / Conversation /
  ipc.ts      the only IPC surface           Composer, Settings (lazy)
  preload     contextBridge, CJS
  runtime     session · engine · tasks · agent · project
  tools       six tools: call, query, probe, more, note, ask
  s3          read-only calls to bundled services, provider kind
  analysis    one SQLite file per dataset
  updater     GitHub releases
                       │
          storage-agent.db (node:sqlite)
          pi_* tables + host tables
```

There is no application HTTP server, sidecar, port or token. The renderer never
touches the filesystem, the database or a credential; it calls the preload
surface, which is exactly `AgentApi` in `src/shared/contract.ts`.

## One engine, one log, one projection

Every turn is pi's durable loop. Its entries live in the task's pi conversation,
and the window renders them through one projection.

```text
                  user message (sa.run / sa.steer / sa.resume)
                                     │
                       pi loop: model ⇄ tool registry
                       (every read through agentTool())
                                     │
                         durable entries in pi_entries
                                     │
                                     │
                          shared/conversation.ts
                          (the thread: messages, text,
                           thoughts, steps, notices, live)
                                     │
                          the window, search, export
```

- **One driver.** The model reads with its tools, calls them in parallel where
  it can, may ask the user a question, and writes its text. There is no plan
  tool, no method tool and no scripted run: the agent says its plan in its own
  words, and each tool's description says what it does. Home has no canned
  prompts; every turn starts from a message the user sent.
- **One settlement.** Every turn settles in `Engine.settle()`: the failure
  state, the search index, the memory digest, the task list and the shell
  notification.

The app decides nothing about the storage. `call` (`s3/api.ts`) returns the
service's response, or its error code, HTTP status and message; what is public,
risky or missing is the agent's to judge and say. No list of sections, reads or
checks stands between the agent and the API: any read-only operation of a
bundled service client is reachable (`docs/tools.md`). The rule engine, Issues,
remembered posture, reading records, change plans, scheduled checks and demo
storage were removed in 36.0 (migration 16 drops their tables).

## What the harness decides

Nothing about the agent's work. There is no round ceiling, no hook, no working
budget, no fixed timeout and no fixed output cap. Which calls to make, whether
to repeat one, how much to read and how long to work are the agent's; Stop is
the user's control. 37.0 removed the 36.x runaway ceiling (`MAX_ROUNDS`, the
`beforeTool` hook and the `budget` notice); a call it blocked in an older task
still shows as a step that did not run.

The only defaults protect the user's machine, and the agent can change them:
the sandbox's memory (`memory_mb`, 1,024 MB) and how much of a body one `call`
holds (`max_bytes`, 1 MiB). A result longer than one piece (24,000
characters) is kept whole in the task folder for `more`.

**Output limit.** Before a run, `learnOutputLimit()` (`runtime/model.ts`) asks
the model's provider once per model per launch: a one-word request that offers
the whole context window. If the provider accepts, the context window is the
limit; if it refuses, `statedMaximum()` takes the maximum its error names. A
limit is remembered only when the provider answered about it. A reply that
reaches the limit adds a `cut` notice.

There is no answer check. The app does not look for ungrounded names,
unresolved citations or uncited paragraphs, and never asks the model to rewrite
its text. The prompt states the hard rules; it does not list
the tools or prescribe a workflow. `COMPOSE` says the window adds no coverage
summary or verdict, so what a read could not reach is the agent's to say.

Prompt sections: identity, time, policy, compose, memory, language. The memory
digest (`buildDigest`) names the accounts with their ids, kinds, endpoints and
scopes, and every note, newest first, with its id and whether the user wrote
it, inside a `<memory>` block marked as data. A note past the retention set in
Settings is left out, as it is in Settings.

Each model configuration is its own provider in the shared pi-ai collection
(`providerIdFor()`), so one task's model never replaces another task's
mid-turn.

## Runtime flow

1. `app.whenReady` opens the data directory and SQLite, builds `AppDb`,
   `Settings`, `Vault`, `Providers`, `Staging`, then `Runtime` (pi, one
   extension, the tool registry), `Tasks` and `Engine`, registers IPC and
   creates the window. The vault stays closed at launch.
2. `Tasks.newTask()` creates one pi conversation per task and writes
   `task_meta` with a title derived from the first message.
3. `Engine.submit()` installs the task's model for this turn, configures the
   conversation, and submits an `sa.run` input (`trigger: 'user'`). Without a
   model in Settings it throws `Choose a model in Settings first.`. A steer is
   an `sa.steer` input that joins a running turn; with no turn going it is a new
   message. Retry resubmits the last user message with its files and focus,
   never a steer. Continue is an `sa.resume` input whose whole content is
   `Continue.`: a divider in the thread.
4. `@` focus names accounts and the buckets an account lists now
   (`Tasks.storageRefs`), as many as the user picks; `sanitizeContext` drops names outside an account's
   scope, and the names reach the model in an `<untrusted-data
   source="user-context">` block marked "focus only, not authorization".
5. A running call is projected from `pi.live.tools`. When it settles, the result
   is a `pi.tool-result` entry whose `details` carry target, note, shaped
   progress, argument summary, view, duration, status and evidence id; the
   result's text is exactly what the model received, and the step shows it.
   Status is written by `agentTool()`; result text is never parsed for it.
6. The open task is streamed with `conversation.watch()`; the live slot
   (reasoning, running calls, streaming text) comes through the `live` event.
7. `watchTaskGraph()` supplies working state for the sidebar, dock badge and
   taskbar progress.
8. Stop aborts the turn (pi keeps committed entries) and writes a `stopped`
   notice with **Continue**.
9. pi compacts when the model context fills; a compaction entry appears as a
   divider. Provider-facing messages never reach the renderer.
10. When a turn settles, `searchRows()` (`shared/conversation.ts`) writes the
    task's user messages and the agent's text to `search_docs`, and the digest
    is rebuilt so a new note shows in the next turn.

## Calls from earlier versions

`project.ts` renders a view only for a tool this build registers and a view
kind it knows (`raw`, `note`, `query`, `question`). A call to a removed tool
(`buckets`, `objects`, `object`, `config`, `account`, `survey`, `estate`,
`change_plan`, `accept_risk`, …), a call the 36.x ceiling blocked, or one with
an older view kind still shows as a step, with its
target, note, status and exactly what the agent received, but without a view.

## Modules

| Module | Responsibility |
|---|---|
| `main/runtime/session.ts` | pi harness, the one extension, tool registry, durable reads, the task's model, digest |
| `main/runtime/engine.ts` | submit, steer, stop, retry, continue; settlement |
| `main/runtime/tasks.ts` | task list, open task watch, task graph, search index, `@` references, notes |
| `main/runtime/agent.ts` | prompt sections, memory digest |
| `main/runtime/project.ts` | entries → `UiEntry`, live state, sanitized reasoning, usage |
| `main/runtime/model.ts` | pi-ai providers (one per model configuration), output limit, saved and draft test |
| `main/runtime/search.ts` | sidebar search over titles and index rows |
| `main/tools/policy.ts` | `agentTool()`: audit, envelope, redaction, pieces kept for `more` (`PIECE`, `fitPiece`, `resultPath`), status, details, evidence id |
| `main/tools/registry.ts` | the tool names |
| `main/tools/call.ts` | `call` |
| `main/tools/query.ts` | code mode: `call`, `dataset`, `inventory`, `sql` |
| `main/tools/probe.ts` | `probe` |
| `main/tools/more.ts` | `more` |
| `main/tools/note.ts` | `note` |
| `main/tools/control.ts` | `ask` |
| `main/s3/api.ts` | `callApi`: the read check, bucket scope, `<account>`, bodies, `scrub`, `describeError` |
| `main/s3/capabilities.ts` | provider kind detection from the endpoint |
| `main/security/scope.ts` | `assertInScope()`, `ScopeError` |
| `main/analysis/dataset.ts` | dataset tables (`TABLES`) and preview |
| `main/providers.ts` | accounts, credentials, `clientFor` (one client per account, service and region) |
| `shared/contract.ts` | the one type contract |
| `shared/conversation.ts` | the one projection: thread, citation lookup, search rows, Markdown transcript |
| `renderer/Conversation.tsx` | the thread: messages, steps, what each call returned, question, notices, overflow menu, task model |
| `renderer/Composer.tsx` | message, steer, stop, files, `@` focus, the live status strip |
| `renderer/Home.tsx` | accounts list and model setup |
| `renderer/Views.tsx` | typed views of tool results; a `raw` view opens as the response's JSON |

## Storage layout

```text
<userData>/
  storage-agent.db          app + pi_ tables + search_docs
  settings.json             non-secret settings
  window.json               window bounds
  .vault-key                only when no OS keyring (0600)
  staging/<token>/          files waiting for their message
  tasks/<conversation>/
    uploads/                attached logs and inventories
    datasets/<id>.sqlite    one analytical database per import
    results/<evidence>.txt  a result longer than one piece, for `more`
```

`storage-agent.db` is opened with WAL and foreign keys. `pi_*` tables belong to
pi-durable; the host tables are owned by this app. Deleting a task purges its
pi rows, host task rows, search rows, datasets, audit rows and task directory.

## Deliberate absences

No event store of our own, no second queue, no SSE, no report DSL, no answer
tool, no in-memory turn state, no prose classifier, no answer validation, no
rule engine, no verdicts, no scripted or scheduled run, no demo storage, no MCP
bridge, no subagents, no follow-up prompts, no automatic background watch, no
second window and no dashboard. pi owns the durable loop; the product owns
read-only capabilities and the safety boundaries.
