# Agent tools

The Agent works only through the tools registered in
`sidecar/app/agent/tools/`. This document lists every registered tool (40)
and describes the registry that binds them to the OpenAI Agents SDK.

Sources of truth: `registry.py` (`REGISTRY`, `GROUPS`, `tool`,
`build_sdk_tools`, `invoke`, `call_direct`, `run_direct`), plus the modules
`core.py`, `storage.py`, `config.py`, `account.py`, `files.py` and
`advice.py`.

To check the registered set against this document:

```sh
cd sidecar && python -c "from app.agent import tools; print(sorted(tools.REGISTRY))"
```

## Safety floor

- **Storage tools are read-only.** There is no tool that writes, puts,
  deletes, copies, restores or changes storage, its configuration, ACLs, tags
  or lifecycle. A fix is text the user applies with their own credentials.
- There is **no shell, no subprocess, no SQL tool, no raw boto3 client, no
  filesystem tool and no browser.** The `@tool` decorator refuses any name
  that `safety.is_forbidden_tool` flags: forbidden tokens, destructive verbs
  such as `delete`, `purge`, `overwrite` or `abort`, and mutating or SQL
  phrases.
- **`import_evidence` is the only data-moving tool.** It copies a discovered
  evidence source from storage onto this machine. It never writes to storage,
  and it is bounded (see its entry below).
- Every storage-addressing tool is **scope-checked** against the account's
  `allowed_buckets` and `allowed_prefixes` before it runs.
- Results are **redacted**. Before a result reaches the model it is bounded,
  and by default it is wrapped in the untrusted-data envelope.
- Every call is **recorded** as items and **audited**.

## Registry mechanics

### Declaration: `@tool(...)`

A tool is a plain Python function with typed parameters and a Google-style
docstring. The SDK derives the tool's JSON schema (strict mode) and
description from the function. Decorator options:

| Option | Default | Meaning |
| --- | --- | --- |
| `group` | required | one of `GROUPS` (see below) |
| `core` | `False` | always loaded, including on the Responses API |
| `timeout` | `60.0` | seconds, enforced by the SDK (`FunctionTool.timeout_seconds`) |
| `scope` | `None` | a `Scope` naming the parameters that address storage (see below) |
| `bounds` | `{}` | `{param: (lo, hi)}`: integer arguments are clamped into range; a non-integer becomes `lo` |
| `summarize` | `default_summary` | builds the one-line summary for the UI (at most 240 chars) |
| `untrusted` | `True` | wrap the model-facing result in the untrusted-data envelope |
| `max_model_chars` | `60 000` | bound on the model-facing result text |
| `special` | `None` | `"conclusion"`: the call is recorded as a `conclusion` item, not as a tool call |
| `name` | the function name | |

`Scope(provider="provider_id", bucket="bucket", key=None, prefix=None, listing=False)`
names which arguments address storage. The **scope check** (`scope_denial`)
works as follows:

- The `provider_id` must be a configured storage account. An empty
  `provider_id` is not checked.
- If a bucket parameter is set and non-empty, it must satisfy `check_scope`:
  - the bucket must be in `allowed_buckets` (when that list is non-empty);
  - an object `key` or a listing `prefix` must fall under `allowed_prefixes`
    at a path boundary;
  - a listing (`listing=True`) with no prefix is refused on a prefix-scoped
    account.
- `Scope(bucket=None)` checks only that the account exists.

### Binding: `build_sdk_tools(responses=…)`

Each tool becomes an Agents SDK `FunctionTool` with:

- `params_json_schema` from `function_schema(fn, strict_json_schema=True)`;
- a **scope input guardrail** (`tool_input_guardrails`) when the tool has a
  `Scope`. A denial records the call as refused (a `tool_call` item plus a
  `tool_output` item with `refused: true`, and an audit row with `ok = 0`),
  and returns `Refused: <reason>` to the model instead of running the tool;
- `timeout_seconds = timeout`;
- `defer_loading = responses and not core`.

The tool list depends on the model endpoint:

