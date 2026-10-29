# CLAUDE.md

> Implementation contract for **Storage Agent 38.0.0**. Read
> `docs/architecture.md`, `docs/product.md`, `docs/security.md`,
> `docs/data-model.md` and `docs/tools.md` before changing product structure.
> The code and its tests are authoritative; release notes and the changelog
> are history.

## The product

A local, read-only agent for object storage and the cloud around it. One
window, one conversation per task, one composer. A **task** is a conversation
with the agent: the user's messages, and between them what the agent did and
said. A **turn** is one user message and the agent's work on it.

> The agent reads, judges and says what it found; the application gives it
> read-only tools that return what the services return, enforces the safety
> boundaries and shows each call where it happened. The app decides nothing
> about the storage: no rules, no findings, no verdict, no report, no
> next-step prompt.

## Non-negotiables

1. Every storage operation is read-only. No put/delete/mutate call exists. The
   agent may write a change (a CLI command, a policy) for the user to apply;
   the app never runs it and has no Apply button.
2. Secrets never reach SQLite in the clear, a model prompt, a log or the
   window. `security/vault.ts` is the only place that opens one. A profile
   account stores a profile name, never a key.
3. A provider's `scope.buckets` is enforced before any bucket call (`checkCall`
   in `s3/api.ts`; `assertInScope` for the inventory a script imports); a
   scoped listing shows only the scoped buckets. `@` focus is not authorization.
4. Tool output reaches the model inside `<untrusted-data>`, through `redact()`;
   `details` reaching the window are already shaped. Status comes from
   `details.status`, never from result text. A result longer than one piece
   (`PIECE`, 24,000 characters) is kept whole in the task folder and the model
   reads on with `more`; nothing a tool returned is out of the agent's reach.
5. Tools return data, not judgements. `call` returns the service's response,
   or its error code, HTTP status and message (`s3/api.ts`); `probe` returns
   what the endpoint answered. What is public, risky or missing is the agent's
   to decide and say.
6. Capabilities are not fixed in code. `call` reaches every operation of every
   bundled service client whose name says it reads (Get, List, Head, Describe,
   Lookup, Search, Select, Simulate, BatchGet, Query, Scan), minus the few that
   hand out credentials. `discover` lists the current services and operations.
   `tool` lets the agent write a reusable read-only method; `render` lets it
   compose a view; `memory` stores arbitrary JSON; `delegate` gives an
   independent investigation to a child with the same tools and scope. No list
   of checks or prescribed workflow stands between the agent and its work.
