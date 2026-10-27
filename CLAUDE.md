# CLAUDE.md

> Implementation contract for **Storage Agent 32.0.0**. Read
> `docs/architecture.md`, `docs/product.md`, `docs/security.md` and
> `docs/data-model.md` before changing product structure. The code and its tests
> are authoritative; release notes and the changelog are history.

## The product

A local, read-only agent for object storage. One window, one run, one
composer. A **Task** is a question or a deterministic account check; the agent
remembers what it read in an **estate**, and the task's page is a **run**: the
agent's own optional plan, its answer, and the sources behind them.

The invariant:

> The task is the window's object; the estate is the agent's memory; every
> claim on the page is grounded in a tool call. The agent owns the plan and the
> composition; the application owns the capabilities, evidence and validation.

## Non-negotiables

1. Every storage operation is read-only. No put/delete/mutate call exists.
   Generated change-plan text may contain a mutating CLI command, but the app
   never runs it.
2. Secrets never reach SQLite in the clear, a model prompt, a log or the window.
   `security/vault.ts` is the only place that opens one. A profile account
   stores a profile name, never a key.
3. A provider's `scope.buckets` is enforced by `assertInScope` in the main
   process before any bucket call. `@` focus is not authorization.
4. Tool output reaches the model inside `<untrusted-data>` and is bounded by
   `bound()` and `redact()`; `details` reaching the window are already shaped.
   Tool status comes from `details.status`, never from result text.
5. Nothing is invented: an unreadable or unsupported read leaves the question
   open, never a clean bill of health. The run shows the blind spot. A
   backticked name in the answer that no tool returned is marked. An answer cites
   evidence ids; the window validates every citation and view and says when one
   does not resolve. The scope line says `All n buckets checked` only when
   account coverage, pending reads, access gaps and failed reads are closed;
   when every bucket was surveyed but access questions remain it says
   `All n buckets checked · x open questions · y blocked`; otherwise it says
   `From memory`, `Live read` or `Not fully checked`. A narrowed re-read never
   counts as account coverage. A clean account claim is corrected once while
   reads remain open.
6. A change plan is one deterministic plan the user applies. There is no Apply
   button. Only re-verification may call a step confirmed; an unapplied step is
   `not applied`, and an unread or undecided one stays `unknown`.
7. The model never opens, resolves, re-grades or accepts an Issue. Rules open
   and resolve them from readings; accepting a risk is the user's act.
8. Code mode runs in the QuickJS sandbox with no network, filesystem, process,
   timers or modules. Its only capabilities are the scoped read-only primitives
   in `tools/query.ts`, each under the call, listing, time and memory budgets.
   Scripts never reach the model access (`models` stays off).
9. The account id read for the account-wide block is used for the account-wide
   read and SCP lookup, and never stored, shown, sent to the model or put in a
   change plan.
10. Access output is evidence with coverage, not a complete authorization
    decision. Policy/ACL grants are not merged with every identity and condition
    into one verdict. Unread sources, undecided conditions and truncation must
    stay visible.
11. Demo storage is an explicit user choice. `Check account` never adds it
    silently.

## Runtime

- `src/main/index.ts` — window, menu, single instance, notifications, dock,
  task protocol.
- `src/main/app.ts` — service wiring, bootstrap, model installation, home
  overview and the opt-in read-only check scheduler.
- `src/main/ipc.ts` — the only IPC surface; every handler returns plain data.
- `src/main/updater.ts` — background updates from GitHub releases, packaged
  builds only, with a visible missing-feed state.
- `src/preload/index.ts` — `contextBridge` surface, sandboxed, CJS.
- `src/shared/contract.ts` — the single type contract; both sides import it.
- `src/shared/facts.ts` — the deterministic facts projection from `UiEntry[]`:
  risks, methods, coverage, change plans, data and tool calls.
- `src/shared/run.ts` — the agent-native projection: the latest optional plan,
  the final Markdown answer, evidence resolution, citation validation and
  grounding.
- `src/shared/activity.ts` — the current-turn work projection: provider reasoning
  summary, live and durable tool calls, compaction and resume.
- `src/shared/audit.ts` — the deterministic summary for a model-free account
  check; it names only buckets and counts already present in survey views.
- `src/shared/grounding.ts` — which names and exposure a task's results show;
  used by the run and by the agent's `onYield` correction.
