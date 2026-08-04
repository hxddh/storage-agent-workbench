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
7. Secrets must be stored only through `security/keyring_store` — a single
   AES-256-GCM encrypted local vault (`secrets.enc`), with the master key
   protected per-OS by a non-prompting mechanism (Windows DPAPI; an owner-only
   `0600` key file on macOS/Linux). Not the OS keychain (the ad-hoc-signed,
   cross-platform app would re-prompt on every update / be absent on headless
   Linux). Do not move secrets back into the keychain, SQLite, or plaintext.
8. SQLite may store only secret references (`keyring://scope/name`).

## Tool safety

Rules:

1. No generic shell tool.
2. No raw subprocess tool exposed to the Agent.
3. No raw boto3 client exposed to the Agent.
4. Cloud operations must go through whitelist tools.
5. Default mode is readonly.
6. `test-write` is a **reserved** mode: it exists only as a schema enum — no
   write tool exists anywhere in the MVP, so nothing can write even with the
   mode set. Any future write tool must enforce the allowed test prefixes
   (e.g. `tmp/agent-test/*`, `diagnose/*`) before performing any write.
7. Destructive operations are forbidden.
8. A provider's `allowed_buckets` / `allowed_prefixes` scope is enforced
   server-side — in the agent session tools, the surviving `/tools` endpoints,
   and the run executors.
9. Prefix scope matches at a **path boundary**, not as a raw string prefix:
   `allowed_prefixes=["logs"]` admits `logs` and `logs/…` but NOT
   `logs-private/…`, which is a different top-level path. Empty-string entries
   are dropped so a stray `""` cannot silently unrestrict the bucket.

Forbidden:

- DeleteBucket
- PutBucketPolicy
- PutBucketAcl
- PutLifecycleConfiguration
- DeleteObjects
- Recursive delete
- Mass object mutation
- Bucket-wide destructive or mutating operation

### Tool results are untrusted data

Everything a tool returns — bucket and object names, previewed object bodies,
config rules, log and inventory content — is third-party text that an attacker
may control. Teaching the model to distrust it is not enough on its own, because
an injected instruction looks exactly like runtime text in the transcript.

Every data-deriving tool output is therefore wrapped in explicit markers
(`<<external_untrusted_data>>` … `<<end_external_untrusted_data>>`) at a single
choke point in `agent_runtime/session_agent.py`, and any literal marker inside a
payload is defanged first so content cannot fake an early close and smuggle text
into the trusted region. The system prompt anchors the data-never-instructions
rule on those exact markers.

Two categories stay **outside** the envelope, deliberately: `read_skill` output
(first-party StorageOps teaching — skills ARE instructions by design) and the
runtime status notes the budget wrapper emits (`budget_exhausted`, `cancelled`),
which are the agent runtime speaking to the model, not data.

## Analysis safety

Rules:

1. No bulk object-body downloads. The one bounded exception is `preview_object`:
   a single, read-only, sanitized preview of one named object's head (hard cap
   1 MiB/call), bounded per turn so it can't be looped into a bulk download, and
   never persisted. Binary/oversized objects are reported, not decoded.
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

`security/redaction.py` is the single implementation. Beyond the AWS shapes it
also covers the non-AWS credentials this app meets through S3-compatible
endpoints: GCP service-account `private_key` PEM blocks **and** `private_key = …`
assignments, Azure `AccountKey=` connection strings, Azure Blob **SAS `sig=`**
query parameters (anchored to `?`/`&`, so the non-secret `se=`/`sp=` params
survive), and temporary-credential **session tokens** by prefix shape
(`FQoG`/`FwoG`/`IQoJ…`).

A *bare* 40-character secret key carries no label to match on, so it is masked
only when the text also contains an `AKIA`/`ASIA…` key-id — the pair-paste that
is how one actually shows up. Bucket names cannot collide with that shape.

### Streaming is redacted separately, and more eagerly

The live answer stream cannot wait for the whole text before deciding what to
hide, and several patterns are only recognizable near their END (a JWT needs its
second `.` plus signature). The stream sanitizer therefore:

- holds back a fixed tail **plus any still-growing run of secret-alphabet
  characters**, so an unfinished long token is never emitted no matter how far
  it extends; and
- masks standalone 40-char base64-ish tokens **unconditionally in the live view
  only**. The persisted answer re-applies the precise rules, so any
  over-redaction is corrected when the final answer replaces the stream.

