# Roadmap

Do not use GitHub Issues for MVP project management.

Use phase branches or clear phase commits.

## Phase 01: Bootstrap

Scope:

- GitHub private repo
- Project skeleton
- Documentation
- Tauri / React shell
- FastAPI sidecar
- GET /health
- Sidecar status UI
- Basic CI
- Example files

Do not implement:

- Agent runtime
- S3 tools
- DuckDB analysis
- keyring
- Provider CRUD
- Generic shell
- Destructive operations

## Phase 02: Providers

Scope:

- SQLite
- keyring wrapper
- Model provider CRUD
- Cloud provider CRUD
- Redaction utility

## Phase 03: S3 tools

Scope:

- Readonly S3-compatible tool layer
- Provider test connection
- Sanitized tool calls
- Audit logs

## Phase 04: Runs and timeline

Scope:

- Analysis Run model
- SSE
- Tool Timeline
- Diagnostic run
- Markdown report

## Phase 05: DuckDB analysis

Scope:

- Access log analysis
- Inventory analysis
- Metrics cards
- Findings
- Analysis reports

## Phase 06: Bucket config review

Scope:

- Readonly config summary
- Security findings
- Lifecycle findings
- Observability findings
- Provider unsupported handling

## Phase 07: Agents SDK

Scope:

- OpenAI Agents SDK integration
- Whitelist tools
- Evidence-backed findings
- Existing SSE and timeline preserved

## Phase 08: Packaging

Scope:

- Tests
- Examples
- Tauri sidecar packaging
- Demo docs
- MVP acceptance review
