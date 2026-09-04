# Security

> **Storage Agent v1.17.3 security contract.** Same floor as v1.13.0. v1.17 is a Codex-window UI/UE release: no new tools, no new gates, no migration (head stays **030**). v1.13 executes the stateless MCP allowlist through the S3 layer (same scope/redaction/bounds, `run_tool`-recorded), fixes the OTel export column, stamps `waiting` executions `interrupted` on restart (pending Decisions survive), rejects unknown execution kinds, chains compaction, redacts Composer history, and covers plural secret keys — same floor, no new capabilities except the honest MCP dispatch. v1.11 moves the confirmation boundary INSIDE the turn: the gated `import_evidence` tool plans, opens a durable Decision, and blocks until the user allows or denies — the same plan → confirm → run path, the same bounds, the same audit rows; no model prose can raise or satisfy it. Otherwise unchanged from v0.96.0; v1.10 adds a bounded runtime title step (Direction + Work Result text only, redacted, never tool payloads) and a per-provider reasoning effort (ordinary config, not a secret) on the same floor; v1.03 keeps the v1.02 window and adds gated extensions — local models, user skills, MCP, observability, OS shell — same safety floor.
>
> Security is part of the Agent Task product model, not a secondary implementation detail. Read-only autonomy is allowed only inside explicit, bounded, sanitized capabilities. Data movement and materially large/full scans cross a real **approval** boundary inside the Execution.

## 1. Security model at a glance

Storage Agent is a local-first desktop Agent with four main trust boundaries:

```text
User
  │
  ▼
Tauri + React UI
  │ localhost HTTP / SSE + per-launch Sidecar token
  ▼
Python Sidecar
  ├── encrypted local secret vault
  ├── SQLite / DuckDB / local artifacts
  ├── one model-driven Agent runtime
  └── typed, read-only S3-compatible capabilities
          │
          ├── configured model endpoint
          └── configured storage endpoint
```

Core guarantees:

- secret values stay local and never enter model prompts;
- storage operations exposed to the Agent are read-only;
- no generic shell/raw subprocess/raw boto3/unrestricted filesystem capability is exposed;
- provider bucket/prefix scope is enforced server-side;
- cloud data movement is confirmation-gated;
- model context and persisted execution/evidence are bounded and sanitized;
- raw analytical rows remain in local deterministic analysis paths;
- external Tool data is treated as untrusted data, not instructions;
- missing evidence/provider capability stays explicit;
- chain-of-thought is neither persisted nor exposed.

## 2. Secret handling

Secrets include, at minimum:

- model API keys;
- cloud access keys;
- cloud secret keys;
- temporary/session tokens;
- Authorization headers;
- bearer tokens;
- cookies;
- signatures and presigned-URL credential material;
- sensitive credential-bearing query parameters;
- provider-specific private keys/connection secrets.

### Non-negotiable rules

1. Secret values must never enter model prompts/context.
2. Secret values must never be stored in SQLite.
3. Secret values must never be written to application logs, Tool traces, audit payloads, reports, screenshots, JSON/YAML state, generated artifacts, or plaintext browser storage (Composer history drops key-material entries and masks credential values, v1.13).
4. Frontend state may contain a newly entered secret only for the minimum time needed to submit it; API responses never return the plaintext value.
5. SQLite stores opaque secret references such as `keyring://scope/name`, never the secret itself.
6. Provider/model code resolves secret references only inside the Sidecar immediately before the configured external call.
7. The local storage price table is ordinary configuration, not a secret — and must still never contain credentials. Example rates stay labelled until the operator confirms they calibrated against their bill.

## 3. Encrypted local vault

Secrets are stored only through `sidecar/app/security/keyring_store` (module path may be imported without the `sidecar/app` prefix inside Python code).

Current storage design:

- one AES-256-GCM encrypted vault file (`secrets.enc`) in the application data directory;
- a separate master key;
- Windows: master key protected with current-user DPAPI;
- macOS/Linux: owner-only `0600` master-key file created/protected by the vault implementation.

