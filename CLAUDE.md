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
message and the agent's work on it. The agent remembers what it read in an
**estate**.

> The window is a conversation; the estate is the agent's memory. The agent
> reads, decides what to say and says it; the application supplies read-only
> capabilities, enforces the safety boundaries and shows each call where it
> happened. It adds no report, no verdict and no coverage summary of its own.

## Non-negotiables

1. Every storage operation is read-only. No put/delete/mutate call exists.
   Change-plan text may contain a mutating CLI command; the app never runs it.
2. Secrets never reach SQLite in the clear, a model prompt, a log or the window.
   `security/vault.ts` is the only place that opens one. A profile account
   stores a profile name, never a key.
3. A provider's `scope.buckets` is enforced by `assertInScope` before any bucket
   call. `@` focus is not authorization.
4. Tool output reaches the model inside `<untrusted-data>`, bounded by `bound()`
   and `redact()`; `details` reaching the window are already shaped. Status comes
   from `details.status`, never from result text.
5. The conversation shows what happened, in order: the user's messages, the
   agent's text, provider reasoning as returned, and every tool call with its
   shaped result. The app never writes into the agent's answer, rewrites it,
   corrects it or summarises it. Honesty about unread parts is the agent's job,
   stated in the prompt (`COMPOSE`); a failed or refused call stays visible as a
   failed step.
6. A change plan is one deterministic plan the user applies. There is no Apply
   button. The plan never says a step was applied; only a later read shows it.
7. Issues change only in `estate/assess.ts`, from rule decisions on readings.
   No tool body, no model and no prose opens, resolves or re-grades one.
   Accepting a risk is the user's act: `accept_risk` asks, the window shows a
   confirmation, and only the user's click calls `AppDb.setAccepted`.
8. Code mode runs in the QuickJS sandbox with no network, filesystem, process,
   timers or modules; its only capabilities are the scoped read-only primitives
   in `tools/query.ts`, under call, listing, time and memory budgets. `models`
   stays off.
9. The account id read for the account-wide block is used for that read and the
   SCP lookup only; never stored, shown, sent to the model or put in a plan.
10. Access output is evidence with coverage, not one authorization verdict.
    Unread sources, undecided conditions and truncation stay in the call's
    result.
11. Demo storage is an explicit user choice. Nothing adds it on its own.
12. Every read goes through the agent. There is no scripted run and no
    model-free check: without a model the window says so and asks for one.
13. Loop guards derive from durable entries. The round budget and the repeated
    read block are rebuilt from the turn's entries; a restarted process
    rebuilds the same guards.

## Architecture

One engine, one log, one projection (`docs/architecture.md`).

- **Engine** (`runtime/engine.ts`): every turn is pi's durable loop. `submit`,
  `steer`, `stop`, `retry` (the last user message again), `continueTask`
  (`sa.resume`); each turn settles in one place (`settle`): budget notice,
  index, readings, digest.
- **Session** (`runtime/session.ts`): opens pi once with the one extension and
  the tool registry; durable reads; per-conversation model tier; digest.
- **Tasks** (`runtime/tasks.ts`): task list, the one watched task, task graph,
  search index, the user's acts on memory.
- **Agent** (`runtime/agent.ts`): prompt sections and hooks. Hooks rebuild the
  turn view from entries (`runView`): repeated reads by argument key, one retry
  after a failure, and the round budget (**14 small, 24 mid, 32 large**,
  counted from the turn's assistant entries).
- **Ledger** (`shared/ledger.ts`): the turn boundary, calls by argument key,
  coverage; `readState()` feeds the guards and the readings Home shows. It is
  never shown in the conversation.
- **Conversation** (`shared/conversation.ts`): the one projection the window,
  search and export use: an ordered thread of messages, text, thoughts, calls,
  questions, confirmations and notices, plus the live slot.
- **Models** (`runtime/model.ts`): one pi-ai provider per model configuration;
  a task's own model never replaces another task's.

pi-durable owns the durable loop. Do not reimplement it: no event store, no
second queue, no SSE, no HTTP server. `viewState()`/`watch()` are the stream.

## Agent

One extension, fourteen tools (`tools/registry.ts` generates the capability
section). Seven reads (`survey`, `buckets`, `objects`, `object`, `config`,
`probe`, `query`), memory (`estate`, `note`, `accept_risk`), `change_plan`, and
the control tools `plan`, `skill`, `ask`. The agent's text is the answer; there
is no answer tool and no report protocol. `query` exists because questions over
many objects or buckets cannot go through a fixed tool without flooding context;
adding a storage tool requires saying why `query` cannot do the job.

Prompt sections: identity, time, policy (with the turn's tier), capabilities,
compose, estate digest, language. The digest lists the first 12 of N open Issues
and notes and says so. The model may link a call as `[1](#ev-<id>)`; a link
opens that call in place. It never authors an Issue transition. `skill` loads
one of four methods (access, change, inventory, capacity); a method is
documentation, not evidence. Provider reasoning is shown only as returned.

`change_plan` returns one plan: lifecycle rules merge per bucket, a policy merge
only when the current policy was read and holds no account id, anything else a
manual step with a blocker; it names its baseline, residual risks and unreadable
dependencies.

`Check account` and a scheduled check send the agent a message; they are turns
like any other, and need a model.

## Data

Host tables in `storage-agent.db`: `providers`, `buckets`, `issues`,
`issue_events`, `notes`, `audit`, `task_meta`, `posture_changes`, `readings`,
`datasets`, `search_docs` (+ FTS5 trigram). pi's tables are prefixed `pi_`.
Schema changes are append-only migrations in `db.ts` gated by `user_version`
(head **15**). Entry kinds and payloads are in `docs/data-model.md` (`sa.run`,
`sa.steer`, `sa.resume`, `sa.notice`; 35.x `sa.call`/`sa.answer` still read as
calls and text). `readings` holds counts per settled account survey, never a
request, answer, policy, account id or secret. Deleting a task purges its pi
rows, host task rows, datasets, audit rows and `tasks/<conversation>/`; Issue
events and readings keep history with a null conversation id.

## Window

`Sidebar · conversation · Composer`, plus a full-screen Settings sheet. The
conversation (messages, inline steps, plan, clarify, risk confirmation,
notices, Stop/Continue/Retry) and the keyboard map are specified in
`docs/design.md`. There are no evidence strips, scope line, earlier-runs fold or
"worked for" summary. Design tokens live in `src/renderer/styles.css`; never use
a raw colour in a component. `npm run contrast` guards secondary text. English
by default; Chinese copy is written, not translated word by word.

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
