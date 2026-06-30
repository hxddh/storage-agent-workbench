# CLAUDE.md

This repository implements **Storage Agent Workbench**, a local-first, Claude/Codex-like desktop application for object storage and S3-compatible systems.

The app supports:

- Object storage diagnostics
- Access log analysis
- Inventory and capacity analysis
- Bucket configuration review (security / lifecycle / observability / cost)

This is not a generic chat assistant. The **primary surface is a thread-first
conversational agent** (a real tool-calling loop over read-only tools); structured
**Analysis Runs** are a callable, auditable capability beneath it.

## Agent architecture (how the LLM is used)

There is exactly **one** LLM in the product: the conversational session agent.
Everything else is deterministic compute it invokes. The old dual-track design
(a second "run-planner" LLM, in-run interpretation narrators, a `planner_mode`
switch) was eliminated in v0.20.0 — do not reintroduce it.

1. **Conversational session agent** (the only agent, `agent_runtime/session_agent.py`).
   A genuine tool-calling agent: it chooses provider/bucket, calls read-only S3
   tools in a loop, loads StorageOps skills on demand (progressive disclosure via
   the `read_skill` tool), and grounds answers in tool output. It is **always a
   fully autonomous read-only investigator — there is no autonomy toggle.** It
   diagnoses connectivity/credential/addressing problems adaptively
   (`test_credentials` → addressing/TLS/head-bucket/list/range) and explains the
   root cause; it analyzes a file the user **attaches in the conversation** with
   read-only `list_uploaded_files` / `analyze_uploaded_file`
   (`agent_runtime/session_analysis_tools.py`, same DuckDB engine, sanitized
   aggregates only); it runs the heavier read-only `survey_account` /
   `review_bucket_config` tools (`agent_runtime/session_action_tools.py`) when
   the request is about the account/buckets; and it picks up a backgrounded run's
   result in a later turn with `read_run_result`. Crucially, **nothing the agent
   does in a conversation surfaces as a structured run card** — those tools
   record runs with `origin='agent'` that the thread filters out; the agent
   narrates the result inline.

   Security tiers are enforced in code regardless: EXPENSIVE/data-moving work
   (cloud evidence import/download, large/full scans) is never auto-run — it
   stays a confirmed proposal — and there is no write/destructive tool in the
   product at all. A *file the user attached* is local, so analyzing it inline is
   not data-moving and needs no confirmation.

2. **Deterministic compute layer** (`runs/`, dispatched by `run_service.py`) —
   the agent-invoked **security/reproducibility floor**, NOT a user-facing fixed
   pipeline and NOT a second agent. These executors are **pure deterministic
   compute — there is no LLM planner and no in-run narrator.** The conversational
   agent (surface 1) is the sole driver: no UI path creates a run, executors
   publish only their real tool trace, findings, and summary (no canned step
   "plan", no agent-written prose section), and the agent narrates the result in
   its own words. This layer survives for one reason — it is the security floor:
   - **deterministic engines** (rule-based, no LLM) compute heavy aggregates so
     the model never touches raw rows — e.g. the DuckDB analysis behind the
     agent's `analyze_uploaded_file` tool, `diagnostic`, `account_discovery`,
     `bucket_config_review`, and error triage.

   A "run" is an agent-invoked tool and/or an opt-in **auditable report
   artifact** — never a reflex the UI fires or a canned plan the agent is marched
   through. Reproducible runs + the deterministic floor are kept because the
   non-negotiable security rules require them (no raw rows to the model, bounded
   scans, confirmed data-moving); they are not a second "surface" the user
   navigates.

The session agent builds its model client through `agent_service.build_agent`
(per-session client; never the SDK process-global).

## Product shape

The UI follows a **thread-first agentic workbench** (Codex-style), not a tabbed
admin panel. As of the v0.19.0-pre.2 rebuild:

- **Slim session rail** (left): "+ New investigation", the session list, and a
  settings + sidecar-status footer. No top-level Runs/Datasets/Reports tabs.
- **Conversation thread** (center, dominant) with a **sticky composer**. The
  composer has two modes: "Ask the agent" (session message) and "Triage an
  error" (offline, no credentials). Messages, analysis runs, error-triage cases,
  and next-action proposals all render as **inline cards** in the thread; a run
  card expands in place to the full run transcript.
- **Settings drawer** (right slide-over) embeds model- and cloud-provider
  management; a one-time **first-run wizard** appears on a fresh install.

> Historical note: earlier phases used a three-column layout (left sidebar
> Runs/Providers/Datasets/Reports/Settings + main analysis-run area + right
> context panel). That shell was retired in the pre.2 rebuild — do not restore
> it. The underlying concepts below (Analysis Runs, run types, providers) are
> unchanged; only the presentation moved into the thread.

## Supported run types

The deterministic compute layer models heavy work as Analysis Runs that the
agent invokes.

Run types:

- `diagnostic`
- `access_log_analysis`
- `inventory_analysis`
- `bucket_config_review`
- `account_discovery`

## Fixed MVP stack

Use the following stack unless explicitly instructed otherwise:

- Desktop: Tauri v2
- Frontend: React + Vite + TypeScript
- UI: Tailwind CSS
- Backend sidecar: Python + FastAPI + Uvicorn
- Agent runtime: OpenAI Agents SDK Python
- S3 SDK: boto3 / botocore
- Local analysis engine: DuckDB + PyArrow + pandas
- App metadata storage: SQLite
- Secrets: AES-256-GCM encrypted local vault (`security/keyring_store`), key protected per-OS (DPAPI / `0600` key file)
- Streaming: Server-Sent Events
- Packaging: Python sidecar via PyInstaller, launched by Tauri sidecar

## Explicitly out of scope for MVP

