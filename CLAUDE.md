# CLAUDE.md

> Implementation contract for **Storage Agent 36.0.0**. Read
> `docs/architecture.md`, `docs/product.md`, `docs/security.md`,
> `docs/data-model.md` and, for anything in the window, `docs/design.md` before
> changing product structure. The code and its tests are authoritative; release
> notes and the changelog are history.

## The product

A local, read-only agent for object storage. One window, one conversation per
task, one composer. A **task** is a conversation with the agent: the user's
messages, and between them what the agent did and said. A **turn** is one user
message and the agent's work on it.

> The agent reads, judges and says what it found; the application gives it
> read-only tools that return what the storage APIs return, enforces the safety
> boundaries and shows each call where it happened. The app decides nothing
> about the storage: no rules, no findings, no Issues, no verdict, no report.

## Non-negotiables

1. Every storage operation is read-only. No put/delete/mutate call exists. The
   agent may write a change (a CLI command, a policy) for the user to apply; the
   app never runs it and has no Apply button.
2. Secrets never reach SQLite in the clear, a model prompt, a log or the window.
   `security/vault.ts` is the only place that opens one. A profile account
   stores a profile name, never a key.
3. A provider's `scope.buckets` is enforced by `assertInScope` before any bucket
   call. `@` focus is not authorization.
4. Tool output reaches the model inside `<untrusted-data>`, bounded by `bound()`
   and `redact()`; `details` reaching the window are already shaped. Status comes
   from `details.status`, never from result text.
5. Tools return data, not judgements. A read returns each API's answer as
   `{ status, value }` or `{ status, error }` (`s3/raw.ts`); what is public,
   risky or missing is the agent's to decide and say.
6. Account ids never reach the model, the window, a log or SQLite. The reads
   that carry them (`config`, `account` and their `query` primitives) and every
   tool's error text pass through `scrub()`, which replaces each 12-digit
   number with `<account>`; `redact()` masks the account in any ARN. The id
   STS returns is used only as the argument of the account-wide block and SCP
   reads.
7. The conversation shows what happened, in order: the user's messages, the
   agent's text, provider reasoning as returned in full, and every tool call —
   blocked ones and calls to tools of earlier versions too — with its shaped
   result and exactly what the agent received. A tool's `model` text carries
   what its view shows; the window never shows the user data the agent did not
   get. The app never writes into the agent's answer, rewrites it, corrects it
   or summarises it.
8. Code mode runs in the QuickJS sandbox with no network, filesystem, process,
   timers or modules; its only capabilities are the scoped read-only primitives
   in `tools/query.ts`, under call, listing, time and memory budgets. `models`
   stays off.
9. Every read goes through the agent. There is no scripted run, no model-free
   check, no scheduled check and no demo storage: without a model the window
   says so and asks for one; without an account it asks for one.
10. The harness overrides the agent in one place only: a runaway ceiling of
    **100** rounds of tool calls per turn, rebuilt from the turn's entries. No
    per-model tiers, no working budget. Which calls to make, whether to repeat
    one, how much to read and how long to work are the agent's. The prompt
    states the hard rules; it does not list the tools again or prescribe a
    workflow. Limits on a tool's input exist only where they protect the user's
    machine or storage (the sandbox budgets, S3's own page size), never to make
    the agent work less.
11. The app does not speak for the user. Home has no canned prompts; Continue
    sends `Continue.`

## Architecture

One engine, one log, one projection (`docs/architecture.md`).

- **Engine** (`runtime/engine.ts`): every turn is pi's durable loop. `submit`,
  `steer`, `stop`, `retry` (the last user message again), `continueTask`
  (`sa.resume`); each turn settles in one place (`settle`): ceiling notice,
  search index, digest.
- **Session** (`runtime/session.ts`): opens pi once with the one extension and
  the tool registry; durable reads; the per-task model; digest.
- **Tasks** (`runtime/tasks.ts`): task list, the one watched task, task graph,
  search index, `@` references (accounts and their live bucket names), notes.
- **Agent** (`runtime/agent.ts`): prompt sections and one hook, the runaway
  ceiling (`MAX_ROUNDS`, counted from the turn's assistant entries by
  `runView`). A blocked call stays in the conversation as a step that did not
  run.
- **Readers** (`s3/raw.ts`): bucket configuration section by section and the
  account-level reads (account block, IAM, SCPs, KMS key policy, Access
  Analyzer, CloudWatch storage metrics, CloudTrail), each as the API answered,
  scrubbed. Nothing there decides anything.
- **Conversation** (`shared/conversation.ts`): the one projection the window,
  search and export use: an ordered thread of messages, text, thoughts, calls,
  questions and notices, plus the live slot.
- **Models** (`runtime/model.ts`): one pi-ai provider per model configuration;
  a task's own model never replaces another task's.

pi-durable owns the durable loop. Do not reimplement it: no event store, no
second queue, no SSE, no HTTP server. `viewState()`/`watch()` are the stream.

## Agent

One extension, nine tools (`tools/registry.ts` lists their names; each tool's
own description, sent with its schema, says what it does). Reads: `buckets`,
`objects`, `object`, `config` (one bucket's configuration, by section),
`account` (account-level AWS data), `probe` (one endpoint check), `query`
(read-only code over many objects or buckets). Memory: `note`. And `ask`. The
agent's text is the answer; there is no answer tool, no report protocol, no
plan tool, no rule engine and no change-plan generator — the agent says its
plan and writes any change in its own words. `query` exists because questions
over many objects or buckets cannot go through a fixed tool without flooding
context; adding a storage tool requires saying why `query` cannot do the job.

Prompt sections: identity, time, policy (the hard rules and the ceiling),
compose, memory digest, language. The digest names the accounts (their ids are
tool arguments) and the first 12 of N notes. The model may link a call as
`[1](#ev-<id>)`; a link opens that call in place. Provider reasoning is shown
in full, as returned.

## Data

Host tables in `storage-agent.db`: `providers`, `notes`, `audit`, `task_meta`,
`datasets`, `search_docs` (+ FTS5 trigram). pi's tables are prefixed `pi_`.
Schema changes are append-only migrations in `db.ts` gated by `user_version`
(head **16**; 16 dropped the rule engine's `issues`, `issue_events`,
`readings`, `posture_changes` and `buckets`, and the providers' `schedule`,
`account_json` and `account_at`). Entry kinds and payloads are in
`docs/data-model.md` (`sa.run`, `sa.steer`, `sa.resume`, `sa.notice`; 35.x
`sa.call`/`sa.answer` still read as calls and text). Deleting a task purges its
pi rows, host task rows, datasets, audit rows and `tasks/<conversation>/`.

## Window

`Sidebar · conversation · Composer`, plus a full-screen Settings sheet. The
conversation (messages, inline steps, what each call returned, clarify,
notices, Stop/Continue/Retry) and the keyboard map are specified in
`docs/design.md`. A `config` or `account` read opens as its sections with their
status and JSON. There are no evidence strips, scope line, earlier-runs fold or
"worked for" summary, and Home lists accounts without saying anything about
them. Design tokens live in `src/renderer/styles.css`; never use a raw colour in
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
