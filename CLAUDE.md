# CLAUDE.md

> Implementation contract for Storage Agent 20.0.0. Read
> `docs/architecture.md`, `docs/product.md`, `docs/security.md` and
> `docs/data-model.md` before changing product structure. The code and its tests
> are authoritative; release notes are history.

## The product

A local, read-only agent for object storage. One window, one brief, one
composer. A **Task** is a question the agent answers by reading storage; the
agent remembers what it saw in an **estate**, and the task's page is a **brief**
projected from its tool results.

The invariant:

> The task is the window's object; the estate is the agent's memory; every
> claim on the page is grounded in a tool call.

## Non-negotiables

1. Every storage operation is read-only. No put/delete/mutate call exists.
2. Secrets never reach SQLite in the clear, a model prompt, a log or the window.
   `security/vault.ts` is the only place that opens one. A profile account
   stores a profile name, never a key.
3. A provider's `scope.buckets` is enforced by `assertInScope` before any call.
4. Tool output reaches the model inside `<untrusted-data>` and is bounded by
   `bound()` and `redact()`; `details` reaching the window are already shaped.
   Tool status comes from `details.status`, never from result text.
5. Nothing is invented: an unreadable or unsupported read leaves the question
   open, never a clean bill of health. The brief shows the blind spot. A
   backticked name in the verdict that no tool returned is marked.
6. Fixes are text the user applies. There is no Apply button.
7. The model never opens, resolves, re-grades or accepts an Issue. Rules open
   and resolve them from readings; accepting a risk is the user's act.
8. Code mode runs in the QuickJS sandbox with no network, filesystem, process
   or timers. Its only capabilities are the scoped read-only primitives in
   `tools/query.ts`, each under the call, listing, time and memory budgets;
   scripts never reach the model's model access (`models` stays off).
9. The account id read for the account-wide block is used for that one call
   and never stored, shown, sent to the model or put in a fix.

## Runtime

- `src/main/index.ts` — window, menu, single instance, notifications, dock.
- `src/main/app.ts` — service wiring, bootstrap.
- `src/main/ipc.ts` — the only IPC surface; every handler returns plain data.
- `src/main/updater.ts` — background updates from GitHub releases.
- `src/preload/index.ts` — `contextBridge` surface, sandboxed, CJS.
- `src/shared/contract.ts` — the single type contract; both sides import it.
- `src/shared/brief.ts` — the one projection from `UiEntry[]` to the brief;
  the window renders it and the main process indexes the same findings.
- `src/shared/grounding.ts` — which names a task's results show; used by the
  brief and by the agent's `onYield` correction.
- `src/main/runtime/harness.ts` — pi-durable lifecycle, task CRUD, model per
  run, conversation watch, task-graph watch, purge on delete.
- `src/main/runtime/project.ts` — entry → UI mapping, live state, usage.
- `src/main/runtime/search.ts` — sidebar search and the index rows.
- `src/main/runtime/agent.ts` — the one extension: prompt sections, tools, hooks.
- `src/main/tools/*` — ten tools through `agentTool()`, which owns scope,
  bounds, timeout, audit, redaction, status and the envelope.
- `src/main/s3/facts.ts` — the one reading of a bucket; `s3/policy.ts`
  evaluates a policy document locally; `s3/account.ts` reads the account-wide
  block; `s3/metrics.ts` reads CloudWatch capacity and prices it;
  `s3/access.ts` reads policy/ACL/IAM/KMS/Analyzer grants;
  `s3/changes.ts` diffs posture and asks CloudTrail; `s3/capabilities.ts` is the
  provider matrix; `s3/permissions.ts` maps a denied read to an IAM action.
- `src/main/estate/*` — eleven bucket rules and one account rule over facts,
  Issue lifecycle, fixes (twelve rules total).
- `src/main/tools/query.ts` — read-only code mode.
- `src/main/demo/*` — the fake S3 responder; demo storage answers it in
  process (no port), the E2E server puts HTTP around it.
- `src/main/analysis/*` — CSV/TSV/JSONL/Parquet import and whitelisted
  aggregates, reached through the `query` dataset primitives.

pi-durable owns the durable loop. Do not reimplement it: no event store, no
second queue, no SSE, no HTTP server. `viewState()`/`watch()` are the stream.

## Data

