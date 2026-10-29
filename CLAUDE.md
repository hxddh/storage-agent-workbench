# CLAUDE.md

> Implementation contract for **Storage Agent 37.0.0**. Read
> `docs/architecture.md`, `docs/product.md`, `docs/security.md`,
> `docs/data-model.md` and, for anything in the window, `docs/design.md` before
> changing product structure. The code and its tests are authoritative.

## The product

A local, read-only agent for object storage. One window, one conversation per
task, one composer. A **task** is a conversation with the agent: the user's
messages, and between them what the agent did and said. A **turn** is one user
message and the agent's work on it.

> The agent reads, judges and says what it found; the application gives it
> read-only tools that return what the storage APIs return, enforces the safety
> boundaries and shows each call where it happened. The app decides nothing
> about the storage: no rules, no findings, no verdict, no report.

## Non-negotiables

1. Every storage operation is read-only. No put/delete/mutate call exists. The
   agent may write a change (a CLI command, a policy) for the user to apply; the
   app never runs it and has no Apply button.
2. Secrets never reach SQLite in the clear, a model prompt, a log or the window.
   `security/vault.ts` is the only place that opens one. A profile account
   stores a profile name, never a key.
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
   Lookup, Search, Select, Simulate), minus the few that hand out credentials;
   no list of sections, reads or checks stands between the agent and the API.
   A custom-endpoint account answers every service at its own endpoint, its
   credentials never sent to AWS. An account is its endpoint, region,
   credentials and scope; the app does not classify providers.
7. Account ids never reach the model, the window, a log or SQLite. Every
   response and every tool's error text pass through `scrub()`, which replaces
   each 12-digit number with `<account>`; `redact()` masks the account in any
   ARN. The agent writes `<account>` where the caller's id belongs and `call`
   fills it in (S3 Control's `AccountId` always); the id is used for that call
   only.
8. The conversation shows what happened, in order: the user's messages, the
   agent's text, provider reasoning as returned in full, and every tool call —
   failed and refused ones, and calls to a tool that does not exist — with its shaped
   result and exactly what the agent received. A tool's `model` text carries
   what its view shows; when the agent got only the first piece, the step says
   so. The app never writes into the agent's answer, rewrites it, corrects it or
   summarises it.
9. Code mode runs in the QuickJS sandbox with no network, filesystem, process,
   timers or modules; its only capabilities are the primitives in
   `tools/query.ts`: `call()` under the same rules as the tool, local datasets,
   and read-only SQL over them. It runs until it returns or the user stops it.
   `models` stays off.
10. Every read goes through the agent. There is no scripted run, no model-free
   check, no scheduled check and no demo storage: without a model the window
   says so and asks for one; without an account it asks for one.
11. The harness never overrides the agent: no round ceiling, no working budget,
    no fixed timeout, no fixed output cap (the model's own maximum is learned
    from its provider). Which calls to make, whether to repeat one, how much to
    read and how long to work are the agent's; Stop is the user's control. The
    prompt states the hard rules; it does not list the tools or prescribe a
    workflow. A default exists only where it protects the user's machine, and
    the agent can change it: the sandbox's memory (`memory_mb`) and how much of
    a body one read holds (`max_bytes`). The window may show a page of a very
    large result; the agent gets all of it.
12. The app does not speak for the user. Home has no canned prompts; Continue
    sends `Continue.`

## Architecture

One engine, one log, one projection (`docs/architecture.md`).

- **Engine** (`runtime/engine.ts`): every turn is pi's durable loop. `submit`,
  `steer`, `stop`, `retry` (the last user message again), `continueTask`
  (`sa.resume`); each turn settles in one place (`settle`): failure notice,
  search index, digest. A run learns its model's output limit first
  (`learnOutputLimit`).
- **Session** (`runtime/session.ts`): opens pi once with the one extension and
  the tool registry; durable reads; the per-task model; digest.
- **Tasks** (`runtime/tasks.ts`): task list, the one watched task, task graph,
  search index, `@` references (accounts and their live bucket names), notes.
- **Agent** (`runtime/agent.ts`): prompt sections and the memory digest. No
  hook: nothing blocks a call.
- **Calls** (`s3/api.ts`): one read-only operation of any bundled service —
  S3, S3 Control, STS, IAM, Organizations, KMS, Access Analyzer, CloudWatch,
  CloudTrail — checked by name, scoped, `<account>` filled in, the response
  scrubbed. `providers.clientFor` builds the client. Nothing there decides
  anything.
- **Conversation** (`shared/conversation.ts`): the one projection the window,
  search and export use: an ordered thread of messages, text, thoughts, calls,
  questions and notices, plus the live slot.
- **Models** (`runtime/model.ts`): one pi-ai provider per model configuration;
  a task's own model never replaces another task's.

pi-durable owns the durable loop. Do not reimplement it: no event store, no
second queue, no SSE, no HTTP server. `viewState()`/`watch()` are the stream.

## Agent

One extension, six tools (`tools/registry.ts` lists their names; each tool's
own description, sent with its schema, says what it does): `call` (any
read-only operation), `query` (a read-only script over many calls, datasets and
SQL), `probe` (one unsigned request to the account's endpoint), `more` (the rest
of a long result), `note` (remember, or forget a note of its own) and `ask`.
The agent's text is the answer; there is no answer tool, no report protocol, no
plan tool, no rule engine and no change-plan generator — the agent says its
plan and writes any change in its own words. A new storage tool must say why
`call` or `query` cannot do the job; a new service is a new SDK client in
`s3/api.ts`, not a new tool.

Prompt sections: identity, time, policy (the hard rules),
compose, memory digest, language. The digest names the accounts (their ids are
tool arguments) and every note with its id and author. The model may link a call as
`[1](#ev-<id>)`; a link opens that call in place. Provider reasoning is shown
in full, as returned.

## Data

Host tables in `storage-agent.db`: `providers`, `notes`, `audit`, `task_meta`,
`datasets`, `search_docs` (+ FTS5 trigram). pi's tables are prefixed `pi_`.
`db.ts` holds one schema at `user_version` **17**. A database at any other
version is cleared and created again, pi's tables and `tasks/` with it: the app
carries nothing from an earlier layout, and no code reads one. A note is text,
its author and its time. Entry kinds and payloads are in `docs/data-model.md`
(`sa.run`, `sa.steer`, `sa.resume`, `sa.notice`). Deleting a task purges its pi
rows, host task rows, datasets, audit rows and `tasks/<conversation>/` (with the
results kept for `more`).

## Window

`Sidebar · conversation · Composer`, plus a full-screen Settings sheet. The
conversation (messages, inline steps, what each call returned, clarify,
notices, Stop/Continue/Retry) and the keyboard map are specified in
`docs/design.md`. A `call` or `probe` step opens as the response's JSON. The
window adds nothing of its own to the conversation, and Home lists accounts
without saying anything about them. Design tokens live in `src/renderer/styles.css`; never use a raw colour in
a component. `npm run contrast` guards secondary text. English by default;
Chinese copy is written, not translated word by word.

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
