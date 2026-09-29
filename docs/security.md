# Security

Storage Agent is a local-first desktop Agent. Read-only autonomy is allowed only inside explicit, bounded, sanitized capabilities; there is no approval step, because nothing the Agent can do writes to storage and the one data-moving tool runs inside hard server-side bounds. Stop ends any work.

```text
User ── Tauri + React ── localhost HTTP/SSE + per-launch token ── Python Sidecar
                                                                   ├── encrypted vault
                                                                   ├── SQLite items · DuckDB datasets
                                                                   ├── one Agent runtime
                                                                   └── typed read-only S3 capabilities
                                                                         ├── the model endpoint
                                                                         └── the storage endpoint
```

## The floor, and where it is enforced

| Rule | Enforcement |
| --- | --- |
| Secrets never reach the model, items, logs, reports or the UI | Stored only through `security/keyring_store` (AES-256-GCM vault; SQLite holds `keyring://` refs). Provider APIs return `has_*` flags, never values. 422 bodies are re-built without `input` and redacted. Every tool result, item payload, audit row, report line and span attribute passes `security/redaction`; streamed text passes the `StreamSanitizer` (tail hold-back, eager masking of secret-shaped strings). `safety.assert_no_secrets_in_context` guards the prompt. |
| Storage is read-only | No tool calls a mutating S3 API (`tests/test_s3_safety.py` scans the source). Issue fixes are generated text; the bucket name, endpoint and region are shell-quoted in the CLI command and HCL-escaped in Terraform, so a hostile listing cannot inject a second command into text the user copies. |
| No generic capability | No shell, subprocess, raw boto3 client, unrestricted filesystem, SQL, browser or computer control is registered; `safety.is_forbidden_tool` rejects such names at registration. |
| Scope | Each storage tool declares its `Scope`; an SDK input guardrail checks the provider's allowed buckets/prefixes before the call runs and records a refusal the model reads. Verify and the MCP bridge use the same check. |
| Bounded data movement | `import_evidence`: a survey-discovered source only; ≤ 500 files and ≤ 256 MiB per call (clamped server-side); refused with nothing downloaded without 1 GiB free disk after the download; audited `approved_by=agent`; stops between files. Uploads are ≤ 2 GiB and stay local. `survey_account` ≤ 500 buckets and reports coverage. Per-turn budgets bound probes (e.g. latency ×8, range reads ×12, previews 16 objects / 24 MiB). |
| Bounded, sanitized context | Tool output to the model ≤ 60 000 chars (UI detail ≤ 24 000) inside `<<external_untrusted_data>>…<<end_external_untrusted_data>>`; the instructions say it is data, never instructions. The SDK's `ToolOutputTrimmer` shortens older outputs; compaction folds old Turns into a bounded summary. Standing instructions (`AGENTS.md`) ≤ 8 000 chars, redacted, below the safety rules. |
| Raw rows stay local | Access logs and inventories are loaded into DuckDB and analyzed deterministically; the model sees bounded metrics, findings and whitelisted aggregates (no SQL passes through). A fix's impact preview reads the same tables for counts, a time range and ≤ 3 key prefixes — never a requester, IP or raw line. |
| No chain-of-thought | Messages and conclusions pass `safety.strip_chain_of_thought`; reasoning items are never persisted (the Responses backend runs `store=False` and carries encrypted reasoning only within a Turn). |
| Honest gaps | Provider capability gaps are `provider_unsupported`; a review blind spot resolves no Issue; cost simulation withholds dollars without a confirmed price table and without inventory. |
| Local process isolation | The Sidecar binds 127.0.0.1; with `STORAGE_AGENT_AUTH_TOKEN` (the packaged app) every route but `/health` needs the token (constant-time compare); the launcher verifies a per-launch nonce before handing the token to the webview; CORS allows only the app's origins. |
| Notes | Notes reach every prompt, so their text is redacted with eager masking of secret-shaped tokens, bounded (1 000 chars, 500 notes, 12 in the digest at 280 chars) and presented as remembered context, never instructions. The `note` tool is never exposed over MCP. |
| Stop | Each tool call's `StopSignal` is set by the Turn's Stop or the call's own timeout; bodies stop at their next check, so a timed-out survey or import does not keep reading in the background. |
| Audit | Every tool call (agent, user, watch, mcp), settings change, note change, upload, import and deletion writes a sanitized `audit` row. |

## Extensions on the same floor

- **Watch** — opt-in per account, off by default, read-only, bounded (≤ 500 buckets surveyed, ≤ 25 re-checked), stops between phases when turned off, opens a task only through the one runtime path.
- **MCP server** — only with `STORAGE_AGENT_ENABLE_MCP=1`; the registry's stateless read-only subset plus `list_providers` (never credentials); same scope check, bounds and redaction; audited `actor=mcp`; behind the Sidecar token.
- **Local models, user skills, standing instructions** — skills and instructions are guidance text, never executed.
- **The shell** — deep links carry only a task id (validated on both sides); `open_task_in_main` validates its id; the tray tooltip is plain text ≤ 120 chars.