Do not introduce these unless explicitly requested:

- LangGraph
- MCP runtime
- LiteLLM
- Langfuse
- n8n
- Postgres
- Redis
- Multi-agent orchestration
- Workflow canvas
- Plugin marketplace
- Generic shell execution
- Destructive S3 operations
- GitHub Issues as the project workflow

## Non-negotiable security rules

1. Never pass cloud access keys, secret keys, session tokens, model API keys, or credentials into LLM prompts.

2. Never store plaintext secrets in SQLite, logs, reports, traces, local JSON files, local YAML files, screenshots, or UI state.

3. Store secrets only through `security/keyring_store` — a single AES-256-GCM
   **encrypted vault** (`secrets.enc` + master key in `secrets.key`) in the app
   data dir, behind the unchanged `make_ref/parse_ref/save_secret/get_secret/
   delete_secret` API. The master key is protected by the strongest *non-
   prompting* mechanism per OS: DPAPI (current-user) on Windows, an `O_EXCL`
   `0600` key file on macOS/Linux. This is deliberately **not** the OS keychain:
   the app is ad-hoc-signed and cross-platform, and the keychain re-prompts on
   every update (macOS) or is absent/prompts on headless Linux. Do not move
   secrets back into the keychain (or into SQLite/files in plaintext) — and keep
   it prompt-free. (A stable Developer-ID signature could later re-enable the
   keychain on macOS with no prompts.)

4. SQLite may store only secret references such as `keyring://scope/name` (the
   `keyring://` scheme is a stable opaque ref; storage is the vault, not the OS
   keyring).

5. Do not implement a generic shell execution tool.

6. All cloud operations must go through explicit whitelist tools.

7. Do not implement destructive S3 operations in the MVP.

8. The following operations are forbidden in MVP:

   - `DeleteBucket`
   - `PutBucketPolicy`
   - `PutBucketAcl`
   - `PutLifecycleConfiguration`
   - `DeleteObjects`
   - Recursive delete
   - Mass object mutation
   - Any bucket-wide destructive or mutating operation

9. Default cloud provider mode is `readonly`.

10. `test-write` mode may only write under explicitly allowed test prefixes, such as:

   - `tmp/agent-test/*`
   - `diagnose/*`

11. Analysis tasks must not download object bodies by default.

12. Large bucket scans must require one of:

   - `max_objects`
   - Prefix limit
   - Explicit user approval

13. Full bucket scan must require explicit user approval.

14. All tool inputs and outputs must be sanitized before persistence.

15. Logs, reports, traces, database rows, and UI output must redact:

   - Access keys
   - Secret keys
   - Session tokens
   - API keys
   - Authorization headers
   - Signatures
   - Presigned URL credentials
   - Sensitive query parameters
   - Cookies
   - Bearer tokens

16. Reports should show at most 20 sample object keys by default.

17. All tool calls, analysis SQL, data imports, approvals, and report generation events must be recorded in audit logs.

18. Provider capability gaps must be represented as `Provider unsupported`, not as hard failures, when working with S3-compatible providers.

## Tooling rules

Agent-accessible tools must be explicit, typed, and whitelisted.

Allowed MVP tool groups:

### Diagnostic tools

- `test_credentials`
- `head_bucket`
- `list_objects_v2`
- `head_object`
- `test_range_get`
- `test_path_style_vs_virtual_host`
- `inspect_tls`

### Access log analysis tools

- `detect_log_format`
- `import_access_logs`
- `analyze_access_logs`

### Inventory and capacity analysis tools

- `import_inventory_file`
- `analyze_inventory`
- `sample_bucket_objects`

### Bucket config review tools

- `get_bucket_config_summary`
- `review_bucket_security`
- `review_bucket_lifecycle`
- `review_bucket_observability`
- `review_bucket_cost_optimization`
- `review_bucket_performance_profile`

### Report tools

- `generate_markdown_report`

Do not expose raw boto3 clients, raw subprocess calls, raw shell commands, or unrestricted filesystem access to the Agent.

## Data ownership

Use SQLite for application metadata:

- Providers
- Runs
- Messages
- Tool calls
- Audit logs
- Approval events
- Dataset metadata
- Report metadata

Use DuckDB for analytical data:

- Access logs
- Inventory files
- Bucket object metadata samples
- Derived analysis tables

Use local files for large raw inputs and generated reports:

- `data/runs/{run_id}/raw/`
- `data/runs/{run_id}/analysis.duckdb`
- `data/runs/{run_id}/report.md`

## Development workflow

> Historical note: the project was built in phases (bootstrap → providers → S3
> tools → runs → DuckDB → config review → Agents SDK → packaging). All of those
> shipped; the phase plan and `phase/NN-*` branch scheme are history, not current
> process. Work now lands as focused PRs cut from `main`.

1. Keep changes simple and focused; one concern per PR.
2. Document before implementing major modules.
3. Do not use GitHub Issues as the project workflow; do not create
   `.github/ISSUE_TEMPLATE`.
4. Releases are cut by dispatching the `Release` workflow against a tag; the
   version is stamped from the tag (see `docs/release.md`).

## Verification expectations

Before reporting completion, actually run the relevant checks:

- `cd sidecar && pytest -q` (full suite passes).
- `cd frontend && npm run build` and `tsc --noEmit` are clean.
- The security invariants still hold (see the rules above): no generic shell, no
  plaintext secrets, no destructive S3 op, secrets resolved only server-side and
  never placed in an LLM prompt.

Never claim a check passed unless it was actually run.

## Review expectations

When summarizing work, include:

- What changed
- How to run it
- What checks were run
- What passed
- What failed or was not run
- Known gaps
- Recommended next phase

Never claim a check passed unless it was actually run.