The current shipped product intentionally does **not** use the OS keychain/secret service as the primary vault. With ad-hoc signing, macOS keychain identity can re-prompt across updates; headless Linux may not have a usable secret service. A future stable signing/distribution chain may justify revisiting that choice, but do not move secrets into another store without an explicit security migration design.

If the vault cannot be decrypted, the product must surface that state without returning secret material.

## 4. Local Sidecar authorization

Binding the Sidecar to `127.0.0.1` prevents remote network exposure but does not prevent another local process from connecting.

Packaged Tauri therefore generates a random per-launch `STORAGE_AGENT_AUTH_TOKEN` and launches the Sidecar with it.

When set:

- normal requests require `X-Sidecar-Token`;
- header-less SSE `EventSource` requests may use the `token` query parameter;
- comparisons are constant-time;
- `GET /health` and CORS preflight remain exempt;
- packaged uvicorn access logging is disabled so an SSE query token is not logged.

When the environment variable is absent in explicit dev/test workflows, the local auth gate is open by design.

CORS is a browser policy, not the security boundary against local native processes. Do not treat it as a replacement for the Sidecar token.

## 5. API error sanitization

Validation errors and unhandled exceptions must not echo plaintext request bodies or arbitrary exception messages that may contain credentials.

The Sidecar therefore sanitizes validation responses and emits bounded generic unhandled-error detail while logging the local traceback separately.

Any new provider/settings endpoint that accepts credentials must preserve this behavior.

## 6. Agent capability boundary

The Agent may call only explicit typed capabilities registered by the runtime.

Forbidden capability classes include:

- generic shell / command execution;
- arbitrary subprocess execution;
- raw boto3/botocore client access;
- arbitrary AWS/S3 method dispatch;
- unrestricted filesystem access;
- arbitrary SQL supplied by the model;
- generic network scanning;
- destructive or mutating object-storage APIs.

Examples of forbidden storage operations:

```text
DeleteBucket
PutBucketPolicy
PutBucketAcl
PutLifecycleConfiguration
DeleteObjects
Abort/recursive bulk mutation exposed as a generic Agent action
mass object mutation
bucket-wide destructive repair
```

The schema may retain historical/reserved mode values such as `test-write`, but the shipped v0.93 Agent has no write tool. A schema enum is not a capability.

## 7. Provider scope enforcement

Configured `allowed_buckets` and `allowed_prefixes` are enforced **server-side** in every relevant path:

- Agent in-process storage tools;
- retained direct `/tools` HTTP endpoints;
- deterministic execution engines.

Prefix matching is path-boundary aware. An allowed prefix `logs` may admit `logs` and `logs/...`, but must not silently admit `logs-private/...`. Empty prefix entries must not turn into an unrestricted scope.

Never rely on frontend filtering or model instruction to enforce provider scope.

## 8. Read-only autonomy vs approval

Read-only investigation can run without approval for every individual call, provided each Tool's bounds are satisfied.

A real confirmation boundary is required before operations that materially move or scan cloud data, including the managed Evidence Import flow and any future operation explicitly classified as gated.

The UI presents this state as **Waiting for approval** with an inline approval card, but the Sidecar remains authoritative. A visual button or Agent-generated recommendation cannot bypass server-side confirmation state.

Since v1.11 the boundary is raised by the gated tool itself: `import_evidence` plans the bounded download (a read-only listing), opens a pending `task_decisions` row (`kind=approval`) carrying the projected impact, and the raising execution is `waiting` while the tool thread blocks. Resolution is persisted with an audit trail before anything moves: `approved` runs the same confirm → run path (the `approval_events` row and `evidence_import.*` audit rows are written by that path), `declined` returns a structured refusal to the model, and a Stop while waiting withdraws the request as `declined`. `scope=task` records an explicit user grant; later calls of the same `action_type` in that Task are recorded as already-approved Decisions rather than silently skipped. A Sidecar restart stamps a `waiting` execution `interrupted` (v1.13) — its tool thread died with the process, so no worker remains to continue the gated action; the pending Decision row itself survives untouched, and Resume starts a new execution that re-plans and re-raises it. A later Allow never settles an execution whose action never ran. The durable execution event log stores structured, sanitized, bounded progress only: never secrets, raw analytical rows, or chain-of-thought.

