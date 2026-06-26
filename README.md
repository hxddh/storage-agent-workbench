# Storage Agent Workbench

A local-first, Claude/Codex-like desktop workbench for object storage and S3-compatible diagnostics and analysis.

## Goal

Storage Agent Workbench helps storage engineers, SREs, data infrastructure engineers, and developers analyze object storage systems.

MVP target:

- Diagnostic runs
- Access log analysis
- Inventory and capacity analysis
- Bucket configuration review
- Markdown reports

This is not a generic chat assistant. It is a task-oriented workbench built around Analysis Runs.

## Fixed stack

- Desktop: Tauri v2
- Frontend: React + Vite + TypeScript
- UI: Tailwind CSS
- Backend sidecar: Python + FastAPI + Uvicorn
- Agent runtime: OpenAI Agents SDK Python
- S3 SDK: boto3 / botocore
- Analysis engine: DuckDB + PyArrow + pandas
- App metadata: SQLite
- Secrets: Python keyring / system Keychain
- Streaming: Server-Sent Events

## Phase 01 status

Implemented in Phase 01:

- Project skeleton
- Documentation
- Tauri / React / Vite shell
- Python FastAPI sidecar
- `GET /health`
- Sidecar status in UI
- Basic CI
- Example files

## Phase 02 status

Implemented in Phase 02 (`phase/02-providers`):

- Local data layer: SQLite initialization + migration runner
- All app-metadata tables (`model_providers`, `cloud_providers`, `runs`,
  `messages`, `tool_calls`, `approval_events`, `audit_logs`, `datasets`,
  `reports`)
- Python `keyring` wrapper (`save_secret` / `get_secret` / `delete_secret`)
- Secret-redaction utility (with tests)
- Model provider CRUD + test endpoint
- Cloud provider CRUD
- Frontend Model Providers / Cloud Providers pages

Secrets are stored only in the system Keychain via `keyring`. SQLite stores
only `keyring://...` references. API responses and logs never echo plaintext
secrets.

## Phase 03 status

Implemented in Phase 03 (`phase/03-s3-tools`):

- Whitelisted, **read-only** S3-compatible tool layer (boto3/botocore):
  `test_credentials`, `head_bucket`, `list_objects_v2`, `head_object`,
  `test_range_get`, `test_path_style_vs_virtual_host`, `inspect_tls`
- Cloud Provider **Test Connection** runs a real read-only credential check
- Every tool call is recorded in `tool_calls` + `audit_logs`, sanitized
- Frontend Tool Result Card + per-provider Test Connection panel

Read-only guarantees: no PutObject/DeleteObject/DeleteObjects/DeleteBucket/
PutBucketPolicy/PutBucketAcl/PutLifecycle, no generic shell, no subprocess.
`list_objects_v2` requires `max_keys` (hard-capped at 1000, ≤20 sample keys);
`test_range_get` requires a bounded Range (≤4 MiB) and never downloads full
objects; `inspect_tls` uses Python `ssl`/`socket` (no `openssl` shell-out).

Tool endpoints (all `POST`): `/cloud-providers/{id}/test`,
`/tools/test-credentials`, `/tools/head-bucket`, `/tools/list-objects-v2`,
`/tools/head-object`, `/tools/test-range-get`,
`/tools/test-path-style-vs-virtual-host`, `/tools/inspect-tls`.

## Phase 04 status

Implemented in Phase 04 (`phase/04-runs-timeline`):

- **Analysis Runs** with a deterministic (rule-based) planner — no LLM, no
  OpenAI Agents SDK. Only `diagnostic` runs execute; the other run types are
  created as `not_implemented` placeholders.
- A diagnostic run drives the Phase 03 read-only tools (`test_credentials`,
  `head_bucket`, `list_objects_v2` with bounded `max_keys`) through the shared
  tool runner, attaching every `tool_calls` / `audit_logs` row to the `run_id`.
- **Server-Sent Events** stream `agent_plan`, `tool_call_started/finished`,
  `agent_message`, `finding`, `report_ready`, and `error` (in-memory bus; no
  Redis/Celery/queue — best-effort, local-only).
