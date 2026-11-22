# CLAUDE.md

> Implementation contract for **Storage Agent 43.0.0**. Read
> `docs/architecture.md`, `docs/product.md`, `docs/security.md`,
> `docs/data-model.md` and `docs/tools.md` before changing product structure.
> The code and its tests are authoritative; release notes, the changelog and
> `docs/v43.md` are history.

## The product

An agent that looks after the user's object storage and the cloud around it,
on their own machine. It reads, judges and says what it found; it keeps what
it learns in a workspace of its own; it works on a schedule when asked to
watch something; and it proposes changes that run only when the user approves
them. One window: tasks (conversations), Home (what the agent keeps in front
of the user), Settings.

> The app gives the agent a few general capabilities and the boundaries around
> them. Everything the user asks for — a watch, a board, a remediation, an
> estate map — is the agent composing those capabilities. The app decides
> nothing about the storage: no rules, no findings, no verdicts, no reports.

The test for every change: does it let a real user, on a real account, with a
real model (possibly small and local), get a correct answer or a correct
change, with no feature code written for that request?

## Hard boundaries

1. **The agent never changes storage itself.** Reads go through `call`/`query`
   (only operations named as reads, minus those that hand out credentials,
   `NEVER` in `s3/api.ts`). A write is a proposal (`change`), runs only when the
   user approves it in the window over IPC (`runtime/approvals.ts`), only on an
   account that allows changes, only from the reversible allowlist
   (`WRITABLE` in `changes.ts`), and always with a snapshot that can roll it
   back. Nothing the model writes or reads can approve.
2. **Secrets never reach SQLite in the clear, a prompt, a log or the window.**
   `security/vault.ts` alone opens one. A saved model key goes only to the
   provider and endpoint it was saved for (`Settings.keyFor`). Redaction runs on
   a whole result before it is kept or cut.
3. **Scope is authorization.** Every input member must be one the operation
   models (`checkInput`); on a scoped account a call names an in-scope bucket,
   is a bucket listing filtered to the scope, or reveals no bucket
   (`checkScope`); changes obey the same scope. `@` focus is not authorization.
4. **Data reaches the agent faithfully, as data.** Identifiers (account ids,
   key ids, ARNs, names) arrive as the service returned them; nothing is
   entity-escaped; each result is wrapped in an `<untrusted-data-<boundary>>`
   block text inside cannot close (`wrapUntrusted`). Workspace skills, memory
   notes and child answers are data too. Status comes from `details.status`.
5. **Unattended work is bounded.** A scheduled run stops at its token budget
   (default 100,000) unless the user opens it; it may notify once per run; it
   may propose a change but nothing runs until a person approves.
6. **The user's data survives upgrades.** The host schema migrates forward
   (`MIGRATIONS` in `db.ts`); a database from a newer version is refused, not
   cleared. The workspace is the user's: never cleared by the app.

## How the agent is built

7. **Parity.** What the user can do in the window, the agent can do with a tool
   or propose for approval (rename/pin its task, ask for scope or change
   permission, schedule, notify, pin a view, export a file).
8. **Primitives, not features.** Tools (`tools/registry.ts`): `call`, `query`,
   `probe`, `more`, `workspace`, `self`, `schedule`, `notify`, `change`,
   `delegate`, `ask`. Each tool's description is its contract; the prompt does
   not list tools or prescribe a workflow. A new capability is a primitive the
   agent composes, not a feature for one request. A new storage tool must say
   why `call` or `query` cannot do the job; a new service is a new SDK client in
   `s3/api.ts`.
9. **Expertise is data.** Bundled skills (`main/skills/*.md`) are listed by name
   and description and read with `more` (`skill:<name>`); skills in the
   workspace are listed as untrusted data and never replace a bundled one.
   Domain know-how goes into a skill, never into the prompt or a tool.
