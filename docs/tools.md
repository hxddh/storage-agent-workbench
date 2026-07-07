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

### list_objects

(The registered agent tool is `list_objects`; the internal S3 helper it calls is
`s3.list_objects_v2`. The `list_objects_v2` name is only that S3-layer function
and the `/tools/list-objects-v2` HTTP endpoint, not an agent tool.)

Purpose:

- List one page of object keys (read-only ListObjectsV2). Supports a
  continuation token and recursive (delimiter-free) listing so the agent can
  page through a large bucket; paging is always explicit, never an automatic
  full scan.

Safety:

- `max_keys` is NOT required — the agent-tool signature defaults it to **50**
  (`session_tools.py`; the guardrails `AGENT_DEFAULT_LIST_KEYS = 100` fallback
  is unreachable because the signature default always supplies a value). An
  explicit larger request is honored but clamped to `AGENT_MAX_LIST_KEYS` = 1000
  (which matches the S3 layer's own `MAX_LIST_KEYS` hard cap), so a deliberate
  wider sample works while a full scan can't be requested. Bounds, not gates —
  there is no approval path.
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

- Must limit requested bytes. The guardrails module defines
  `AGENT_MAX_RANGE_BYTES` (1 MiB) as a no-approval ceiling constant, but
  `test_range_get` is not routed through `bound_tool_args`, so the effective
  hard cap on a single range read is the S3 layer's `MAX_RANGE_BYTES` (4 MiB) in
  `s3/tools.py` — a request beyond that is refused.
- Budgeted per turn: at most 8 calls, after which the tool asks the agent to
  work with what it has.
- Must not download a full object. There is no full-object download path.

### preview_object

Purpose:

- Read a bounded, read-only, sanitized preview of one object's content (a
  manifest, small config, or log/data sample) so the agent can answer "what's
  inside this object". Gzip objects (`.gz`) are decompressed within the same byte
  bound; `.parquet` objects return a STRUCTURE preview (schema + row counts from
  the footer via one bounded suffix-range GET — never the object body). Other
  binary/oversized objects are reported, not decoded.

Safety:

- Single named object; hard cap 1 MiB per call (bounded Range GET); never persisted.
- Binary or oversized objects are reported, not decoded; output is redaction-passed.
- Budgeted per turn (12 objects / 16 MiB) so it can't be looped into a bulk
  download. No full-object download, no bulk/recursive body reads.

### list_object_versions

Purpose:

- Surface the actual version / delete-marker pileup on a versioned bucket (the
  real storage/cost driver that config review can't see).

Safety:

- Read-only ListObjectVersions; one bounded page (markers for paging). No bodies.
- At most 20 sample keys echoed back.

### list_multipart_uploads

Purpose:

- Surface in-progress / abandoned multipart uploads (a silent cost leak whose
  parts are billed but invisible in a normal object listing).

Safety:

- Read-only ListMultipartUploads; listing only. Aborting is a mutation and is
  NOT available — propose a lifecycle rule instead. At most 20 sample keys.

### measure_request_latency

Purpose:

- Measure live request latency (min/p50/p95/max/mean ms) with a bounded set of
  head round-trips, so a "slow" complaint becomes numbers.

Safety:

- HeadBucket, or HeadObject when a key is given — never an object body.
- Per-call sample count hard-capped (≤10); probe runs bounded per turn. A
  diagnostic probe, not a load test.

### get_object_lock_status

Purpose:

- Read one object's Object-Lock state — retention mode + retain-until date and
  legal-hold status — to answer "why can't I delete/overwrite this object?".

Safety:

- Read-only GetObjectRetention + GetObjectLegalHold; single object, no body.
- A missing lock, or a provider that doesn't implement object-lock, is reported
  as a normal `none` / `provider_unsupported` state, not a hard failure.

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

- **list_providers** — enumerate the configured cloud providers (ids + safe
  metadata, no secrets) so the agent can pick one before any bucket operation.
- **list_uploaded_files** — list the data files the user attached to this
  session (from `session_datasets`) so the agent can discover and then
  `analyze_uploaded_file` them. Local, read-only, always available.
- **aggregate_uploaded_file** — one CONSTRAINED aggregation over an uploaded file
  when the fixed `analyze_uploaded_file` metrics don't answer the question (e.g.
  "top masked IPs by 4xx count", "total bytes per storage class"). The agent
  chooses a metric + group-by dimension + equality/status-range filters **from a
  hard whitelist** (`analysis/aggregate.py`); it can never supply SQL, and only
  grouped aggregates (≤50 groups, redacted labels) come back — never raw rows.
  All filter VALUES are bound as DuckDB parameters; the real SQL + params are
  recorded in the audit log (rule 17). Over-limit results report `truncated`.
- **read_skill** — load a StorageOps skill's method on demand (progressive
  disclosure); guidance text only, no skill tools/scripts are executed.
- **Working memory** — `note_fact` / `record_finding` / `note_open_question`
  persist sanitized, audited items that are fed back into later turns, plus
  update/resolve lifecycle tools so stale memory can be corrected or closed out.
- **Inline read-only runs** — the agent executes the deterministic
  `survey_account` / `review_bucket_config` engines itself (real, audited,
  read-only, wall-clock-bounded) and `analyze_uploaded_file` for an attached
  file; it picks up a backgrounded run later with `read_run_result`. There is no
  autonomy toggle. Nothing data-moving or mutating is auto-run — cloud evidence
  import / large scans stay confirmation-gated proposals.

These tools return only the deterministic engine's sanitized summary + counts
(no raw rows, no full key lists, no object bodies) for the agent to narrate.

On top of the per-tool bounds there is a **per-turn cumulative tool-output
budget** (~150k chars): once a turn's tool results have consumed it, further
tool calls return a notice asking the agent to synthesize from what it already
has instead of more data.

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