- A local Markdown report is written to `data/runs/{run_id}/report.md` and
  referenced from the `reports` table.
- Frontend: Runs list, New Run form, Run Detail (plan + Tool Timeline + findings
  + report preview + status), and a Reports view.

Run/report endpoints: `GET/POST /runs`, `GET /runs/{id}`,
`POST /runs/{id}/message`, `GET /runs/{id}/events` (SSE), `GET /reports/{id}`.

Reports never contain secrets; SSE events and tool outputs are sanitized;
`list_objects_v2` is bounded (not a full scan) and no object bodies are
downloaded.

## Phase 05 status

Implemented in Phase 05 (`phase/05-duckdb-analysis`):

- **DuckDB / PyArrow / pandas** local analysis engine. Each run gets its own
  `data/runs/{run_id}/analysis.duckdb`; SQLite still holds only app metadata.
- `access_log_analysis` runs: `detect_log_format` → `import_access_logs`
  (JSONL / text / CSV → DuckDB `access_logs`) → `analyze_access_logs`
  (status/method distributions, requests-by-hour, top keys/prefixes/UAs, 4xx/5xx
  rates) + findings + Markdown report.
- `inventory_analysis` runs: `import_inventory_file` (CSV / Parquet → DuckDB
  `inventory_objects`) → `analyze_inventory` (size histogram, age distribution,
  prefix/storage-class distributions, small-object ratio, top large objects) +
  findings + Markdown report.
- Dataset upload (`POST /runs/{id}/datasets/upload`, multipart) into
  `data/runs/{id}/raw/`; `GET /datasets`, `GET /datasets/{id}`.
- Every analysis action (`detect_log_format`, `import_*`, `analyze_*`,
  `generate_markdown_report`) is recorded in `tool_calls` + `audit_logs` with
  `run_id`; inputs/outputs are sanitized and paths recorded relative.
- Client IPs are masked (`192.0.2.10` → `192.0.2.x`); credential-shaped values
  are redacted before they reach DuckDB, reports, or events.
- Frontend: New Run form supports run-type selection + file upload, Run Detail
  shows metrics cards, and a Datasets page lists imported datasets.

`diagnostic` (Phase 04) is retained; `bucket_config_review` and
`optimization_report` remain `not_implemented` placeholders.

## Phase 06 status

Implemented in Phase 06 (`phase/06-config-review`):

- `bucket_config_review` run type with six **read-only** config tools:
  `get_bucket_config_summary`, `review_bucket_security`,
  `review_bucket_lifecycle`, `review_bucket_observability`,
  `review_bucket_cost_optimization`, `review_bucket_performance_profile`.
- Reads bucket config via read-only APIs only (location, versioning, lifecycle,
  encryption, logging, policy, CORS, ACL, public access block, replication,
  notification, tagging). Each read is mapped to a structured status:
  `available` / `not_configured` / `provider_unsupported` / `access_denied` /
  `error` — a single failed read never fails the whole run.
- Findings categorized as Critical / Warning / Opportunity / Good /
  Not applicable / Provider unsupported. Reports never dump raw bucket policy,
  account IDs, ARNs, credentials, signatures, or presigned-URL params.
- Performance profile uses a bounded `list_objects_v2` sample (max_keys ≤ 100,
  ≤20 sample keys); no full scan, no object body download.
- Optional read-only tool endpoints under `/tools/*` for each review tool.
- Frontend: New Run form supports `bucket_config_review`; Run Detail shows
  config metrics cards (Critical/Warning/Opportunity/Provider unsupported/
  Access denied/Good counts).

`optimization_report` remains a `not_implemented` placeholder.

## Phase 07 status

Implemented in Phase 07 (`phase/07-agents-sdk`):

- **Optional `agent` planner mode** (deterministic remains the default). A
  controlled LLM agent (OpenAI Agents SDK) can plan, select among the existing
  whitelisted read-only tools, interpret results, and write a narrative — for
  `diagnostic` and `bucket_config_review` runs.
