# Security

Security is a core product requirement.

## Secret handling

Secrets include:

- Model API keys
- Cloud access keys
- Cloud secret keys
- Session tokens
- Authorization headers
- Presigned URL credentials
- Cookies
- Bearer tokens

Rules:

1. Secrets must never enter LLM prompts.
2. Secrets must never be stored in SQLite.
3. Secrets must never be stored in logs.
4. Secrets must never be stored in traces.
5. Secrets must never be stored in reports.
6. Secrets must never be stored in frontend state longer than needed for submission.
7. Secrets must be stored only through system Keychain / Python keyring.
8. SQLite may store only secret references.

## Tool safety

Rules:

1. No generic shell tool.
2. No raw subprocess tool exposed to the Agent.
3. No raw boto3 client exposed to the Agent.
4. Cloud operations must go through whitelist tools.
5. Default mode is readonly.
6. test-write mode must be explicitly enabled and prefix-limited.
7. Destructive operations are forbidden in MVP.

Forbidden in MVP:

- DeleteBucket
- PutBucketPolicy
- PutBucketAcl
- PutLifecycleConfiguration
- DeleteObjects
- Recursive delete
- Mass object mutation
- Bucket-wide destructive or mutating operation

## Analysis safety

Rules:

1. Do not download object bodies by default.
2. Full bucket scans require explicit user approval.
3. Large scans require max_objects or prefix limits.
4. Reports should show at most 20 sample object keys by default.
5. Logs should be sanitized before persistence.
6. Presigned URLs must be redacted before storage or display.

## Redaction

Must redact:

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

## Audit

Record these events:

- Tool calls
- Tool inputs after sanitization
- Tool outputs after sanitization
- Analysis SQL
- Data imports
- Approval events
- Report generation

## Provider unsupported

S3-compatible providers may not support every AWS S3 API.

Unsupported APIs should be recorded as:

```text
Provider unsupported
```

They should not be treated as hard failures unless the requested task requires that capability.

## Agent dataset analysis (Phase 13)

Agent planner mode is available for `access_log_analysis` and
`inventory_analysis` as an **interpretation-only narrator** — it explains the
deterministic results, it does not produce them.

- The deterministic DuckDB analysis runs first and is authoritative. Default
  planner mode stays `deterministic`; agent mode is opt-in per run.
- The model is given **only** a bounded, sanitized, aggregated context: run +
  dataset metadata, the deterministic metrics, and the deterministic findings.
  Lists are capped at 20 entries and the whole context is asserted to contain no
  secret-shaped content before it can leave the process.
- The model has **no tools** in this path. It therefore cannot run SQL, read raw
  log lines or inventory rows, list a full key set, download object bodies, or
  call any S3 API. No new tool is registered; the existing allowlist is
  unchanged. (Forbidden by construction, not just by prompt.)
- Forbidden in the agent context: raw log lines, raw inventory rows, full key
  lists / >20 sample keys, Authorization headers, cookies, presigned-URL query
  params, access/secret/session keys, model API keys, unmasked client IPs, and
  arbitrary SQL result dumps. Client IPs are masked upstream at import.
- The model output is redacted, chain-of-thought-stripped, length-bounded, and
  coerced to a fixed field set before it is shown or saved. Hidden reasoning,
  raw prompts, and raw model reasoning are never persisted.
- The inventory narrator may *recommend reviewing* lifecycle-policy candidates,
  but must never auto-create/update/delete lifecycle rules or emit bulk-delete
  commands — same destructive-operation ban as the rest of the MVP.
- Missing model provider key fails the agent run cleanly with a safe message;
  deterministic mode is unaffected.
- The report separates **Deterministic metrics** (authoritative) from the
  **Agent Interpretation** section, so every agent claim is traceable to a
  deterministic metric or finding shown above it.

## Account discovery (Phase 14)

The `account_discovery` run type enumerates an account's buckets and their
configuration from read-only APIs only. It is deterministic; Agent mode is
rejected with a clean 422 and no bucket list / config is ever sent to an LLM.

- **AK/SK/session tokens stay in the OS keyring**, resolved at call time inside
  the boto3 client factory; they never enter SQLite, logs, reports, UI state, or
  any LLM prompt.
- **`list_buckets` is read-only ListBuckets.** It does not call ListObjectsV2,
  does not scan objects, and does not download object bodies. Object-level
  listing/`get_object` are never invoked by this run type.
- **Bucket config snapshot** uses only read-only `get_*` / `list_*` config APIs
  (no put/delete/create/update). No logging or inventory is auto-enabled; no
  lifecycle / policy / ACL / encryption / replication is auto-modified or
  auto-remediated.
- **Evidence-source discovery only discovers** whether inventory / server access
  logging are *configured* (plus destination metadata). It never pulls the full
  inventory report or access log — that is a future phase / manual operator
  action. Reserved sources (CloudTrail / Storage Lens / provider access logs)
  are surfaced as `not_implemented`, never faked.
- **Bounded scan:** processing is capped by `max_buckets` (default 100, hard cap
  500) with optional include/exclude globs; truncation is reported, not silent.
- **Capability vs permission:** S3-compatible gaps are `provider_unsupported`;
  permission gaps are `access_denied` — distinct, and neither crashes the run
  (per-bucket failures are isolated).
- **Persistence is sanitized:** the four account-discovery tables store only
  redaction-passed JSON — never AK/SK/session token/Authorization/cookies/
  presigned-URL/model key. Bucket names, inventory destinations, and logging
  targets pass through the redaction pipeline; reports never contain secrets,
  signatures, raw object listings, raw inventory rows, or raw access-log content.

