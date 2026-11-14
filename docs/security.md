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
2. **Scope is authorization.** An account may name a bucket allow-list. On a
   scoped account, `checkCall()` (`s3/api.ts`) lets a call run only if it
   names an in-scope bucket in `Bucket` (S3 or S3 Control), or is a listing
   filtered to the scope (`s3 ListBuckets`, `s3 ListDirectoryBuckets`), or
   reveals no bucket (`sts GetCallerIdentity`, `s3control
   GetPublicAccessBlock`). Every other service (IAM, CloudTrail, Config,
   CloudWatch, Access Analyzer…) sees across the account and is refused, as is
   an S3 Control call by access point name or an access point / outpost ARN.
   The same check covers `query`'s `call()`; `inventory()` and `dataset()`
   check their buckets with `assertInScope()`. An empty list means every
   bucket the credentials can see. Composer focus is not scope.
3. **Secrets.** Cloud keys and the model key are sealed with Electron
   `safeStorage`; without an OS keyring, with AES-256-GCM under a locally
   generated 0600 key file. SQLite stores only sealed references. The window
   receives a masked key id and a `hasSessionToken` boolean, never a key. A
   profile account stores only the profile name; the AWS SDK resolves it from
   the user's `~/.aws` files at call time, and the app reads those files only
   for profile names.
4. **Identifiers are data.** Account ids, access key ids, ARNs, canonical
   user ids, bucket names and object keys reach the agent, the window and the
   task folder exactly as the service returned them. They are not secrets
   (AWS says so of account ids and key ids), and the agent cannot judge
   cross-account access, find a stale key or call with a key it was shown if
   they are masked. `<account>` in an input is a convenience the agent may
   use for the caller's id; S3 Control's `AccountId` is filled in when left
   out.
5. **Secrets are redacted.** `security/redact.ts` masks `X-Amz-*` signatures
   and credentials, authorization and API-key headers, bearer tokens, secret
   JSON fields (`SecretAccessKey`, `SessionToken`, `password`, `token`…),
   signature query parameters, model API keys (`sk-…`) and shared-credentials
   lines; `shape()` (`s3/api.ts`) also replaces the value of any response field
   named like a secret (`SecretAccessKey`, `SessionToken`, `Password`,
   `PrivateKey`, `Plaintext`, `SecretString`…). Redaction runs before a value
   is stored, shown or sent to the model, including targets, argument
   summaries, progress lines, memory text, method code and error text.
6. **Envelope.** Every tool result the model sees is wrapped in
   `<untrusted-data-<boundary> source="…" evidence="…">…</untrusted-data-<boundary>>`,
   where the boundary is 48 random bits drawn for that result. The content is
   not rewritten — a key spelled `a&b <x>.csv` reaches the agent so — and no
   tag, policy, metadata value or error message can close the block, because
   it cannot know the boundary. A result longer than one piece (24,000
   characters, less for a model with a small window) reaches the model a
   piece at a time; every result is kept in `tasks/<conversation>/results/`
   for `more`. Bucket names, object keys, bodies and log lines are data, not
   instructions.
7. **Attached and imported data.** A dataset keeps every column of its source;
   client addresses, user agents and request lines are kept as they are, so
   the agent can follow one address or request. Credential-shaped text is
   redacted before a string is stored; identifiers are kept. The agent reads a
   dataset with `sql()`: one `SELECT` (or `WITH … SELECT`) on a read-only
   connection, no second statement and no `load_extension`. A dataset the
   agent keeps with `scope: 'user'` is stored at `datasets/<id>.sqlite` under
   the app data directory, bounded to 512 MiB each and 2 GiB in total; it is
   readable only through the read-only `sql()` connection and is removed by
   Settings **Forget**, the agent, or a host schema reset. An attached image is sent to the model
   as an image; its bytes are not redacted.
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
    primitives are `call()` (the same read check, scope and redaction as the
    tool), `read()`, `dataset()` (scope checked for an object or prefix),
    `inventory()`, `sql()`, `datasets()`, `history()`, `discover()`,
    `memory()` and `render()`. A script runs until it returns or the user stops it; its memory is
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
    user's save dialog, from values already redacted.
17. **Dropped files.** The preload turns a dropped or pasted `File` into a path
    with `webUtils.getPathForFile`, which yields nothing for a file the page
    constructed. The main process accepts only absolute paths to regular files
    up to 4 GiB, at most ten at a time.
18. **Updates** come only from this repository's GitHub releases through
    `electron-updater`, in packaged builds. A missing feed shows as
    unavailable in Settings.

## Threat notes

- **A hostile S3-compatible endpoint** can return huge XML, hostile names or
  error text. Responses are read through the AWS SDK's typed shapes, wrapped
  in a block they cannot close, given to the model a piece at a time, and redacted in
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
  document reaches the model inside an `<untrusted-data-…>` block with the task that
  wrote it and when, and Settings lists every document so the user can forget
  one.
- **`probe`** sends one unsigned HEAD, GET or OPTIONS — what an anonymous
  internet user gets — to any public host: the account endpoint, a bucket's
  virtual host or website endpoint, a CloudFront or custom domain. Every
  address the host resolves to must be public (not loopback, private, link-
  local, CGNAT, ULA or multicast) unless the host is the account's own custom
  endpoint (a local MinIO); the connection is pinned to the checked address,
  so a second DNS answer cannot redirect it, and redirects are not followed.
  A GET returns the first 4 KiB of the body. A header that would carry a
  credential (`Authorization`, `Cookie`, `X-Amz-Security-Token`,
  `X-Amz-Credential`, `X-Amz-Signature` and the like) or a `user:pass@` URL
  is refused and nothing is sent.
- **Skills** are Markdown the agent reads with `skill`; bundled ones ship in
  `main/skills/`, the user's live in `<data>/skills/`. They are advice in the
  prompt's index and in a tool result, never executed. The agent can write a
  user skill, so untrusted tool output could persuade it to save a false one;
  Settings lists every skill with its source and the user can delete theirs.
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
