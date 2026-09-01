# CLAUDE.md

> **Implementation contract for Storage Agent v1.04.0.**
>
> Before changing product structure, read `docs/README.md`, `docs/product.md`,
> `docs/architecture.md`, and `docs/security.md`. Current code and executable
> architecture tests are authoritative when historical docs or names disagree.

Storage Agent is a local-first desktop Agent for object storage and S3-compatible systems. It is not a generic chatbot, storage admin console, ticket system, or coding Agent.

The v1.04 product invariant is:

> **The Agent Task is the application.**

The canonical work model is:

> **Direction → Execution → Decision (when required) → Work Result → Artifact**

The user delegates work to one durable Agent Task, sees real runtime Execution, can Steer or Stop that same task, crosses explicit confirmation boundaries when necessary, and reviews durable Evidence/Execution/Report artifacts without leaving the Task.

## 1. Never regress the v1.04 native Agent

New product/frontend work must preserve these boundaries:

- **Agent Task** is the primary application object and primary work area.
- **AgentTaskNavigation** is a quiet chronological title list. Rename and Delete only. State is a row mark. New task is a button, not a painted shortcut chip.
- **AgentShell** owns the active task environment and overlay Review state. There is no task header, no live execution strip, and no second presentation mode.
- **AgentTask** is the public task boundary; persistence compatibility names stay behind adapters.
- **Composer** is the only Agent input: **Delegate** at rest, **Steer + Stop** while work is active. Attach + textarea + those actions. No persistent keyboard legend.
- **Direction** is user intent/steering input. Copy is the only Direction chrome.
- **Execution** is real runtime/tool work, shown as tool rows in the Task document. Never invent plans, steps, workers, or capabilities the runtime does not expose.
- **Decision required** is a blocking confirmation state derived from real backend proposals, with projected bounds/impact and a durable Decline path.
- **Work Result** is the durable result of Agent work, not a generic assistant bubble. Figures and provenance sit inside the latest Work Result. Working copy is Agent-native, not chat-era "still running" language.
- Review is a light overlay over the Task (Evidence, Execution detail, Report), opened from the document or ⌘I. It is not a 4-tab application destination, not a side-column application, and not a document hero. Cost simulation, Remediation Plans, baselines, Drift, and revisit schedules may exist as Sidecar engines; they have no product UI entry.
- Production UI must not teach a chat transcript: no `New chat` titles, no `thread.*` copy keys, no leftover `.thread-prose` layout layer.

Do not reconstruct earlier chat/investigation/workbench information architecture from old release notes, database names, API names, or git history. Historical `session` and `run` terminology is compatibility vocabulary, not a reason to change current product semantics.

The executable frontend guards under `frontend/src/agent/` are part of this contract. If an intentional architecture replacement is needed, change the code, tests, and canonical docs together in one PR.

## 2. Runtime architecture

The shipped desktop stack is fixed unless explicitly changed:

- Desktop shell: **Tauri v2**.
- Frontend: **React 19 + Vite + TypeScript + Tailwind CSS**.
- Local backend: **Python + FastAPI + Uvicorn** Sidecar.
- Agent runtime: **OpenAI Agents SDK for Python**.
- S3-compatible access: **boto3 / botocore**.
- Analytical compute: **DuckDB + PyArrow + pandas**.
- Application metadata: **SQLite** with append-only migrations.
- Secret storage: **AES-256-GCM encrypted local vault** through `security/keyring_store`.
- Streaming: **Server-Sent Events (SSE)**.
- Packaging: **PyInstaller one-dir Sidecar** embedded as a Tauri resource.

Topology:

```text
Tauri desktop shell
        │
React Agent UI
        │ localhost HTTP / SSE + per-launch auth token
Python Sidecar
        │
        ├── model endpoint configured by the user
        └── S3-compatible storage configured by the user
```

The frontend never receives cloud/model secret values. The Sidecar resolves secret references server-side.

## 3. One real Agent, deterministic compute beneath it

There is one model-driven Agent runtime: the durable task/session Agent implemented under `sidecar/app/agent_runtime/`.

It may invoke explicit read-only storage tools, StorageOps skills, bounded file-analysis tools, deterministic account/config analysis, and report/evidence workflows. The model drives the investigation; deterministic engines remain the security/reproducibility floor for operations that should not expose raw analytical rows to the model.

