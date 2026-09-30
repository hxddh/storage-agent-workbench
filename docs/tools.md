# Agent tools

The Agent works only through the tools registered in
`sidecar/app/agent/tools/`. This document lists every registered tool (15)
and describes the registry that binds them to the OpenAI Agents SDK.

Sources of truth: `registry.py` (`REGISTRY`, `GROUPS`, `tool`,
`build_sdk_tools`, `invoke`, `call_direct`, `run_direct`), plus the modules
`core.py`, `storage.py`, `config.py`, `account.py`, `files.py` and
`advice.py`. v10 cut the set from 30 to 15 — one tool per job, the mode
picked by an enum (see [Retired names](#retired-names)).

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
docstring. The SDK derives the tool's JSON schema and description from the
function (`registry.tool_schema`), not in strict mode, so an optional argument
stays optional and the body's default applies when the model omits it. The
schema is slimmed before it is sent (v9): no pydantic `title` keys, `Optional`
collapsed to its type, empty defaults dropped, descriptions on one line. A
fixed choice is a `Literal`, so the schema carries a real `enum` (review and
object aspects, `review_bucket_config.detail`, `probe_endpoint.check`,
`list_objects.kind`, `import_evidence.source_type`, `query_estate.status` /
`survey_filter`, the finding `severity`, the candidate-rule `kind`, the
aggregation `metric` / `group_by`). Structured arguments are typed (lists,
objects, models), never JSON inside a string; list limits are in the schema
(`maxItems`). Descriptions are one or two sentences and do not repeat the
instructions.

**Argument coercion** (`coerce_args`, v10): a parameter typed as a list or an
object that arrives as a string is coerced before the scope check and the
call — JSON when it parses as one, else (a list) a comma-separated value — so
`aspects="security"` is `["security"]`. Decorator options:

| Option | Default | Meaning |
| --- | --- | --- |
| `group` | required | one of `GROUPS` (see below) |
| `core` | `False` | always loaded, including on the Responses API |
| `timeout` | `60.0` | seconds, enforced by the SDK (`FunctionTool.timeout_seconds`) |
| `scope` | `None` | a `Scope` naming the parameters that address storage (see below) |
| `bounds` | `{}` | `{param: (lo, hi)}`: integer arguments are clamped into range; a non-integer becomes `lo` |
| `summarize` | `default_summary` | builds the tool row's note: one short English clause, at most 60 chars, real plurals (`tidy_summary`) |
| `untrusted` | `True` | wrap the model-facing result in the untrusted-data envelope |
| `max_model_chars` | `60 000` | bound on the model-facing result text (a small window lowers it per turn, see Execution) |
| `special` | `None` | `"conclusion"`: the call is recorded as a `conclusion` item, not as a tool call |
| `name` | the function name | |

`Scope(provider="provider_id", bucket="bucket", key=None, prefix=None, listing=False)`
names which arguments address storage; `listing` may be a predicate over the
arguments (a review lists objects only for its `performance` aspect). The
**scope check** (`scope_denial`) works as follows:

- `provider_id` is optional on every scoped tool (v9): with exactly one
  storage account configured, an omitted `provider_id` is that account
  (`with_default_provider`, applied before the guardrail, in `invoke` — which
  re-checks the scope of the filled-in call — and in `call_direct`). With
  several accounts, or none, an omitted `provider_id` is refused with a clear
  message.
- The `provider_id` must be a configured storage account. A refusal names
  where ids come from: `configured_providers` in a turn, `list_providers`
  over MCP.
- A bucket, key, prefix or provider id that is not a string is refused
  ("must be a string"), never coerced or crashed on.
- If a bucket parameter is set and non-empty, it must satisfy `check_scope`:
  - the bucket must be in `allowed_buckets` (when that list is non-empty);
  - an object `key` or a listing `prefix` must fall under `allowed_prefixes`
    at a path boundary;
  - a listing (`listing=True`) with no prefix is refused on a prefix-scoped
    account;
  - a key or prefix with a `..` path segment is refused on every account;
    on a prefix-scoped account a `.` segment or an empty one (`//`) is
    refused too, since a path-normalizing gateway could resolve it outside
    the prefix the check approved.
- `Scope(bucket=None)` checks only that the account exists.

### Binding: `build_sdk_tools(responses=…)`

Each tool becomes an Agents SDK `FunctionTool` with:

- `params_json_schema` from `tool_schema(td)` and `strict_json_schema=False`;
- a **scope input guardrail** (`tool_input_guardrails`) when the tool has a
  `Scope`. A denial records the call as refused (a `tool_call` item plus a
  `tool_output` item with `refused: true`, and an audit row with `ok = 0`),
  and returns `Refused: <reason>` to the model instead of running the tool;
- `timeout_seconds = timeout`;
- `defer_loading = responses and not core`.

The tool list depends on the model endpoint:

- **Responses API** (`api_style = responses`, the official OpenAI endpoint):
  - Every core tool (`core=True`, whatever its group — including
    `survey_account`, `analyze_uploaded_file` and `triage_error`) is sent
    directly, never deferred.
  - The other tools of each group become a `tool_namespace(name=group, description=GROUPS[group])`;
    they are deferred and are loaded through the hosted `ToolSearchTool`,
    which the runtime appends to the tool list.
  - The instructions tell the model which groups load on demand.
- **Chat Completions** (`api_style = chat`, every other endpoint): every tool
  is sent. There is no tool search.

The runtime runs at most 60 model steps per turn and at most 6 function tools
at once (`max_function_tool_concurrency`). A tool name the model invents is
returned to it as an error. An SDK `ToolOutputTrimmer` shortens older tool
outputs in the model input: those before the last 2 Directions to 4 000 chars
with a 600-char preview; with a window under 64k tokens, those before the
current Direction to 2 000 chars with a 400-char preview.

### Execution: `invoke(td, tool_ctx, raw_args)`

1. Parse the JSON arguments. A non-object becomes `{}`.
2. **`record_conclusion`** (`special="conclusion"`) stops here. The recorder
   validates the arguments (see its entry below), closes the open text
   segment and appends one `conclusion` item. The model receives
   `Conclusion recorded.`, or `Not recorded: <validation error>. Fix the fields and call again.`
   No `tool_call` or `tool_output` item and no audit row is written.
3. Fill in the only storage account when `provider_id` was omitted (and, if
   it was, check the scope of the filled-in call; a refusal is recorded as in
   the guardrail). Clamp with `bounds`, then redact a copy for recording.
   Record a `tool_call` item: `{call_id, name, args, target}`. The open text
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
6. **Redact** the result: the credential patterns (`redact`), then the
   **exact secret values the local vault holds** (`SecretScrubber`, built
   once per call from the in-memory vault; values under 8 chars are skipped
   and none is ever logged) — so a gateway's error that echoes a secret of no
   known shape never reaches an item, the audit or the model. The recorded
   arguments get the same. `ok` is false when the result has
   `success: false` or an `error` key. The summary comes from `summarize`,
   redacted and tidied (`tidy_summary`: `3 buckets`, never `3 bucket(s)`; one
   clause, at most 60 chars). Examples: `3 buckets, all readable; none public`
   (survey), `2 issues` (review), `12 keys, more to page` (listing),
   `imported 4 files, partial` (import).
7. **Record** a `tool_output` item:
   `{call_id, name, ok, summary, duration_ms, detail, detail_truncated, model_output}`.
   - `detail` is the redacted result as JSON, at most **24 000 chars**. The
     UI reads it.
   - `model_output` is at most 60 000 chars and is never served to the UI.
   - One audit row is written: actor `agent`, action `tool.<name>`, target
     the bucket or provider, detail `{args, summary}`.
   - The recorder then passes the result to registered `on_tool_output`
     hooks. Hooks never fail a call.
8. Return to the model the result text bounded to the smaller of
   `max_model_chars` and the turn's `model_chars` — a quarter of the model's
   context window in chars (window tokens × 4 × 0.25), at least 4 000 and never
   above 60 000 — so one survey cannot fill a 16k-token window. When it
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
  - Arguments get the same coercion, account default, `bounds` clamp and
    scope check. A refusal is audited with `ok = 0` and returns
    `{"error": "Refused: …"}`; `providers` names where ids come from
    (`list_providers` over MCP).
  - The body runs with a detached context: an empty task ID, and a recorder
    that discards progress. `turn` passes a shared context whose budgets
    persist across calls (the MCP bridge's rolling window); without it every
    call starts with fresh budgets.
  - No items are written.
  - It then goes through `run_direct`.
- **`run_direct(conn, name, args, fn, *, actor)`**: runs one read-only call,
  redacts the result (patterns and exact vault values), and writes one audit row (action `tool.<name>`, detail
  `{args}`). An exception becomes a sanitized failure result (message at most
  300 chars). Settings uses it directly for `POST /providers/clouds/{id}/test`
  (the engine's credential check, audited as `tool.test_credentials`, actor `user`). Neither function bounds the output to
  `max_model_chars` or applies the envelope.

## Groups

| Group | Tools | Description (sent as the namespace description) |
| --- | --- | --- |
| `core` | `read_skill`, `query_estate`, `fix_preview`, `note`, `record_conclusion`, `list_buckets` | Orientation: accounts, buckets, skills, the estate and the conclusion. |
| `probes` | `probe_endpoint` | Endpoint probes: reachability, region, addressing, TLS, latency. |
| `objects` | `list_objects`, `inspect_object` | Objects: listing (keys, versions, multipart uploads) and one object's metadata, preview and read tests. |
| `config` | `review_bucket_config` | Bucket configuration: the review per aspect, rule detail, performance profile. |
| `account` | `survey_account` (core) | Account-wide survey. |
| `files` | `analyze_uploaded_file` (core), `import_evidence` | Attached files and imported evidence: analyze, aggregate, import. |
| `advice` | `triage_error` (core), `simulate_storage_cost` | Deterministic advice: error triage, storage-class projection. |

Always loaded on the Responses backend (`core=True`): the six `core` tools
plus `survey_account`, `analyze_uploaded_file` and `triage_error` — every
tool the instructions' routing table names.

In the tables below, **Scope** shows the `Scope` declaration:

- *account*: `Scope(bucket=None)`; checks only that the account exists.
- *bucket*: `Scope()`; the bucket must be in scope.
- *key*: `Scope(key="key")`; the bucket and the object key (when given) must be in scope.
- *listing*: `Scope(prefix="prefix", listing=True)`; the bucket and prefix
  must be in scope, and an empty prefix is refused on a prefix-scoped account.
- *listing when sampling*: `Scope(prefix="prefix", listing=<predicate>)`;
  listing scope only when the call lists objects (the `performance` aspect).
- *none*: no storage scope.

**Env.** means the result is wrapped in the untrusted-data envelope. Every
tool's model output is bounded to 60 000 chars (less on a small window).

In the parameter columns, `provider_id` is omitted: every scoped tool takes
`provider_id: str = ""` as its last parameter (optional with one account).

Measured (Chat Completions shape, as sent): v9 had 30 tools costing 16 006
chars of schema per request; v10 has 15 tools costing about 10 300.

## `core` (always loaded)

| Tool | Parameters | Scope | Env. | Timeout |
| --- | --- | --- | --- | --- |
| `list_buckets` | — | account | yes | 30 s |
| `read_skill` | `name: str` | none | no | 15 s |
| `query_estate` | `provider_id = "", bucket = "", status: IssueStatus = "active", survey_filter: SurveyFilter \| None = None, since_last_survey = False` | none | yes | 15 s |
| `fix_preview` | `issue_id: str` | none | yes | 15 s |
| `note` | `text: str, provider_id = "", bucket = ""` | none | no | 10 s |
| `record_conclusion` | `findings: list[Finding] (≤ 8) \| None = None, next_steps: list[str] (≤ 4) \| None = None` | none | no | 10 s |

- **`list_buckets`**: read-only `ListBuckets` for the account. It is also the
  credential check: success means the keys work; `InvalidAccessKeyId` /
  `SignatureDoesNotMatch` mean they or the signing are wrong; `AccessDenied`
  means they authenticate but may not list; `provider_unsupported` is a
  capability gap, not bad keys.
  - On an account with `allowed_buckets`, the list is **filtered to that
    scope** (inside a turn and over MCP alike) and says so (`scope`); a
    bucket outside the scope is never named.
  - Routing headers, host ids and success request ids are dropped (`quiet`).
- **`read_skill`**: returns one method card, bundled or user-supplied, as
  named in the skills catalog (bundled cards show without their
  `storageops-` prefix; both spellings load). The names of the skills folded
  into a card in v10 still load that card (`aliases` in
  `skill-registry.yaml`), so a replayed call keeps working.
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
  - With `survey_filter` it answers from the account's newest stored survey
    instead (`provider_id`, or the only account; with several accounts and
    none named → `error`). No new scan.
    `survey_filter` is one of `all`, `public_buckets`, `missing_encryption`,
    `missing_public_access_block`, `missing_lifecycle`, `missing_logging`,
    `no_versioning` or `access_denied`; anything else → `error`. Buckets the
    survey could not decide are listed as undetermined; with no survey it
    returns `has_survey: false`.
  - With `since_last_survey` (v10, absorbing `compare_to_last_survey`) it
    diffs the two newest stored surveys of the account: buckets added and
    removed, posture changes (a bucket that became public first) and
    evidence-source changes, at most 200 changes. With fewer than two surveys
    it returns `comparable: false`.
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
- **`record_conclusion`**: records the turn's findings and next steps (see
  [Execution](#execution-invoketd-tool_ctx-raw_args), step 2), once, right
  before the final answer; the window shows them under the answer. The
  schema carries `maxItems` 8 / 4. The arguments are validated by the
  recorder's `Conclusion` model:
  - `findings`: optional, at most 8, each `Finding {title: 1–240 chars, severity: high|medium|low|info, detail?: ≤ 600 chars}`;
  - `next_steps`: optional, at most 4, each cut to 200 chars;
  - at least one finding or next step (v9: there is no `answer` field — the
    answer is the Turn's final message).

  The conclusion is redacted. When the model calls it more than once, each
  call appends a new `conclusion` item. A conclusion recorded before v9 may
  still carry `answer`; it is read (the report) but never written.

## `probes`

| Tool | Parameters | Bounds | Scope | Env. | Timeout |
| --- | --- | --- | --- | --- | --- |
| `probe_endpoint` | `bucket = "", check: reach\|location\|addressing\|tls\|latency = "reach", key = "", samples = 5` | `samples` 1–10 | key | yes | 60 s |

- **`probe_endpoint`** (v10, absorbing `head_bucket`, `get_bucket_location`,
  `test_addressing_style`, `inspect_endpoint_tls` and
  `measure_request_latency`). Every result carries `check`. `check`:
  - `reach`: one `HeadBucket` — does the bucket exist and answer?
  - `location`: one `GetBucketLocation`: `bucket_region`, the configured
    region and endpoint, and `region_mismatch` (a 301 still answers from its
    `x-amz-bucket-region` header).
  - `addressing`: two `HeadBucket` calls, virtual-hosted and path-style, and
    the style that works (`recommendation`); on an IP endpoint only
    path-style is testable.
  - `tls`: the custom endpoint's TLS certificate (version, subject, issuer,
    validity); no bucket needed. An account on the default AWS endpoint
    returns `no_endpoint`.
  - `latency`: `samples` `HeadBucket` round-trips (`HeadObject` on `key`);
    min, p50, p95, max and mean in ms. Budget: 8 runs per turn.
  - Any check but `tls` without a bucket → `error`.
  - Summary: `reachable`, `region eu-west-1, mismatch`, `addressing: path`,
    `TLSv1.3`, `p50 12.5 ms, p95 40.1 ms`.

## `objects`

| Tool | Parameters | Bounds | Scope | Env. | Timeout |
| --- | --- | --- | --- | --- | --- |
| `list_objects` | `bucket, kind: keys\|versions\|uploads = "keys", prefix = "", max_keys = 200, page_token = "", recursive = False` | `max_keys` 1–1000 | listing | yes | 60 s |
| `inspect_object` | `bucket, key, aspects: list[head\|attributes\|lock\|acl\|tags\|preview\|range\|conditional] \| None = None, version_id = "", etag = "", byte_range = "bytes=0-1023", preview_kib = 256` | `preview_kib` 1–1024 | key | yes | 60 s |

- **`list_objects`**: one page of a listing, no bodies. Every result carries
  `kind` and `next_token` (null on the last page); the caller pages with
  `page_token` set to it. `kind`:
  - `keys` (the default): `ListObjectsV2`, delimiter `/` unless `recursive`.
    `objects` carries size, storage class, last-modified and restore status
    for the first 100 keys; `keys` then lists only the keys beyond them
    (dropped when `objects` covers the page); `sample_keys` is gone.
  - `versions` (absorbing `list_object_versions`): versions and delete
    markers — counts, current and noncurrent bytes, `sample_versions` with
    version ids.
  - `uploads` (absorbing `list_multipart_uploads`; `list_upload_parts` is
    retired): incomplete multipart uploads — count, oldest initiation, and
    `sample_uploads` with each upload's **key and `upload_id`**, initiation
    time and storage class. Aborting an upload does not exist as a tool.
  - `versions` / `uploads` carry two S3 markers in one opaque token.
  - `provider_unsupported: true` means the listing is not available there,
    never "none found"; a truncated page is a lower bound.
  - Summary: `N keys` / `N versions` / `N open uploads` (with `, more to page`).
- **`inspect_object`**: one object. `aspects` picks the reads; the default
  is `head` alone (one `HeadObject`, the cheapest):
  - `head`: `HeadObject` metadata, with sanitized user metadata;
  - `attributes`: `GetObjectAttributes` (checksum, parts, storage class,
    size); `provider_unsupported` where the provider lacks it;
  - `lock`: retention mode, retain-until date and legal hold;
  - `acl`: the object's ACL, grantees reduced to a kind, `is_public` set for
    a public grant;
  - `tags`: the tag set, at most 20 tags, keys and values redacted;
  - `preview` (absorbing `preview_object`): a bounded, sanitized preview of
    the first `preview_kib` KiB (at most 1 MiB). Gzip is decompressed within
    the bound, Parquet returns its structure only, binary content is reported
    rather than decoded, and secrets are redacted. Budgets per turn: 16
    objects and 24 MiB read in total — each read is clamped to what is left
    of the byte budget before it runs;
  - `range` (absorbing `test_object_read` mode range): a GET of `byte_range`
    (bounded; at most 4 MiB). Budget: 12 range reads per turn;
  - `conditional`: `HeadObject` with `If-None-Match: etag`, no body; returns
    `etag_matches`. `etag` is required.

  One aspect returns that read's result as is; several return
  `{bucket, key, <aspect>: result…, success}`, checking Stop between reads.
  When some reads failed, `partial: true` and `failed: [aspects]` say which
  (an unreadable ACL is not "not public"); `success` is true when any read
  succeeded. An unknown aspect → `error`. Summary: `N bytes`, or
  `partial: acl failed`.

Every storage result drops the noise (`quiet`): the host id, the request id
of a successful call, and routing headers (`server`, `date`,
`x-amz-request-id`, `x-amz-id-2`, …). A failure keeps its request id — the
first thing a provider's support asks for.

## `config`

| Tool | Parameters | Scope | Env. | Timeout |
| --- | --- | --- | --- | --- |
| `review_bucket_config` | `bucket, aspects: list[summary\|security\|lifecycle\|observability\|cost\|performance] \| None = None, detail: DetailAspect \| None = None, prefix = ""` | listing when sampling | yes | 240 s |

Read-only `GET` calls only, plus a bounded object sample for `performance`.

- **`review_bucket_config`**: the configuration review. `aspects` picks any
  of the following; omitted (or empty, and no `detail`), it runs the first
  five, in this order:
  - `summary`: encryption, versioning, policy, CORS, lifecycle, logging and
    more, with an overall status;
  - `security`: policy (anonymous and wildcard principals, the AWS public
    verdict), ACL grants, public access block, default encryption and CORS;
  - `lifecycle`: multipart cleanup, expiration, transitions and noncurrent
    versions;
  - `observability`: logging, event notifications and tagging;
  - `cost`: transitions, incomplete uploads and cost-attribution tags. With
    `lifecycle` in the same call, the cost findings and facts that repeat it
    are dropped;
  - `performance` (absorbing `review_bucket_performance_profile`; only on
    request): key layout, sizes and storage classes from a bounded object
    sample under `prefix`. It lists objects, so on a prefix-scoped account it
    needs an in-scope `prefix`.

  `detail` (absorbing `get_bucket_config_detail`) adds the sanitized rules of
  one aspect — `replication`, `notification`, `cors`, `logging`,
  `lifecycle`, `encryption`, `public_access_block`, `policy`,
  `policy_status`, `ownership`, `object_lock`, `acl`, `inventory`,
  `website`, `intelligent_tiering`, `accelerate`, `request_payment`,
  `metrics` or `analytics` — as `detail: {<aspect>: {aspect, status, rules,
  rule_count}}`. ARNs are reduced, values redacted, at most 20 rules. With
  `detail` and no `aspects`, only that read runs. `policy_status` is the
  verdict on the policy only; combine it with `acl` before calling a bucket
  public.

  Behaviour:
  - An unknown aspect or detail → `error`, nothing runs.
  - Returns `{success, bucket, aspects, sections: {<aspect>: status…}, findings, detail?}`.
    With one read that could not be made, `success` is false.
  - Stop is checked between aspects; a stopped review sets `stopped: true`.
  - A failed aspect never sinks the review.
  - Findings carry their `section` and are sorted critical → warning →
    opportunity → good; a finding repeated across sections is listed once.
    At most 80 are returned to the model.
  - A finding that asserts an estate Issue (its title is one of the rule's
    `review_titles` in `estate/rules.py`, for that aspect) carries
    `issue: {title, severity}` — the rule's canonical title (in the
    `language` setting) and product severity — so the model's findings and
    the home name the Issue alike.
  - Each `security` and `lifecycle` aspect it ran is fed to the estate
    (`ingest_review`, one aspect at a time), which opens, resolves or recurs
    issues. An aspect it did not run decides nothing.
  - Inside a task it saves a `review` artifact with up to 200 findings (the
    title names the aspects when not the default five ran). Over MCP there is
    no task, so no artifact.

Summary: `N issues` (distinct estate Issues it found), else `N warnings`
(critical and warning findings), else `<aspect>: <status>` for a detail
read, else `nothing to fix`.

## `account`

| Tool | Parameters | Bounds | Scope | Env. | Timeout |
| --- | --- | --- | --- | --- | --- |
| `survey_account` (core) | `max_buckets = 100` | `max_buckets` 1–500 | account | yes | 900 s |

- **`survey_account`** (core since v9: always loaded, never deferred): a credential check, then `ListBuckets`, then a
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
    at most 150 buckets, with a note when more rows are stored. A row whose
    posture asserts an estate Issue lists its rule codes in `issues`, and the
    result's `issues` maps each code to the rule's canonical `{title, severity}`.
  - Summary: `12 buckets, 2 unreadable; 1 public` (or `all readable`,
    `none public`, `public unknown for N`).

Posture questions over the newest survey, and what changed since the survey
before it, go through `query_estate` (`survey_filter`, `since_last_survey`).

## `files`

| Tool | Parameters | Bounds | Scope | Env. | Timeout |
| --- | --- | --- | --- | --- | --- |
| `analyze_uploaded_file` (core) | `dataset_id = "", metric: Metric \| None = None, group_by: list[Dimension] (≤ 2) \| None = None, filters: dict[str, str] \| None = None, status_min = 0, status_max = 0, limit = 20` | `limit` 1–50 | none (task-owned) | yes | 600 s |
| `import_evidence` | `bucket, source_type: inventory\|access_log, time_range_start = "", time_range_end = "", max_mib = 256` | clamped in the engine: 500 files, 1–256 MiB | bucket | yes | 900 s |

A `dataset_id` must belong to the current task. It comes from the
attachment line of the Direction (`[Attached: access.log · dataset_id=… ·
kind=access_log]`) or from `import_evidence`'s result; `list_uploaded_files`
is retired. An unknown ID returns an `error` listing the task's datasets
(id, filename, kind; at most 10).

- **`analyze_uploaded_file`** (v10, absorbing `aggregate_uploaded_file`):
  without `metric`, the deterministic analysis of an access log or an
  inventory; without `dataset_id`, the task's newest dataset.
  - On first use the raw file is loaded into the dataset's DuckDB database.
    Ingest is bounded, and truncation is recorded and reported.
  - Returns metrics (lists cut to 20 entries, nested lists to 15), up to 30
    findings, and notes.
  - With `metric`: one whitelisted aggregation, grouped by up to two
    `group_by` dimensions and narrowed by `filters` (equality on a
    dimension) and, for logs, `status_min` / `status_max`. `group_by` or
    `filters` without `metric` → `error`.
  - One metric vocabulary for both kinds (`Metric`): `count`, `sum_bytes`,
    `avg_bytes`, `min_bytes`, `max_bytes` (bytes sent for a log, object size
    for an inventory), the latency percentiles, `distinct_ips`,
    `distinct_keys`, `distinct_prefixes`, `distinct_storage_classes`.
    Dimensions (`Dimension`): `status_code`, `method`, `error_code`,
    `prefix`, `key`, `path`, `user_agent`, `client_ip_masked`, `hour`,
    `day`, `weekday` (logs); `storage_class`, `bucket`, `prefix` (inventories).
  - The generated SQL and its parameters are removed from the result; values
    from a truncated dataset carry a lower-bound note. Raw rows never reach
    the model.
- **`import_evidence`**: the only data-moving tool. It downloads a
  **discovered** evidence source onto this machine and analyzes it.
  - The source must be a bucket's S3 Inventory or its server access logs, as
    found by the newest 5 `survey` artifacts of the account.
  - Bounds: **at most 500 files and 256 MiB (`max_mib`) per call**, clamped.
    It is refused unless **1 GiB of free disk** remains after the download,
    and the **decompressed output** (gzip members, the combined log/CSV, the
    combined Parquet) is budgeted against the free space left after the
    download minus the same 1 GiB, re-checked every 64 MiB written; the
    per-member (1000:1) and per-combine (16 GiB) decompression caps still hold.
    Running out stops the import and keeps nothing.
  - An access-log import needs `time_range_start` and `time_range_end`
    (ISO-8601).
  - It is **stoppable**: Stop is checked before the import and between files.
  - Reports progress per file.
  - It is **audited** as `evidence.import` with
    `{source_type, files, bytes, approved_by: "agent", bounds}`.
  - It returns `{dataset_id, files, bytes, coverage: complete|partial, bounds, warnings, analysis}`.
  - A refusal (`ImportRefused`) returns an `error`, and nothing is kept.
  - Nothing is ever written to storage.

## `advice`

| Tool | Parameters | Scope | Env. | Timeout |
| --- | --- | --- | --- | --- |
| `triage_error` (core) | `text = "", url = ""` | none | yes | 15 s |
| `simulate_storage_cost` | `dataset_id = "", candidate_rules: list[CandidateRule] \| None = None` | none | yes | 300 s |

Neither tool calls storage or a model.

- **`triage_error`**: redacts the pasted text, then parses it. Returns the
  error code, HTTP status, operation, method, region, endpoint, bucket,
  request ID and SDK language when present. Also returns up to 6 candidate
  causes ordered by confidence (each with up to 5 likely causes, evidence to
  check and next checks), plus `suggested_skills` (the card a category maps
  to; a category no card covers suggests none). The causes are hypotheses.
  - A presigned URL — in `url`, or found in `text` (v10, absorbing
    `diagnose_presigned_url`) — is parsed with no request: signature
    version, expiry, credential scope (date, region, service), signed
    headers, addressing style and a list of problems (`presigned_url`). The
    signature, key id and token never reach the parser or the result; the
    URL suggests the protocol-compat card.
  - Neither `text` nor `url` → `error`.
- **`simulate_storage_cost`**: projects the storage-class mix of an inventory
  the task holds over 0–365 days, under the current lifecycle and the
  candidate rules. Without `dataset_id`, it uses the task's newest inventory.
  - `candidate_rules` are typed (v10; no JSON in a string):
    `CandidateRule {kind: transition|expiration|abort_mpu, days: 0–3650, storage_class?, prefix?}`.
  - It produces no dollar figures (v8): bytes per storage class only.
  - A missing inventory or an unconfirmed table is returned as a gap
    (`kind: "gap"`, with `gaps`).

## Exposure over MCP

With `STORAGE_AGENT_ENABLE_MCP=1`, the read-only MCP server exposes these
tools through `call_direct` with actor `mcp`:

- every `probes`, `objects` and `config` tool (`probe_endpoint`,
  `list_objects`, `inspect_object`, `review_bucket_config` — which keeps no
  artifact there);
- plus `list_buckets`, `read_skill`, `query_estate` and `triage_error`.

`note` (it writes local state), `record_conclusion`, `fix_preview`,
`survey_account`, `import_evidence`, `analyze_uploaded_file` and
`simulate_storage_cost` are never exposed.

What the bridge returns (v10):

- an enveloped **text** result for every enveloped tool — the same
  untrusted-data envelope as inside a turn (`read_skill` stays plain);
- budgets (previews, ranged reads, latency runs, skill loads) that hold
  **across MCP calls** for a rolling 10-minute window
  (`mcp.budget_turn`), instead of a fresh budget per call;
- refusals that name the bridge's own `list_providers` tool.

## Retired names

Tasks recorded before this set keep their calls under the old names. v8
retired `get_bucket_config_summary`, `review_bucket_security`,
`review_bucket_lifecycle`, `review_bucket_observability`,
`review_bucket_cost_optimization`, `head_object`, `get_object_attributes`,
`get_object_lock_status`, `get_object_acl`, `get_object_tagging`,
`test_conditional_get`, `test_range_get`, `test_credentials` and
`query_account_profile`. v10 retired:

| Retired | Now |
| --- | --- |
| `head_bucket` | `probe_endpoint(check="reach")` |
| `get_bucket_location` | `probe_endpoint(check="location")` |
| `test_addressing_style` | `probe_endpoint(check="addressing")` |
| `inspect_endpoint_tls` | `probe_endpoint(check="tls")` |
| `measure_request_latency` | `probe_endpoint(check="latency", key, samples)` |
| `diagnose_presigned_url` | `triage_error(url=…)` |
| `list_object_versions` | `list_objects(kind="versions")` |
| `list_multipart_uploads` | `list_objects(kind="uploads")` (with upload ids) |
| `list_upload_parts` | — (the upload id and initiation time are in `sample_uploads`) |
| `test_object_read` | `inspect_object(aspects=["conditional"], etag)` / `(aspects=["range"], byte_range)` |
| `preview_object` | `inspect_object(aspects=["preview"], preview_kib)` |
| `get_bucket_config_detail` | `review_bucket_config(detail=…)` |
| `review_bucket_performance_profile` | `review_bucket_config(aspects=["performance"], prefix)` |
| `list_uploaded_files` | the attachment line; an unknown `dataset_id` lists the task's datasets |
| `aggregate_uploaded_file` | `analyze_uploaded_file(metric, group_by, filters)` |
| `compare_to_last_survey` | `query_estate(since_last_survey=true)` |

History replay (`agent/session.py:to_input`) sends them back as past
function calls with their outputs; nothing checks a replayed name against
the registry.

See [api.md](api.md#mcp-server).