## Managed evidence import (Phase 15)

Pulling inventory / access-log evidence into the analysis path is bounded and
confirmation-gated.

- **Discovered sources only.** Imports read only the inventory *destination*
  (bucket/prefix) or server-access-logging *target* (bucket/prefix) that
  account_discovery already found and persisted. The caller cannot supply an
  arbitrary bucket or object key; the business source bucket is never listed.
- **No business object scan / body download.** The only listing is a bounded
  `list_objects_v2` over the evidence destination prefix; the only `get_object`
  calls are for evidence files in the confirmed plan (manifest, inventory data
  files, log objects). No business object body is ever downloaded, no recursive
  copy / sync, no full bucket scan.
- **Bounded.** Selection is capped by `max_files` (default 1000, hard cap 5000)
  and `max_bytes` (default 1 GiB, hard cap 5 GiB). Access-log import REQUIRES a
  time range. The byte/file budget is enforced again at download (a file larger
  than the remaining budget aborts the import as failed).
- **Explicit confirmation.** A plan downloads nothing. Download happens only
  after `confirm`, which is recorded in `approval_events` (decision=approved)
  and `audit_logs`. There is no hidden auto-confirm; a zero-file or over-limit
  plan is refused.
- **No mutation.** No S3 put/delete/create, no auto-enable of inventory/logging,
  no lifecycle/policy/ACL/encryption/replication change.
- **Secrets & storage.** AK/SK/session token/model key never enter SQLite, logs,
  reports, UI, or any LLM prompt. Evidence files download to the app data dir
  (`data/runs/{id}/raw/`), never the install dir; raw file content never appears
  in reports (only redacted aggregates from the existing analyzers). The two
  evidence-import tables store redaction-passed bucket/prefix/key/warnings only.
- **Reuse.** Downloaded files feed the existing deterministic
  `inventory_analysis` / `access_log_analysis` importers + analyzers; the import
  is deterministic (no LLM, no agent in this phase).
- **Support gaps.** ORC inventory is `detected_but_not_supported`; full inventory
  manifests with unusual structures degrade to a clean limitation rather than a
  crash. CloudTrail / Storage Lens / provider access logs remain unimplemented.

## Next-action handoff (Phase 17)

Turning a proposal into action is gated and reuses existing safe flows.

- **Proposals are not automation.** preview/prepare only validate and prefill;
  they never create a run, download evidence, confirm an import, mutate a bucket,
  call S3, or call an LLM. There is no hidden auto-run and no hidden
  auto-confirm.
- **Allowlist enforced.** Only a fixed set of `action_type`s is accepted; any
  other value (including assistant-proposed ones) is rejected/dropped. Every
  proposal carries `requires_confirmation=true`.
- **Existing safe workflows are reused.** A run still starts only when the user
  submits `NewRunForm`; evidence import still requires plan → confirm → run in
  `EvidenceImportDialog`. The handoff just opens those flows prefilled.
- **No unsafe auto-fill.** Access-log import does not auto-fill the time range;
  the user enters it in the planner.
- **Sanitized.** Proposals, prefills, and assistant `proposed_actions` are
  redaction-passed (no secrets, no raw logs/rows); assistant output is
  chain-of-thought-stripped; a missing model key still fails cleanly.
- **Not a task system.** Audit events (`next_action_previewed/prepared/opened`)
  are lightweight; there is no assignee, due date, status board, ticket state, or
  workflow state machine.

## Sessions (Phase 16)

Sessions add a persistent working context over the existing runs without adding
any new dangerous capability.

- **Deterministic, sanitized summary.** The session summary is built only from
  already-sanitized run artifacts (run_type/status/final_summary, sanitized
  tool_call outputs, the persisted account profile). It never reads raw access
  logs, raw inventory rows, evidence file contents, credentials, or
  chain-of-thought, and it does not call an LLM.
- **Interpretation-only assistant.** The session Agent sees ONLY the sanitized,
  bounded session context (goal + summary facts/findings/open-questions/
  next-actions + recent messages). It has no tools: it cannot download evidence,
  change configuration, delete objects, run a shell, run arbitrary SQL, or call
  any S3 API. It may explain, attribute, weigh evidence, and recommend which
  existing next-action proposal to take — the user acts. Output is redacted and
  chain-of-thought-stripped; a missing model key fails cleanly and never affects
  the deterministic summary.
- **Proposals only.** Next actions carry `requires_confirmation`; nothing is
  auto-executed. There is no auto-download, no auto-remediation, no auto-run.
- **Safe persistence.** Session titles/goals/bucket names, messages, findings,
  evidence refs, and summaries are all redaction-passed — never AK/SK/session
  token/Authorization/cookies/presigned URL/model key, never raw logs/rows, never
  chain-of-thought.
- **Not a PM/kanban/ticketing system.** There are no boards, columns, tickets,
  tasks, assignees, sprints, due dates, labels, notifications, or multi-user/
  permission models — only investigation context.

## Packaging (Phase 08)

- The application bundle contains code and library data only. It must never
  include `.env`, the SQLite database, keyring contents, or `data/runs/` output.
- Secrets remain in the OS keychain (`keyring`); user data lives in the app data
  dir, never inside the install/app bundle.
- The packaged sidecar binds localhost only, never enables reload in production,
  and prints a sanitized startup banner (no secrets, no full paths, no env dump).
- Tauri spawns only the internal packaged sidecar; no user-controlled shell or
  subprocess execution is exposed.