10. **The harness does not override the agent** when someone is watching: no
    round ceiling, no working budget, no fixed timeout. Defaults protect the
    machine and the agent can change them (`memory_mb`, `max_bytes`). The
    model's window decides compaction and result pieces (`compactionFor`,
    `pieceFor`); a window under 16,384 tokens is refused with how to fix it.
11. **The conversation shows what happened**, in order: messages, the agent's
    text and reasoning, every call with exactly what the agent received, a
    child's calls inside its `delegate` step, proposals with their decision.
    The app never writes into, rewrites or summarises the agent's answer.
12. **The app does not speak for the user.** Home has no canned prompts;
    Continue sends `Continue.`; an approval is reported to the agent as the
    user's own message.

## Architecture

One engine, one log, one projection (`docs/architecture.md`). pi-durable owns
the durable loop, timers and tasks: no event store, no second queue, no SSE,
no HTTP server.

- **Engine** (`runtime/engine.ts`): every turn is pi's durable loop; `submit`,
  `steer`, `stop`, `retry`, `continueTask`, `runScheduled`; each turn settles
  in `settle`. The task's model is resolved with its own key and window
  (`resolveTaskModel`).
- **Session** (`runtime/session.ts`): opens pi once with the one extension, its
  tools and the `sa.schedule` task.
- **Tasks** (`runtime/tasks.ts`): task list, the watched task, usage (children
  included), search, workspace and board for the window.
- **Scheduler** (`runtime/scheduler.ts`, `schedules.ts`): schedules, each a
  task plus a background pi task that sleeps until due.
- **Approvals** (`runtime/approvals.ts`, `changes.ts`): proposals, decisions,
  rollbacks.
- **Workspace** (`workspace.ts`): the agent's folder and `db.sqlite`; paths
  never leave it.
- **Calls** (`s3/api.ts`): one read of any bundled service, checked, scoped,
  shaped. `providers.ts` builds clients; `writeConfig` for approved changes.
- **MCP** (`mcp.ts`): `storage-agent --mcp` serves the read tools over stdio.
- **Window**: `Sidebar · conversation · Composer`, Home (`AgentSurface`: inbox,
  board, schedules) and Settings (Model, Storage accounts, Workspace,
  Appearance; close X top-left). Design tokens in `src/renderer/styles.css`;
  never a raw colour in a component. English by default; Chinese copy is
  written, not translated word by word.

## Data

Host tables in `storage-agent.db` (`db.ts`, baseline schema 22, current
**23**): `providers` (with `allow_changes`, `write_profile`), `audit`,
`task_meta`, `datasets`, `agent_tools` (legacy, emptied on import),
`search_docs` (+ FTS5), `schedules`, `changes`, `inbox`. pi's tables are
prefixed `pi_`. The workspace is `<data>/workspace/`; 42's `memory.sqlite`,
methods and user skills are imported once (`legacy.ts`). Deleting a task
purges its pi rows, host rows, datasets, audit rows and `tasks/<id>/`; the
workspace and schedules are not the task's.

## Commands

`npm run dev` · `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
· `npm run budget` · `npm run contrast` · `npm run audit` · `npm run sbom` ·
`npm run dist:dir` · `xvfb-run -a node scripts/e2e.mjs` ·
`xvfb-run -a node scripts/e2e-audit.mjs` · `xvfb-run -a node scripts/mcp-smoke.mjs` ·
`xvfb-run -a node scripts/eval.mjs --smoke` (or with `EVAL_*`) ·
`xvfb-run -a node scripts/bench.mjs --smoke` (or with `EVAL_*` and `--runs 3`:
the real-model gate, including the acceptance scenarios) ·
`xvfb-run -a node scripts/shots.mjs && node scripts/visual.mjs` ·
`STORAGE_AGENT_AWS_ENDPOINT=http://127.0.0.1:5055 npx vitest run src/main/compat.test.ts`
(with `moto_server -p 5055` running)

Never claim a check you did not run.