Do not add a second planner/narrator Agent, hidden orchestration Agent, or simulated multi-agent UI. If the runtime does not implement a capability, the UI must not pretend it exists.

Historical persistence still stores task work in `sessions`, `session_messages`, `runs`, `tool_calls`, evidence tables, and report artifacts. Product adapters project those records into Agent Task / Direction / Execution / Work Result / Review semantics.

## 4. Task state and execution truth

Task state must be derived from real runtime and durable state, not visual guesses.

Current product states include:

- **Ready to delegate** — no active Task.
- **Ready** — durable Task available for another Direction.
- **Working** — real execution is active.
- **Needs decision** — current durable or live work has a confirmation-gated action.
- **Needs attention** — execution/provider/runtime requires user intervention.
- upload/preparation state where applicable.

Since v0.94 the Agent Task and its Executions are DURABLE domain objects owned by the Sidecar's task runtime (`sidecar/app/task_runtime/`):

- an Execution is a `task_executions` row with lifecycle `queued` / `running` / `waiting` / `completed` / `failed` / `cancelled` / `interrupted`, driven by a background execution supervisor keyed by durable task identity — never by an HTTP request;
- execution progress is the append-only structured `execution_events` log (status, tool started/completed, steer received/applied, decision opened/resolved, work result recorded), replayable by sequence number; never inferred from assistant prose;
- Steer acts ON the current execution (injected into the running model loop), never cancel-and-rerun; Stop persists the partial Work Result durably;
- UI disconnect, task switching, and reload never interrupt an execution; a Sidecar restart stamps in-flight executions `interrupted` and the Task presents an explicit **Resume** action that starts a new Execution and follows its event stream;
- a Direction submitted while another Execution is running is **queued durably** and must be visible/cancellable in the Task;
- dropped event streams reconnect with `after=<last seq>` only — never a blocking `/sessions` POST or assistant-id poll;
- Decision (`task_decisions`), Work Result (`work_results`), Artifact (`task_artifacts`), and the typed versioned Storage Task Context (`task_context_versions`) are first-class durable rows;
- the latest typed context version is injected into the Agent prompt's stable half so restart grounding matches the pre-restart snapshot;
- deterministic cross-evidence correlation produces bounded findings through existing summary/findings/memory channels;
- deterministic cost/lifecycle simulation, Remediation Plans, baselines/Drift, and per-task revisits remain Sidecar engines on this same runtime — never a second Agent, a second submit path, or a Settings/Review destination;
- Verify (`kind=verify`) and scheduled revisits (`kind=revisit`) remain runtime paths; the UI does not paint a Verify control or a revisit scheduler. The user asks in Composer. Revisits are read-only and never auto-resolve a Decision;
- `execution_events` retention is a periodic SQL-set prune (terminal executions only, dual cap, explicit `execution.events_truncated` marker; `0` disables). Active and waiting logs are never touched;
- at most one pending Decision exists per `(task, action_type)`; a later proposal of the same type supersedes the earlier pending row.

The execution runner is the one submission lifecycle: submit a Direction as a durable execution, follow its durable event stream (reconnect by sequence), steer/stop/resume/verify the current execution, then reload persisted task state. The legacy `/sessions` message endpoints are compatibility shims over this runtime. Do not create a second submit path.

## 5. Current Sidecar API boundary

The Sidecar exposes both product projection and compatibility APIs:

- `/agent-tasks` is the product-level task surface: the task list (with durable decision/lifecycle state) plus the runtime API — executions (submit / steer / stop / resume / SSE event stream resumable by sequence), Verify (`POST .../verify`, kind=`verify`), queued visibility, decisions (list / resolve with impact projection), work results, artifacts, **read-only provenance** (`GET .../provenance`), remediation plans, baselines, revisit schedule, and the typed task context. Engine endpoints are not product destinations.
- `/sessions/...` remains the durable task/message/runtime compatibility API.
- `/runs/...` remains deterministic execution/report compatibility API and is not a top-level product surface.
- `/evidence-imports/...` owns bounded plan → confirm → execute data movement.
- `/model-providers`, `/cloud-providers`, `/settings` (including the local price-table **engine** API; Settings UI does not edit it), `/tools`, `/error-triage`, `/reports`, and dataset endpoints keep their existing responsibilities.

