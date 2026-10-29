# Architecture

## Processes

```text
Electron main                              Renderer (sandboxed)
  index.ts    window, menu, dock, links      App.tsx  state + layout
  app.ts      wiring, bootstrap     ⇄ IPC   Sidebar / Home / Conversation /
  ipc.ts      the only IPC surface           Composer, Settings (lazy)
  preload     contextBridge, CJS
  runtime     session · engine · tasks · agent · project
  tools       nine tools: seven reads, note, ask
  s3          raw readers, read status, provider capabilities
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
        runtime/agent.ts                     shared/conversation.ts
        (runaway ceiling)                    (the thread: messages, text,
                                              thoughts, steps, notices, live)
                     │                                  │
              the beforeTool hook            the window, search, export
```

- **One driver.** The model reads with its tools, calls them in parallel where
  it can, may ask the user a question, and writes its text. There is no plan
  tool, no method tool and no scripted run: the agent says its plan in its own
  words, and each tool's description says what it does. Home has no canned
  prompts; every turn starts from a message the user sent.
- **One settlement.** Every turn settles in `Engine.settle()`: the ceiling
  notice, the search index, the memory digest, the task list and the shell
  notification.

The app decides nothing about the storage. The readers in `s3/raw.ts` return
each API's answer as `{ status, value }` or `{ status, error }`; what is public,
risky or missing is the agent's to judge and say. The rule engine, Issues,
remembered posture, reading records, change plans, scheduled checks and demo
storage were removed in 36.0 (migration 16 drops their tables).

## What the harness decides

One thing: a runaway ceiling. `runtime/agent.ts` counts the turn's assistant
entries that called a tool (`runView()` over `roundsOf()` in `project.ts`; the
count restarts at each `sa.run` and `sa.resume`), so a restarted process counts
the same as an uninterrupted one. Past `MAX_ROUNDS` (100) `beforeTool` blocks
the call with "This turn has made 100 rounds of tool calls; this call did not
run." The blocked call stays in the conversation as a step that did not run,
with that text as what the agent received, and the turn settles with a
`budget` notice. The ceiling is the same for every model. Which calls to make,
and whether to make one again, is the agent's.

There is no answer check. The app does not look for ungrounded names,
unresolved citations or uncited paragraphs, and never asks the model to rewrite
its text. The prompt states the hard rules and the ceiling; it does not list
the tools or prescribe a workflow. `COMPOSE` says the window adds no coverage
summary or verdict, so what a read could not reach is the agent's to say.

Prompt sections: identity, time, policy, compose, memory, language. The memory
digest (`buildDigest`) names the accounts with their ids, kinds, endpoints and
scopes, and the first 12 of N notes, inside a `<memory>` block marked as data.

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
   `Continue.`: a divider in the thread, with a fresh round count.
4. `@` focus names accounts and the buckets an account lists now
   (`Tasks.storageRefs`); `sanitizeContext` drops names outside an account's
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
kind it knows (`buckets`, `objects`, `object`, `raw`, `probe`, `note`, `query`,
`question`). A call to a removed tool (`survey`, `estate`, `change_plan`,
`accept_risk`, …) or with an older view kind still shows as a step, with its
target, note, status and exactly what the agent received, but without a view.

## Modules

| Module | Responsibility |
|---|---|
| `main/runtime/session.ts` | pi harness, the one extension, tool registry, durable reads, the task's model, digest |
| `main/runtime/engine.ts` | submit, steer, stop, retry, continue; settlement |
| `main/runtime/tasks.ts` | task list, open task watch, task graph, search index, `@` references, notes |
| `main/runtime/agent.ts` | prompt sections, the runaway ceiling, memory digest |
| `main/runtime/project.ts` | entries → `UiEntry`, live state, sanitized reasoning, usage, rounds |
| `main/runtime/model.ts` | pi-ai providers (one per model configuration), saved and draft test |
| `main/runtime/search.ts` | sidebar search over titles and index rows |
| `main/tools/policy.ts` | `agentTool()`: timeout, audit, envelope, bound, redaction, status, details, evidence id; `assertInScope()` |
| `main/tools/registry.ts` | the tool names |
| `main/tools/browse.ts` | `buckets`, `objects`, `object` |
| `main/tools/config.ts` | `config` |
| `main/tools/account.ts` | `account` and the account-level read `query` shares |
| `main/tools/probe.ts` | `probe` |
| `main/tools/query.ts` | code mode: read-only primitives, datasets, inventory, budgets |
| `main/tools/note.ts` | `note` |
| `main/tools/control.ts` | `ask` |
| `main/s3/raw.ts` | `scrub`, `readConfig` by section, account-level readers |
| `main/s3/status.ts` | error → read status (`available`, `not_configured`, `access_denied`, …) |
| `main/s3/capabilities.ts` | provider kind detection from the endpoint |
| `shared/contract.ts` | the one type contract |
| `shared/conversation.ts` | the one projection: thread, citation lookup, search rows, Markdown transcript |
| `renderer/Conversation.tsx` | the thread: messages, steps, what each call returned, question, notices, overflow menu, task model |
| `renderer/Composer.tsx` | message, steer, stop, files, `@` focus, the live status strip |
| `renderer/Home.tsx` | accounts list and model setup |
| `renderer/Views.tsx` | typed views of tool results; a `raw` view opens as its sections with status and JSON |

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
