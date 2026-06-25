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

## Phase 08 acceptance (packaging)

- PyInstaller sidecar build script + spec exist; packaged entrypoint exists.
- Packaged sidecar serves `/health` in the smoke test (or a clear environment
  blocker is reported).
- Tauri config includes sidecar integration (externalBin + shell plugin +
  `get_sidecar_url`); frontend resolves the URL in dev and prod.
- Sidecar status UI handles starting / connected / disconnected / error.
- App data dir behavior implemented + documented; no secrets bundled or logged;
  no user data written to the install dir.
- Existing sidecar tests + frontend build pass; deterministic mode works without
  a model key; agent missing-key path fails cleanly.
- Rust/Tauri desktop build status is reported honestly (blocked when the Rust
  toolchain is absent).

## Phase 09 acceptance (desktop release hardening)

- Branch `phase/09-desktop-release-hardening` from latest main.
- Scripts build the sidecar externalBin and copy it to the Tauri path
  automatically (`scripts/build-sidecar-for-tauri.py`); `build-desktop-macos.sh`
  and `verify-desktop-build.sh` drive/verify the desktop build.
- `cargo check` + `cargo build` pass on macOS arm64; `cargo tauri build` works
  with the Tauri CLI installed (Option A). Frontend build + sidecar tests +
  PyInstaller smoke test pass.
- Startup UX shows a clear slow-start hint (>15s) and sanitized error guidance.
- CI gains a Rust-enabled `desktop-build-macos` job; full bundle + signing +
  notarization are intentionally skipped with a clear reason.
- App data dir behavior documented + tested; no user data in the install dir.
- No Vercel SDK; no new dangerous execution surface; no S3 mutation; Phase 10
  not started.
