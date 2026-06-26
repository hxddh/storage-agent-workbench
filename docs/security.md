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

## Packaging (Phase 08)

- The application bundle contains code and library data only. It must never
  include `.env`, the SQLite database, keyring contents, or `data/runs/` output.
- Secrets remain in the OS keychain (`keyring`); user data lives in the app data
  dir, never inside the install/app bundle.
- The packaged sidecar binds localhost only, never enables reload in production,
  and prints a sanitized startup banner (no secrets, no full paths, no env dump).
- Tauri spawns only the internal packaged sidecar; no user-controlled shell or
  subprocess execution is exposed.
