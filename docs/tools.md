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

- `max_keys` is NOT required — the agent-tool signature defaults it to **200**
  (`session_tools.py`; the guardrails `AGENT_DEFAULT_LIST_KEYS = 100` fallback
  is unreachable because the signature default always supplies a value). An
  explicit larger request is honored but clamped to `AGENT_MAX_LIST_KEYS` = 1000
  (which matches the S3 layer's own `MAX_LIST_KEYS` hard cap), so a deliberate
  wider sample works while a full scan can't be requested. Bounds, not gates —
  there is no approval path.
- Must sanitize sample keys and bound the keys surfaced to the model per call.
  The clamp is reported (`max_keys_requested` / `max_keys_applied`) and the
  in-context echo cap sets `keys_truncated_in_context` — never a silent cap.
- `objects` carries per-key `{size, storage_class, last_modified}` for the first
  100 entries, so size/storage-class distribution is samplable from one listing
  (no N× head_object).
- Never returns object bodies.

### head_object

Purpose:

- Inspect one object's metadata — size/ETag/mtime/storage class plus the
  diagnostic headers the same response already carries: `replication_status`,
  `restore` (GLACIER restore progress/expiry), `archive_status`, `parts_count`,
  `lifecycle_expiration`, `version_id`, `content_type`/`content_encoding`/
  `cache_control`, `website_redirect_location`. Accepts `version_id` to HEAD a
  specific version (compare current vs noncurrent).

Safety:

- Must not download object body. Restore/expiration strings are redacted.

### test_range_get

Purpose:

- Test range request behavior.

Safety:

- Must limit requested bytes. The hard cap on a single range read is the S3
  layer's `MAX_RANGE_BYTES` (4 MiB) in `s3/tools.py` — a request beyond that is
  refused.
- Budgeted per turn: at most 12 calls (`_MAX_RANGE_GETS` in `session_tools.py`),
  after which the tool asks the agent to work with what it has.
- Must not download a full object. There is no full-object download path.

### preview_object

Purpose:

- Read a bounded, read-only, sanitized preview of one object's content (a
  manifest, small config, or log/data sample) so the agent can answer "what's
  inside this object". Gzip objects (`.gz`) are decompressed within the same byte
  bound; `.parquet` objects return a STRUCTURE preview (schema + row counts from
  the footer via one bounded suffix-range GET — never the object body). CSV/TSV
  and JSON/JSONL text previews additionally carry a `structure` summary (columns
  or top-level keys) read from the SAME preview bytes — no extra fetch, the raw
  text is still returned. Other binary/oversized objects are reported, not decoded.

Safety:

- Single named object; hard cap 1 MiB per call (bounded Range GET); never persisted.
- Binary or oversized objects are reported, not decoded; output is redaction-passed.
- Budgeted per turn (16 objects / 24 MiB) so it can't be looped into a bulk
  download. No full-object download, no bulk/recursive body reads.

### list_object_versions

Purpose:

- Surface the actual version / delete-marker pileup on a versioned bucket (the
  real storage/cost driver that config review can't see).

Safety:

- Read-only ListObjectVersions; one bounded page (markers for paging). No bodies.
- At most 20 sample keys echoed back; `sample_versions` additionally carries
  bounded per-entry detail (`version_id`, `is_latest`, `is_delete_marker`, size,
  storage class) so the agent can point at WHICH version to inspect.

### list_multipart_uploads

Purpose:

- Surface in-progress / abandoned multipart uploads (a silent cost leak whose
  parts are billed but invisible in a normal object listing).

Safety:

- Read-only ListMultipartUploads; listing only. Aborting is a mutation and is
  NOT available — propose a lifecycle rule instead. At most 20 sample keys.

### list_upload_parts

Purpose:

- List the PARTS of one in-progress multipart upload (read-only ListParts):
  part count, total bytes accrued, first/last part times — the concrete
  "this abandoned upload holds N GB since <date>" cost evidence.

Safety:

- Read-only; listing only (no abort — propose an
  AbortIncompleteMultipartUpload lifecycle rule). ≤20 sample parts.

### test_conditional_get

Purpose:

- Prove whether a cached ETag still matches the stored object (HeadObject with
  If-None-Match): 304 → unchanged (stale reads are a cache/CDN problem), 200 →
  changed + the current ETag. Doubles as a conditional-header compat probe.

Safety:

- Read-only HeadObject; no body on either outcome.

### diagnose_presigned_url

Purpose:

- Diagnose a user-pasted presigned URL by PURE PARSING — signature version,
  computed expired/valid (X-Amz-Date + X-Amz-Expires, or the V2 epoch), the
  credential SCOPE (date/region/service), signed headers, addressing style,
  and a `problems` list (expired / clock skew / >7d V4 expiry / legacy SigV2).

Safety:

- NO network request is made. The signature, access-key id, and any security
  token are dropped entirely — credential material never reaches the model
  (rule 15). Host and key are redaction-passed.

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

### get_object_acl

Purpose:

- Read ONE object's ACL — who is granted what — to answer "is THIS object
  public?" / "who can read it?" at the object level (an object can be public even
  under a locked-down bucket, which bucket-level review can't see).

Safety:

- Read-only GetObjectAcl; single object, no body. Grantees are reduced to a KIND
  (`public-all-users` / `authenticated-users` / `canonical-user` /
  `log-delivery` / `email-user`) — no owner id, canonical id, or email is ever
  surfaced. A public grant (AllUsers/AuthenticatedUsers) sets `is_public`. A
  provider without object-ACL support reports `provider_unsupported`.

### get_object_tagging

Purpose:

- Read ONE object's tag set (tags drive lifecycle, cost attribution, and
  tag-scoped access policies), to explain why such a rule does or doesn't apply.