- `src/main/runtime/harness.ts` — pi-durable lifecycle, task CRUD, model per
  run, conversation watch, task-graph watch, model-free `audit()`, re-verify,
  purge on delete.
- `src/main/runtime/project.ts` — entry → UI mapping, live state, sanitized
  provider reasoning, usage.
- `src/main/runtime/model.ts` — pi-ai provider installation and saved/draft
  model test.
- `src/main/runtime/reverify-plan.ts` — compares a change plan with a model-free
  replay; confirmed, not applied or unknown per step.
- `src/main/runtime/search.ts` — sidebar search and the FTS5-trigram index rows.
- `src/main/runtime/schedule.ts` — daily/weekly due calculation; no OS daemon.
- `src/main/runtime/agent.ts` — the one extension: prompt sections, tools,
  hooks, per-run read coverage and the one clean-claim correction.
- `src/main/tools/*` — read-only storage tools through `agentTool()`, which
  owns scope, bounds, timeout, audit, redaction, status, evidence ids and the
  untrusted envelope; plus the control tools `plan` and `skill` in
  `tools/control.ts`. `estate` returns current memory and, with `history`,
  Issue events and posture changes filtered by account, bucket, code or
  `since`. `change_plan` returns deterministic change text.
- `src/main/s3/facts.ts` — the one reading of a bucket; `s3/policy.ts`
  evaluates a policy document locally; `s3/account.ts` reads the account-wide
  block; `s3/metrics.ts` reads CloudWatch capacity and prices it;
  `s3/access.ts` reads policy/ACL/IAM/KMS/Access Analyzer/SCP grants with
  coverage, intersects identity grants with bucket-policy Denies and, where
  present, SCPs and boundaries, pairs action and resource forms, matches ARNs
  case-sensitively and shares an `AccessSession` when a caller supplies one;
  `s3/changes.ts` diffs posture and queries CloudTrail's 90-day window;
  `s3/capabilities.ts` is the provider matrix; `s3/permissions.ts` maps a denied
  read to an IAM action.
- `src/main/estate/*` — eleven bucket rules and one account rule over facts,
  Issue lifecycle and change-plan generation (twelve rules total).
- `src/main/tools/query.ts` — read-only code mode.
- `src/main/skills.ts` — four on-demand methods: access, change, inventory and
  capacity. A skill is documentation, not evidence or a check.
- `src/main/demo/*` — the fake S3 responder; demo storage answers it in process
  (no port), the E2E server puts HTTP around it.
- `src/main/analysis/*` — CSV/TSV/JSONL/Parquet import and whitelisted
  aggregates, reached through the `query` dataset primitives.

pi-durable owns the durable loop. Do not reimplement it: no event store, no
second queue, no SSE, no HTTP server. `viewState()`/`watch()` are the stream.

## Data

Host tables in `storage-agent.db`: `providers`, `buckets`, `issues`,
`issue_events`, `notes`, `audit`, `task_meta`, `posture_changes`, `readings`,
`datasets`, `search_docs`. pi's tables are prefixed `pi_` in the same file.
Datasets live under `<userData>/tasks/<conversation>/datasets/<id>.sqlite`.

Issues are `open`, `resolved` or `accepted`, and carry the reading's evidence
`detail`. The account rule's Issue has the empty string as its bucket. A bucket
a complete listing no longer shows gets `gone_at` and its Issues resolve as
`gone`. Capacity (bytes, objects, monthly estimate, growth) is remembered in
each bucket's posture; the account posture in `providers.account_json`. Schema
changes are append-only migrations in `db.ts`, gated by `user_version` (head
**13**).

`readings` records one settled account survey: trigger, coverage counts, open
high/total and whether it was complete. It stores no request, answer, policy,
account id or secret. `complete` is false for any narrowed or re-verified read;
Home's "last complete read" comes from this table. `estate(history: true)`
includes reading rows only in an unfiltered history.

`search_docs` is a derived index backed by FTS5 trigram (short queries fall back
to LIKE; title search reads `task_meta` directly). It
is rebuilt for a conversation when that conversation settles, and backfilled at
startup for tasks without rows. It stores the request, the current answer summary
(`entry_id = 'answer'`) and one row per risk (`f:<source entry>:<key>`).
A model-free check writes one `sa.audit` entry; its `survey` and `access`
progress events are transient and never persisted. It has no `sa.user`
request, so the page shows its synthesized answer and Sources index without a fake
question. Its search rows are derived from the same durable entries as the run, after
the active watch and durable view settle.