Chain-of-thought is stripped **before** redacting and again after: redaction can
consume a `</think>` tag when a credential-shaped token abuts it, and a single
strip would then persist the whole hidden-reasoning block.

### Names are content too

A user-chosen filename can itself be a secret (`AKIA…-backup.csv`). Redacting
only the display column left the raw string in the adjacent `stored_path`, so
both upload routes replace a secret-shaped filename with a generated one before
anything reaches disk or SQLite.

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

## Agent dataset analysis

Dataset analysis (`access_log_analysis`, `inventory_analysis`, and the agent's
`analyze_uploaded_file` tool) is **deterministic** — there is no in-run LLM
narrator or drill-down agent (both were removed in v0.20.0). The deterministic
DuckDB engine is authoritative and produces the metrics + findings; the single
conversational agent narrates the sanitized result if the user asks.

- The conversational agent is given **only** a bounded, sanitized, aggregated
  context: run + dataset metadata, the deterministic metrics, and the
  deterministic findings. Lists are capped at 20 entries and the whole context
  is asserted to contain no secret-shaped content before it can leave the
  process. It never reaches raw rows, full key lists, free SQL, or object bodies.
- Forbidden in the agent context: raw log lines, raw inventory rows, full key
  lists / >20 sample keys, Authorization headers, cookies, presigned-URL query
  params, access/secret/session keys, model API keys, unmasked client IPs, and
  arbitrary SQL result dumps. Client IPs are masked upstream at import.
- The agent's output is redacted, chain-of-thought-stripped, length-bounded, and
  coerced to a fixed field set before it is shown or saved. Hidden reasoning,
  raw prompts, and raw model reasoning are never persisted.
- The agent may *recommend reviewing* lifecycle-policy candidates, but must never
  auto-create/update/delete lifecycle rules or emit bulk-delete commands — same
  destructive-operation ban as the rest of the app.
- A missing model provider key fails only the conversational turn cleanly (422);
  the deterministic run is unaffected.

## Account discovery

The `account_discovery` run type enumerates an account's buckets and their
configuration from read-only APIs only. It is deterministic; no bucket list /
config is ever sent to an LLM (the conversational agent sees only the sanitized
summary + counts via `survey_account`).

- **AK/SK/session tokens stay in the encrypted secret vault**, resolved at call
  time inside the boto3 client factory; they never enter SQLite, logs, reports,
  UI state, or any LLM prompt.
- **`list_buckets` is read-only ListBuckets.** It does not call ListObjectsV2,
  does not scan objects, and does not download object bodies. Object-level
  listing/`get_object` are never invoked by this run type.
- **Bucket config snapshot** uses only read-only `get_*` / `list_*` config APIs
  (no put/delete/create/update). No logging or inventory is auto-enabled; no
  lifecycle / policy / ACL / encryption / replication is auto-modified or
  auto-remediated.
- **Evidence-source discovery only discovers** whether inventory / server access
  logging are *configured* (plus destination metadata). It never pulls the full
  inventory report or access log — pulling that evidence is the separate,
  confirmation-gated managed evidence import flow (see below), never part of
  discovery. Reserved sources (CloudTrail / Storage Lens / provider access logs)
  are surfaced as `not_implemented`, never faked.
- **Bounded scan:** processing is capped by `max_buckets` (default 100, hard cap
  500) with optional include/exclude globs; truncation is reported, not silent.
- **Capability vs permission:** S3-compatible gaps are `provider_unsupported`;
  permission gaps are `access_denied` — distinct, and neither crashes the run
  (per-bucket failures are isolated).
- **Persistence is sanitized:** the four account-discovery tables store only
  redaction-passed JSON — never AK/SK/session token/Authorization/cookies/
  presigned-URL/model key. Bucket names, inventory destinations, and logging
  targets pass through the redaction pipeline; reports never contain secrets,
  signatures, raw object listings, raw inventory rows, or raw access-log content.

## Managed evidence import

Pulling inventory / access-log evidence into the analysis path is bounded and
confirmation-gated.

- **Discovered sources only.** Imports read only the inventory *destination*
  (bucket/prefix) or server-access-logging *target* (bucket/prefix) that
  account_discovery already found and persisted. The caller cannot supply an
  arbitrary bucket or object key; the business source bucket is never listed.