Do not rename persistence/API contracts just for cosmetic consistency if that adds migration risk. Adapt them at explicit boundaries instead.

## 6. Non-negotiable security rules

1. Never place cloud access keys, secret keys, session tokens, model API keys, Authorization headers, cookies, signatures, or presigned credentials in model prompts.
2. Never persist plaintext secrets in SQLite, logs, reports, traces, screenshots, local JSON/YAML, or frontend state.
3. Store secrets only through `security/keyring_store`; SQLite stores opaque `keyring://...` references only.
4. Do not introduce a generic shell, raw subprocess, raw boto3 client, unrestricted filesystem tool, terminal, browser/computer-control tool, or arbitrary SQL tool for the Agent.
5. Storage operations are read-only in the shipped product. There is no destructive/mutating S3 tool.
6. Provider bucket/prefix scopes are enforced server-side.
7. Read-only diagnostic work may run autonomously; data-moving or materially large/full-scan operations must cross an explicit confirmation boundary.
8. Tool inputs/outputs, Evidence, audit rows, reports, and model context must be sanitized and bounded.
9. Raw access-log/inventory rows do not enter model context. Deterministic analysis produces bounded aggregates/findings.
10. Chain-of-thought is never persisted, exposed, or modeled as an Artifact.
11. Capability gaps on S3-compatible providers are represented explicitly (`provider_unsupported`) rather than fabricated as success or collapsed into unrelated errors.
12. Missing Evidence stays a gap/uncertainty. Never manufacture evidence to complete a narrative.

See `docs/security.md` for the full contract.

## 7. Tool contract

Agent tools are explicit, typed, whitelisted, bounded, and sanitized. Current capability classes include:

- credential/reachability/addressing/TLS diagnostics;
- bucket/object metadata inspection;
- bounded object listing, versions, multipart and object-lock/ACL/tag/attribute inspection;
- bounded Range/conditional/preview probes and request-latency measurement;
- pure presigned-URL diagnosis;
- account discovery and bucket configuration review;
- local uploaded inventory/access-log analysis;
- managed Evidence Import through a confirmation gate;
- deterministic cost/lifecycle simulation over bounded inventory aggregates and a local price table (estimates always carry coverage; missing inventory or an unconfirmed price table is an explicit gap);
- typed Remediation Plan artifacts with read-only Verify executions;
- versioned baselines and Drift reports;
- optional per-task read-only revisit schedules submitted through the existing runtime path;
- task memory/evidence lookup and deterministic report generation.

Do not infer tool availability from a documentation example. `docs/tools.md` and the registered runtime tool set must agree with code.

## 8. Data ownership

SQLite stores application metadata and durable task/execution records. Current migrations are append-only through **027**; never edit a shipped migration, append a new one.

DuckDB/local files store analytical data and large inputs/artifacts. User data lives under the application data directory, never the install directory.

Product-to-persistence mapping:

| Product | Durable runtime (v0.94) | Compatibility persistence/API |
| --- | --- | --- |
| Agent Task | `agent_tasks` | `sessions`, `/sessions/...`, `/agent-tasks` |
| Direction | execution direction + steer events | `session_messages` (user rows) |
| Execution | `task_executions` + `execution_events` | `runs`, `session_runs`, `tool_calls`, turn metrics |
| Work Result | `work_results` | `session_messages` (assistant rows) |
| Decision | `task_decisions` | persisted proposed actions + approval/evidence-import state |
| Evidence / Artifact | `task_artifacts` index (`report`, `evidence_import`, `analysis`, `remediation_plan`, `baseline`, `drift_report`) | evidence references/imports, reports, local artifact files |
| Remediation Plan | `remediation_plans` | indexed via `task_artifacts` |
| Baseline / Drift | `task_baselines` + `drift_report` artifacts | — |
| Revisit schedule | `task_revisit_schedules` | submitted as `task_executions.kind=revisit` |
| Price table | `storage_price_table` (ordinary config, not a secret) | `/settings/price-table` |
| Storage Task Context | `task_context_versions` | — |
| Task memory | — | session summaries/findings/agent memory |

See `docs/data-model.md`.

## 9. Product and design rules