Deleting a task purges `task_meta`, `search_docs`, its pi conversation, entries,
tasks, submissions, documents and revisions, datasets, audit rows and
`tasks/<conversation>/` on disk. Issue events and reading rows keep history with
a null conversation id. There is no automatic background watch; an account can
opt into daily or weekly read-only checks while the app is open.

## Agent

One extension, twelve tools, six capability groups. Seven reads (`survey`,
`buckets`, `objects`, `object`, `config`, `probe`, `query`) cover storage;
`estate` and `note` cover memory; `change_plan` returns deterministic change
text; `plan` publishes an optional investigation plan; `skill` loads one of four
methods. The final assistant message is the answer; there is no answer tool.
`query` exists because questions over many objects or buckets (largest prefixes,
data untouched for a year, buckets by size) cannot be carried to the model by a
fixed tool without flooding its context or adding one tool per question. It also
imports attached logs and inventories through `dataset` / `aggregate`; there is
no separate analyze tool. Adding another storage tool requires saying why
`query` cannot do the job; control tools are not storage reads.

Prompt sections: identity, today, policy, capabilities, compose, estate digest,
language. The model owns the investigation and writes normal Markdown. It does
not have to call `plan`; the plan is optional and appears only when useful. Its
final message is the answer. It cites a tool result by actual evidence id as
`[1](#ev-<id>)`; the window resolves the tool view, validates every citation,
drops a missing view with a quiet note, and marks names the task never showed.
The model never authors a table of facts or an Issue transition. There is no
answer tool and no forced report protocol.

`skill` is a real on-demand method, not a check: access evidence, change
planning, inventory/logs and capacity/cost. The model sees the four descriptions
in the capability section and loads one only when the question needs it. Methods
are visible in Sources and never counted as tool calls. Provider reasoning is
shown only as the provider returned it (a summary); the app never fabricates a
chain of thought or turns a tool label into thinking text.

`change_plan` returns one change plan: lifecycle rules merge per bucket, a
policy change is merged only when the current policy was read and contains no
account id, and an unread or unsafe merge becomes a manual step with a blocker.
The plan names its baseline, residual risks and unreadable dependencies. It
remains text for the user.

The agent decides when to read memory (`estate`), survey an account, review one
bucket (`config`), run `query`, or ask for history. The policy says read before
concluding; a survey reads up to 5,000 buckets, longest-unread first, and may be
called again. Temporal questions use `estate(history: true)` with optional
`since`, `bucket` or `code`; it returns Issue events and posture changes, never
raw request text. Hooks: a repeated storage read is blocked and left off the
page; a storage tool stops at the model-tier round budget (**14 small, 24 mid,
32 large**); an answer that names something no tool returned, or calls a bucket
public (or not) against the readings, gets one correction; a clean account claim
while the run has open reads gets one correction. The correction sees the
answer text as well as the final prose. Read coverage is per run: a narrowed
survey updates its buckets but never replaces an account-wide survey's pending,
blind or truncated coverage. Every model run uses the configured model and its
inferred reasoning level. Compaction is pi's, configured by model context
window. The no-model `audit()` path runs the same survey and access readers
without a model, emits transient progress, and writes a deterministic answer
that the same run surface renders.

The estate digest lists the first 12 of N open Issues and notes, and says so; it
never presents a truncated memory list as complete.

`harness.audit()` surveys every configured account and examines access evidence
for up to 24 buckets per account, reporting examined/total when the run covers
fewer buckets than the account has.
`harness.reverify()` replays reads for up to 50 buckets per account, includes
the buckets and account block in a change plan, and reports skipped or
truncated coverage. It compares every plan step: all codes clear is confirmed,
an open or accepted Issue is not applied, and an unread or undecided code stays
unknown. Neither path calls a model. A settled unscoped survey writes one
`readings` row per account; re-verification is always partial.

## Window

`Sidebar · run · Composer`, plus a full-screen Settings sheet. No side pane,
no command palette, no second window, no chat transcript. Settings uses a
top-left close control; it is a sheet, not a page with a top-right Done button.