**Approval policy (v1.12).** The user chooses once, in Settings → Safety, how gated calls are answered: `ask` (default), `allow_session` (auto-approved for the lifetime of this Sidecar process — held in memory only, a restart falls back to `ask`), or `allow_always` (auto-approved for this data directory — stored in `app_settings`, ordinary configuration, never a secret). The policy is consulted in exactly one place, `runtime.request_approval`, so no tool can grow its own bypass. An auto-approval is still a durable already-approved Decision row (`scope = session | always`) and an `approval.granted` event carrying `policy`; the transcript and audit trail show what was allowed and why. A policy can only answer a gate that exists: it cannot create a tool, widen a provider scope, raise a bound, or make a read-only tool write.

A plan step is not execution and must not perform hidden downloads or mutation.

Remediation Plans, Verify Executions, and scheduled revisits are also read-only toward the cloud. A plan contains pasteable JSON for the operator's console; Storage Agent never applies it. Verify re-reads configuration with existing read-only tools. A revisit that needs confirmation-gated work opens a pending Decision and waits — it never auto-resolves. At most one pending Decision exists per `(task, action_type)`.

## 9. Bounded object reads

### Object listing

Object listing is page-bounded and explicitly paged. It must not silently convert a user request into an unbounded full recursive scan.

### Range reads

Range diagnostics have hard per-call byte caps and cumulative turn limits. They cannot be used as a loop to reconstruct unrestricted object bodies.

### `preview_object`

The bounded preview capability is the only intentional path for reading a small portion of a named object's content into Agent-visible context.

Security properties:

- single named object;
- hard cap of **1 MiB per call**;
- cumulative per-turn preview budget (**16 previews / 24 MiB** in the current runtime contract);
- redaction before model context;
- no persistence as an unrestricted body dump;
- binary/unsupported/oversized content is reported rather than decoded;
- gzip decompression remains bounded;
- Parquet inspection uses bounded structure/footer access rather than full-object download.

Larger model context windows must not increase these security-floor byte caps.

## 10. Large/full scan rules

Large/full scans must be explicitly bounded or gated.

Current safety rule:

- bounded read-only samples/pages may run autonomously;
- materially large scans require explicit limits such as object count/prefix and, where classified by the workflow, an explicit user Decision;
- a true full-bucket scan requires explicit confirmation;
- (v1.12) an account survey above the default 100-bucket cap is a gated call: `survey_account(max_buckets > 100)` raises `action_type = survey_account_large` through the same `request_approval` path as data movement, with the projected impact (`provider`, `buckets`, `estimated_calls`); Deny returns a refusal and nothing is enumerated; a call not attached to a durable execution is clamped to the default cap, never widened.

Bounds must be reported. Silent truncation is not acceptable evidence.

## 11. Managed Evidence Import

Managed Evidence Import is the primary cloud data-movement workflow and remains:

> **plan → approval (inline Decision) → confirmed execution**

### Source restriction

Import reads only evidence destinations discovered/persisted through supported account/config discovery paths. The operation is not a generic arbitrary-bucket downloader.

### Bounds

Current hard workflow bounds include:

- `max_files`: default **1000**, hard cap **5000**;
- `max_bytes`: default **1 GiB**, hard cap **5 GiB**;
- access-log imports require a time range;
- listing is restricted to the discovered evidence destination prefix;
- selected files/bytes are visible in the plan;
- limits are checked again during execution, not only during planning.

### Download behavior

- files stream to local disk rather than buffering an entire import in memory;
- decompression has explicit expansion bounds;
- an over-budget/oversized/decompression-bomb case fails cleanly rather than consuming unbounded resources;
- raw evidence files remain local and are analyzed by deterministic engines;
- no storage mutation is performed.

### Confirmation/audit

A plan downloads nothing. Confirmation is persisted/audited. Execution without the required confirmation is forbidden.

## 12. Account discovery and configuration review

Account discovery/config review uses read-only APIs only.

Current account-survey bounds:

- default `max_buckets`: **100**;
- hard cap: **500**;
- optional include/exclude filters;
- truncation is explicit.