- Strong local guardrails (not just prompt rules): tool allowlist + forbidden
  tool denial, argument bounds (list max_keys ≤ 100), no-secret-in-context
  assertion, output sanitization/bounding before results reach the LLM, and
  report sanitization before saving. Hidden chain-of-thought is stripped and
  never persisted or shown.
- Agent tools are thin wrappers that call the EXISTING tools through the shared
  `tool_runner` (so `tool_calls`/`audit_logs` still carry `run_id`); the agent
  never sees AK/SK/session tokens or the model API key, and provider/bucket are
  fixed by the run (no pivoting).
- New SSE events: `agent_started`, `agent_tool_selected`, `guardrail_passed`,
  `guardrail_blocked`, `agent_final` (plus existing events). Run Detail shows
  planner mode, agent activity, and a clean error banner.
- `POST /runs` accepts `planner_mode` (`deterministic` | `agent`); agent mode
  for analysis run types returns a clear "not supported yet" error.
- The Agents SDK is imported lazily; if it is absent or no model API key is
  configured (read from the keyring model-provider store), agent mode fails
  cleanly while deterministic mode keeps working. CI does not need `OPENAI_API_KEY`.

## Phase 08 status

Implemented in Phase 08 (`phase/08-packaging`):

- **PyInstaller packaging** of the FastAPI sidecar (`sidecar/packaging/`):
  build script, spec, and a smoke test that starts the bundle and checks
  `/health` (no AWS / no `OPENAI_API_KEY` / no real keyring secret).
- **Packaged entrypoint** `app/packaged_main.py` — `storage-agent-sidecar
  --host --port --data-dir`; localhost by default; production never enables
  uvicorn reload; sanitized startup banner (no secrets, no full paths).
- **Tauri v2 sidecar integration** — picks a free localhost port, spawns the
  bundled sidecar with `STORAGE_AGENT_DATA_DIR` set to the OS app-data dir,
  exposes the URL via the `get_sidecar_url` command, and kills it on exit.
- **Frontend URL resolution** — dev `VITE_SIDECAR_URL`, prod Tauri command,
  fallback default; sidecar status renders **starting / connected /
  disconnected / error**.
- **Stable app data dir** — `STORAGE_AGENT_DATA_DIR` → `SAW_DATA_DIR` →
  `<repo>/data`; user data never written to the install dir or bundled.
- Packaging docs in [`docs/packaging.md`](docs/packaging.md); CI gains an
  informational packaging job.

See `docs/packaging.md` for dev/build/desktop instructions.

> **Rust toolchain blocker:** `cargo`/`rustc` are not installed in this
> environment, so `cargo tauri dev/build` has not been run or verified here. The
> Tauri Rust integration follows the standard v2 sidecar pattern and must be
> built on a machine with Rust. No code signing / notarization and no
> auto-update in Phase 08.

## Phase 09 status

Implemented in Phase 09 (`phase/09-desktop-release-hardening`):

- **Desktop build scripts** in `scripts/`: `build-sidecar-for-tauri.py`
  (detects the Rust target triple, builds the PyInstaller one-file sidecar, and
  copies it to `src-tauri/binaries/storage-agent-sidecar-<triple>`),
  `build-desktop-macos.sh`, and `verify-desktop-build.sh`.
- **Tauri CLI path** documented (Option A: `cargo install tauri-cli --locked`
  then `cargo tauri build`); the build script falls back to `cargo build` when
  the CLI is absent.
- **Startup UX**: a slow-start hint after 15s ("Sidecar is still starting…")
  and sanitized disconnected/error guidance (restart / check logs).
- **App data dir** verified by tests (all artifacts under the app-data dir,
  never the install dir; relative path recording).
- **CI**: a real `desktop-build-macos` job (Apple Silicon runner) — Rust +
  frontend build + sidecar build + externalBin copy + `cargo check` +
  `cargo build`.
- **Release docs**: `docs/release.md` (build flow, externalBin naming rule,
  limitations).

Verified locally on macOS arm64: `cargo check` + `cargo build` link the desktop
binary; the packaged sidecar serves `/health`.