- **No business object scan / body download.** The only listing is a bounded
  `list_objects_v2` over the evidence destination prefix; the only `get_object`
  calls are for evidence files in the confirmed plan (manifest, inventory data
  files, log objects). No business object body is ever downloaded, no recursive
  copy / sync, no full bucket scan.
- **Bounded.** Selection is capped by `max_files` (default 1000, hard cap 5000)
  and `max_bytes` (default 1 GiB, hard cap 5 GiB). Access-log import REQUIRES a
  time range. The byte/file budget is enforced again at download (a file larger
  than the remaining budget aborts the import as failed). Downloads stream to
  disk (never buffered whole in memory) and gzip evidence is decompressed with
  an explicit expansion bound — a decompression bomb aborts, it doesn't exhaust
  the machine.
- **Explicit confirmation.** A plan downloads nothing. Download happens only
  after `confirm`, which is recorded in `approval_events` (decision=approved)
  and `audit_logs`. There is no hidden auto-confirm; a zero-file or over-limit
  plan is refused.
- **No mutation.** No S3 put/delete/create, no auto-enable of inventory/logging,
  no lifecycle/policy/ACL/encryption/replication change.
- **Secrets & storage.** AK/SK/session token/model key never enter SQLite, logs,
  reports, UI, or any LLM prompt. Evidence files download to the app data dir
  (`data/runs/{id}/raw/`), never the install dir; raw file content never appears
  in reports (only redacted aggregates from the existing analyzers). The two
  evidence-import tables store redaction-passed bucket/prefix/key/warnings only.
- **Reuse.** Downloaded files feed the existing deterministic
  `inventory_analysis` / `access_log_analysis` importers + analyzers; the import
  is deterministic by design (no LLM, no agent).
- **Support gaps.** ORC inventory is `detected_but_not_supported`; full inventory
  manifests with unusual structures degrade to a clean limitation rather than a
  crash. CloudTrail / Storage Lens / provider access logs remain unimplemented.

## Next-action handoff

Turning a proposal into action is gated and reuses existing safe flows.

- **Proposals are not automation.** The single `/actions/prepare` endpoint only
  validates and prefills; it never creates a run, downloads evidence, confirms an
  import, mutates a bucket, calls S3, or calls an LLM. There is no hidden auto-run
  and no hidden auto-confirm. (There is no separate "preview" endpoint — that was
  removed; `prepare` is the only handoff step.)
- **Bounds, not gates.** `action_type` is **free-form** — the agent proposes any
  concrete next step in its own words; there is deliberately no fixed
  `action_type` allowlist (`sessions/next_actions.py`). Each value is sanitized
  to a bounded slug (lowercase alphanumeric/`_`/`-`, max 64 chars), and a slug
  carrying a forbidden/destructive token (shell / exec / sql / delete-object /
  put-bucket-policy / …) is dropped — a proposal must never even *suggest* a
  mutating operation. `SPECIAL_ACTION_TYPES` only selects the purpose-built UI
  flows (evidence import, session report, composer seeding); it is explicitly
  **not** a cap — an unrecognized type simply routes back to the conversational
  agent, which carries it out with its own read-only tools. Every proposal
  carries `requires_confirmation=true`.
- **Existing safe workflows are reused.** Most proposals just seed the composer
  with a natural-language prompt that the conversational agent then handles inline
  with read-only tools — there is no `NewRunForm` (it was removed). The one flow
  that still creates a run is evidence import, which keeps its plan → confirm →
  run gate in `EvidenceImportDialog`.
- **No unsafe auto-fill.** Access-log evidence import does not auto-fill the time
  range; the user enters it in the import plan.
- **Sanitized.** Proposals, prefills, and assistant `proposed_actions` are
  redaction-passed (no secrets, no raw logs/rows); assistant output is
  chain-of-thought-stripped; a missing model key still fails cleanly.
- **Not a task system.** Audit events (`next_action_prepared` / `next_action_opened`)
  are lightweight; there is no assignee, due date, status board, ticket state, or
  workflow state machine.

## StorageOps skill context

The bundled StorageOps skill pack is professional-method *context only*; it adds
no executable capability.

- **Vendored content is data, not code.** Only `skill-registry.yaml` +
  `skills/*/SKILL.md` are bundled. No StorageOps tools, helper scripts, CLI, Pi
  runtime, `references/`, or `templates/` are copied. If a SKILL.md *mentions*
  scripts / tools / `capture_http_trace` / `scan_secrets` / `recommended_tools`,
  that is allowed prose — the Workbench never registers, exposes, imports, or
  executes them. `recommended_tools` is dropped at load time.