Discovery may identify configured evidence destinations but must not automatically download inventory/access-log content. Evidence movement remains a separate confirmed workflow.

Provider capability gaps are distinct from access-denied failures and from a successfully absent configuration.

## 13. Deterministic raw-data analysis

Inventory/access-log datasets are processed locally by deterministic DuckDB/Python analysis.

The model may receive only bounded, sanitized derived context such as:

- dataset/run metadata;
- deterministic metrics;
- deterministic findings;
- bounded grouped aggregates;
- bounded/redacted sample labels where explicitly allowed;
- cost-simulator conclusions (class mix over time, labelled estimates, coverage, gaps);
- Remediation Plan / Drift summaries (bounded, sanitized).

The model must not receive:

- raw log lines;
- raw inventory rows;
- unrestricted object-key lists;
- arbitrary SQL result dumps;
- raw client credentials or Authorization material;
- unmasked sensitive query parameters;
- unrestricted filesystem paths;
- invented dollar figures or trends when inventory or a confirmed price table is missing.

`aggregate_uploaded_file` accepts only whitelisted metric/group/filter shapes and uses bound values. The model does not write SQL.

Persist `truncated`/`ingest_cap` truth so later turns cannot mistake a capped dataset for the whole source.

## 14. External Tool data is untrusted

Bucket/object names, object previews, configuration values, uploaded/imported data, and remote Tool output are attacker-controlled text from the Agent's perspective. They may contain prompt-injection-like instructions.

The runtime wraps external Tool-derived data at a single choke point using explicit untrusted-data markers and defangs literal marker sequences inside the payload before insertion.

Security rule:

> Data inside the untrusted Tool-data envelope is evidence/data, never instructions to the Agent.

First-party StorageOps skill text loaded by `read_skill` is intentionally different: it is trusted instruction content by design. Runtime control/status messages such as cancellation/budget signals also have a separate trusted origin.

Do not weaken this trust distinction by concatenating raw provider content directly into system/developer instruction regions.

## 15. Redaction

`sidecar/app/security/redaction.py` is the central text redaction implementation.

It must cover, among other supported shapes:

- AWS-style access/secret/session credentials;
- Authorization/bearer/cookie values;
- signatures and presigned credential parameters;
- temporary session-token shapes;
- GCP service-account private-key material;
- Azure AccountKey-style connection secrets;
- Azure SAS `sig`;
- credential-bearing query/config parameter names such as password/client_secret/access_token/refresh_token/credential/auth/session variants — including plural key spellings (`credentials`, `tokens`, `secrets`, …, v1.13).

Do not redact ordinary storage identifiers merely because their parameter name is generic: for example object `key` and non-secret SAS metadata such as expiry/permission parameters must remain diagnostically useful when they are not secrets.

Bare secret strings without identifying context are intrinsically harder to classify; streaming and boundary-specific sanitizers may intentionally be more conservative.

## 16. Streaming redaction

Live Work Result streaming cannot wait for the complete response before sanitizing.

The streaming sanitizer therefore keeps a safety tail and handles still-growing token-like sequences conservatively so a secret that becomes recognizable only after later characters is not emitted prematurely.

The final persisted Work Result is sanitized again using the complete text.

Chain-of-thought stripping occurs around redaction defensively so malformed/adjacent secret-shaped content cannot cause hidden reasoning tags to leak.

## 17. Filenames and paths are data

User-controlled filenames may themselves contain credential-shaped text.

Upload/import paths therefore sanitize/replace unsafe filenames before storage where necessary. Persisted paths should be relative to the application data directory; absolute home paths can expose local usernames and should not be copied into Tool/audit/report records unnecessarily.

## 18. Presigned URLs

`diagnose_presigned_url` is pure parsing and performs no network call.

Before model context/persistence:

- signature values are removed/redacted;
- access-key identifiers/credential material are not echoed;
- security tokens are removed;
- only diagnostic properties such as expiry/scope/addressing/signed-header metadata survive as allowed by the redaction contract.

A presigned URL must never be persisted verbatim merely because the user pasted it as diagnostic input.

## 19. Auditability

Record sanitized evidence of security-relevant execution, including as applicable:

