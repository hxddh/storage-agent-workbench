# Architecture

## Processes

```text
Electron main                              Renderer (sandboxed)
  index.ts    window, menu, dock, links      App.tsx  state + layout
  app.ts      wiring, bootstrap     ⇄ IPC   Sidebar / Home / Run / Composer
  ipc.ts      the only IPC surface           Settings (lazy)
  preload     contextBridge, CJS
  harness     pi-durable tasks, entries, watches
  tools       read-only tools + plan/report/playbook
  estate      rules, Issues, change plans
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

## Runtime flow

1. `app.whenReady` opens the data directory and SQLite, builds `AppDb`,
   `Settings`, `Vault`, `Providers`, `Estate`, `Staging` and `AgentHarness`,
   registers IPC, then creates the window.
2. `harness.newTask()` creates one pi conversation per task and writes
   `task_meta`. A request-derived title is stored; a check gets an
   account-and-minute title.
3. Before a model run, `configure()` points the conversation at the stored model
   and its inferred thinking level. The run state (rounds, calls and names the
   task has read) is seeded from the task's entries, so old tasks use the model
   currently in Settings.
4. `submit` writes a `sa.user` entry and starts pi's generation task. A running
   call is projected from `pi.live.tools` (name, target, progress, start time).
   When it settles, the tool result becomes a `pi.tool-result` entry carrying
   `details` (`{ target, note, view, ms, status }`); the live row is replaced in
   place. `agentTool()` writes the status (`done`, `failed`, `refused`,
   `timeout`, `stopped`); the projection never parses result text for it.
5. Hooks guard the run. `beforeTool` blocks a repeated storage read and any
   call after the model tier's round budget (14 small, 24 mid, 32 large).
   `afterTool` records the names, exposure and evidence id a result shows.
   `onYield` asks once for a corrected answer when the report summary or final
   prose names something no result showed or contradicts what the readings
   proved (`shared/grounding.ts`). `plan`, `report` and `playbook` are control
   tools, not storage reads.
6. The open task is streamed with `conversation.watch()`. Each frame appends
   new entries and pushes live state and `pi.usage` to the window through
   `agent:event`.
7. `harness.watchTaskGraph()` supplies working state for the sidebar, dock badge
   and taskbar progress.
8. `conversation.abort()` stops a run; pi keeps committed entries. A stopped
   survey has already remembered every bucket it read, so a later survey
   continues with the unread remainder first.
9. pi compacts when the model context fills; a compaction entry appears as a
   divider. The model's provider-facing messages never reach the renderer.
10. When a task settles, its request, report summary, findings and evidence are
    written to `search_docs` from the same run/brief projection the window
    uses.
    A settled account reading also writes one `readings` row per account: the
    trigger, coverage counts, open totals and whether the read was complete.
    The row carries no request, answer, policy, account id or secret. The shell
    may send one notification if the window is in the background. Tasks without
    search rows are backfilled at startup.
11. `harness.audit()` is the deterministic path. `ipc.ts` creates the task,
    returns it immediately, and starts `audit()` in the background. `audit()`
    surveys every account, reads access evidence for up to 24 buckets per
    account, emits transient `audit` progress, and writes one `sa.audit` entry.
    The window expands that entry into ordinary checks and a synthesized run
    report (`shared/run.ts`) whose summary comes from `shared/audit.ts`. It
    never asks the model and uses the same run surface as a model task.
12. `harness.reverify()` replays the read operations for buckets the task
    touched and the buckets and account block in its latest change plan, up to
    50 buckets per account, and writes one `sa.reverify` entry. When a plan
    exists, `runtime/reverify-plan.ts` compares every step with the fresh
    decisions: confirmed only when all of its codes are clear, not applied when
    an Issue remains open or accepted, and unknown when the bucket or rule was
    not read. It never calls the model and never writes storage.

`Check again` creates a new task and runs the same deterministic path. A
model-free check is a snapshot; the estate remains the durable memory.

Memory history is a read of host rows, not a second store: `AppDb.listIssueEvents`
joins `issue_events` to `issues`, and `estate(history: true)` merges those rows
with `posture_changes` under the same `agentTool()` bounds, redaction and
untrusted-data envelope as every other tool result. It never reads raw requests
or `search_docs`.

Read closure is deterministic too. `buildBrief()` keeps account coverage across
a narrowed re-read instead of replacing it. `readStateOfBrief()` is the one
calculation used by the scope line, Home and the reading record; it says
`Reads complete` only when account coverage, pending reads, access evidence,
failed reads and undecided rules are closed. The agent keeps a per-run set of
the same coverage signals; a clean account claim while that set is non-empty
gets one correction. The scope line remains the source of truth on the page.
A model-free re-verification is always recorded as partial; only an unscoped
survey can produce a complete reading.

The window never receives `entry.model` (provider-facing messages). The mapper
in `runtime/project.ts` projects entries into `UiEntry`, extracting only answer
text and shaped tool details. `pi.user` entries (the harness's correction to
the model) are not shown; `sa.continue` is a boundary, not a question.

## One reading, one set of rules

`s3/facts.ts` reads a bucket once for the aspects asked for (security,
lifecycle, observability) and returns typed facts, each with a read status.
`readBucket()` reads the bucket's region first and switches to a regional client
when the account spans regions. `s3/policy.ts` evaluates a policy document
locally, including whether it denies plain HTTP. On AWS, `s3/account.ts` reads
the account-wide block, `s3/metrics.ts` reads CloudWatch capacity,
`s3/changes.ts` diffs posture and asks CloudTrail, and `s3/access.ts` reads
policy, ACL, IAM, KMS, Access Analyzer and SCP grants with coverage.
Identity grants are intersected with bucket-policy Denies and, when read, SCPs
and boundaries; object and bucket actions use their matching resource form;
ARNs are case-sensitive. An `AccessSession` shares account-wide IAM and SCP
reads across the buckets of one reverse query, re-verification or account check;
a standalone `config` call reads them for that call. `s3/permissions.ts` turns
an access-denied read into the missing IAM action.

These modules feed the same facts. `estate/rules.ts` decides the twelve rules
(eleven per bucket, one per account) by code. `survey` and `config` both apply
the same decisions to the estate and attach observations to their view, which
is how the run knows a finding was proved fixed.

**Access is evidence, not one merged authorization decision.** Policy and ACL
rows are grants; they are not intersected with every identity, SCP and condition
to produce a single allow/deny. Identity grants do get Deny/SCP/boundary
intersection. Conditions are reported, not evaluated. Coverage, unread sources
and truncation stay in the view.

## Modules

| Module | Responsibility |
|---|---|
| `main/db.ts` | schema, append-only migrations (`user_version`), typed queries including Issue events and reading records |
| `main/providers.ts` | accounts (keys or profile), regional S3 clients, profile list, connection test |
| `main/settings.ts` | `settings.json` (language, theme, notify, stale days, model, last task) |
| `main/model-catalog.ts` | provider model list and context-window/thinking inference |
| `main/updater.ts` | `electron-updater` against GitHub releases, packaged builds only |
| `main/security/vault.ts` | `safeStorage` or AES-256-GCM fallback |
| `main/security/redact.ts` | credential-shaped text removal, bounded views, envelope escaping |
| `main/staging.ts` | files waiting for their message |
| `main/runtime/model.ts` | pi-ai provider (Anthropic, OpenAI Responses, Chat Completions), saved and draft test |
| `main/runtime/agent.ts` | prompt sections, guard hooks, grounding and open-read corrections, estate digest |
| `main/runtime/harness.ts` | task lifecycle, model per run, watches, model-free audit, re-verify, reading records, purge |
| `main/runtime/reverify-plan.ts` | deterministic plan-step comparison for re-verification |
| `main/runtime/project.ts` | entries → `UiEntry`, live state, usage |
| `main/runtime/search.ts` | sidebar search and index rows |
| `shared/audit.ts` | deterministic account-check summary from survey views |
| `shared/brief.ts` | entries → deterministic evidence (findings, coverage, fixes, data) |
| `shared/run.ts` | plan + report blocks + evidence resolution + audit synthesis |
| `shared/grounding.ts` | names and exposure a task's results show; correction input |
| `main/tools/policy.ts` | `agentTool()`: scope, timeout, audit, envelope, status, details, evidence id |
| `main/tools/control.ts` | `plan`, `report`, `playbook` control tools |
| `main/s3/facts.ts` | one reading per bucket, exposure, rememberable posture |
| `main/s3/policy.ts` | local policy evaluation, TLS enforcement |
| `main/s3/account.ts` | account-wide public access block (STS, S3 Control) |
| `main/s3/metrics.ts` | CloudWatch capacity, storage-class mix, list-price estimate |
| `main/s3/access.ts` | policy/ACL/IAM/KMS/Access Analyzer/SCP grants with coverage |
| `main/s3/changes.ts` | posture diff and paginated 90-day CloudTrail attribution |
| `main/s3/capabilities.ts` | provider capability matrix |
| `main/s3/permissions.ts` | read status → missing IAM action |
| `main/tools/query.ts` | code mode: read-only primitives, datasets, inventory, budgets |
| `main/demo/*` | demo storage answered in process through an SDK request handler |
| `main/local-models.ts` | Ollama and LM Studio detection on loopback |
| `main/estate/rules.ts` | twelve rules over facts, Security Hub controls, review findings |
| `main/estate/estate.ts` | applying decisions, gone buckets, Issue rows |
| `main/estate/fixes.ts` | fix formats and impact preview |
| `main/analysis/*` | bounded import and whitelisted aggregates |
| `main/app.ts` | service wiring, model install, home overview |
| `main/window-state.ts` | window bounds in `window.json`, clamped to a display |
| `renderer/Sidebar.tsx` | task list, search, rename, pin, delete |
| `renderer/Home.tsx` | account summary, demo/local-model entry |
| `renderer/Run.tsx` | run header, plan, report blocks, evidence, copy/save/export |
| `renderer/Brief.tsx` | evidence body, checks, focus, findings |
| `renderer/Composer.tsx` | request, steer, stop, @ focus, files |
| `renderer/Settings.tsx` | model, accounts, memory, appearance, version |

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
pi-durable; the host tables are owned by this app. App deletes purge the task's
pi rows, host task rows, search rows, datasets, audit rows and task directory.

## Deliberate absences

No event-sourcing layer, no second queue, no SSE, no free-form report generator,
no MCP bridge, no skills loader, no subagents, no approval UI, no follow-up
prompts, no background watch, no second window and no dashboard. The agent
composes from a fixed block vocabulary; the app resolves every data block to a
tool result. pi owns the durable loop; the product owns storage semantics,
evidence and validation.
