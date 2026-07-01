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

### preview_object

Purpose:

- Read a bounded, read-only, sanitized preview of one text object's content (a
  manifest, small config, or log/data sample) so the agent can answer "what's
  inside this object".

Safety:

- Single named object; hard cap 1 MiB per call (bounded Range GET); never persisted.
- Binary or oversized objects are reported, not decoded; output is redaction-passed.
- Bounded per turn (a few objects / a few MiB) so it can't be looped into a bulk
  download. No full-object download, no bulk/recursive body reads.

### test_addressing_style

(S3 layer: `test_path_style_vs_virtual_host`)

Purpose:

- Compare path-style and virtual-hosted-style behavior.

### inspect_endpoint_tls

(S3 layer: `inspect_tls`)

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
- **Inline read-only runs** — the agent executes the deterministic
  `survey_account` / `review_bucket_config` engines itself (real, audited,
  read-only, wall-clock-bounded) and `analyze_uploaded_file` for an attached
  file; it picks up a backgrounded run later with `read_run_result`. There is no
  autonomy toggle. Nothing data-moving or mutating is auto-run — cloud evidence
  import / large scans stay confirmation-gated proposals.

These tools return only the deterministic engine's sanitized summary + counts
(no raw rows, no full key lists, no object bodies) for the agent to narrate.

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
