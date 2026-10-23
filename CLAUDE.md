# CLAUDE.md

> Implementation contract for Storage Agent 15.0.0. Read
> `docs/architecture.md`, `docs/product.md`, `docs/security.md` and
> `docs/data-model.md` before changing product structure. The code and its tests
> are authoritative; release notes are history.

## The product

A local, read-only agent for object storage. One window, one document, one
composer. A **Task** is a conversation with the agent; the agent surveys storage,
remembers what it saw in an **estate**, and answers with data rendered from tool
results.

The invariant:

> The task is the window's object; the estate is the agent's memory; every
> answer is grounded in a tool call.

## Non-negotiables

1. Every storage operation is read-only. No put/delete/mutate call exists.
2. Secrets never reach SQLite in the clear, a model prompt, a log or the window.
   `security/vault.ts` is the only place that opens one.
3. A provider's `scope.buckets` is enforced by `assertInScope` before any call.
4. Tool output reaches the model inside `<untrusted-data>` and is bounded by
   `bound()` and `redact()`; `details` reaching the window are already shaped.
5. Nothing is invented: an unreadable or unsupported read leaves the question
   open, never a clean bill of health.
6. Fixes are text the user applies. There is no Apply button.

## Runtime

- `src/main/index.ts` — window, menu, single instance.
- `src/main/app.ts` — service wiring, watch loop, bootstrap.
- `src/main/ipc.ts` — the only IPC surface; every handler returns plain data.
- `src/preload/index.ts` — `contextBridge` surface, sandboxed, CJS.
- `src/shared/contract.ts` — the single type contract; both sides import it.
- `src/main/runtime/harness.ts` — pi-durable lifecycle, task CRUD, entry → UI
  mapping, conversation watch, task-graph watch.
- `src/main/runtime/agent.ts` — the one extension: prompt sections, tools, hooks.
- `src/main/tools/*` — ten tools through `agentTool()`, which owns scope,
  bounds, timeout, audit, redaction and the envelope.
- `src/main/estate/*` — the seven rules, issue lifecycle, fixes and impact.
- `src/main/s3/*` — posture snapshots, configuration review, reads, probe.
- `src/main/analysis/*` — CSV/TSV/JSONL/Parquet import and whitelisted
  aggregates over a per-dataset SQLite file.

pi-durable owns the durable loop. Do not reimplement it: no event store, no
second queue, no SSE, no HTTP server. `viewState()`/`watch()` are the stream.

## Data

Host tables in `storage-agent.db`: `providers`, `buckets`, `issues`,
`issue_events`, `notes`, `audit`, `watch`, `task_meta`, `capability`, `datasets`.
pi's tables are prefixed `pi_` in the same file. Datasets live under
`<userData>/tasks/<conversation>/datasets/<id>.sqlite`.

Schema changes are append-only migrations in `db.ts`, gated by `user_version`.

## Agent

One extension, ten tools: `survey`, `buckets`, `objects`, `object`, `config`,
`probe`, `estate`, `fix`, `analyze`, `note`. Adding an eleventh requires saying
why an existing one cannot do the job.

Prompt sections: identity, method, answer format, five method cards, estate
digest, language. The answer is short prose — no headings, no tables, no next
steps; tables, findings and fixes are rendered by the window from `details`.

A tool round counter blocks all tools after 40 rounds and tells the model to
answer. Compaction is pi's, configured by model context window.

## Window

`Sidebar · document · Composer`, plus a full-screen Settings sheet. No side
pane, no command palette, no second window. Tool rows expand in place.
Design tokens live in `src/renderer/styles.css`; never use a raw colour in a
component.

## Commands

`npm run dev` · `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
· `npm run dist:dir` · `xvfb-run -a node scripts/e2e.mjs`

Never claim a check you did not run.
