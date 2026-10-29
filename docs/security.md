# Security

## The floor

1. **Read-only.** No product tool calls a mutating storage or cloud API.
   `call` (`s3/api.ts`) runs an operation only when its name starts with Get,
   List, Head, Describe, Lookup, Search, Select, Simulate or BatchGet and it
   exists on a bundled SDK client. `NEVER` refuses the reads that hand out
   credentials or start state on the service (STS `GetSessionToken`,
   `GetFederationToken`, `GetWebIdentityToken`, `GetDelegatedAccessToken`;
   KMS `GetParametersForImport`). The bundled services are the storage and the
   account around it; a service whose reads return secrets or run compute
   (Lambda function configuration and code URLs, EC2 user data and console
   output, Secrets Manager, SSM parameters and command output, ECR layer URLs,
   DynamoDB items) is not bundled at all. A refused call sends nothing. There is no shell, raw HTTP proxy, write
   endpoint or apply action. A change the agent writes is text for the user;
   the app never runs it.
2. **Scope.** An account may name a bucket allow-list. On a scoped account,
   `checkCall()` refuses an S3 or S3 Control call whose `Bucket` is outside it,
   from the `call` tool and from `query`'s `call()` alike. A plain bucket ARN
   is checked by its name; any other ARN (an access point, an outpost) is
   refused. `inventory()` checks its bucket and the inventory's destination
   bucket with `assertInScope()`. `s3 ListBuckets` is filtered to the scope.
   Scope is a bucket list: reads of other services (IAM, CloudTrail, Access
   Analyzer, …) are not filtered and may name buckets outside it. An empty
   list means every bucket the credentials can see. Composer focus is not
   scope.
3. **Secrets.** Cloud keys and the model key are sealed with Electron
   `safeStorage`; without an OS keyring, with AES-256-GCM under a locally
   generated 0600 key file. SQLite stores only sealed references. The window
   receives a masked key id and a `hasSessionToken` boolean, never a key. A
   profile account stores only the profile name; the AWS SDK resolves it from
   the user's `~/.aws` files at call time, and the app reads those files only
   for profile names.
4. **Account ids.** `scrub()` (`s3/api.ts`) replaces every 12-digit number,
   keys included, with `<account>`, whichever account it names: the caller's,
   an organization member's, a cross-account principal's, one inside a
   CloudTrail event string. `redact()` masks the account in ARNs. A 12-digit
   object key or timestamp is masked too; that is the price of never letting
   an id through. Every `call` response, every `probe`
   answer and every value a `query` script returns is scrubbed, and
   `describeError()` scrubs every tool's error text. Where the agent writes
   `<account>` in an input, and for S3 Control's `AccountId`, `call` puts in
   the id STS `GetCallerIdentity` returns; it is used for that call only and
   never returned.
5. **Redaction.** `security/redact.ts` masks access-key ids, `X-Amz-*`
   signatures and credentials, authorization and API-key headers, bearer
   tokens, secret JSON fields, the account in any ARN, signature query
   parameters, model API keys (`sk-…`) and shared-credentials lines. It runs
   before a value is stored, shown or sent to the model, including targets,
   argument summaries, progress lines, memory text, method code and error
   text. Every string in a tool view is redacted.
6. **Envelope.** Every tool result the model sees is wrapped in
   `<untrusted-data source="storage" evidence="…">…</untrusted-data>`, with
   `<`, `>` and `&` escaped first, so no tag, policy, metadata value or error
   message can close the envelope. A result longer than 24,000 characters
   reaches the model one piece at a time; the rest is kept in
   `tasks/<conversation>/results/` for `more`. Bucket names, object keys,
   bodies and log lines are data, not instructions.
7. **Attached data.** Logs and inventories are parsed into a local SQLite file
   with client IPs masked at import. The agent reads it with `sql()`: one
   `SELECT` (or `WITH … SELECT`) on a read-only connection, no second
   statement and no `load_extension`.
8. **Memory is a separate database.** `memory.sqlite` holds only the agent's
   documents. A `memory` query runs on a read-only connection with one
   `SELECT`; it cannot see `storage-agent.db`, accounts, task metadata or vault
   references. Memory values are redacted when written and are returned to the
   model inside the untrusted envelope.
9. **Agent-authored methods.** `tool` saves a JSON Schema and a JavaScript
   body. The body runs in the same QuickJS sandbox as `query`: no network,
   filesystem, process, timers or modules, and only the read-only primitives.
   Arguments are checked against the schema before execution. The code is
   redacted when stored. Task methods are purged with the task; user methods
   are listed in Settings and can be deleted.
10. **Views are data.** `render` validates a `ViewDoc` against
    `shared/view.ts`: block types, depth, size, rows and nodes are bounded.
    The document is never HTML or code. The window renders each block with
    React and never evaluates it.
11. **Delegation.** A child agent is a pi conversation owned by the task. It
    inherits the same read-only tools, account scope and memory; it cannot
    write. Its answer is returned to the parent as untrusted data. The child is
    purged with the task.
