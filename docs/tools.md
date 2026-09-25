# Agent tools and capability contract

> **Storage Agent v2.2.0.** Since v2.2 every tool is callable from the first step (the grouped `load_tools` disclosure applies only to context windows ≤ 16k tokens), `survey_account` and `import_evidence` report real counts as durable `tool.progress` events, and Stop ends an import between files. Tool surface otherwise unchanged from v1.02.0 except for gated `GET /skills`, `GET /.*export/otel` (now with derived spans), `GET /mcp.*` + executing `POST /mcp/tools/call`, local-model provider types, `record_conclusion` (v2.0), and — v2.1 — no approval gate and no `update_plan`: `import_evidence` is bounded server-side instead of gated, and `survey_account` runs to its 500-bucket hard cap without asking. Agent-accessible capabilities are explicit, typed, whitelisted, bounded, sanitized, and read-only except for the one bounded data-movement tool documented below.

This document describes capability classes available to the one model-driven Agent runtime plus deterministic compute it can invoke. It is not a promise that every internal S3 helper is a public Agent tool or HTTP route.

## Invariants

Never expose to the Agent:

- a generic shell or arbitrary command execution;
- raw subprocess execution;
- a raw boto3/botocore client;
- unrestricted filesystem access;
- arbitrary SQL;
- destructive or mutating S3 APIs;
- unbounded object-body download;
- plaintext cloud/model credentials.

Every tool must enforce the relevant provider bucket/prefix scope server-side and must sanitize data before it is persisted or returned into model context.

## Capability groups

### Provider discovery

#### `list_providers`

Returns configured cloud-provider identities and safe metadata so the Agent can select a provider. It never returns credential values.

## S3-compatible diagnostics and object inspection

### `test_credentials`

Validates that a configured provider can be used through bounded read-only checks.

### `list_buckets`

Read-only ListBuckets-style enumeration of visible buckets. It does not list object bodies or mutate storage.

### `head_bucket`

Checks bucket reachability/access.

### `get_bucket_location`

Determines the bucket's real region/location where supported and compares it with configured region/endpoint context.

Important semantics:

- AWS empty `LocationConstraint` maps to `us-east-1` only in the AWS case;
- custom endpoints without region partitioning may legitimately produce unknown rather than a fabricated mismatch;
- `x-amz-bucket-region` may provide the useful answer on redirects;
- unsupported provider capability is represented as `provider_unsupported`.

### `list_objects`

The Agent-facing bounded ListObjectsV2 capability. The internal helper/HTTP compatibility route may use the name `list_objects_v2`.

Safety/behavior:

- explicit page, never automatic unbounded recursive scan;
- bounded `max_keys`, clamped by hard runtime limits;
- continuation-token paging is explicit;
- returned key/object samples are bounded and sanitized;
- object bodies are not returned;
- size/storage-class/mtime metadata may be included for bounded sample entries.

### `head_object`

Reads one object's metadata without downloading the body. May include size, ETag, timestamps, storage class, restore/archive state, parts/version/content/cache metadata, and other safe headers supported by the provider.

### `get_object_attributes`

Reads one object's supported attribute summary such as checksum/parts/storage class/size. Provider gaps are normal `provider_unsupported` outcomes.

### `get_object_lock_status`

Reads retention/legal-hold state for one object/version.

A hard lookup error must not be rendered as “no lock”; unknown/error is distinct from a successful empty lock state.

### `get_object_acl`

Reads one object's ACL with identity reduction. Public grants can be represented, but owner/canonical ids/emails are not exposed to the model.

### `get_object_tagging`

Reads one object's tag set, bounded and redaction-passed.

### `list_object_versions`

Reads one bounded page of object versions/delete markers with bounded sample detail. No body reads.

### `list_multipart_uploads`

Reads bounded in-progress multipart-upload metadata. There is no AbortMultipartUpload mutation tool.

### `list_upload_parts`