- Tool calls and measured duration/status;
- sanitized Tool inputs/outputs;
- deterministic analysis SQL + bound parameters where the system executes SQL internally;
- data import planning/execution;
- approval/Decision events;
- report generation;
- memory edits/resolution;
- important safety failures/gaps.

Auditability must not become a reason to persist secrets or raw chain-of-thought.

If audit persistence is incomplete, surface an audit gap rather than asserting a complete trail.

## 20. Next steps, plans, and instructions

The Agent emits no structured next-action proposals and there is no action-prepare endpoint (removed in v1.12). Next steps are asked for in prose; the only gated actions are tool calls the user approves inline (or the approval policy answers, §8).

The model's plan (`update_plan`, v1.12) is a bounded list of ≤ 12 short steps with a status — a checklist the model keeps for the user, not a plan the runtime executes. Steps are redacted and chain-of-thought-stripped; the tool never dispatches anything and never appears as a tool row.

`AGENTS.md` (v1.12) is standing guidance the user keeps in the data directory (or at `STORAGE_AGENT_INSTRUCTIONS`). It is Markdown only: bounded to 8 000 characters, redacted, never executed, injected after the skills catalog and beneath the system safety rules, which it cannot override. It cannot add a tool, widen a scope, or approve a gate. The UI reports only its status, never its text.

The deterministic summary/triage engines still normalise `next_actions` internally for their own findings; destructive/mutating action identifiers are rejected/sanitized there and nothing dispatches on them.

## 21. Provider unsupported is a first-class outcome

S3-compatible providers do not implement a uniform AWS API surface.

Keep these concepts distinct:

- capability unsupported;
- access denied;
- resource/config absent after a successful read;
- region/addressing mismatch;
- transient/runtime error;
- unknown/inconclusive.

A missing API must not be displayed as “configuration off” unless that fact was actually established.

## 22. Chain-of-thought and hidden reasoning

Never persist or expose model chain-of-thought/hidden reasoning.

A provider-authored *reasoning summary* is still model reasoning text for the
purposes of this rule (v1.13): the transcript shows tool activity, measured
metadata, Work Results, Evidence/provenance, and gaps — never a reasoning
summary, however the provider labels it. If a future provider knob offers a
sanitized summary distinct from hidden reasoning, it needs its own rule here
before any UI may render it.

Execution transparency means:

- real Tool activity;
- measured execution metadata;
- durable Work Results;
- Evidence and provenance;
- explicit gaps/Decisions.

It does not mean storing private reasoning tokens or inventing a fake plan to make the Agent look transparent.

## 23. MCP-client threat model (v1.13 appendix)

Consuming third-party MCP servers is **not implemented**: `GET
/mcp/client/status` reports disabled with this pointer. If it is ever built,
the design must satisfy this appendix first — it is a new trust boundary, not
a new transport:

- server text is untrusted input: tool descriptions, schemas, and results are
  attacker-controlled data, never instructions; they enter the model only
  inside the untrusted-data envelope;
- tool schemas are attacker-controlled: parameter names/defaults must not
  smuggle credential exfiltration (e.g. a `callback_url` that echoes context)
  — calls allowlist parameters and redact values like any other tool I/O;
- no secret ever leaves the machine toward an MCP server: secret references
  resolve only for configured first-party endpoints, never from server text;
- server identity is pinned (localhost-only by default); a remote server needs
  an explicit operator grant recorded in `app_settings`;
- every call is `run_tool`-recorded and audited; data-moving verbs a server
  advertises are refused client-side (read-only bridge, same floor).

Until an implementation satisfies all five, the status endpoint stays
disabled-by-design and no execution path ships.

## 24. Security changes require executable coverage

A PR that changes any of the following must update tests and this document in the same change:

- secret storage/resolution;
- Sidecar authorization;
- provider scope enforcement;
- Tool trust/bounds;
- object preview/range/list caps;
- Evidence Import bounds/confirmation;
- redaction/streaming behavior;
- raw-data-to-model boundary;
- Decision semantics;
- storage mutation capability.

If the change also alters the product-visible contract, update `product.md` and `architecture.md`. If persistence/API changes, update `data-model.md` / `api.md`.