- Optimize the first viewport for: **what is the Task, what is happening/what was produced, what can the user do now**.
- The Task is a **document**: one reading column, figures inline in the Work Result. Artifacts open from the document.
- Composer is the only start surface. An empty window is the Composer. Missing model is a banner plus Settings. The model discovers tools; there is no slash SKU catalog and no first-run wizard.
- Settings is **model + storage credentials + language/theme**. There is no price-table spreadsheet.
- Keep settings/provider/model selection secondary to delegated work.
- Keep technical results readable as documents: prose, tables, code/config, structured errors, tool rows, provenance.
- Use progressive disclosure for execution detail; do not turn the main Task into a permanent observability wall.
- Preserve accessibility, contrast, responsive/narrow-window behavior, English/Chinese parity, and real-state visual review.
- Do not copy another Agent client's chrome without matching runtime semantics.

## 10. Explicit non-goals (with conditional native-agent extensions)

The following remain non-goals until a real runtime and safety contract
exists. **Additive, gated extensions** that reuse the durable runtime and
the same security floor are permitted as opt-in and do not require a full
product/runtime rewrite:

- **Still non-goals:** multi-agent orchestration (single-agent fanout via
  `_MAX_PARALLEL_TOOLS=6` is the bounded alternative), coding
  projects/worktrees, synthetic plans/checklists not emitted by the runtime,
  generic terminal/browser/computer control, workflow canvas,
  LangGraph/LiteLLM/Langfuse/n8n as new architectural dependencies,
  Postgres/Redis for the local desktop product, destructive storage repair or
  mutation, a top-level page for every backend table, multi-user SaaS/RBAC
  semantics.
- **Gated extensions (since post-1.02 modern native-agent work):**
  - `STORAGE_AGENT_DATA_DIR/skills/*/SKILL.md` + `STORAGE_AGENT_SKILLS_DIR`
    user skills (markdown guidance only, shadows bundled by name, bounded,
    never executed) — `GET /skills`;
  - local model providers (`ollama`, `lmstudio`, `vllm`, `llama.cpp` and
    `openai-compatible` without a stored key, localhost defaults, dummy
    `not-needed` bearer) — same probe and budgeting as cloud models;
  - read-only MCP bridge (`STORAGE_AGENT_ENABLE_MCP=1`,
    `GET /mcp/tools` + `POST /mcp/tools/call` over the whitelisted read-only
    tool set, same scope/redaction/bounds);
  - observability export (`GET /agent-tasks/{id}/export/otel` +
    `GET /observability/export`, bounded, sanitized, no new tables);
  - Tauri OS shell (`dialog`, `notification`, `opener`, `deep-link`,
    `global-shortcut`, `updater` — inert until signing/pubkey is configured).

Every extension preserves: read-only storage tools, no generic shell/
arbitrary subprocess, secrets only in the encrypted vault, server-side
provider scope, explicit Decisions for data movement, bounded/sanitized
context, and no chain-of-thought persistence.

## 11. Development workflow

Work from `main` in focused PRs. GitHub Issues are not the project workflow unless explicitly requested.

For architecture or behavior changes:

1. Inspect current implementation and regression tests first.
2. Update the relevant canonical docs in the same PR.
3. Preserve compatibility adapters unless migration is part of the requested change.
4. Add or update executable architecture/regression tests for boundaries that matter.
5. Validate the real rendered/runtime state rather than reasoning only from component code.

## 12. Verification expectations

Run the checks relevant to the change and never claim checks you did not execute.

Minimum repository gates represented in CI include:

- frontend TypeScript typecheck/lint;
- frontend Vitest unit + architecture/documentation contracts;
- frontend production build;
- Python Sidecar tests;
- packaged Sidecar smoke;
- real-Sidecar Playwright E2E;
- visual-review capture from asserted real states;
- macOS Apple Silicon, Linux x64, and Windows x64 desktop build/runtime verification.

For local focused work, at minimum run the directly affected test suites; before release, use the release/smoke documentation and CI matrix.

## 13. Documentation discipline

`docs/README.md` defines documentation precedence. Release notes, CHANGELOG entries, and historical rebuild docs are descriptive history and may contain retired vocabulary. Never use them as the primary architecture specification for current implementation.

When reporting completion include:

- what changed;
- what contract/behavior it changes or preserves;
- what checks actually ran and their result;
- what was not run;
- known gaps or follow-up work.

Never claim a check passed unless it actually ran.