The task list groups pinned, today and earlier, with a state dot only for
working, attention or failed and a relative time. Titles may take two lines;
task rows support rename, pin and delete. The task title appears once: in the
sidebar on desktop and in the run header/compact top area on narrow screens,
never twice at the top.

Every task is an agent run page. Earlier turns appear as compact expandable
rows under **Earlier in this task**; the latest question is the run header. A
deterministic check has no fake question. The run header names the account(s),
the scope line (`All n buckets checked`, `Not fully checked: n`,
`From memory · …`, `Live read · …`, or `Not read yet`), checked/total buckets
and read time. A failed or stopped storage read keeps the line open. Copy and
one overflow menu sit in the header: save Markdown, check again, re-check,
copy link, export sources and save PDF. `Check again` opens a new check task;
re-check writes a result in the current task and opens its Sources section.
Home reads its "last complete read" from the reading records.

The plan section is the agent's own 1–6 steps (commonly 3–6) with
pending/active/done/blocked states; it is optional and not a transcript. It is
visible while the run is live and remains for a stopped run or a blocked step; a
settled answer folds it away. Plan state is intent, not proof: an actual call is
the only execution evidence.

**Work** is the one current-turn activity surface. While live it is open and
shows a provider reasoning summary when one was returned, the current call and
all completed calls, with status, target, shaped result summary and duration.
After the answer settles it collapses to one `Worked for … · n calls` row; the
same rows reopen in their original order. It never invents a reasoning summary:
an omitted or empty thinking block is shown as an honest `Thought` row with no
summary. Live progress comes from shaped `ToolDetails.progress`, never from raw
tool output. A failed call stays in place with its status and note.

The answer is normal Markdown with citations. The window shows one proof view:
the first cited tool result, otherwise the latest data read, otherwise the
latest change plan. When there is no proof, the current risk list stands in its
place. A missing citation is shown as plain text with a quiet note. There is no
report block renderer and no legacy entry path.

**Sources** is one compact index below the answer: Risks, Data, Change plan,
Tool calls, Not checked, Checked again, Changes and Methods, each row only when
it has content. One row opens one section; nothing is expanded by default. The
index does not carry a duplicate check count; Tool calls shows the receipt
inside. Risks are grouped by bucket, severity ordered, memory-marked, five
visible with **N more** expanding in place. Accepted and proved-fixed folds
remain. **Not read** names blind, pending, truncated, failed and access gaps.
Every table can be copied as CSV or saved; the page can be copied or saved as
Markdown.

A model-free check renders through the same run surface with a synthesized
answer and a `Deterministic account check` tag. A model run opens Work when it
starts and collapses it to `Worked for … · n calls` when the answer settles;
Sources Tool calls remains the audit receipt. A stopped run keeps its plan and
offers Continue. There are no next-step
suggestions or follow-up prompts. A query's script opens under its check as the
evidence; the answer can cite it.

Failed model runs offer Retry; stopped runs offer Continue. The sidebar search
(⌘K) covers titles, requests, risks and the composed answer summary. Files can
be dropped or pasted onto the composer. A run that finishes while the window is
in the background sends one notification. PDF export expands Risks, Tool calls
and Data before printing; the receipt is not repeated. `storage-agent://task/<id>`
opens a task; Copy link puts it on the clipboard. In risks, j/k move, Enter opens
the check, a accepts. Settings offers demo storage and the models already running
on this machine; its Test button tests the values currently in the form, and
typing a key fetches the provider's model list automatically.

Design tokens live in `src/renderer/styles.css`; never use a raw colour in a
component. Secondary text that is used as normal text must clear WCAG AA on the
surface where it appears; `npm run contrast` guards the token pairs.

The interface is English by default. Chinese copy is written separately, not
translated word by word; model answers follow the user's language preference.

## Commands

`npm run dev` · `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
· `npm run budget` · `npm run contrast` · `npm run audit` · `npm run sbom` · `npm run dist:dir` ·
`xvfb-run -a node scripts/e2e.mjs` · `xvfb-run -a node scripts/e2e-audit.mjs`
· `xvfb-run -a node scripts/eval.mjs --smoke` (or with `EVAL_*` for a real model)
· `STORAGE_AGENT_AWS_ENDPOINT=http://127.0.0.1:5055 npx vitest run src/main/compat.test.ts`
(with `moto_server -p 5055` running)

Never claim a check you did not run.
