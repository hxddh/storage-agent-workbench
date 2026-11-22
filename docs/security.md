# Security

## The floor

1. **The agent never changes storage itself.** `call` (`s3/api.ts`) runs an
   operation only when its name starts with Get, List, Head, Describe, Lookup,
   Search, Select, Simulate or BatchGet and it exists on a bundled SDK client.
   `NEVER` refuses the reads that hand out credentials or start state on the
   service (STS `GetSessionToken`, `GetFederationToken`,
   `GetWebIdentityToken`, `GetDelegatedAccessToken`; KMS
   `GetParametersForImport`; S3 Control `GetDataAccess`). The bundled services
   are the storage and the account around it; a service whose reads return
   secrets or run compute (Lambda function configuration and code URLs, EC2
   user data and console output, Secrets Manager, SSM parameters and command
   output, ECR layer URLs, DynamoDB items) is not bundled at all. A refused
   call sends nothing. There is no shell and no raw HTTP proxy.
2. **A write is the user's decision.** The agent can only propose one with
   `change` (`changes.ts`, `runtime/approvals.ts`), and the app runs it only
   when all of these hold: the account allows changes (off by default, set by
   the user in Settings or by approving the agent's proposal); the operation is
   on the reversible allowlist `WRITABLE` (bucket configuration only — no
   object write, no delete of data, no IAM); every input member is one the
   operation models; the bucket is in scope (an account-wide write is refused
   on a scoped account); the current state could be read as a snapshot; and
   the user clicked **Approve**, then confirmed. Approve, Reject and Roll back
   reach the main process only over IPC from the window
   (`agent:approveChange`, `agent:rejectChange`, `agent:rollbackChange`); no
   tool can call them, and the model never sees anything that could approve.
   The app runs exactly the stored call, checked again, with a separate write
   client (`Providers.writeConfig`: the account's write profile, else its own
   credentials). The model never holds a write-capable client. Every applied
   change can be rolled back from its snapshot.
3. **Scope is authorization.** An account may name a bucket allow-list. On a
   scoped account, `checkCall()` (`s3/api.ts`) lets a call run only if it
   names an in-scope bucket in `Bucket` (S3 or S3 Control), or is a listing
   filtered to the scope (`s3 ListBuckets`, `s3 ListDirectoryBuckets`), or
   reveals no bucket (`sts GetCallerIdentity`, `s3control
   GetPublicAccessBlock`). Every other service (IAM, CloudTrail, Config,
   CloudWatch, Access Analyzer…) sees across the account and is refused, as is
   an S3 Control call by access point name or an access point / outpost ARN.
   Before the scope check, `checkInput()` refuses any input member the
   operation does not model, so a call cannot pass the check on a `Bucket` the
   SDK would drop. The same check covers `query`'s `call()`; `inventory()` and
   `dataset()` check their buckets with `assertInScope()`; `change` obeys the
   same scope. An empty list means every bucket the credentials can see. The
   agent can propose a new scope with `self`; it applies only when the user
   approves. Composer focus is not scope.
4. **Secrets.** Cloud keys and model keys are sealed with Electron
   `safeStorage`; without an OS keyring, with AES-256-GCM under a locally
   generated 0600 key file. SQLite stores only sealed references. The window
   receives a masked key id and a `hasSessionToken` boolean, never a key. A
   profile account stores only the profile name, and a write profile only its
   name; the AWS SDK resolves them from the user's `~/.aws` files at call time,
   and the app reads those files only for profile names. A saved model key is
   sent only to the provider and base URL it was saved for
   (`Settings.keyFor`): listing models, testing a draft and running a task
   never try another endpoint's key.
5. **Identifiers are data.** Account ids, access key ids, ARNs, canonical
   user ids, bucket names and object keys reach the agent, the window and the
   task folder exactly as the service returned them. They are not secrets
   (AWS says so of account ids and key ids), and the agent cannot judge
   cross-account access, find a stale key or call with a key it was shown if
   they are masked. `<account>` in an input is a convenience the agent may
   use for the caller's id; S3 Control's `AccountId` is filled in when left
   out.
6. **Secrets are redacted.** `security/redact.ts` masks PEM private keys, a
   secret access key next to its access key id (the IAM console's CSV, a
   pasted pair), `X-Amz-*` signatures and credentials, authorization and
   API-key headers, bearer tokens, secret JSON fields (`SecretAccessKey`,
   `SessionToken`, `aws_secret_access_key`, `client_secret`, `private_key`,
   `password`, `token`…), signature query parameters, model API keys (`sk-…`)
   and secret lines in ini, YAML and env files (`aws_secret_access_key`,
   `aws_session_token`, `client_secret`, `password`…). `shape()`
   (`s3/api.ts`) also replaces the value of any response field named like a
   secret (`SecretAccessKey`, `SessionToken`, `Password`, `PrivateKey`,
   `Plaintext`, `SecretString`…). A tool result is redacted whole before it is
   kept or cut into pieces, so a secret never straddles two pieces; `more`
   ends a text piece on a line end. Redaction also runs on targets, argument
   summaries, progress lines, error text, workspace writes, workspace SQL
   parameters and a proposal's input and reason.
7. **Envelope.** Every tool result the model sees is wrapped in
   `<untrusted-data-<boundary> source="…" evidence="…">…</untrusted-data-<boundary>>`,
   where the boundary is 48 random bits drawn for that result. The content is
   not rewritten — a key spelled `a&b <x>.csv` reaches the agent so — and no
   tag, policy, metadata value or error message can close the block, because
   it cannot know the boundary. A result longer than one piece (about a fifth
   of the window, at most 24,000 characters) reaches the model a piece at a
   time; every result is kept in `tasks/<conversation>/results/` for `more`.
   Bucket names, object keys, bodies, log lines, workspace files and child
   answers are data, not instructions.
8. **Attached and imported data.** A dataset keeps every column of its source;
   client addresses, user agents and request lines are kept as they are, so
   the agent can follow one address or request. Credential-shaped text is
   redacted before a string is stored; identifiers are kept. The agent reads a
   dataset with `sql()`: one `SELECT` (or `WITH … SELECT`) on a read-only
   connection, no second statement and no `load_extension`. A dataset the
   agent keeps with `scope: 'user'` is stored in the workspace's `data/`,
   bounded to 512 MiB each and 2 GiB in total, and is removed by Settings
   **Forget** or the agent. An attached image is sent to the model as an
   image; its bytes are not redacted.
9. **The workspace stays in its folder.** `workspace.ts` resolves every path
   inside `<data>/workspace/`: an absolute path, a `..` that climbs out, or a
   path that leads out through a symbolic link is refused, and listings skip
   links. Content and string SQL parameters are redacted before they are
   written. The agent's SQL runs only on `db.sqlite`; `ATTACH`, `DETACH`,
   `load_extension` and `VACUUM INTO` are refused, so it cannot reach
   `storage-agent.db`, accounts, task metadata or vault references. A
   workspace script runs in the `query` sandbox with its primitives; it reads
   its arguments as `args`. The window opens and saves workspace paths only
   after resolving them the same way.
10. **Skills are advice.** Bundled skills ship with the app and are listed in
    the prompt as trusted text. Skills in the workspace's `skills/` may have
    been written by the agent or by something it read, so they are listed
    inside an `<untrusted-data-…>` block with their file, and they never
    replace a bundled skill. No skill is executed.
11. **Views are data.** A view document is validated against `shared/view.ts`:
    block types, depth, size, rows and nodes are bounded. The document is never
    HTML or code. The window renders each block with React and never evaluates
    it. A board file that is not a valid view is not on the board.
12. **Unattended work is bounded.** A scheduled run stops at its token budget
    (the schedule's own, at least 1,000, else 100,000) unless the user opens
    its task. A schedule runs at most every 5 minutes. A run may notify the
    user once; a second `notify` before the user's next message is refused.
    Notifications respect the Settings switch, which the agent cannot change.
    A scheduled run may propose a change, but nothing runs until a person
    approves it.
13. **Delegation.** A child agent is a pi conversation owned by the task. It
    has the same tools and account scope as the parent. Its answer is returned
    to the parent as untrusted data. The child is purged with the task.
14. **Audit.** Every call through `agentTool()` writes
    `audit(tool, target, outcome, conversation)`: `ok`, `refused`, `stopped` or
    `error`, including calls served over MCP. `ask` and `delegate` are not
    audited. A change's proposal, decision, result and rollback are kept on its
    `changes` row.
15. **Status is structured.** `agentTool()` writes a call's status into
    `details`; nothing parses result text, which a bucket name or an error body
    could forge.
16. **Code mode.** `query` scripts and workspace scripts run in a QuickJS VM
    with no network, filesystem, process, timers or modules, and no model
    access. The primitives are `call()` (the same read check, input check,
    scope and redaction as the tool), `read()`, `dataset()` (scope checked for
    an object or prefix), `inventory()`, `sql()`, `datasets()`, `history()`,
    `discover()`, `workspace()` (the workspace's own rules), `run()` and
    `render()`. A script runs until it returns or the user stops it; its memory
    is 1,024 MB unless the agent sets `memory_mb`.
17. **Tools return data.** `call` returns the service's response or its
    error; `probe` returns what the endpoint answered. The app computes no
    exposure, no "public" and no authorization decision, and does not merge
    policies, ACLs, IAM and SCPs into a verdict. What a read could not reach is
    the agent's to say; the failed read stays visible as a step.
18. **Export.** The JSON export holds the task, the projected conversation and
    usage. The Markdown export holds the messages, the agent's text and
    reasoning, and each call with what the agent received. PDF prints the
    window with every step open. A workspace file under `exports/` is copied
    out only through the save dialog. All of them are written only where the
    user chooses, from values already redacted.
19. **Dropped files.** The preload turns a dropped or pasted `File` into a path
    with `webUtils.getPathForFile`, which yields nothing for a file the page
    constructed. The main process accepts only absolute paths to regular files
    up to 4 GiB, at most ten at a time.
20. **MCP.** `storage-agent --mcp` serves `call`, `query`, `probe`, `more` and
    the workspace's `list`, `read` and `search` over stdio to the process that
    started it, with the same scope, redaction, envelope and audit. It serves
    no change, schedule, notification or settings tool, opens no model and
    listens on no port.
21. **Updates** come only from this repository's GitHub releases through
    `electron-updater`, in packaged builds. A missing feed shows as
    unavailable in Settings.

## Threat notes

- **A hostile S3-compatible endpoint** can return huge XML, hostile names or
  error text. Responses are read through the AWS SDK's typed shapes, wrapped
  in a block they cannot close, given to the model a piece at a time, and
  redacted in views. A custom-endpoint account sends every service, IAM and
  STS included, to its own endpoint, approved changes too; its credentials
  never go to AWS.
- **A hostile attached file or inventory** can be enormous or malformed.
  Logs and CSV files import row by row and the strings they store are capped.
  Inventory files stream to disk. A Parquet file is read whole into
  memory. Attachments are not malware-scanned.
- **A hostile object body.** A streamed `GetObject` body is written to the
  task folder up to `max_bytes` (default 1 MiB, so one read cannot fill the
  disk); the model gets a 64 KiB preview and a ref. The bytes are never
  executed, and `more` reads text by offset. An event stream is read up to
  `max_bytes`.
- **A persuaded agent.** Untrusted tool output can persuade the agent to write
  a false note, a misleading skill or a script, or to propose a harmful
  change. Notes and skills reach later turns only when the agent reads them,
  inside the envelope; workspace skills are listed as untrusted data; a
  script runs only in the sandbox. A proposed change shows the exact call, the
  state now and after, and the reason, and runs only on the user's approval;
  only reversible bucket configuration is possible, and every applied change
  can be rolled back. The user can open, edit or delete anything in the
  workspace from Settings.
- **A runaway schedule** is bounded by its token budget, the 5-minute minimum
  interval and one notification per run; it appears on Home with **Cancel**,
  and its runs are an ordinary task the user can open and stop.
- **`probe`** sends one unsigned HEAD, GET or OPTIONS — what an anonymous
  internet user gets — to any public host: the account endpoint, a bucket's
  virtual host or website endpoint, a CloudFront or custom domain. Every
  address the host resolves to must be public (not loopback, private, link-
  local, CGNAT, ULA or multicast) unless the host is the account's own custom
  endpoint (a local MinIO); the connection is pinned to the checked address,
  so a second DNS answer cannot redirect it, and redirects are not followed.
  A GET returns the first 4 KiB of the body, and the probe stops reading
  there. A header that would carry a credential (`Authorization`, `Cookie`,
  `X-Amz-Security-Token`, `X-Amz-Credential`, `X-Amz-Signature` and the like)
  or a `user:pass@` URL is refused and nothing is sent.
- **The renderer is sandboxed**: `contextIsolation`, sandbox, no
  `nodeIntegration`, a CJS preload and a CSP that forbids remote scripts. It
  never receives a credential, a raw provider message or a filesystem handle.
- **The model is untrusted.** It can propose a change, never approve or apply
  one, and its prose is never parsed as product state. A citation link opens
  only a step the task holds. Links in model prose open in the system browser;
  the window never navigates to one.
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

- A change the user applied outside the app is outside its record. A later
  read can show that a configuration changed; it cannot prove which command
  was run.
- A rollback restores the snapshot taken when the change was proposed; a
  change someone else made in between is overwritten. Versioning that was
  never enabled can only go back to `Suspended`.
- The app does not verify the agent's answer. The evidence is the steps in the
  conversation.
- The app makes no authorization claim. IAM, Organizations, KMS and Access
  Analyzer responses come back as the APIs return them, one page per call
  where the API pages.
- No accessibility certification is claimed. `scripts/contrast.mjs` guards
  the secondary-text token pairs, and the E2E axe gate fails serious or
  critical violations only.