- **No wrapper execution.** `read_skill` returns a SKILL.md body frontmatter-
  stripped and length-bounded — no tools, scripts, CLI, or external execution are
  ever wired up. Script/tool mentions inside a SKILL.md are conceptual prose only;
  the Workbench never registers or runs them.
- **No raw data / secrets to the model.** The catalog + context builder feed the
  Agent only skill docs + the already-sanitized session/triage context. The raw
  error blob, raw logs/rows, credentials, model keys, and chain-of-thought are
  never included. Agent output is redacted + CoT-stripped.
- **Routing is the model's, not a rule engine.** The agent sees the catalog
  (name + one-line description) and chooses which skill to `read_skill` on demand;
  there is no lexical selector (it was removed) and no hard-coded error-code →
  skill mapping. Registry `trigger_keywords` / `auto_route` are parsed but
  currently unconsumed.
- **Human-in-the-loop preserved.** Skill-grounded answers still produce only
  next-action *proposals* (all require confirmation); nothing
  auto-runs, auto-confirms, downloads, or mutates. No new tool, API, DB table,
  subprocess, MCP, or multi-agent runtime is introduced.
- **Public-repo hygiene.** Vendored skills + docs/tests use generic content; no
  real customer / endpoint / bucket / credential data is added.

## Error triage

The error-triage assistant adds S3 error diagnosis inside a session without any
new dangerous capability.

- **Redaction before anything.** Pasted error text is redacted *first* — shared
  redactor plus triage-local patterns for SigV4 `Signature=`/`Credential=`,
  cookies, secret/session/API keys in `key=value` form, and `sk-` model keys.
  Only the redacted input + sanitized parsed signals/findings are persisted.
- **Triage is deterministic — no LLM.** Error triage is pure pattern-matching +
  playbook lookup; there is no interpretation-only triage Agent (that was
  removed). Interpretation, when wanted, comes from the conversational session
  agent in-thread over the already-sanitized triage context. Triage itself has no
  tools and calls no model.
- **Triage performs no S3 call.** Parsing + playbook matching are local and
  read-only-by-construction. Any actual cloud check happens only later, if the
  user explicitly starts an existing diagnostic / config-review / import flow via
  a next-action proposal (review → prepare → confirm).
- **No automation.** Triage never creates a run, downloads evidence, confirms an
  import, or changes configuration. Next actions are proposals only.
- **Not a ticketing system / FAQ / error-code dictionary.** No assignee, board,
  status machine, or static code-table; just sanitized cases tied to a session.
- **Public-repo hygiene.** Docs and tests use only synthetic examples
  (`example.com`, fake buckets/ids) — no real customer/endpoint/credential data.

## Sessions

Sessions add a persistent working context over the existing runs without adding
any new dangerous capability.

- **Deterministic, sanitized summary.** The session summary is built only from
  already-sanitized run artifacts (run_type/status/final_summary, sanitized
  tool_call outputs, the persisted account profile). It never reads raw access
  logs, raw inventory rows, evidence file contents, credentials, or
  chain-of-thought, and it does not call an LLM.
- **Read-only investigator agent.** The session agent investigates live with
  **read-only** tools (bucket/object listing — bounded + paginated, no bodies —
  config readers, credential/addressing/TLS/range probes, progressive-disclosure
  skills) and bounded **working memory** (sanitized facts/findings/open-questions
  it records itself). Credentials are resolved server-side and **never** enter
  its context; it **cannot** bulk-download object bodies (the sole bounded
  exception is `preview_object` / `test_range_get` — one sanitized, per-turn-
  budgeted, text-only read, never a full or recursive download), change
  configuration, delete or mutate anything, run a shell, run free SQL, reach any
  destructive S3 op, or see any secret. Output is redacted + chain-of-thought-
  stripped + bounded; a missing model key fails cleanly and never affects the
  deterministic summary.
- **Graded execution, never destructive.** There is no autonomy toggle: the
  agent always EXECUTES read-only runs itself (config-review / account-survey —
  real, audited, read-only, wall-clock-bounded) and narrates the result.
  EXPENSIVE/data-moving work (cloud evidence import/download, large/full scans)
  and any MUTATING op are **never** auto-run — they carry `requires_confirmation`
  and the user acts. There is no auto-download, no auto-remediation, no write
  tool.
