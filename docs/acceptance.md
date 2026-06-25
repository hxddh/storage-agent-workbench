# Acceptance

## Phase 01: Bootstrap

Must pass:

- GitHub private repo exists.
- Project structure exists.
- `CLAUDE.md` exists.
- `README.md` exists.
- `docs/*.md` exist.
- Tauri / React / Vite shell exists.
- Python FastAPI sidecar exists.
- `GET /health` returns OK.
- Frontend displays sidecar connected / disconnected status.
- Basic CI exists.
- No GitHub issue templates exist.
- No generic shell tool exists.
- No keyring implementation yet.
- No S3 tools yet.
- No DuckDB analysis yet.
- No destructive S3 operation exists.
- Initial commit is pushed to GitHub.

## Phase 02: Providers

Placeholder.

Expected later:

- SQLite initialized.
- keyring wrapper implemented.
- Model provider CRUD implemented.
- Cloud provider CRUD implemented.
- Secrets stored only in keyring.
- SQLite stores only secret references.

## Phase 03: S3 tools

Placeholder.

Expected later:

- Readonly S3-compatible tools implemented.
- Tool outputs sanitized.
- Tool calls audited.
- No destructive operations.

## Phase 04: Runs and timeline

Placeholder.

Expected later:

- Analysis Run model.
- SSE events.
- Tool Timeline.
- Diagnostic run.
- Markdown report.

## Phase 05: DuckDB analysis

Placeholder.

Expected later:

- Access log analysis.
- Inventory analysis.
- Metrics cards.
- Findings.
- Markdown reports.

## Phase 06: Bucket config review

Placeholder.

Expected later:

- Readonly config summary.
- Security findings.
- Lifecycle findings.
- Observability findings.
- Provider unsupported handling.

## Phase 07: Agents SDK

Placeholder.

Expected later:

- OpenAI Agents SDK integration.
- Whitelist tools only.
- Evidence-backed findings.
- Existing SSE and timeline preserved.

## Phase 08: Packaging

Placeholder.

Expected later:

- Tests.
- Examples.
- Tauri sidecar packaging.
- Demo docs.
- MVP acceptance review.