12. **Audit.** Every call through `agentTool()` writes
    `audit(tool, target, outcome, conversation)`: `ok`, `refused`, `stopped` or
    `error`. `ask` reads nothing and is not audited.
13. **Status is structured.** `agentTool()` writes a call's status into
    `details`; nothing parses result text, which a bucket name or an error body
    could forge.
14. **Code mode.** `query` scripts run in a QuickJS VM with no network,
    filesystem, process, timers or modules, and no model access. Its
    primitives are `call()` (the same read check, scope and scrubbing as the
    tool), `discover()`, `memory()`, `render()`, `dataset()`, `inventory()` and
    `sql()`. A script runs until it returns or the user stops it; its memory is
    1,024 MB unless the agent sets `memory_mb`.
15. **Tools return data.** `call` returns the service's response or its
    error; `probe` returns what the endpoint answered. The app computes no
    exposure, no "public" and no authorization decision, and does not merge
    policies, ACLs, IAM and SCPs into a verdict. What a read could not reach is
    the agent's to say; the failed read stays visible as a step.
16. **Export.** The JSON export holds the task, the projected conversation and
    usage. The Markdown export holds the messages, the agent's text and
    reasoning, and each call with what the agent received. PDF prints the
    window with every step open. All of them are written only through the
    user's save dialog, from values already redacted and scrubbed.
17. **Dropped files.** The preload turns a dropped or pasted `File` into a path
    with `webUtils.getPathForFile`, which yields nothing for a file the page
    constructed. The main process accepts only absolute paths to regular files
    up to 4 GiB, at most ten at a time.
18. **Updates** come only from this repository's GitHub releases through
    `electron-updater`, in packaged builds. A missing feed shows as
    unavailable in Settings.

## Threat notes

- **A hostile S3-compatible endpoint** can return huge XML, hostile names or
  error text. Responses are read through the AWS SDK's typed shapes, escaped
  inside the envelope, given to the model a piece at a time, and redacted in
  views. A custom-endpoint account sends every service, IAM and STS included,
  to its own endpoint; its credentials never go to AWS.
- **A hostile attached file or inventory** can be enormous or malformed.
  Logs and CSV files import row by row and the strings they store are capped.
  Inventory files stream to disk. A Parquet file is read whole into
  memory. Attachments are not malware-scanned.
- **A hostile object body.** A streamed `GetObject` body is written to the
  task folder up to `max_bytes` (default 1 MiB, so one read cannot fill the
  disk); the model gets a 64 KiB preview and a ref. The bytes are never executed, and `more` reads text by
  offset. An event stream is read up to `max_bytes`.
- **A hostile memory document or method.** Memory values are data; a method's
  code runs only in the QuickJS sandbox with read-only primitives. Neither can
  reach the host filesystem, network, process or vault. Untrusted tool output
  can still persuade the agent to remember something false; a recalled
  document reaches the model inside `<untrusted-data>` with the task that
  wrote it and when, and Settings lists every document so the user can forget
  one.
- **`probe`** sends one unsigned request, without credentials, only to the
  account's endpoint host or a host under it (on AWS, an S3 host).
- **The renderer is sandboxed**: `contextIsolation`, sandbox, no
  `nodeIntegration`, a CJS preload and a CSP that forbids remote scripts. It
  never receives a credential, a raw provider message or a filesystem handle.
- **The model is untrusted.** It can write a change, never apply one, and its
  prose is never parsed as product state. A citation link opens only a step
  the task holds. Links in model prose open in the system browser; the window
  never navigates to one.
- **The vault fallback is local.** Without an OS keyring, the AES key file and
  the database both live under the user profile. Copying the database without
  the key file protects the ciphertext; copying both does not.
- **Crash dumps stay local**: `crashReporter` runs with
  `uploadToServer: false`. The app sends no telemetry.
- **Signing is conditional.** With every release secret present, macOS is
  signed and notarized and Windows is signed. Otherwise macOS is ad-hoc signed
  and Windows is unsigned, and the release notes say so. This is an installer
  trust limit, not a runtime secret boundary.
- **Keychain prompts follow the app signature.** macOS `safeStorage` ties the
  vault key to the app's code identity. The app opens the model key when a
  turn starts, not while the window opens. An unsigned or ad-hoc build has no
  stable identity, so macOS may ask for Keychain access on first use or after
  an update.

## Not claimed

- A change the agent writes is text. A later read can show that a
  configuration changed; it cannot prove which command was run.
- The app does not verify the agent's answer. The evidence is the steps in the
  conversation.
- The app makes no authorization claim. IAM, Organizations, KMS and Access
  Analyzer responses come back as the APIs return them, one page per call
  where the API pages.
- No accessibility certification is claimed. `scripts/contrast.mjs` guards
  the secondary-text token pairs, and the E2E axe gate fails serious or
  critical violations only.
