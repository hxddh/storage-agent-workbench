# Architecture

## Processes

```text
Electron main                            Renderer (sandboxed)
  app.ts      wiring                     App.tsx   state + layout
  ipc.ts      the only IPC surface   ⇄    Sidebar / Brief / Composer
  preload     contextBridge, CJS           Settings
  pi-durable  harness, tasks, entries
  tools       ten read-only tools; datasets are query primitives
  estate      rules, issues, fixes
  s3          one reading per bucket
  updater     GitHub releases
  analysis    SQLite per dataset
                     │
        storage-agent.db (node:sqlite)
        pi_* tables + host tables
```

There is no HTTP server, no sidecar, no port and no token. The renderer never
touches the filesystem, the database or a credential; it calls the preload
surface, which is exactly `AgentApi` in `src/shared/contract.ts`.

## Runtime flow

1. `app.whenReady` opens the database, builds services, opens the harness and
   registers IPC.
2. `harness.createConversation()` creates one conversation per task.
3. Before every run, `configure()` points the conversation at the model and
   thinking level in Settings, so a model change reaches old tasks too. The run
   state (round count, calls made, names the task has read) is seeded from the
   task's entries.
4. `submit` writes a `sa.user` entry and runs pi's generation task. A running
   call is projected from `pi.live.tools` (name, target, progress, start time);
   when it settles it becomes a `pi.tool-result` entry carrying `details`
   (`{ target, note, view, ms, status }`), and the row is replaced in place.
   Status is written by `agentTool()`: `done`, `failed`, `refused`, `timeout` or
   `stopped`. The projection never reads it from result text.
5. Hooks guard the run: `beforeTool` blocks a repeated storage read and every
   call after 24 rounds; `afterTool` records the names a result shows;
   `onYield` asks once for a corrected verdict when it names something no
   result showed (`shared/grounding.ts`).
6. The open task is streamed with `conversation.watch()`. Each frame appends new
   entries and pushes the live state and the task's usage (`pi.usage`) to the
   window through `agent:event`.
7. `harness.watchTaskGraph()` supplies working state for the sidebar and the
   dock badge.
8. `conversation.abort()` stops a run; pi keeps what was committed. A stopped
   survey has already remembered every bucket it read.
9. pi compacts when the model's context window fills; compaction appears as a
   divider in the stream.
10. When a task settles, its requests, current verdict and findings are written
    to `search_docs` from the same `buildBrief()` projection the window uses,
    and the shell may send a notification. Tasks without rows are backfilled in
    the background at startup.

The window never receives `entry.model` (the provider-facing messages). The
mapper in `runtime/project.ts` projects entries into `UiEntry`, extracting only
the answer text and the tool details. `pi.user` entries (the harness's own
correction to the model) are not shown; `sa.continue` is a boundary, not a
question.

## One reading, one set of rules

`s3/facts.ts` reads a bucket once for the aspects asked for (security,
lifecycle, observability) and returns typed facts, each with its read status.
`readBucket()` reads the bucket's region first and switches to that region's
client when the account spans regions; every client follows region redirects.
`s3/policy.ts` evaluates the policy document locally, including whether it
denies plain HTTP. On AWS, `s3/account.ts` reads the account-wide block, `s3/metrics.ts` reads CloudWatch
capacity, `s3/changes.ts` diffs the last remembered posture and asks CloudTrail,
`s3/access.ts` reads policy/ACL/IAM/KMS/Access Analyzer and SCP grants with a
coverage count; `s3/permissions.ts` turns an access-denied read into the missing
action. They all feed the same facts. `estate/rules.ts` decides
the twelve rules (eleven per bucket, one per account) from facts by code; `survey` and `config` both apply the same
decisions to the estate and attach the observations (`bucket, code, verdict`)
to their view, which is how the brief knows a finding was proved fixed.

## Modules

| Module | Responsibility |
|---|---|
| `main/db.ts` | schema, migrations (`user_version`), typed queries |
| `main/providers.ts` | accounts (keys or AWS profile), regional S3 clients, profile list, connection test |
| `main/settings.ts` | `settings.json` (language, theme, notify, stale days, model, last task, last seen) |
| `main/model-catalog.ts` | provider model list and context-window inference |
| `main/updater.ts` | `electron-updater` against GitHub releases, packaged builds only |
| `main/security/vault.ts` | `safeStorage` or AES-256-GCM fallback |
| `main/security/redact.ts` | credential-shaped text removal, bounding |
| `main/runtime/model.ts` | pi-ai provider (Anthropic, OpenAI Responses, Chat Completions) and a one-shot test |
| `main/runtime/agent.ts` | prompt sections, guard hooks, grounding correction, estate digest |
| `main/runtime/harness.ts` | task lifecycle, model per run, watches, settle bookkeeping |
| `main/runtime/project.ts` | entries → `UiEntry`, live state, usage |
| `main/runtime/search.ts` | sidebar search, index rows |
| `main/tools/policy.ts` | `agentTool()`: scope, timeout, audit, envelope, status, details |
| `main/s3/facts.ts` | one reading per bucket, exposure, rememberable posture |
| `main/s3/policy.ts` | local policy evaluation, TLS enforcement |
| `main/s3/account.ts` | account-wide public access block (STS, S3 Control) |
| `main/s3/metrics.ts` | CloudWatch capacity, storage class mix, list-price estimate |
| `main/s3/access.ts` | policy/ACL/IAM/KMS/Access Analyzer/SCP access paths with coverage |
| `main/s3/changes.ts` | posture diff and paginated 90-day CloudTrail attribution |
| `main/s3/capabilities.ts` | provider capability matrix |
| `main/s3/permissions.ts` | read status → missing IAM action; read policy |
| `main/model-catalog.ts` | model list and context-window inference |
| `main/tools/query.ts` | code mode: read-only primitives, datasets, inventory, budgets |
| `main/demo/*` | demo storage answered in process through an SDK request handler |
| `main/local-models.ts` | Ollama and LM Studio detection on localhost |
| `main/estate/rules.ts` | twelve rules over facts, Security Hub controls, review findings |
| `main/estate/estate.ts` | applying decisions, gone buckets, Issue rows |
| `main/estate/fixes.ts` | fix formats and impact preview |
| `main/analysis/*` | import (bounded, redacted) and whitelisted aggregates |
| `main/app.ts` | service wiring, model install |
| `main/window-state.ts` | window bounds in `window.json`, clamped to a display |
| `renderer/Sidebar.tsx` | task list, ⌘K search, rename, inline delete |
| `renderer/Brief.tsx` | the brief, checks, focus, copy/save |
| `shared/brief.ts` | deterministic projection from entries to the brief, current state |
| `shared/grounding.ts` | names and exposure a task's results show; ungrounded and contradicted verdicts |

## Storage layout

```
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

## Deliberate absences

No event-sourcing layer, no second queue, no SSE, no report generator, no MCP
bridge, no skills loader, no subagents, no approval UI, no background watch, no
second window, no dashboard. pi owns the durable loop; the product owns storage semantics.