Safety:

- Read-only GetObjectTagging; single object, no body. Both tag keys and values
  are redacted (user-controlled). Bounded to 20 tags; an untagged object is a
  normal empty result; a provider without object tagging → `provider_unsupported`.

### get_object_attributes

Purpose:

- Read ONE object's attributes — checksum algorithm, multipart part count,
  storage class, size — in a single call, for "how was this large object
  assembled?" / checksum / storage-class checks.

Safety:

- Read-only GetObjectAttributes; single object, no body. Not universally
  implemented by S3-compatible providers → `provider_unsupported` on gap (fall
  back to `head_object`).

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

- get_bucket_config_summary — status map over ~21 config reads, including the
  authoritative `policy_status` (is-public), `ownership` (Object Ownership /
  ACLs-disabled), bucket-level `object_lock`, `website`, `intelligent_tiering`,
  `accelerate`, `request_payment`, `metrics`, and `analytics`. Also exposes the
  bucket's REAL region (`bucket_region` from LocationConstraint) plus a
  `region_mismatch` flag against the provider's configured region — the #1
  SignatureDoesNotMatch root cause, now checkable. An all-reads-errored summary
  reports `overall_status='inconclusive'`, never "reviewed".
- get_bucket_config_detail — read-only, sanitized RULE detail for one aspect that
  the review tools return only a status/boolean for. Aspects (15): `replication`,
  `notification`, `cors`, `logging`, `lifecycle` (transitions/expiration/cleanup),
  `encryption` (SSE algorithm + reduced KMS key), `public_access_block` (the four
  booleans), `policy` (per-statement effect/actions/`is_public` — principal
  reduced to `*`/`specific`, never the raw ARN), `inventory` (schedule/
  destination/format/fields), `website` (index/error docs, redirect host,
  routing-rule count), `intelligent_tiering` (status/filter/tiering days), 
  `accelerate` (Transfer Acceleration status), `request_payment` (Requester Pays),
  `metrics` (request-metrics configs), `analytics` (storage-class-analysis +
  reduced export destination).
  ARNs reduced (account id stripped), values redacted, ≤20 rules; a provider
  lacking the API returns `status='provider_unsupported'`. Fills the config
  skills' decision trees so the agent reads the config instead of asking for it.
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
- **compare_to_last_survey** — "what changed since last time?": a deterministic
  diff of a provider's two most recent account surveys (buckets added/removed,
  per-bucket config-aspect changes, evidence-source changes) computed from
  ALREADY-PERSISTED, sanitized snapshot data — no new S3 call, no LLM, no raw
  rows. Needs two completed surveys to compare.
- **query_account_profile** — account-WIDE posture from the latest persisted
  survey: "which of my N buckets have no encryption / no public-access-block / no
  lifecycle / logging off / no versioning / access issues?" Returns the per-bucket
  config-flag matrix (region + logging/encryption/lifecycle/replication/policy/
  public_access_block/tagging/inventory status) filtered by a whitelist
  (`all` | `missing_public_access_block` | `missing_encryption` |
  `missing_lifecycle` | `missing_logging` | `no_versioning` | `access_issues`).
  Reads ALREADY-PERSISTED, sanitized snapshot flags — no new S3 call, no LLM,
  statuses only (never object keys/bodies). Needs one completed `survey_account`.

These tools return only the deterministic engine's sanitized summary + counts
(no raw rows, no full key lists, no object bodies) for the agent to narrate.

On top of the per-tool bounds there is a **per-turn cumulative tool-output
budget**: once a turn's tool results have consumed it, further tool calls return
a notice asking the agent to synthesize from what it already has instead of more
data. The budget is **model-elastic** (`agent_runtime/model_budget.py`) — derived
from the active model's context window (≈25% of it), with the historical ~200k
chars as a **hard floor**. A 128k/200k-context model is unchanged; a 1M-context
model gets a proportionally deeper turn. This scales only sanitized, bounded tool
output — it never relaxes any security-floor cap (preview/range byte caps, list
caps, sample caps, ingest caps stay fixed).

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