7. Account ids never reach the model, the window, a log or SQLite. Every
   response and every tool's error text pass through `scrub()`, which replaces
   the caller's actual 12-digit id and account fields (such as a policy
   principal) with `<account>` and redacts the account in ARNs; other 12-digit
   data is not rewritten. The agent writes `<account>` where the caller's id
   belongs and `call` fills it in (S3 Control's `AccountId` always); the id is
   used for that call only.
8. The conversation shows what happened, in order: the user's messages, the
   agent's text, provider reasoning as returned, and every tool call — failed
   and refused ones, and calls to a tool that does not exist — with its shaped
   result and exactly what the agent received. A tool's `model` text carries
   what its view shows; when the agent got only the first piece, the step says
   so. The app never writes into the agent's answer, rewrites it, corrects it,
   validates its claims or summarises it. A citation that resolves opens its
   call; one that does not is plain text with a quiet tooltip.
9. Code mode runs in the QuickJS sandbox with no network, filesystem, process,
   timers or modules. Its only capabilities are the scoped read-only
   primitives in `tools/query.ts`: `call()`, `discover()`, `memory()`,
   `render()`, `dataset()`, `inventory()` and `sql()`. A script runs until it
   returns or the user stops it. `models` stays off. Agent-authored methods
   run in the same sandbox, with their arguments checked against their schema.
10. Every read goes through the agent. There is no scripted run, model-free
    check, scheduled check or demo storage: without a model the window says so
    and asks for one; without an account it asks for one.
11. The harness never overrides the agent: no round ceiling, no working budget,
    no fixed timeout, no fixed output cap. Which calls to make, whether to
    repeat one, how much to read, whether to delegate, what to remember and
    how long to work are the agent's; Stop is the user's control. The prompt
    states the hard rules; it does not list the tools or prescribe a workflow.
    A default exists only where it protects the user's machine, and the agent
    can change it: the sandbox's memory (`memory_mb`) and how much of a body
    one read holds (`max_bytes`). The model's output budget is a bounded
    default of `min(8,192, context window)` tokens.
12. The app does not speak for the user. Home has no canned prompts; Continue
    sends `Continue.`

## Architecture

One engine, one log, one projection (`docs/architecture.md`).

- **Engine** (`runtime/engine.ts`): every turn is pi's durable loop. `submit`,
  `steer`, `stop`, `retry` (the last user message again), `continueTask`
  (`sa.resume`); each turn settles in one place (`settle`): failure notice,
  search index, digest.
- **Session** (`runtime/session.ts`): opens pi once with the one extension and
  the tool registry; durable reads; the per-task model; digest.
- **Tasks** (`runtime/tasks.ts`): task list, the one watched task, task graph,
  search index, `@` references, memory and methods.
- **Agent** (`runtime/agent.ts`): prompt sections, memory digest. No hook:
  nothing blocks a call.
- **Calls** (`s3/api.ts`): one read-only operation of any bundled service,
  checked by name, scoped, `<account>` filled in, the response scrubbed.
  `providers.clientFor` builds the client. Nothing there decides anything.
- **Memory** (`memory.ts`): a separate `memory.sqlite` with JSON documents,
  task or user scope, read-only SQL. Host tables are not reachable from it.
- **Methods** (`tools/tool.ts`, `agent_tools`): agent-authored JSON Schema +
  QuickJS body, task or user scope, purged with the task.
- **Conversation** (`shared/conversation.ts`): the one projection the window,
  search and export use: an ordered thread of messages, text, thoughts, calls,
  questions and notices, plus the live slot.
- **Views** (`shared/view.ts`, `renderer/Blocks.tsx`): a declarative view
  document, validated and rendered as data.
- **Models** (`runtime/model.ts`): one pi-ai provider per model configuration;
  a task's own model never replaces another task's.

pi-durable owns the durable loop. Do not reimplement it: no event store, no
second queue, no SSE, no HTTP server. `viewState()`/`watch()` are the stream.

## Agent

One extension, ten tools (`tools/registry.ts` lists their names; each tool's
own description, sent with its schema, says what it does): `call` (any
read-only operation), `query` (a read-only script over many calls, datasets,
memory and views), `probe` (one unsigned request to the account's endpoint),
`more` (the rest of a long result or an object body), `discover` (services,
operations and tools), `render` (a view document), `memory` (durable JSON),
`tool` (an agent-authored method), `delegate` (a child agent) and `ask`. The
agent's text is the answer; there is no answer tool, no report protocol, no
plan tool, no rule engine and no change-plan generator — the agent says its
plan and writes any change in its own words. A new storage tool must say why
`call` or `query` cannot do the job; a new service is a new SDK client in
`s3/api.ts`, not a new tool.

Prompt sections: identity, time, policy (the hard rules), capabilities,
compose, memory digest, language. The digest names the accounts (their ids are
tool arguments) and how many memory documents exist; it does not inject their
content. The model may link a call as `[1](#ev-<id>)`; a link opens that call
in place. Provider reasoning is shown in full, as returned. Delegation is a
foreground child conversation with the same tools and scope; it is not a
second queue.

## Data

Host tables in `storage-agent.db`: `providers`, `notes` (v37 only, imported
once and cleared), `audit`, `task_meta`, `datasets`, `agent_tools`,
`search_docs` (+ FTS5 trigram). pi's tables are prefixed `pi_`. `db.ts` holds
schema **18**; 17 migrates in place for `agent_tools`. A database from an older
incompatible layout is backed up beside the new one before it is cleared, and
the shell renames `tasks/` rather than deleting it. The agent's memory is
`memory.sqlite` (`docs` table); task-scoped documents are purged with the task.
A note from v37 becomes a user memory document with key `note:<id>`.

Entry kinds and payloads are in `docs/data-model.md` (`sa.run`, `sa.steer`,
`sa.resume`, `sa.notice`). Deleting a task purges its pi rows, host task rows,
datasets, audit rows, task memory documents, task methods, search rows and
`tasks/<conversation>/` (with results and object bodies kept for `more`).

## Window

`Sidebar · conversation · Composer`, plus a full-screen Settings sheet. The
conversation (messages, inline steps, what each call returned, clarify,
notices, Stop/Continue/Retry) and the keyboard map are specified in
`docs/design.md`. A `call` or `probe` step opens as the response's JSON; a
`render` step draws its view; a `delegate` step shows the child's answer.
Settings has five panes: Model, Storage accounts, Memory, Methods and
Appearance; its close control is an X at the top-left. Design tokens live in
`src/renderer/styles.css`; never use a raw colour in a component.
`npm run contrast` guards secondary text. English by default; Chinese copy is
written, not translated word by word.

## Commands

`npm run dev` · `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
· `npm run budget` · `npm run contrast` · `npm run audit` · `npm run sbom` ·
`npm run dist:dir` · `xvfb-run -a node scripts/e2e.mjs` ·
`xvfb-run -a node scripts/e2e-audit.mjs` ·
`xvfb-run -a node scripts/eval.mjs --smoke` (or with `EVAL_*`) ·
`xvfb-run -a node scripts/bench.mjs --smoke` (or with `EVAL_*` and `--runs 3`:
the real-model gate) · `xvfb-run -a node scripts/shots.mjs && node scripts/visual.mjs`
· `STORAGE_AGENT_AWS_ENDPOINT=http://127.0.0.1:5055 npx vitest run src/main/compat.test.ts`
(with `moto_server -p 5055` running)

Never claim a check you did not run.
