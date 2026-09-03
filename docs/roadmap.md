# Roadmap

> **Status: delivered in v1.13.0** (see `releases/1.13.0.md` and the
> CHANGELOG). Everything below landed as planned; the MCP consuming side
> landed as disabled-by-design plus its threat model (`docs/security.md`
> appendix), with no execution path — the one scoped cut, recorded in the
> release note.

> **Baseline: Storage Agent v1.12.0.** This file is the plan for
> **v1.13.0 — Honesty and completeness**: every known gap from the v1.12
> review closes in one version, with no migration and no second batch. The
> product invariant is unchanged: **the Agent Task is the application.** Every
> finding below was checked against the code on `main` at v1.12.0 (merge
> `e26bcb1`). The v1.12.0 plan this file replaces is recorded in
> `releases/1.12.0.md`.

## 1. Verdict on v1.12.0 — what still is not honest

v1.12.0 made the *runtime* native all the way through. What remains is truthfulness: a bridge that echoes instead of executing, an export that is empty, a recovery that loses gated actions, kinds that downgrade silently, compaction that needs reported usage, a history that stores secrets, and quality that is prose instead of gates.

| # | Finding (verified in code) | Where | Verdict |
| --- | --- | --- | --- |
| F1 | **MCP `call` is a stub.** `POST /mcp/tools/call` returns `200 accepted` with a validated echo; nothing executes. | `routers/mcp.py` | **rebuild** — real dispatch |
| F2 | **OTel export is empty.** The events query names `payload_json`; the column is `payload_json_sanitized`. A bare except returns `events: []`. No spans exist. | `routers/observability.py` | **rebuild** — fix + spans |
| F3 | **Restart loses gated actions.** Recovery leaves `waiting` executions waiting, but their tool thread died — a later Allow settles them completed without the action running. | `task_runtime/recovery.py` | **rebuild** — interrupt waiting |
| F4 | **Unknown kinds downgrade silently.** Any `kind` outside the trio runs as `direction`. | `routers/agent_tasks.py` | **rebuild** — 422 |
| F5 | **Compaction needs reported usage.** Usage-less gateways never trigger it; CJK estimates run 4–8x optimistic; chaining is implicit. | `agent_runtime/compaction.py` | **rebuild** — fallback + weights + chain |
| F6 | **Capability memories never clear.** A fixed proxy waits for a restart. | `agent_runtime/session_agent.py` | **new** — clear on green probe |
| F7 | **History stores secrets.** Composer history keeps pasted key material in plaintext localStorage. | `components/Composer.tsx` | **rebuild** — redact/drop |
| F8 | **No `@` references, substring palette.** Files attach but cannot be named; 30+ tasks stay `O(n)`. | `components/Composer.tsx`, `CommandPalette.tsx` | **new** — mentions + fuzzy |
| F9 | **Large-scan cards hide the estimate.** `buckets`/`estimated_calls` never reach the card. | `components/ApprovalCard.tsx` | **new** — project bounds |
| F10 | **No evals.** Golden cases are prose. | (none) | **new** — harness + `docs/evals.md` |
| F11 | **Fanout unnamed.** The survey pool has no pinned design. | `runs/account_discovery_run.py` | **new** — pin + name |
| F12 | **Updater unwirable; packaging informational.** No key path; broken bundles ride release branches. | `scripts/stamp-version.py`, `ci.yml` | **new** — env wiring + required gate |
| F13 | **No MCP client.** Consuming third-party servers is a new trust boundary with no design. | (none) | **non-goal** — threat model + disabled status |

## 2. Workstreams (all mandatory for v1.13.0)

### W1 — Execute or explain (F1, F2)

- MCP dispatch through the S3 layer with scope/input clamps, `run_tool`-recorded; stateless allowlist (session-bound tools out by design); `GET /mcp/client/status` reports the F13 non-goal.
- OTel export: fix the column, log the failure path, project deterministic spans (no migration).

### W2 — Runtime truth (F3, F4)

- Recovery stamps `waiting` → `interrupted` (Decision survives; Resume re-plans); unknown `kind` → 422; cancelled resume → `kind=retry`; `waiting` rides heartbeats; hub comment corrected; `stop()` dead code removed.

### W3 — Scope/bounds truth

- One scope function, list clamps everywhere, plural secret keys, range/preview budgets verified as bounds (synthesize, never Decide).

### W4 — Context staying power (F5, F6)

- Usage-less compaction trigger, CJK-weighted estimates, chained summaries, 5 s `AGENTS.md` cache, capability reset on green probe.

### W5 — Tool-row truth

- Optimization tools emit full activity rows (visible compute, no empty shells).

### W6 — Composer truth (F7, F8)

- `@` completion from the Task, redacted history (drop key material, mask values, migration-clean on read), fuzzy palette, per-execution detail pages, 200-message cache bound, 90 s long-run hint.

### W7 — Approval truth (F9)

- Large-scan cards show buckets + estimated calls; preview/range budgets pinned as bounds-not-gates by test.

### W8 — Evals (F10)

- `test_v113_eval_golden.py` + `docs/evals.md`; provenance recency note.

### W9 — Release truth (F12)

- Updater from `TAURI_UPDATER_PUBKEY`/`TAURI_UPDATER_ENDPOINTS` (both-or-neither); packaging smoke required on `release/*`.

### W10 — Named fanout; MCP-client non-goal (F11, F13)

- `_PROBE_WORKERS = 4` pinned, `fanout_workers` in the survey result, single-row merge tested; threat-model appendix for the client.

### W11 — Release

- `releases/1.13.0.md`, CHANGELOG, version stamps, guard bumps (architecture v1.13 block, documentation contract at v1.13.0). No migration. No new E2E specs (approval cards have no positive-E2E precedent; new behaviour is pinned by unit + Sidecar tests and the existing real-Sidecar suite runs in CI); `shots` re-capture runs in CI.

## 3. Non-goals for v1.13.0

- An executing MCP client (threat model only).
- Reasoning summaries in the transcript (rule 10/§22 stands).
- Multi-agent orchestration, worktrees, terminal/browser control, storage mutation, realtime collab/SaaS (documented as non-architecture).
- Signed/notarised builds (operations; the updater path is now wirable).
