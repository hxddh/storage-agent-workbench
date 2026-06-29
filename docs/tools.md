# Tools

Agent-accessible tools must be typed, explicit, and whitelisted.

Do not expose:

- Generic shell
- Raw subprocess
- Raw boto3 client
- Unrestricted filesystem access
- Destructive S3 APIs

## Diagnostic tools

### test_credentials

Purpose:

- Validate that a provider can be used.

### list_buckets

Purpose:

- Enumerate the buckets the credentials can see (read-only ListBuckets). Never
  lists objects or touches object bodies.

### head_bucket

Purpose:

- Check bucket existence and access.

### list_objects_v2

Purpose:

- List object keys with an explicit max_keys. Supports a continuation token and
  recursive (delimiter-free) listing so the agent can page through a large
  bucket; paging is always explicit, never an automatic full scan.

Safety:

- Must require max_keys; clamped to a per-call hard cap.
- Must sanitize sample keys and bound the keys surfaced to the model per call.
- Never returns object bodies.

### head_object

Purpose:

- Inspect object metadata.

Safety:

- Must not download object body.

### test_range_get

Purpose:

- Test range request behavior.

Safety:

- Must limit requested bytes.
- Must not download full object unless explicitly approved in a future phase.

### test_path_style_vs_virtual_host

Purpose:

- Compare path-style and virtual-hosted-style behavior.

### inspect_tls

Purpose:

- Inspect endpoint TLS configuration.

## Access log analysis tools

- detect_log_format
- import_access_logs
- analyze_access_logs

## Inventory analysis tools

- import_inventory_file
- analyze_inventory
- sample_bucket_objects

## Bucket config review tools

- get_bucket_config_summary
- review_bucket_security
- review_bucket_lifecycle
- review_bucket_observability
- review_bucket_cost_optimization
- review_bucket_performance_profile

## Report tools

- generate_markdown_report

## Session agent tools

The conversational session agent uses the read-only diagnostic + config-review
tools above (choosing provider/bucket itself), plus:

- **read_skill** — load a StorageOps skill's method on demand (progressive
  disclosure); guidance text only, no skill tools/scripts are executed.
- **Working memory** — `note_fact` / `record_finding` / `note_open_question`
  persist sanitized, audited items that are fed back into later turns.
- **Inline read-only runs** — under the `autonomous_readonly` autonomy policy the
  agent may execute `run_diagnostic` / `run_bucket_config_review` /
  `run_account_discovery` itself (real, audited, read-only, wall-clock-bounded);
  under `assisted` it proposes them. Nothing data-moving or mutating is auto-run.

The analysis narrator additionally gets bounded, read-only **drill-down**
aggregates over the already-local DuckDB dataset (`aggregate_by`, `count_where`
over whitelisted dimensions/fields) — no raw rows, no free SQL, no object bodies.

## Forbidden tools

- generic_shell
- run_command
- raw_subprocess
- delete_bucket
- put_bucket_policy
- put_bucket_acl
- put_lifecycle
- delete_objects
- recursive_delete
