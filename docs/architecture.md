# Architecture

## Processes

```text
Electron main                              Renderer (sandboxed)
  index.ts    window, menu, dock, links      App.tsx  state + layout
  app.ts      wiring, bootstrap     ⇄ IPC   Sidebar / Home / Run / Composer
  ipc.ts      the only IPC surface           Settings (lazy)
  preload     contextBridge, CJS
  runtime     session · engine · tasks · agent · check
  tools       read-only tools + plan/skill/ask
  estate      rules, assess (the only Issue writer), change plans
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

## One engine, one log, one reducer

Every run, whoever drives it, ends up as the same durable entries in the task's
pi conversation, and the window renders them through one reducer.

```text
             model run (pi loop)          scripted run (check / re-check)
                    │                                │
                    └──── same tool registry, same agentTool() ────┘
                                     │
                         durable entries in pi_entries
                                     │
                shared/ledger.ts  ── fold ──  shared/trace.ts
                 (coverage, calls,            (the run: request, plan, calls,
                  names, evidence)             validations, answer, findings)
                     │                                  │
          agent hooks, readings, search          the window
```

- **Model driver.** pi-durable's loop. The model plans, calls tools in parallel
  where it can, may publish a plan or ask one question, and writes the answer.
- **Script driver.** `Engine.check()` and `Engine.recheck()` call the same
  registered tools in a fixed order, through the same `agentTool()`, and write
  each call as an `sa.call` entry with the same shaped details a model call
  gets. Their answer is a template over what the calls returned
  (`runtime/check.ts`); it cites the survey's evidence id and passes the same
  validation as a model's answer. The answer entry also carries the calls'
  bounded, enveloped output as model context, so a question asked later in the
  same task can use, and cite, the check.
- **One settlement.** Both drivers settle in `Engine.settle()`: notices, the
  search index, reading records, the estate digest and the shell notification.

## Run state is derived, never held

`shared/ledger.ts` folds a task's entries into the current run's ledger: the
run boundary (latest request or scripted check), call keys and attempts, names
every finished result shows, evidence ids, coverage, blind spots, undecided
rules and access gaps. `readState()` turns it into the one read status used by
the scope line, the **Not checked** strip, Home and reading records.

The agent's hooks rebuild that ledger from durable entries
(`runtime/agent.ts` → `runView()`), so a restart or a resumed run has the same
guards as an uninterrupted one:

- `beforeTool` blocks an exact storage read that already finished in the run
  (by argument key, which `agentTool()` writes into the details), allows one
  retry after a failed read, treats two identical calls in one round as one,
  and stops every tool past the model tier's round budget (14 small, 24 mid,
  32 large). Rounds are counted from the assistant entries of the run.
- `onYield` sends at most one correction per run (`shared/validate.ts`): a
  backticked name no result showed, a citation that does not resolve to this
  run, or a paragraph that names something the run read without citing the
  result that shows it. The correction is a durable `pi.user` entry and a
  visible validation row. Whether the account was fully checked is never judged
  from the prose: the window states coverage from the ledger.

The tier comes from the model the conversation runs with (a task's own model or
the one in Settings), never from a global. Each model configuration is its own
provider in the shared pi-ai collection (`providerIdFor()`), so one task's model
never replaces another task's mid-run.

## Runtime flow

1. `app.whenReady` opens the data directory and SQLite, builds `AppDb`,
   `Settings`, `Vault`, `Providers`, `Estate`, `Staging`, then `Runtime` (pi,
   one extension, the tool registry), `Tasks` and `Engine`, registers IPC and
   creates the window.
2. `Tasks.newTask()` creates one pi conversation per task and writes
   `task_meta`. A request-derived title is stored; a check gets an
   account-and-minute title.
3. `Engine.submit()` installs the task's model for this run, configures the
   conversation, and submits an `sa.run` input (`trigger: 'user'`). A steer is an
   `sa.steer` input that joins a running run; with no run going it is a new
   request. Retry resubmits the run's request, never a steer. Continue is an
   `sa.resume` input: a row in the run, with a fresh round budget.
4. A running call is projected from `pi.live.tools`. When it settles, the result
   is a `pi.tool-result` entry whose `details` carry target, note, shaped
   progress, argument summary, view, duration, status, evidence id, argument key
   and what the rules did with the reading. Status is written by `agentTool()`;
   result text is never parsed for it.
5. A tool reads; it never writes an Issue. `agentTool()` hands each call an
   `Assessor` (`estate/assess.ts`), the only module that turns rule decisions
   into Issue transitions. The transitions are recorded on the call
   (`assessed`) and shown in its trace row.
6. The open task is streamed with `conversation.watch()`. A scripted run has no
   pi generation; its live slot (the running call and its progress) comes from
   the engine instead, through the same `live` event.
7. `watchTaskGraph()` plus the scripted runs supply working state for the
   sidebar, dock badge and taskbar progress.
8. Stop aborts a model run (pi keeps committed entries) or a scripted run (it
   ends with what it read). A stopped survey has already remembered every bucket
   it read; a later survey continues with the unread remainder first.
9. pi compacts when the model context fills; a compaction entry appears as a
   divider. Provider-facing messages never reach the renderer.
10. When a run settles, `searchRows()` (the same reducer) writes the task's
    requests, every run's answer and the findings to `search_docs`. A settled
    account survey writes one `readings` row per account; a re-check writes a
    partial row. Readings carry counts only: no request, answer, policy,
    account id or secret.

`Check account` and `Check again` create a new task and run a check. Re-check
runs in the current task as a new run: it replays every bucket the task read (by
account and aspect, up to 50 per account) and the buckets and account block of
its latest change plan, then compares every remembered conclusion and plan step
with what the fresh calls decided (`runtime/reverify-plan.ts`): confirmed only
when all of a step's codes are clear, not applied while an Issue is open or
accepted, unknown when a bucket or rule was not read. Neither path calls a model
or writes storage.

Memory history is a read of host rows: `AppDb.listIssueEvents` joins
`issue_events` to `issues`, and `estate(history: true)` merges those rows with
`posture_changes` under the same bounds, redaction and envelope as every other
tool result.

## One reading, one set of rules

`s3/facts.ts` reads a bucket once for the aspects asked for (security,
lifecycle, observability) and returns typed facts, each with a read status.
`readBucket()` reads the bucket's region first and switches to a regional client
when the account spans regions. `s3/policy.ts` evaluates a policy document
locally, including whether it denies plain HTTP. On AWS, `s3/account.ts` reads
the account-wide block, `s3/metrics.ts` reads CloudWatch capacity,
`s3/changes.ts` diffs posture and asks CloudTrail, and `s3/access.ts` reads
policy, ACL, IAM, KMS, Access Analyzer and SCP grants with coverage. Identity
grants are intersected with bucket-policy Denies and, when read, SCPs and
boundaries; object and bucket actions use their matching resource form; ARNs
are case-sensitive. One `AccessSession` per run shares account-wide IAM and SCP
reads across buckets (`ToolDeps.accessSessions`, cleared when the run settles).
`s3/permissions.ts` turns an access-denied read into the missing IAM action.

`estate/rules.ts` decides the twelve rules (eleven per bucket, one per account)
by code. `survey` and `config` pass the decisions to their `Assessor` and attach
the resulting observations to their view, which is how the run knows a finding
was proved fixed.

**Access is evidence, not one merged authorization decision.** Policy and ACL
rows are grants; they are not intersected with every identity, SCP and condition
to produce a single allow/deny. Conditions are reported, not evaluated.
Coverage, unread sources and truncation stay in the view.

## Modules

| Module | Responsibility |
|---|---|
| `main/runtime/session.ts` | pi harness, the one extension, tool registry, durable reads, tier, digest |
| `main/runtime/engine.ts` | model and scripted runs, steer/retry/continue/stop, settlement, readings |
| `main/runtime/check.ts` | what a check and a re-check read; their template answers |
| `main/runtime/tasks.ts` | task list, open task watch, task graph, search index, memory acts |
| `main/runtime/agent.ts` | prompt sections, hooks over the derived run view, estate digest |
| `main/runtime/project.ts` | entries → `UiEntry`, live state, sanitized reasoning, usage, rounds |
| `main/runtime/model.ts` | pi-ai providers (one per model configuration), saved and draft test |
| `main/runtime/reverify-plan.ts` | plan-step comparison for a re-check |
| `main/runtime/search.ts` | sidebar search over titles and index rows |
| `main/estate/assess.ts` | the only writer of Issue transitions |
| `main/estate/estate.ts` | read-only estate memory: Issue rows, posture |
| `main/estate/rules.ts` | twelve rules over facts, Security Hub controls, review findings |
| `main/estate/changes.ts` | change formats and impact preview |
| `main/tools/policy.ts` | `agentTool()`: scope, timeout, audit, envelope, status, details, key, evidence id, assessor |
| `main/tools/registry.ts` | the capability manifest and generated prompt section |
| `main/tools/control.ts` | `plan`, `skill` and `ask` |
| `main/tools/query.ts` | code mode: read-only primitives, datasets, inventory, budgets |
| `main/s3/*` | readers: facts, policy, account, metrics, access, changes, capabilities, permissions |
| `shared/contract.ts` | the one type contract |
| `shared/ledger.ts` | the run ledger and read status |
| `shared/validate.ts` | structural answer checks and the one correction |
| `shared/trace.ts` | the one reducer: current run, earlier runs, findings, search rows, Markdown |
| `shared/grounding.ts` | names a tool result shows |
| `renderer/Run.tsx` | run header, notices, clarify, answer/trace order, evidence, footer |
| `renderer/Answer.tsx` | answer Markdown, citations, marks, evidence peek |
| `renderer/Trace.tsx` | plan, reasoning, calls, validations, steer/resume/re-check rows |
| `renderer/Evidence.tsx` | **Findings** and **Not checked** strips |
| `renderer/EarlierRuns.tsx` | earlier runs of the task |

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
pi-durable; the host tables are owned by this app. Deleting a task purges its
pi rows, host task rows, search rows, datasets, audit rows and task directory.

## Deliberate absences

No event store of our own, no second queue, no SSE, no report DSL, no answer
tool, no in-memory run state, no prose classifier, no MCP bridge, no subagents,
no approval UI, no follow-up prompts, no automatic background watch, no second
window and no dashboard. pi owns the durable loop; the product owns storage
semantics, evidence and validation.