- **Responses API** (`api_style = responses`, the official OpenAI endpoint):
  - The tools of the `core` group are sent directly.
  - Every other group becomes a `tool_namespace(name=group, description=GROUPS[group])`.
    Its non-core tools are deferred and are loaded through the hosted
    `ToolSearchTool`, which the runtime appends to the tool list.
  - A core tool that belongs to a non-core group (`list_uploaded_files` in
    `files`) sits in that namespace but is not deferred.
  - The instructions tell the model which groups load on demand.
- **Chat Completions** (`api_style = chat`, every other endpoint): every tool
  is sent. There is no tool search.

The runtime runs at most 60 model steps per turn and at most 6 function tools
at once (`max_function_tool_concurrency`). A tool name the model invents is
returned to it as an error. An SDK `ToolOutputTrimmer` shortens tool outputs
older than the last 2 turns in the model input (to 4 000 chars, with a
600-char preview).

### Execution: `invoke(td, tool_ctx, raw_args)`

1. Parse the JSON arguments. A non-object becomes `{}`. Clamp them with
   `bounds`, then redact a copy for recording.
2. **`record_conclusion`** (`special="conclusion"`) stops here. The recorder
   validates the arguments (see its entry below), closes the open text
   segment and appends one `conclusion` item. The model receives
   `Conclusion recorded.`, or `Not recorded: <validation error>. Fix the fields and call again.`
   No `tool_call` or `tool_output` item and no audit row is written.
3. Record a `tool_call` item: `{call_id, name, args, target}`. The open text
   segment closes first.
4. If Stop was already pressed, record `tool_output` with `ok: false` and
   summary `stopped`, and return `Stopped by the user before this call ran.`
5. Run the body in a worker thread (`asyncio.to_thread`) with a `CallContext`
   set in a context variable. The body reads it through `current()`, which
   provides task and turn IDs, a lazily opened per-call DB connection,
   `progress()`, `budget()` and `cancelled`.
   - If the SDK cancels the call (timeout or Stop), set the call's
     `StopSignal`, record `tool_output` with `ok: false` and summary
     `cancelled or timed out`, then re-raise. A worker thread cannot be
     killed: the body stops at its next `ctx.cancelled` check (between
     buckets, files or checks), which reads the call's own signal **or** the
     Turn's Stop.
   - A `TypeError` (bad arguments) becomes `{"error": "Invalid arguments: …"}`.
   - Any other exception becomes
     `{"success": false, "error_code": <ExceptionType>, "error_message_sanitized": <redacted, ≤ 500 chars>}`.
     A failure is a result the model can read, never a crash.
6. **Redact** the result. `ok` is false when the result has
   `success: false` or an `error` key. The summary comes from `summarize`
   (redacted, at most 240 chars).
7. **Record** a `tool_output` item:
   `{call_id, name, ok, summary, duration_ms, detail, detail_truncated, model_output}`.
   - `detail` is the redacted result as JSON, at most **24 000 chars**. The
     UI reads it.
   - `model_output` is at most 60 000 chars and is never served to the UI.
   - One audit row is written: actor `agent`, action `tool.<name>`, target
     the bucket or provider, detail `{args, summary}`.
   - The recorder then passes the result to registered `on_tool_output`
     hooks. Hooks never fail a call.
8. Return to the model the result text bounded to `max_model_chars`. When it
   is cut, a `[TRUNCATED: N more characters. Narrow the request …]` note is
   appended. The text is wrapped in the envelope when `untrusted`:

   ```text
   <<external_untrusted_data>>
   …result…
   <<end_external_untrusted_data>>
   ```

   Marker strings inside the payload are defanged, so a payload cannot close
   the envelope early.

Per-turn budgets: `ctx.budget(key, limit, cost=1)` spends from a counter kept
per tool, per turn, and returns `False` once the limit would be exceeded. The
tool then returns an `error` telling the model the budget is used up.

Progress: `ctx.progress(done, total, unit)` appends throttled
`tool_progress` items: at most 1 per second and 120 per call, and the final
count is always written.

### Calls outside a turn