> No code signing, notarization, or auto-update. macOS x64 / universal builds
> are not verified yet. The Vercel SDK is not used and is not part of the
> desktop architecture.

## Phase 10 status

Implemented in Phase 10 (`phase/10-macos-app-bundle`):

- **Tauri bundle enabled** (`bundle.active=true`, targets `["app","dmg"]`, full
  icon set incl. `icon.icns`). `cargo tauri build` produces an **unsigned**
  macOS `.app` and a **DMG**.
- **Build/verify scripts**: `scripts/build-macos-app-bundle.sh` and
  `scripts/verify-macos-app-bundle.sh` (checks the `.app`, embedded sidecar, no
  user data shipped, and the embedded sidecar `/health`).
- **Verified locally on macOS arm64:** the `.app` launches, Tauri spawns the
  bundled sidecar on a free port, and `/health` returns ok.
- **Sidecar cleanup hardening:** a parent-PID watchdog in the sidecar exits it
  when the desktop app goes away, so a one-file PyInstaller child is never
  orphaned (Tauri also passes its PID and kills the child on exit).
- **CI**: `desktop-build-macos` now runs `cargo tauri build` and uploads the
  `.app` (zipped) + DMG as artifacts. Unsigned; GUI not exercised on the runner.

Artifacts: `src-tauri/target/release/bundle/{macos/*.app,dmg/*.dmg}`. See
[`docs/release.md`](docs/release.md) for the build flow and opening the unsigned
app past Gatekeeper.

## Phase 11 status

Implemented in Phase 11 (`phase/11-linux-windows-build-matrix`):

- **Cross-platform externalBin**: `scripts/build-sidecar-for-tauri.py` names and
  copies the sidecar per Rust target triple (incl. Windows `.exe`).
- **Linux/Windows build scripts**: `scripts/build-desktop-linux.sh`,
  `scripts/build-desktop-windows.ps1`, and `scripts/verify-desktop-artifacts.py`
  (macOS scripts unchanged).
- **CI build matrix**: existing macOS arm64 job (artifact
  `storage-agent-workbench-macos-arm64`) plus new **experimental**
  `desktop-build-linux-x64` (`.deb`) and `desktop-build-windows-x64` (NSIS)
  jobs (`continue-on-error`) that build, smoke-test the sidecar `/health`, and
  upload artifacts when produced.
- Bundle `targets` set to `"all"` so each OS builds its native bundles (macOS
  still produces `.app` + DMG).

Platform support matrix (see [`docs/release.md`](docs/release.md)):

| Platform | Arch | Build | Sidecar smoke | Runtime launch | Cleanup | Status |
|----------|------|-------|---------------|----------------|---------|--------|
| macOS | arm64 | yes | yes | local verified (CI best-effort) | yes | supported (unsigned) |
| macOS | x64 / universal | — | — | — | — | out of scope |
| Linux | x64 | CI | CI | skipped on headless CI | — | experimental |
| Windows | x64 | CI | CI | verified (CI) | verified (CI) | experimental |

## Phase 12 status

Phase 12 (`phase/12-cross-platform-runtime-verification`) adds cross-platform
**runtime verification**: `scripts/verify-runtime-common.py` + per-OS wrappers
verify the app launches, spawns the bundled sidecar, serves `/health`, and
cleans up the sidecar on quit (no orphans), and that app data stays out of the
install dir. The 3 desktop CI jobs run it (macOS arm64 required; Linux/Windows
under xvfb/best-effort, experimental). macOS arm64 launch lifecycle is verified
locally. Linux/Windows promotion criteria are documented in `docs/release.md`.

## Phase 13 status