Reads bounded part metadata for one in-progress upload. No abort/mutation.

### `test_range_get`

Performs a bounded Range GET diagnostic. A single call and cumulative turn usage are capped so this cannot become a full-object or bulk downloader.

### `test_conditional_get`

Uses read-only conditional metadata behavior (for example ETag/If-None-Match semantics) without retrieving an object body.

### `preview_object`

Reads a bounded, sanitized preview of one named object when safe and useful.

Current safety contract:

- hard per-call byte cap;
- cumulative per-turn preview budget;
- never persisted as an unrestricted body dump;
- binary/oversized unsupported content is reported rather than decoded;
- gzip handling stays inside the bounded preview contract;
- Parquet preview is structure-oriented through bounded metadata/footer access rather than full-object download;
- CSV/TSV/JSON-style previews can expose bounded structure summaries from the same preview bytes.

### `measure_request_latency`

Runs a small bounded set of read-only HEAD-style probes and returns measured latency statistics. It is a diagnostic probe, not a load generator.

### `diagnose_presigned_url`

Purely parses a user-supplied presigned URL to diagnose expiry/scope/signature/addressing properties.

It makes no network request and drops/redacts signature/access-key/session-token material before model context.

### `test_addressing_style`

Compares path-style and virtual-hosted-style behavior through bounded read-only probes.

### `inspect_endpoint_tls`

Inspects endpoint TLS behavior/certificate properties needed for storage diagnosis. It does not provide a generic network scanner.

## Bucket/account configuration capabilities

### `get_bucket_config_summary`

Returns a sanitized bounded summary across supported read-only bucket configuration APIs, including capability/access status. It can surface region mismatch and configuration posture without sending raw provider responses to the model.

### `get_bucket_config_detail`

Reads sanitized detail for a single supported configuration aspect, such as:

- replication;
- notification;
- CORS;
- logging;
- lifecycle;
- encryption;
- public access block;
- policy / policy public-status;
- ownership controls;
- bucket object lock;
- ACL;
- inventory;
- website;
- intelligent tiering;
- acceleration;
- requester pays;
- metrics;
- analytics.

Rules/identities/ARN-like values are reduced/redacted/bounded. Unsupported APIs return `provider_unsupported` rather than becoming a false negative.

### Review helpers

Current deterministic/read-only review capability includes:

- `review_bucket_security`
- `review_bucket_lifecycle`
- `review_bucket_observability`
- `review_bucket_cost_optimization`
- `review_bucket_performance_profile`

### `survey_account`

Runs bounded deterministic account discovery/config snapshot work for the current Agent Task. It is real execution, not a second Agent.

The result is persisted and sanitized; raw object rows/bodies are not sent to the model.

`max_buckets` (optional, 1–500) raises the per-survey bucket cap for large accounts: default 100 when not given, hard cap 500 (larger values are clamped). Since v2.1 a larger survey runs without asking — the v1.12–v2.0 `survey_account_large` gate is gone — and the result's `truncated` flag reports whether buckets were left out.

While the survey runs (v2.2), the engine (`runs/account_discovery_run._probe_buckets`) reports each finished bucket through `app/progress.py`, keyed by its run id; `survey_account` binds that key to its tool call only while the call waits (`_execute_run(on_progress=...)`), and the runtime writes a durable, throttled `tool.progress` event (`unit: "buckets"`; at most one per call per second plus the final one, ≤ 120 per call). Counts only — never a percentage from time, never row data. The running tool row reads *120 of 500 buckets* with a hairline meter.

### `review_bucket_config`

Runs the deterministic bucket-review engine as Agent-invoked Execution and returns bounded sanitized result context.

### `query_account_profile`

Answers account-wide posture questions from the latest persisted sanitized survey without re-scanning S3. Supported filters are hard-whitelisted.

It must report survey truncation/coverage so a partial account sample is not presented as complete posture.

### `compare_to_last_survey`