- **`call_direct(name, args, *, actor, allowed)`**: runs one registered tool
  outside a turn. It is used by the MCP bridge (actor `mcp`).
  - Only names in `allowed` run. Anything else returns
    `{"error": "Unknown tool: <name>"}`.
  - Arguments get the same `bounds` clamp and the same scope check. A refusal
    is audited with `ok = 0` and returns `{"error": "Refused: …"}`.
  - The body runs with a detached context: an empty task ID, and a recorder
    that discards progress.
  - No items are written.
  - It then goes through `run_direct`.
- **`run_direct(conn, name, args, fn, *, actor)`**: runs one read-only call,
  redacts the result, and writes one audit row (action `tool.<name>`, detail
  `{args}`). An exception becomes a sanitized failure result (message at most
  300 chars). Settings uses it directly for `POST /providers/clouds/{id}/test`
  (`test_credentials`, actor `user`). Neither function bounds the output to
  `max_model_chars` or applies the envelope.

## Groups

| Group | Description (sent as the namespace description) |
| --- | --- |
| `core` | Orientation: providers, buckets, skills, the estate and the conclusion. |
| `probes` | Endpoint and credential probes: reachability, TLS, addressing, latency, presigned URLs. |
| `objects` | Object forensics: listing, versions, multipart uploads, heads, ACLs, tags, lock, previews. |
| `config` | Bucket configuration: summary, detail per aspect, security / lifecycle / cost / performance reviews. |
| `account` | Account-wide: survey every bucket, compare with the last survey, query posture. |
| `files` | Local analysis of attached files and imported evidence: analyze, aggregate, import evidence. |
| `advice` | Deterministic advice: error triage, cost and lifecycle simulation. |

In the tables below, **Scope** shows the `Scope` declaration:

- *account*: `Scope(bucket=None)`; checks only that the account exists.
- *bucket*: `Scope()`; the bucket must be in scope.
- *key*: `Scope(key="key")`; the bucket and the object key must be in scope.
- *listing*: `Scope(prefix="prefix", listing=True)`; the bucket and prefix
  must be in scope, and an empty prefix is refused on a prefix-scoped account.
- *none*: no storage scope.

**Env.** means the result is wrapped in the untrusted-data envelope. Every
tool's model output is bounded to 60 000 chars.

## `core` (always loaded)

| Tool | Parameters | Scope | Env. | Timeout |
| --- | --- | --- | --- | --- |
| `list_buckets` | `provider_id: str` | account | yes | 30 s |
| `head_bucket` | `provider_id: str, bucket: str` | bucket | yes | 30 s |
| `read_skill` | `name: str` | none | no | 15 s |
| `query_estate` | `provider_id: str = "", bucket: str = "", status: str = "active"` | none | yes | 15 s |
| `fix_preview` | `issue_id: str` | none | yes | 30 s |
| `note` | `text: str, provider_id: str = "", bucket: str = ""` | none | no | 10 s |
| `record_conclusion` | `answer: str, findings: list[Finding], next_steps: list[str]` | none | no | 10 s |

- **`list_buckets`**: read-only `ListBuckets` for the account.
- **`head_bucket`**: read-only `HeadBucket`. Checks that the bucket exists
  and is reachable.
- **`read_skill`**: returns the full text of a StorageOps skill, bundled or
  user-supplied, as named in the skills catalog in the instructions.
  - Budget: 20 loads per turn.
  - Unknown name → `error`.
  - Skills are local guidance, so the result is not enveloped.
- **`query_estate`**: reads the local estate. No storage call.
  - Returns known buckets (region, posture projection, `last_checked_at`),
    at most 200 returned (300 read), plus `bucket_count` and up to 100 issues.
  - `status` accepts `active`, `care`, `all`, `open`, `fix_proposed`,
    `resolved`, `recurred` or `accepted`. Anything else falls back to
    `active`.
  - Issue titles follow the `language` setting.