Host tables in `storage-agent.db`: `providers`, `buckets`, `issues`,
`issue_events`, `notes`, `audit`, `task_meta`, `datasets`, `search_docs`. pi's
tables are prefixed `pi_` in the same file. Datasets live under
`<userData>/tasks/<conversation>/datasets/<id>.sqlite`.

Issues are `open`, `resolved` or `accepted`, and carry the reading's evidence
`detail`. The account rule's Issue has the empty string as its bucket. A bucket
a complete listing no longer shows gets `gone_at` and its Issues resolve as
`gone`. Capacity (bytes, objects, monthly estimate, growth) is remembered in
each bucket's posture; the account posture in `providers.account_json`. Schema
changes are append-only migrations in `db.ts`, gated by `user_version` (head
**5**).

`search_docs` is a derived index (title search reads `task_meta` directly). It
is rebuilt for a conversation when that conversation settles, and backfilled at
startup for tasks without rows. It stores the request, the current verdict
(`entry_id = 'verdict'`) and one row per finding (`f:<source entry>:<key>`).

Deleting a task purges `task_meta`, `search_docs`, its pi conversation, entries,
tasks, submissions, documents and revisions, datasets, audit rows and
`tasks/<conversation>/` on disk. There is no background watch.

## Agent

One extension, ten tools: `survey`, `buckets`, `objects`, `object`, `config`,
`probe`, `estate`, `fix`, `note`, `query`. `query` exists because questions over
many objects or buckets (largest prefixes, data untouched for a year, buckets by
size) cannot be carried to the model by a fixed tool without flooding its
context or adding one tool per question. It also imports attached logs and
inventories through `dataset` / `aggregate`; there is no separate analyze tool.
Adding an eleventh requires saying why `query` cannot do the job.

Prompt sections: identity, today, method, answer format, method cards, estate
digest, language. The model writes only the verdict: at most two sentences, no
headings, tables or restated numbers, every bucket, key and account name in
backticks. Findings, tables, fixes and checks are projected by the window from
`details`.

The method reads memory first (`estate`), surveys only when memory is empty,
stale, or the question is about current exposure, after a fix re-reads only
that bucket (`survey` with `buckets`), and uses `query` for questions over many
objects or buckets. A survey reads up to 5,000 buckets, longest-unread first,
and may be called again to continue. Hooks: a repeated storage read is blocked
and left off the page; all tools stop after 24 rounds and the brief says so; a
verdict that names something no tool returned, or calls a bucket public (or
not) against the readings, gets one correction. Every run is pointed at the model and
thinking level in Settings. Compaction is pi's, configured by model context
window.

## Window

`Sidebar · brief · Composer`, plus a full-screen Settings sheet. No side pane,
no command palette, no second window, no chat transcript.

A check appears the moment a tool starts, shows its real progress and settles in
place; the Checks section folds to a receipt (checks · time · tokens) when the
run ends. The brief shows the verdict, the current findings (merged by rule and
bucket, severity ordered, memory marked), what the task proved fixed, accepted
risks folded, the blind spots, the fixes, one data section (folded when findings
already answer; a query's rows and chart, or the survey table with capacity),
checks and the folded questions. A query's script opens under its check as the
evidence. Results are flat sections separated by hairlines, never cards.
Findings carry their Security Hub control where one matches; when a survey
view carries fewer Issues than the account has, the brief says how many.

The task title lives once, in the sidebar. Every table can be copied as CSV or
saved; the page can be copied or saved as Markdown. Failed and stopped runs offer
Retry or Continue. The sidebar search (⌘K) covers titles, requests, findings and
the current verdict. Files can be dropped or pasted onto the composer. A run that
finishes while the window is in the background sends one notification.
`storage-agent://task/<id>` opens a task; Copy link puts it on the clipboard.
In findings, j/k move, Enter opens the evidence, a accepts. Settings offers demo
storage and the models already running on this machine.

Design tokens live in `src/renderer/styles.css`; never use a raw colour in a
component. Secondary text clears WCAG AA on every surface.

## Commands

`npm run dev` · `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
· `npm run budget` · `npm run audit` · `npm run sbom` · `npm run dist:dir` ·
`xvfb-run -a node scripts/e2e.mjs`
· `xvfb-run -a node scripts/eval.mjs --smoke` (or with `EVAL_*` for a real model)
· `STORAGE_AGENT_AWS_ENDPOINT=http://127.0.0.1:5055 npx vitest run src/main/compat.test.ts`
(with `moto_server -p 5055` running)

Never claim a check you did not run.