Computes deterministic differences between the two most recent compatible persisted account surveys. It performs no new S3 call and no model-side diff over raw data.

### `read_run_result`

Reads the result of a deterministic execution already associated with the Agent's work. A bounded wait can allow a still-running compatible execution to complete in the same Agent turn.

## Local uploaded evidence analysis

Files attached to an Agent Task are local evidence, not cloud data movement.

### `list_uploaded_files`

Lists safe metadata for files attached to the current Task.

### `analyze_uploaded_file`

Runs the deterministic local analysis path over a supported Task attachment and returns bounded sanitized metrics/findings to the Agent.

### `aggregate_uploaded_file`

Allows one constrained aggregation when fixed metrics do not answer the question.

Safety contract:

- metric/group/filter choices come from hard whitelists;
- filter values are bound parameters;
- the Agent never supplies SQL;
- only grouped aggregate results return to the model;
- group count/result size is bounded;
- SQL + parameters are audit-recorded;
- truncation is explicit.

## Deterministic inventory/access-log engines

Underlying deterministic capability includes:

### Access logs

- `detect_log_format`
- `import_access_logs`
- `analyze_access_logs`

### Inventory

- `import_inventory_file`
- `analyze_inventory`

These engines may be invoked through Task attachments, deterministic executions, or managed Evidence Import. Raw rows stay in local analysis storage; the model receives only bounded sanitized output.

## Managed cloud Evidence Import

Cloud evidence movement is the ONE data-moving tool. Since v2.1 it is **bounded, not gated**: it runs inside the Execution with no Decision and no pause, within a hard server-side envelope the model cannot widen (`sidecar/app/agent_runtime/import_tools.py`, formerly `gated_tools.py`).

### `import_evidence`