- **`fix_preview`**: the generated fix for an estate Issue and what applying
  it would change. No storage call, and it never changes the Issue (only the
  user proposes a fix).
  - Returns `formats` (`cli` — the AWS CLI command against the Issue's
    provider endpoint and region; `terraform` — a resource, with a custom
    endpoint noted for the user's provider block; `json` — the API
    document), the fix's `notes`, and `impact`
    (`{verdict: low|caution|unknown, points: [{text, evidence}], gaps}`) —
    see `estate/fixpacks.py`.
  - An Issue whose fix depends on intent returns `fixable: false`.
  - The bucket name, endpoint and region are shell-quoted in the command and
    HCL-escaped in Terraform.
- **`note`**: keeps a note about the estate, an account (`provider_id`) or a
  bucket (`provider_id` + `bucket`) for later tasks.
  - Stored with `source = agent` and the task id; the user sees, edits and
    deletes every note.
  - Redacted with eager masking of secret-shaped tokens; ≤ 1 000 chars.
  - Budget: 5 per turn. An unknown provider or a bucket without a provider
    → `error`.
  - The 12 most recent notes reach every turn inside the untrusted-data envelope (`estate_notes`) as
    remembered context.
- **`record_conclusion`**: records the turn's conclusion (see
  [Execution](#execution-invoketd-tool_ctx-raw_args), step 2). The arguments
  are validated by the recorder's `Conclusion` model:
  - `answer`: 1–400 chars;
  - `findings`: at most 8, each `Finding {title: 1–240 chars, severity: high|medium|low|info, detail?: ≤ 600 chars}`;
  - `next_steps`: at most 4, each cut to 200 chars.

  The answer is filtered for chain-of-thought and the whole conclusion is
  redacted. When the model calls it more than once, each call appends a new
  `conclusion` item.

## `probes`

| Tool | Parameters | Bounds | Scope | Env. | Timeout |
| --- | --- | --- | --- | --- | --- |
| `test_credentials` | `provider_id` | — | account | yes | 30 s |
| `get_bucket_location` | `provider_id, bucket` | — | bucket | yes | 30 s |
| `test_addressing_style` | `provider_id, bucket` | — | bucket | yes | 45 s |
| `inspect_endpoint_tls` | `provider_id` | — | account | yes | 30 s |
| `measure_request_latency` | `provider_id, bucket, key = "", samples = 5` | `samples` 1–10 | key | yes | 60 s |
| `diagnose_presigned_url` | `url: str` | — | none | yes | 10 s |

- **`test_credentials`**: validates the credentials with a read-only call.
  Returns whether they work and which endpoint was reached. No secrets.
- **`get_bucket_location`**: one `GetBucketLocation`. Returns
  `bucket_region`, the configured region and endpoint, and `region_mismatch`.
- **`test_addressing_style`**: two read-only `HeadBucket` calls, one
  virtual-hosted and one path-style, and recommends the style that works.
- **`inspect_endpoint_tls`**: reads the custom endpoint's TLS certificate
  (version, subject, issuer, validity). An account on the default AWS
  endpoint returns `no_endpoint`.
- **`measure_request_latency`**: `samples` lightweight round-trips
  (`HeadBucket`, or `HeadObject` when `key` is given; no bodies). Returns
  min, p50, p95, max and mean in ms. Budget: 8 runs per turn.
- **`diagnose_presigned_url`**: pure parsing, with no network request. Reports
  the signature version, expiry, credential scope, signed headers, addressing
  style and a list of problems. No credential is echoed.

## `objects`

| Tool | Parameters | Bounds | Scope | Env. | Timeout |
| --- | --- | --- | --- | --- | --- |
| `list_objects` | `provider_id, bucket, prefix = "", max_keys = 200, continuation_token = "", recursive = False` | `max_keys` 1–1000 | listing | yes | 60 s |
| `list_object_versions` | `provider_id, bucket, prefix = "", max_keys = 1000, key_marker = "", version_id_marker = ""` | `max_keys` 1–1000 | listing | yes | 60 s |
| `list_multipart_uploads` | `provider_id, bucket, prefix = "", max_uploads = 1000, key_marker = "", upload_id_marker = ""` | `max_uploads` 1–1000 | listing | yes | 60 s |
| `list_upload_parts` | `provider_id, bucket, key, upload_id, max_parts = 1000, part_number_marker = 0` | `max_parts` 1–1000 | key | yes | 45 s |
| `head_object` | `provider_id, bucket, key, version_id = ""` | — | key | yes | 30 s |
| `get_object_lock_status` | `provider_id, bucket, key, version_id = ""` | — | key | yes | 30 s |
| `get_object_acl` | `provider_id, bucket, key, version_id = ""` | — | key | yes | 30 s |
| `get_object_tagging` | `provider_id, bucket, key, version_id = ""` | — | key | yes | 30 s |
| `get_object_attributes` | `provider_id, bucket, key, version_id = ""` | — | key | yes | 30 s |
| `test_conditional_get` | `provider_id, bucket, key, etag` | — | key | yes | 30 s |
| `test_range_get` | `provider_id, bucket, key, range_header = "bytes=0-1023"` | — | key | yes | 45 s |
| `preview_object` | `provider_id, bucket, key, max_bytes = 262144` | `max_bytes` 1 024–1 048 576 | key | yes | 60 s |

- **`list_objects`**: one page of `ListObjectsV2` (no bodies).
  - Delimiter `/` unless `recursive`.
  - The caller pages with `continuation_token` set to the previous
    `next_token`.
  - `objects` carries size, storage class and last-modified for the first 100
    keys.
  - `sample_keys` is dropped when it duplicates `keys`.
  - Summary: `N keys` (with `· more` when truncated).
- **`list_object_versions`**: one page of versions and delete markers.
  Returns counts, current and noncurrent bytes, sample keys and next-page
  markers.
- **`list_multipart_uploads`**: one page of incomplete multipart uploads:
  count, oldest initiation, sample keys and markers. Aborting an upload does
  not exist as a tool.
- **`list_upload_parts`**: `ListParts` for one upload. Returns part count,
  bytes and first/last part times.
- **`head_object`**: `HeadObject` metadata (no body), with sanitized user
  metadata.
- **`get_object_lock_status`**: retention mode, retain-until date and legal
  hold. An unsupported provider reports `provider_unsupported`.
- **`get_object_acl`**: the object's ACL. Grantees are reduced to a kind, and
  `is_public` is set for a public grant.
- **`get_object_tagging`**: the object's tag set, at most 20 tags, with keys
  and values redacted.
- **`get_object_attributes`**: `GetObjectAttributes` (checksum, parts,
  storage class, size). Reports `provider_unsupported` where the provider
  lacks it.
- **`test_conditional_get`**: `HeadObject` with `If-None-Match`, no body.
  Returns `etag_matches`.
- **`test_range_get`**: a GET with a `Range` header. Reads at most the
  requested bytes. Budget: 12 calls per turn.
- **`preview_object`**: a bounded, sanitized preview of the first bytes,
  at most 1 MiB. Gzip is decompressed within the bound, Parquet returns its
  structure only, binary content is reported rather than decoded, and secrets
  are redacted. Budgets per turn: 16 objects and 24 MiB read in total — each read is clamped to what is left of the byte budget before it runs.

## `config`

| Tool | Parameters | Scope | Env. | Timeout |
| --- | --- | --- | --- | --- |
| `get_bucket_config_summary` | `provider_id, bucket` | bucket | yes | 60 s |
| `get_bucket_config_detail` | `provider_id, bucket, aspect: str` | bucket | yes | 45 s |
| `review_bucket_security` | `provider_id, bucket` | bucket | yes | 90 s |
| `review_bucket_lifecycle` | `provider_id, bucket` | bucket | yes | 90 s |
| `review_bucket_observability` | `provider_id, bucket` | bucket | yes | 90 s |
| `review_bucket_cost_optimization` | `provider_id, bucket` | bucket | yes | 90 s |
| `review_bucket_performance_profile` | `provider_id, bucket, prefix = ""` | listing | yes | 90 s |
| `review_bucket_config` | `provider_id, bucket` | bucket | yes | 240 s |

All of these tools use read-only `GET` calls only.

- **`get_bucket_config_summary`**: encryption, versioning, policy, CORS,
  lifecycle, logging and more, with an overall status.
- **`get_bucket_config_detail`**: the sanitized detail of one `aspect`:
  `replication`, `notification`, `cors`, `logging`, `lifecycle`,
  `encryption`, `public_access_block`, `policy`, `policy_status`,
  `ownership`, `object_lock`, `acl`, `inventory`, `website`,
  `intelligent_tiering`, `accelerate`, `request_payment`, `metrics` or
  `analytics`. ARNs are reduced, values redacted, and at most 20 rules are
  returned.
- **`review_bucket_security`**: policy (anonymous and wildcard principals,
  the AWS public verdict), ACL grants, public access block, default
  encryption and CORS. Its output is fed to the estate (`ingest_review`),
  which opens, resolves or recurs issues.
- **`review_bucket_lifecycle`**: multipart cleanup, expiration, transitions
  and noncurrent versions. Also feeds the estate.
- **`review_bucket_observability`**: logging, event notifications and
  tagging.
- **`review_bucket_cost_optimization`**: lifecycle, transitions, noncurrent
  versions, incomplete uploads and cost-attribution tags.
- **`review_bucket_performance_profile`**: key layout, sizes and storage
  classes from a bounded object sample. Because it lists objects, it uses
  listing scope.
- **`review_bucket_config`**: runs the summary and the security, lifecycle,
  observability and cost reviews in one call. Behaviour:
  - Stop is checked between sections; a stopped review sets `stopped: true`.
  - A failed section never sinks the review.
  - Findings are sorted critical → warning → opportunity → good. At most 80
    are returned to the model.
  - The security and lifecycle sections feed the estate.
  - Saves a `review` artifact with up to 200 findings.

The review tools summarize as `N to fix · M findings`, where "to fix" counts
critical and warning findings.

## `account`

| Tool | Parameters | Bounds | Scope | Env. | Timeout |
| --- | --- | --- | --- | --- | --- |
| `survey_account` | `provider_id, max_buckets = 100` | `max_buckets` 1–500 | account | yes | 900 s |
| `compare_to_last_survey` | `provider_id` | — | account | yes | 30 s |
| `query_account_profile` | `provider_id, filter = "all"` | — | account | yes | 30 s |

- **`survey_account`**: `test_credentials`, then `ListBuckets`, then a
  read-only probe of each bucket. The probe covers region, public exposure,
  encryption, public access block, lifecycle, versioning, logging and
  evidence sources (inventory and access logs).
  - Bounds: at most 500 buckets (engine hard cap, `HARD_MAX_BUCKETS`), probed
    4 at a time.
  - Buckets outside the account's scope are filtered out.
  - Reports progress per bucket. Stop ends it early (`truncated: true`).
  - Undecidable checks are reported as undetermined, never as fine.
  - On success, saves a `survey` artifact with the full profile, projects it
    onto the estate, and returns `estate_changes: {opened, recurred, resolved}`.
  - The model receives the summary fields plus one short row per bucket, for
    at most 150 buckets, with a note when more rows are stored.
- **`compare_to_last_survey`**: diffs the two newest stored surveys of the
  account. Reports buckets added and removed, posture changes (a bucket that
  became public is flagged first) and evidence-source changes; at most 200
  changes are listed. No new scan. With fewer than two surveys it returns
  `comparable: false`.
- **`query_account_profile`**: answers from the newest stored survey. No new
  scan. `filter` is one of `all`, `public_buckets`, `missing_encryption`,
  `missing_public_access_block`, `missing_lifecycle`, `missing_logging`,
  `no_versioning` or `access_denied`. Buckets the survey could not decide are
  listed as undetermined.

## `files`

| Tool | Parameters | Bounds | Scope | Env. | Timeout |
| --- | --- | --- | --- | --- | --- |
| `list_uploaded_files` (core) | — | — | none | yes | 15 s |
| `analyze_uploaded_file` | `dataset_id` | — | none (task-owned) | yes | 600 s |
| `aggregate_uploaded_file` | `dataset_id, metric, group_by = "", group_by_2 = "", filters_json = "", status_min = 0, status_max = 0, limit = 20` | `limit` 1–50 | none (task-owned) | yes | 300 s |
| `import_evidence` | `provider_id, bucket, source_type, time_range_start = "", time_range_end = "", max_files = 500, max_bytes = 268435456` | clamped in the engine: `max_files` 1–500, `max_bytes` 1–256 MiB | bucket | yes | 900 s |

A `dataset_id` must belong to the current task. Any other ID returns an
`error`.

- **`list_uploaded_files`**: the task's datasets: `dataset_id`, origin,
  type, filename, size, rows once analyzed, status, and bucket for imports.
- **`analyze_uploaded_file`**: deterministic analysis of an access log or an
  inventory.
  - On first use the raw file is loaded into the dataset's DuckDB database.
    Ingest is bounded, and truncation is recorded and reported.
  - Returns metrics (lists cut to 20 entries, nested lists to 15), up to 30
    findings, and notes.
  - Raw rows never reach the model.
- **`aggregate_uploaded_file`**: one whitelisted aggregation, with the metric
  and dimensions from the engine's allow-list.
  - `filters_json` must be a JSON object.
  - The generated SQL and its parameters are removed from the result.
  - An invalid request returns the `error` plus the `allowed` surface.
  - Values from a truncated dataset carry a lower-bound note.
- **`import_evidence`**: the only data-moving tool. It downloads a
  **discovered** evidence source onto this machine and analyzes it.
  - The source must be a bucket's S3 Inventory or its server access logs, as
    found by the newest 5 `survey` artifacts of the account.
  - Bounds: **at most 500 files and 256 MiB per call**, clamped. It is
    refused unless **1 GiB of free disk** remains after the download.
  - An access-log import needs `time_range_start` and `time_range_end`
    (ISO-8601).
  - It is **stoppable**: Stop is checked before the import and between files.
  - Reports progress per file.
  - It is **audited** as `evidence.import` with
    `{source_type, files, bytes, approved_by: "agent", bounds}`.
  - It returns `{dataset_id, files, bytes, coverage: complete|partial, bounds, warnings, analysis}`.
  - A refusal (`ImportRefused`) returns an `error`, and nothing is downloaded.
  - Nothing is ever written to storage.

## `advice`

| Tool | Parameters | Scope | Env. | Timeout |
| --- | --- | --- | --- | --- |
| `triage_error` | `text: str` | none | yes | 15 s |
| `simulate_storage_cost` | `dataset_id = "", candidate_rules_json = ""` | none | yes | 300 s |

Neither tool calls storage or a model.

- **`triage_error`**: redacts the pasted text, then parses it. Returns the
  error code, HTTP status, operation, method, region, endpoint, bucket,
  request ID and SDK language when present. Also returns up to 6 candidate
  causes ordered by confidence (each with up to 5 likely causes, evidence to
  check and next checks), plus suggested skills. The causes are hypotheses.
- **`simulate_storage_cost`**: projects the storage-class mix of an inventory
  the task holds over 0–365 days, under the current lifecycle and the
  candidate rules. Without `dataset_id`, it uses the task's latest inventory.
  - Dollar figures appear only when the local price table is confirmed.
  - A missing inventory or an unconfirmed table is returned as a gap
    (`kind: "gap"`, with `gaps`).
  - `candidate_rules_json` must be valid JSON.

## Exposure over MCP

With `STORAGE_AGENT_ENABLE_MCP=1`, the read-only MCP server exposes these
tools through `call_direct` with actor `mcp`:

- every `probes`, `objects` and `config` tool except `review_bucket_config`;
- plus `list_buckets`, `head_bucket`, `read_skill`, `query_estate` and
  `triage_error`.

`note` (it writes local state) and `fix_preview` are never exposed.

See [api.md](api.md#mcp-server).
