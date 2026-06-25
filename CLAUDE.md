# CLAUDE.md

This repository implements **Storage Agent Workbench**, a local-first, Claude/Codex-like desktop application for object storage and S3-compatible systems.

The app supports:

- Object storage diagnostics
- Access log analysis
- Inventory and capacity analysis
- Bucket configuration review
- Optimization reporting

This is not a generic chat assistant. It is a task-oriented workbench built around **Analysis Runs**.

## Product shape

The UI should follow a Claude/Codex-like three-column workbench layout.

Left sidebar:

- Runs
- Providers
- Datasets
- Reports
- Settings

Main area:

- Current Analysis Run
- User input
- Agent plan
- Tool / Analysis Timeline
- Metrics cards
- Findings
- Report preview

Right context panel:

- Current Cloud Provider
- Bucket
- Endpoint
- Region
- Mode
- Allowed Prefixes
- Risk Policy
- Approval status

## Supported run types

The product should model work as Analysis Runs.

Initial run types:

- `diagnostic`
- `access_log_analysis`
- `inventory_analysis`
- `bucket_config_review`
- `optimization_report`

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
- Secrets: Python keyring / system Keychain
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

3. Store secrets only through system Keychain / Python keyring.

4. SQLite may store only secret references such as `keyring://scope/name`.

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

1. Keep the MVP simple.

2. Document before implementing major modules.

3. Follow the phase plan in `docs/roadmap.md`.

4. Do not use GitHub Issues as the project workflow.

5. Do not create `.github/ISSUE_TEMPLATE`.

6. Prefer phase branches or clear phase commits:

   - `phase/01-bootstrap`
   - `phase/02-providers`
   - `phase/03-s3-tools`
   - `phase/04-runs-timeline`
   - `phase/05-duckdb-analysis`
   - `phase/06-config-review`
   - `phase/07-agents-sdk`
   - `phase/08-packaging`

7. Each phase should end with:

   - Build or test results
   - A concise change summary
   - Known limitations
   - Next recommended phase

8. Do not continue into the next phase without explicit instruction.

## First-phase scope

For `phase/01-bootstrap`, only implement:

- Project skeleton
- Documentation
- Tauri + React/Vite shell
- Python FastAPI sidecar
- `GET /health`
- Frontend sidecar connected / disconnected status
- Basic CI for frontend build and sidecar import/test
- Small example files

Do not implement in Phase 01:

- Full Agent runtime
- S3 tools
- DuckDB analysis
- Keyring storage logic
- Provider CRUD
- Generic shell
- Destructive S3 operation

## Verification expectations

Before reporting completion, run the relevant checks for the current phase.

For Phase 01, verify at minimum:

- Frontend install/build works, or clearly document any environment blocker.
- Sidecar imports successfully.
- `GET /health` returns OK.
- Frontend can display sidecar connected / disconnected status.
- No generic shell tool exists.
- No plaintext secret storage exists.
- No destructive S3 API exists.
- No GitHub issue templates were created.

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