Group `evidence_import`. Args: `source_type` (`inventory` | `access_log`), `bucket_name`, optional `account_run_id` (defaults to the Task's latest completed account survey), `time_range_start` / `time_range_end` (required for access logs), optional `max_files` / `max_bytes` (clamped server-side). The tool:

1. validates the target against an evidence source DISCOVERED by the task's account survey (never an arbitrary bucket/key) and plans the bounded download (read-only listing) through `app.evidence.import_service`;
2. clamps the plan to at most 500 files / 256 MiB per call (`AGENT_MAX_FILES` / `AGENT_MAX_BYTES`), whatever the model asked for; the result says when coverage is partial;
3. refuses with nothing downloaded when the data directory would keep less than 1 GiB free;
4. checks Stop before downloading and, since v2.2, before each file (`managed_import.download_and_combine(on_file=..., cancel_event=...)` raises `ImportStopped`; the tool answers "status: stopped — … nothing was kept"). Stop ends the Execution; the storage side stays read-only;
5. confirms and runs the import through the confirm → run path, audited as `approved_by="agent"` (`approval_events` + `audit_logs`), starts the deterministic analysis, links the run, indexes the `evidence_import` Artifact, and returns a bounded status line (files, bytes) to the model. It shows as an ordinary tool row; while files download, each finished file is a durable `tool.progress` event (`unit: "files"`, same throttle as the survey).

The workflow is:

> **plan → bounded, agent-confirmed, audited execution**

The v1.11–v2.0 inline approval (Decision, `approval.opened`, `waiting`, Allow / Allow for this task / Deny) and the v1.12 approval policy were removed in v2.1. No prose proposal can raise the tool, and it re-validates limits during download.

See `security.md` and `api.md`.

## Deterministic optimization tools

These tools never send raw inventory or access-log rows to the model. They operate on bounded aggregates already on the Task, plus ordinary local configuration. Dollar figures and trends are estimates with coverage, or explicit gaps.

### `simulate_storage_cost`

Projects storage-class mix and monthly cost under candidate lifecycle rules (transition / expiration / abort-MPU) using this Task's bounded inventory aggregates, current lifecycle facts, and the local price table. Missing inventory → `kind=gap`. Unconfirmed prices withhold dollars (`price_unconfirmed`). Abort-MPU savings are not invented when MPU inventory is absent.

### `draft_remediation_plan`

Writes a versioned `remediation_plan` Artifact: pasteable lifecycle JSON fragments, finding/Evidence refs, simulator impact with coverage, and a verification checklist. The plan is local. Applying it is the operator's job in their console/CLI.

### `verify_remediation_plan`

Diffs the latest plan against the latest read-only lifecycle review already on the Task. Classifies each action `applied` / `not_applied` / `partial` / `cannot_verify` and writes plan status `verified` / `partially_verified` / `proposed` / `stale`. Does not call mutating APIs.

### `capture_task_baseline`

Persists a versioned bounded snapshot (inventory overview, lifecycle facts, findings, context version). Not raw rows.

### `compare_task_drift`

Compares the current bounded snapshot to the latest baseline. Findings are classified added / resolved / still present. Missing baseline is an explicit gap, never a fabricated trend. Records a `drift_report` Artifact.

### `get_price_table_status`

Shows whether the local price table is still the example schedule or has been confirmed. Never contains credentials.

### `set_task_revisit_days`

Sets this Task's optional revisit interval (1–365 days) or disables it. Revisits are read-only Executions submitted through `runtime.submit` when the Sidecar is running.

## Plan tool (removed in v2.1)

`update_plan` (v1.12–v2.0: a model-kept checklist emitted as `plan.updated` events and one `plan` turn item) was removed in v2.1 together with `agent_runtime/plan_tools.py`. The model keeps no plan the UI renders; stored pre-2.1 `plan` items are dropped on read.

## Conclusion tool (v2.0)

### `record_conclusion`

Args:
- `answer`: the direct answer in one or two sentences, at most 400 characters.
- `findings`: a list of `{title, severity, detail}`. `severity` is one of `high`, `medium`, `low` or `info`; aliases such as `critical` or `warning` map onto that set, and unknown values become `info`. At most 8 findings; titles are at most 140 characters and details at most 400.
- `next_steps`: at most 4 follow-ups of at most 160 characters each.

The model calls this tool once, right before its final answer, whenever the Direction asked it to investigate, diagnose, review or estimate something. The last call of a turn wins.

What the runtime does with it:
- appends a `conclusion.recorded` event;
- persists the conclusion on the assistant message (`session_messages.conclusion`) and on the durable Work Result (`work_results.conclusion_json_sanitized`, migration 031);
- shows it at the top of the Task as the Work Result's head.

Constraints:
- Every string is redacted and has hidden reasoning stripped.
- The tool executes nothing, is budget-exempt, and is never a tool row.
- Evidence and gaps are not model-claimed here. They stay derived from the tool trace.
- A turn without this call has no conclusion. The UI then shows the answer only and never guesses a head from the prose.

## Task memory tools

The Agent can maintain durable sanitized working memory through tools equivalent to:

- note a fact;
- record a finding;
- note an open question;
- update/correct a memory item;
- resolve/close a memory item.

These records are replayed into later Task work according to runtime bounds and are auditable. They are not hidden chain-of-thought.

## Skills

### `read_skill`

Loads first-party StorageOps guidance on demand. Skill text is trusted first-party instruction by design; the tool does not execute arbitrary scripts from the skill.

## MCP bridge tools (stateless subset, v1.13)

`POST /mcp/tools/call` (behind `STORAGE_AGENT_ENABLE_MCP=1`) executes the
stateless read-only tools — S3/config/review reads, `diagnose_presigned_url`,
`inspect_endpoint_tls`, `read_skill`, `get_price_table_status` — through the
same S3 layer with the same scope/input clamps, recorded via `run_tool`.
Session-bound tools (`survey_account`, `query_account_profile`,
`compare_to_last_survey`, `list_uploaded_files`) are intentionally not
exposed: the bridge is stateless and they need a Task's runs. Consuming
third-party MCP servers is not implemented (`GET /mcp/client/status`).

## Read-only fanout (v1.13)

The account survey fans bucket shards across `_PROBE_WORKERS = 4` threads
inside the deterministic executor and merges as ONE `survey_account` tool row
(`fanout_workers` in the result). This is the product's single-agent fanout:
no sub-agent fleet, shared turn budget, per-bucket failures isolated. The
bound is pinned by `test_v113_native_fanout.py`.

## Bounds are not gates (v1.13)

Per-turn preview/range/latency budgets degrade into a synthesize note when
spent — they never raise a Decision. Since v2.1 nothing pauses an execution:
the former gates (`import_evidence`, `survey_account_large`) are now hard
server-side bounds too (≤ 500 files / 256 MiB per import call, clamped; disk
headroom; a survey never exceeds 500 buckets and reports `truncated`).

## Report capability

### `generate_markdown_report`

Produces a durable report from sanitized task/execution/evidence state under the existing report-generation contract. Reports do not contain secret values, raw chain-of-thought, or unrestricted raw rows.

## Tool-result trust boundary

Storage/object/config/file content is untrusted external data, including text that may look like instructions.

The Agent runtime must keep external Tool data inside the untrusted-data envelope implemented in `agent_runtime/session_agent.py` (historical module name) and defang nested marker text so untrusted data cannot escape the boundary.

First-party skill guidance and runtime control/status notes have separate trust semantics.

## Tool disclosure (v0.55; small windows only since v2.2)

Every tool is callable from the first step. `limits.tools_gated(model, explicit_window)` decides, from the resolved context window, whether the v0.55 progressive tool-group gate applies: only when the window is ≤ 16,384 tokens (`_GATED_WINDOW_MAX`). Otherwise all groups are open, `load_tools` is **not registered**, and the instructions (`prompt.INSTRUCTIONS`) say every tool is callable from the first step. A small-window model gets `prompt.INSTRUCTIONS_GATED` (the group catalog) and the grouped `load_tools(group)` disclosure; a call to a tool in a locked group is answered with the group to load. The runtime decides which applies, never the model. Gating is a context-size measure, not a safety bound: every tool keeps its own bounds either way.

## Per-turn budgets

Per-tool limits are supplemented by cumulative turn budgets.

Current model budgeting uses the active model's context window, with explicit provider overrides available for context window and max output where needed. Larger model windows may permit deeper bounded sanitized context, but **security-floor limits do not scale up** merely because the model context is larger.

Do not relax:

- object preview/range byte caps;
- list/sample caps;
- ingest caps;
- Evidence Import file/byte bounds;
- redaction rules;
- the evidence-source, disk-headroom and survey-cap bounds that replaced confirmation (v2.1).

Runtime governor metrics such as `budget_tokens` and `repeat_calls_avoided` can be persisted in turn metrics and shown as Execution detail when available.

## Provider capability semantics

S3-compatible providers may legitimately lack APIs supported by AWS S3.

Use explicit outcomes such as:

- success;
- access denied;
- region mismatch;
- provider unsupported;
- unknown/error.

Do not convert `provider_unsupported` into “feature disabled” or “configuration absent” unless the code has actually established that fact.

## Forbidden capability examples

The shipped Agent must not gain equivalents of:

```text
generic_shell
run_command
raw_subprocess
delete_bucket
put_bucket_policy
put_bucket_acl
put_lifecycle
delete_objects
recursive_delete
mass_object_mutation
```

Likewise, do not expose a generic raw AWS/S3 method dispatcher as a shortcut around the typed Tool layer.

## Maintenance rule

When a Tool or safety bound changes:

1. update the registered runtime Tool/schema/tests;
2. update this document;
3. update `security.md` when the trust/boundary changes;
4. update `api.md` only if the HTTP contract changes;
5. update `product.md`/`architecture.md` only if the product semantics or ownership change.

A documentation example does not make an unimplemented capability real.
