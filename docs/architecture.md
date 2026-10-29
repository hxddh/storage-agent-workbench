# Architecture

## Processes

```text
Electron main                              Renderer (sandboxed)
  index.ts    window, menu, dock, links      App.tsx  state + layout
  app.ts      wiring, bootstrap     ⇄ IPC   Sidebar / Home / Conversation /
  ipc.ts      the only IPC surface           Composer, Settings (lazy)
  preload     contextBridge, CJS
  runtime     session · engine · tasks · agent
  tools       read-only tools + plan/skill/ask/accept_risk
  estate      rules, assess (the only Issue writer), change plans
  s3          readers, policy, access, changes
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
                       (every call through agentTool())
                                     │
                         durable entries in pi_entries
                                     │
                shared/ledger.ts            shared/conversation.ts
                 (turn boundary, calls       (the thread: messages, text,
                  by key, coverage)           thoughts, steps, notices, live)
                     │                                  │
          agent hooks, readings              the window, search, export
```

- **One driver.** The model reads with its tools, calls them in parallel where
  it can, may publish a plan, ask one question or ask the user to accept a
  risk, and writes its text. There is no scripted run: `Check account` and a
  scheduled check are user messages (`src/main/app.ts`,
  `src/renderer/App.tsx`).
- **One settlement.** Every turn settles in `Engine.settle()`: the budget
  notice, the search index, reading records, the estate digest and the shell
  notification.

The scripted check and re-check (`runtime/check.ts`, `runtime/reverify-plan.ts`)
and the trace reducer (`shared/trace.ts`) were removed in 36.0.

## Turn state is derived, never held

`shared/ledger.ts` folds a task's entries into the current turn's ledger: the
turn boundary (the latest user message; a steer joins the running turn), call
keys and attempts, coverage, blind spots and undecided rules. `readState()`
turns it into one read status stored in the reading records `estate` history
returns to the agent. The ledger is never shown in the window.

The agent's hooks rebuild that ledger from durable entries
(`runtime/agent.ts` → `runView()`), so a restart or a resumed turn has the same
guards as an uninterrupted one:

- `beforeTool` blocks an exact storage read that already finished in the turn
  (by argument key, which `agentTool()` writes into the details), allows one
  retry after a failed read, treats two identical calls in one round as one,
  and stops every tool past the model tier's round budget (14 small, 24 mid,
  32 large). Rounds are counted from the assistant entries of the turn.
  `estate`, `change_plan`, `note`, `survey`, `accept_risk` and the control
  tools (`skill`, `plan`, `ask`) may repeat.

There is no answer check. The app does not look for ungrounded names,
unresolved citations or uncited paragraphs, and never asks the model to rewrite
its text. The prompt's `COMPOSE` section tells the agent to say what it read and
what it could not, and never to call the account clean while a read is open.

The tier comes from the model the conversation runs with (a task's own model or
the one in Settings), never from a global. Each model configuration is its own
provider in the shared pi-ai collection (`providerIdFor()`), so one task's model
never replaces another task's mid-turn.

## Runtime flow

1. `app.whenReady` opens the data directory and SQLite, builds `AppDb`,
   `Settings`, `Vault`, `Providers`, `Estate`, `Staging`, then `Runtime` (pi,
   one extension, the tool registry), `Tasks` and `Engine`, registers IPC and
   creates the window.
2. `Tasks.newTask()` creates one pi conversation per task and writes
   `task_meta` with a title derived from the first message. A scheduled check
   gets an account-and-minute title (`Scheduled check · Demo · 2026-10-29 05:45`).
3. `Engine.submit()` installs the task's model for this turn, configures the
   conversation, and submits an `sa.run` input (`trigger: 'user'`). Without a
   model in Settings it throws `Choose a model in Settings first.`. A steer is
   an `sa.steer` input that joins a running turn; with no turn going it is a new
   message. Retry resubmits the last user message with its files and focus,
   never a steer. Continue is an `sa.resume` input: a divider in the thread, with
   a fresh round budget.
4. A running call is projected from `pi.live.tools`. When it settles, the result
   is a `pi.tool-result` entry whose `details` carry target, note, shaped
   progress, argument summary, view, duration, status, evidence id, argument key
   and what the rules did with the reading. Status is written by `agentTool()`;
   result text is never parsed for it.
5. A tool reads; it never writes an Issue. `agentTool()` hands each call an
   `Assessor` (`estate/assess.ts`), the only module that turns rule decisions
   into Issue transitions. The transitions are recorded on the call
   (`assessed`); a survey's step note says how many Issues opened or resolved.
   `accept_risk` changes nothing: it returns an `accept` view, and only the
   user's click on the confirmation card calls `AppDb.setAccepted` (through
   `Tasks.acceptIssue`).
6. The open task is streamed with `conversation.watch()`; the live slot (reasoning,
   running calls, streaming text) comes through the `live` event.
7. `watchTaskGraph()` supplies working state for the sidebar, dock badge and
   taskbar progress.