- **Safe persistence.** Session titles/goals/bucket names, messages, findings,
  evidence refs, and summaries are all redaction-passed — never AK/SK/session
  token/Authorization/cookies/presigned URL/model key, never raw logs/rows, never
  chain-of-thought.
- **Not a PM/kanban/ticketing system.** There are no boards, columns, tickets,
  tasks, assignees, sprints, due dates, labels, notifications, or multi-user/
  permission models — only investigation context.

## Sidecar local authentication

The sidecar binds localhost only — but loopback is not process isolation: any
*other* process on the same machine could reach the port, and CORS does nothing
against non-browser clients. A shared-secret gate closes that gap:

- The Tauri shell generates a random per-launch token (`src-tauri/src/lib.rs`)
  and passes it to the sidecar as `STORAGE_AGENT_AUTH_TOKEN`; the frontend
  fetches it via the `get_sidecar_token` command.
- When the variable is set, every request must present the token — the
  `X-Sidecar-Token` header, or `?token=` for the header-less SSE `EventSource`
  — except `GET /health` and CORS `OPTIONS` preflight. Anything else gets 401.
  Token comparison is constant-time.
- The packaged sidecar runs uvicorn with **access logging disabled**, so the
  `?token=` query parameter can never leak into request logs.
- When the variable is unset (plain dev/browser runs, the test suite), auth
  stays open so the local workflow keeps working. The token is defense in
  depth, not the sole boundary — secrets still never transit the API in
  plaintext.

### The launcher proves the sidecar's identity before handing over the token

Picking a free port and spawning a child is a TOCTOU: another local process can
take the port in between, and the webview would then send the auth token to
whatever answered. So the shell does not publish the URL or token until the
process on that port proves it is the child that was just started:

- The shell generates a second per-launch value (a **non-secret** identity
  nonce), passes it as `STORAGE_AGENT_LAUNCH_NONCE`, and polls `/health` until
  the response echoes it back as `launch_nonce` — watching the child for early
  exit at the same time, so a sidecar that died at startup reports why instead
  of leaving a permanent "starting…" spinner. The nonce is an identity marker,
  never a credential: it is deliberately distinct from the auth token, and
  `/health` stays auth-exempt so the handshake can happen before a token is in
  hand.
- There is no fallback to the documented dev port `8765`. That is precisely
  where a stale sidecar from an earlier crashed run listens — with a different
  token and a different data dir — so a launcher that cannot find a port fails
  loudly instead.
- A **single-instance guard** means a second launch focuses the running window
  rather than starting a second sidecar over the same SQLite database and secret
  vault. That sharing was never benign: the vault rewrites the whole file on
  every save, so the second instance's write could silently discard a credential
  the first had just stored. The vault additionally re-reads the file before a
  write when its (mtime, size) changed, so the loss cannot happen even if two
  writers do share a data dir.

### CORS is not the boundary

The allowlist covers the dev origins plus the packaged webview origins Tauri v2
actually uses — `tauri://localhost` on macOS/iOS and `http(s)://tauri.localhost`
on Windows/Android. Every call carries `X-Sidecar-Token`, a non-simple header, so
requests are preflighted and a missing origin breaks the packaged app entirely.
Widening the list costs nothing security-wise: the token gate is the real
authorization boundary, and CORS never constrained a non-browser caller.

## Packaging

- The application bundle contains code and library data only. It must never
  include `.env`, the SQLite database, the secret vault, or `data/runs/` output.
- Secrets live in the encrypted vault in the app data dir (never the install/app
  bundle), alongside the rest of the user data.
- The packaged sidecar binds localhost only, never enables reload in production,
  and prints a sanitized startup banner (no secrets, no full paths, no env dump).
- Tauri spawns only the internal packaged sidecar; no user-controlled shell or
  subprocess execution is exposed.
- The sidecar exits when its launching parent disappears, so it can never be
  orphaned. That watchdog is **platform-specific by necessity**: on POSIX
  `os.kill(pid, 0)` is a liveness probe, but on Windows CPython maps it to
  `TerminateProcess` — using it there made the sidecar kill the very app it was
  guarding. Windows waits on a `SYNCHRONIZE` process handle instead (also immune
  to PID reuse).
- Failing to resolve the app data dir aborts startup rather than degrading to an
  empty value, which the sidecar would treat as unset — falling back to a path
  *inside* the packaged bundle and writing the database and vault into the
  signed app.