Phase 13 (`phase/13-agent-dataset-analysis`) extends agent planner mode to
`access_log_analysis` and `inventory_analysis` as an **interpretation-only
narrator**. The deterministic DuckDB analysis still runs first and is
authoritative; in agent mode the model then receives **only** a bounded,
sanitized aggregate context (run/dataset metadata + deterministic metrics +
findings) and writes a structured narrative (executive summary, observations,
root causes / cost & lifecycle opportunities, risks, recommended next steps).
The model has **no tools** — it cannot run SQL, read raw logs/rows, list
objects, download bodies, or call any S3 API — so no raw or sensitive data can
reach it. Output is redacted, chain-of-thought-stripped, and bounded; the report
keeps deterministic metrics and the agent interpretation in separate sections. A
missing model provider key fails the agent run cleanly and never affects
deterministic runs. New tests live in `sidecar/tests/test_agent_analysis.py`.

## Phase 14 status

Phase 14 (`phase/14-cloud-account-discovery`) adds **account-level discovery**.
A new read-only `list_buckets` tool plus an `account_discovery` run type
enumerate the buckets visible to a cloud provider, capture a per-bucket
read-only **configuration snapshot** (versioning / encryption / lifecycle /
logging / replication / policy / public-access-block / tagging / inventory with
clear status enums), and **discover evidence sources** — whether bucket
inventory and server access logging are configured (and their destinations),
without pulling the full inventory report or access log. It builds an
account-profile report and a filterable bucket table in the UI (with a "Discover
account" entry on each cloud provider). The scan is bounded by `max_buckets`
(default 100) with include/exclude globs; it never scans objects (no
ListObjectsV2), never downloads object bodies, never enables logging/inventory,
and never modifies any bucket configuration. AK/SK stay in the OS keyring and
never reach SQLite/logs/reports/UI/LLM. `account_discovery` is deterministic
only — Agent mode returns a clean 422. New tests:
`sidecar/tests/test_account_discovery.py`.

## Phase 15 status

Phase 15 (`phase/15-managed-evidence-import`) connects discovered evidence
sources to the analysis path. From the account-profile bucket table you can
**Import inventory** or **Import access logs**: the sidecar generates a bounded
**import plan** (file count / total bytes / format / time range / limits) from
the *discovered* inventory destination or logging target only, you **confirm**
it (recorded in `approval_events` + `audit_logs`), and only then are the
evidence files downloaded — bounded by `max_files` (≤5000) and `max_bytes`
(≤5 GiB), with a time range required for logs. Downloaded files feed the
existing deterministic `inventory_analysis` / `access_log_analysis` importers
and analyzers, and the UI navigates to the resulting analysis run. It never
scans the business bucket, never downloads business object bodies, never
imports without confirmation, and never mutates S3. AK/SK stay in the keyring;
evidence lands in the app data dir; reports carry no raw content or secrets. New
tests: `sidecar/tests/test_evidence_import.py`.

Not implemented yet:

- Agent-assisted account-level analysis (account_discovery is deterministic only)
- ORC inventory import (CSV / Parquet supported; ORC detected_but_not_supported)
- CloudTrail / Storage Lens / provider-access-log evidence sources
- `optimization_report` run type
- Code signing / notarization / auto-update
- macOS x64 / universal desktop builds
- Verified Linux / Windows GUI launch (CI builds only)

## Requirements

- **Python 3.12** (recommended; pinned in `.python-version`)
- Node.js 20+
- Rust toolchain (for the Tauri desktop shell only)

## Local development

### Sidecar

Use Python 3.12 (see `.python-version`).

```bash
cd sidecar
python3.12 -m venv .venv   # or: python -m venv .venv
source .venv/bin/activate
pip install -e .
uvicorn app.main:app --reload --host 127.0.0.1 --port 8765
```

Health check:

```bash
curl http://127.0.0.1:8765/health
```

By default the SQLite database is created at `data/app.db` (relative to the
repo root). Override with the `SAW_DB_PATH` environment variable.

### Sidecar tests

```bash
cd sidecar
pip install -e ".[dev]"
pytest -q
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### Tauri

```bash
cd src-tauri
cargo tauri dev
```

## Security

See:

- `CLAUDE.md`
- `docs/security.md`

Core rules:

- No plaintext secrets in SQLite, logs, traces, reports, or prompts.
- No generic shell tool.
- Whitelist tools only.
- Readonly by default.
- No destructive S3 operations in MVP.
