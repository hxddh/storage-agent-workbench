# CLAUDE.md

> Implementation contract for **Storage Agent 35.0.0**. Read
> `docs/architecture.md`, `docs/product.md`, `docs/security.md`,
> `docs/data-model.md` and, for anything in the window, `docs/design.md` before
> changing product structure. The code and its tests are authoritative; release
> notes and the changelog are history.

## The product

A local, read-only agent for object storage. One window, one current run, one
composer. A **task** is durable history of runs; a **run** is one request or one
scripted check. The agent remembers what it read in an **estate**.

> The task is the window's object; the estate is the agent's memory; every
> claim on the page is grounded in a tool call. The agent owns the plan and the
> composition; the application owns the capabilities, evidence and validation.

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
5. Nothing is invented. An unreadable or unsupported read leaves the question
   open and the run shows the blind spot. A backticked name no tool returned is
   marked. Citations are validated; one that does not resolve is said to. The
   scope line comes from the ledger, never from the prose: `All n buckets
   checked` only when coverage, pending reads, access gaps and failed reads are
   closed; `All n buckets checked · x open questions · y blocked` when every
   bucket was surveyed but questions remain; otherwise `From memory`, `Live
   read` or `Not fully checked`. A narrowed re-read never counts as coverage.
6. A change plan is one deterministic plan the user applies. There is no Apply
   button. Only a re-check may call a step confirmed; an unapplied step is
   `not applied`, an unread or undecided one stays `unknown`.
7. Issues change only in `estate/assess.ts`, from rule decisions on readings.
   No tool body, no model and no prose opens, resolves or re-grades one.
   Accepting a risk is the user's act (`AppDb.setAccepted`).
8. Code mode runs in the QuickJS sandbox with no network, filesystem, process,
   timers or modules; its only capabilities are the scoped read-only primitives
   in `tools/query.ts`, under call, listing, time and memory budgets. `models`
   stays off.
9. The account id read for the account-wide block is used for that read and the
   SCP lookup only; never stored, shown, sent to the model or put in a plan.
10. Access output is evidence with coverage, not one authorization verdict.
    Unread sources, undecided conditions and truncation stay visible.
11. Demo storage is an explicit user choice. `Check account` never adds it.
12. Run state is derived from durable entries. Nothing that decides a run's
    behaviour (budget, repeated reads, grounding, coverage) lives only in
    memory; a restarted process rebuilds the same guards.

## Architecture

One engine, one log, one reducer (`docs/architecture.md`).

- **Engine** (`runtime/engine.ts`): a model run is pi's durable loop; a scripted
  run (`check`, `recheck`) calls the same registered tools through the same
  `agentTool()`, writes each call as `sa.call` with the same details, and writes
  a template answer (`runtime/check.ts`) that cites its calls and carries their
  enveloped output as model context. Both settle in one place.
- **Session** (`runtime/session.ts`): opens pi once with the one extension and
  the tool registry; durable reads; per-conversation model tier; digest.
- **Tasks** (`runtime/tasks.ts`): task list, the one watched task, task graph,
  search index, the user's acts on memory.
- **Agent** (`runtime/agent.ts`): prompt sections and hooks. Hooks rebuild the
  run view from entries (`runView`): repeated reads by argument key, one retry
  after a failure, the round budget (**14 small, 24 mid, 32 large**, counted
  from the run's assistant entries), and one structural answer correction.
- **Ledger** (`shared/ledger.ts`): the run boundary, calls, names, evidence,
  coverage, blind spots; `readState()` is the one read status.
- **Validation** (`shared/validate.ts`): ungrounded names, unresolved
  citations, a paragraph naming a read bucket without citing it. Never wording,
  never "is the account clean".
- **Trace** (`shared/trace.ts`): the one reducer the window, search and export
  use: current run, earlier runs, findings, Markdown, search rows.
- **Models** (`runtime/model.ts`): one pi-ai provider per model configuration;
  a task's own model never replaces another task's.

pi-durable owns the durable loop. Do not reimplement it: no event store, no
second queue, no SSE, no HTTP server. `viewState()`/`watch()` are the stream.

## Agent

One extension, thirteen tools in seven groups (`tools/registry.ts` generates the
capability section). Seven reads (`survey`, `buckets`, `objects`, `object`,
`config`, `probe`, `query`), memory (`estate`, `note`), `change_plan`, and the
control tools `plan`, `skill`, `ask`. The final assistant message is the answer;
there is no answer tool and no report protocol. `query` exists because questions
over many objects or buckets cannot go through a fixed tool without flooding
context; adding a storage tool requires saying why `query` cannot do the job.

Prompt sections: identity, time, policy (with the run's tier), capabilities,
compose, estate digest, language. The digest lists the first 12 of N open Issues
and notes and says so. The model cites evidence as `[1](#ev-<id>)`; it never
authors a table of facts or an Issue transition. `skill` loads one of four
methods (access, change, inventory, capacity); a method is documentation, not
evidence, and not a call. Provider reasoning is shown only as returned.

`change_plan` returns one plan: lifecycle rules merge per bucket, a policy merge
only when the current policy was read and holds no account id, anything else a
manual step with a blocker; it names its baseline, residual risks and unreadable
dependencies.

`Engine.check()` surveys every account and examines access for up to 24 buckets
per account, saying examined/total. `Engine.recheck()` replays every bucket the
task read (up to 50 per account) plus its change plan, as a new run in the same
task, and compares every conclusion and plan step. Neither calls a model.

## Data

Host tables in `storage-agent.db`: `providers`, `buckets`, `issues`,
`issue_events`, `notes`, `audit`, `task_meta`, `posture_changes`, `readings`,
`datasets`, `search_docs` (+ FTS5 trigram). pi's tables are prefixed `pi_`.
Schema changes are append-only migrations in `db.ts` gated by `user_version`
(head **15**; 15 started the task history over and kept accounts, memory,
Issues and readings). Entry kinds and payloads are in `docs/data-model.md`
(`sa.run`, `sa.steer`, `sa.resume`, `sa.call`, `sa.answer`, `sa.reverify`,
`sa.notice`). `readings` holds counts per settled account survey, never a
request, answer, policy, account id or secret; a re-check row is partial.
Deleting a task purges its pi rows, host task rows, datasets, audit rows and
`tasks/<conversation>/`; Issue events and readings keep history with a null
conversation id.

## Window

`Sidebar · run · Composer`, plus a full-screen Settings sheet. The run page,
the trace, the two evidence strips (**Findings**, **Not checked**), notices,
clarify, earlier runs and the keyboard map are specified in `docs/design.md`.
Design tokens live in `src/renderer/styles.css`; never use a raw colour in a
component. `npm run contrast` guards secondary text. English by default; Chinese
copy is written, not translated word by word.

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