8. Stop aborts the turn (pi keeps committed entries) and writes a `stopped`
   notice with **Continue**. A stopped survey has already remembered every
   bucket it read; a later survey continues with the unread remainder first.
9. pi compacts when the model context fills; a compaction entry appears as a
   divider. Provider-facing messages never reach the renderer.
10. When a turn settles, `searchRows()` (`shared/conversation.ts`) writes the
    task's user messages and the agent's text to `search_docs`. A settled
    account survey in the turn writes one `readings` row per account
    (`trigger: 'task'`). Readings carry counts only: no request, answer, policy,
    account id or secret.

`Check account` creates a new task whose first message asks the agent to read
every bucket, say which risks are open and say what it could not read. An
account with a daily or weekly schedule gets the same kind of message, focused
on that account, while the app is open and a model is set. Neither path runs
without a model or writes storage.

Memory history is a read of host rows: `AppDb.listIssueEvents` joins
`issue_events` to `issues`, and `estate(history: true)` merges those rows with
`posture_changes` under the same bounds, redaction and envelope as every other
tool result.

## One reading, one set of rules

`s3/facts.ts` reads a bucket once for the aspects asked for (security,
lifecycle, observability) and returns typed facts, each with a read status.
`readBucket()` reads the bucket's region first and switches to a regional client
when the account spans regions. `s3/policy.ts` evaluates a policy document
locally, including whether it denies plain HTTP. On AWS, `s3/account.ts` reads
the account-wide block, `s3/metrics.ts` reads CloudWatch capacity,
`s3/changes.ts` diffs posture and asks CloudTrail, and `s3/access.ts` reads
policy, ACL, IAM, KMS, Access Analyzer and SCP grants with coverage. Identity
grants are intersected with bucket-policy Denies and, when read, SCPs and
boundaries; object and bucket actions use their matching resource form; ARNs
are case-sensitive. One `AccessSession` per turn shares account-wide IAM and SCP
reads across buckets (`ToolDeps.accessSessions`, cleared when the turn settles).
`s3/permissions.ts` turns an access-denied read into the missing IAM action.

`estate/rules.ts` decides the twelve rules (eleven per bucket, one per account)
by code. `survey` and `config` pass the decisions to their `Assessor` and attach
the resulting observations to their view, which is how a step shows that a
finding was proved fixed.

**Access is evidence, not one merged authorization decision.** Policy and ACL
rows are grants; they are not intersected with every identity, SCP and condition
to produce a single allow/deny. Conditions are reported, not evaluated.
Coverage, unread sources and truncation stay in the view.

## Modules

| Module | Responsibility |
|---|---|
| `main/runtime/session.ts` | pi harness, the one extension, tool registry, durable reads, tier, digest |
| `main/runtime/engine.ts` | submit, steer, stop, retry, continue; settlement, readings |
| `main/runtime/tasks.ts` | task list, open task watch, task graph, search index, memory acts |
| `main/runtime/agent.ts` | prompt sections, hooks over the derived turn view, estate digest |
| `main/runtime/project.ts` | entries → `UiEntry`, live state, sanitized reasoning, usage, rounds |
| `main/runtime/model.ts` | pi-ai providers (one per model configuration), saved and draft test |
| `main/runtime/schedule.ts` | when an opt-in scheduled check is due |
| `main/runtime/search.ts` | sidebar search over titles and index rows |
| `main/estate/assess.ts` | the only writer of Issue transitions |
| `main/estate/estate.ts` | read-only estate memory: Issue rows, posture |
| `main/estate/rules.ts` | twelve rules over facts, Security Hub controls, review findings |
| `main/estate/changes.ts` | change formats and impact preview |
| `main/tools/policy.ts` | `agentTool()`: scope, timeout, audit, envelope, status, details, key, evidence id, assessor |
| `main/tools/registry.ts` | the capability manifest and generated prompt section |
| `main/tools/control.ts` | `plan`, `skill` and `ask` |
| `main/tools/estate.ts` | `estate`, `note`, `change_plan` and `accept_risk` |
| `main/tools/query.ts` | code mode: read-only primitives, datasets, inventory, budgets |
| `main/s3/*` | readers: facts, policy, account, metrics, access, changes, capabilities, permissions |
| `shared/contract.ts` | the one type contract |
| `shared/ledger.ts` | the turn ledger and read status |
| `shared/conversation.ts` | the one projection: thread, newest plan per turn, citation lookup, search rows, Markdown transcript |
| `renderer/Conversation.tsx` | the thread: messages, steps, plan, question, confirmation, notices, overflow menu, task model |
| `renderer/Composer.tsx` | message, steer, stop, files, `@` focus, the live status strip |
| `renderer/Home.tsx` | accounts list, Check account, demo and model setup |
| `renderer/Views.tsx` | typed views of tool results |

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
scripted run, no MCP bridge, no subagents, no follow-up prompts, no automatic
background watch, no second window and no dashboard. The only confirmation in
the window is the one `accept_risk` asks for. pi owns the durable loop; the
product owns storage semantics, read-only capabilities and the safety
boundaries.
