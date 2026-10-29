# Security

## The floor

1. **Read-only.** No product tool calls a mutating storage or cloud API.
   `call` (`s3/api.ts`) runs an operation only when its name starts with Get,
   List, Head, Describe, Lookup, Search, Select or Simulate and it exists on a
   bundled SDK client; `NEVER` refuses the reads that hand out credentials or
   start service-side state (STS `GetSessionToken`, `GetFederationToken`,
   `GetWebIdentityToken`; KMS `GetParametersForImport`). A refused operation
   sends nothing. There is no generic shell, raw HTTP proxy for storage, write
   endpoint or apply action. A change the agent writes (a CLI command, a policy) is text for the
   user; the app never runs it.
2. **Scope.** A provider may name a bucket allow-list. `checkCall()` refuses an
   S3 or S3 Control call whose `Bucket` input (a name or a bucket ARN) is
   outside it, from the `call` tool and `query`'s `call()` alike;
   `assertInScope()` checks `inventory()`'s bucket and its destination bucket.
   `s3 ListBuckets` is filtered to the scope. Scope is a bucket list: account
   reads of other services (IAM, CloudTrail, Access Analyzer, …) are not
   filtered by bucket and may name buckets outside it. An empty list means
   every bucket the credentials can see. Composer focus is not scope.
3. **Secrets.** Cloud keys live in the OS keychain through Electron
   `safeStorage`; without a keyring they are sealed with AES-256-GCM under a
   locally generated 0600 key. SQLite stores only sealed references. The window
   receives a masked key id and a `hasSessionToken` boolean, never a key. A
   profile account stores only the profile name; the AWS SDK resolves it from
   the user's `~/.aws` files at call time (SSO, `credential_process`,
   assume-role), and the app lists profile names without reading keys.
4. **Account ids.** `scrub()` (`s3/api.ts`) replaces every 12-digit number in a
   value, keys included, with `<account>`. Every `call` response, from the tool
   or from `query`, is scrubbed, and `describeError()` scrubs every tool's error
   text. Where the agent writes `<account>` in an input, and in S3 Control's
   `AccountId`, `call` puts in the id STS `GetCallerIdentity` returns; the id is
   used for that call only and is never returned.
5. **Redaction.** `security/redact.ts` removes access-key shapes, `X-Amz-*`
   signatures and credentials, authorization headers, bearer tokens, secret JSON
   fields, account ids inside ARNs (`arn:aws:s3:[account]:`), signature query
   parameters, model API keys (`sk-…`), shared-credentials lines and
   token-shaped keys. It runs before a value is stored, shown or sent to the
   model, including tool targets, argument summaries, progress lines and error
   notes. Tool views are walked and every string is redacted.
6. **Envelope.** Every tool result the model sees is redacted and wrapped in
   `<untrusted-data source="storage" evidence="…">…</untrusted-data>`. `<`, `>`
   and `&` are escaped before wrapping, so an object tag, policy, metadata value
   or error message cannot close the envelope. A result longer than one piece
   (24,000 characters) reaches the model one piece at a time: the rest is kept
   in `tasks/<conversation>/results/` and read with `more`, and the step says
   the agent got the first part. Bucket names, object keys, object bodies and
   log lines are data, not instructions.
7. **Attached data is parsed, masked and redacted before the model reads it.**
   Logs and inventories are parsed into a local SQLite file with client IPs
   masked at import. The agent reads it with `query`'s `sql()`: one `SELECT`
   (or `WITH … SELECT`) on a read-only SQLite connection, no second statement
   and no `load_extension`. String values a script returns are redacted.
8. **Audit.** Every executed call through `agentTool()` writes
   `audit(tool, target, outcome, conversation)`. A refused scope call is
   `refused`, a user-stopped call is `stopped`, and other failures are `error`.
   `ask` reads nothing and is not audited.
9. **Status is structured.** A call's status is written by `agentTool()` into
   `details`; nothing parses result text, which a bucket name or an error body
   could forge.
10. **Code mode.** `query` scripts run in a QuickJS VM with no network,
    filesystem, process, timers or modules, and with model access off. The four
    primitives are `call()` under the same read check, scope and scrubbing as
    the tool, `dataset()`, `inventory()` and `sql()`. A script runs until it
    returns or the user stops it; its memory defaults to 1,024 MB and the
    agent can set `memory_mb`. Returned rows are redacted before the model or
    window sees them.
11. **Tools return data.** `call` returns the service's response, or its error
    code, HTTP status and message; `probe` returns what the endpoint answered,
    with no `ok`/`fail`. The app computes no exposure,
    no "public" and no authorization decision; it does not merge policies,
    ACLs, IAM and SCPs into a verdict. What a read could not reach is the
    agent's to say, and the failed read stays visible in the step.
12. **Export.** The JSON export holds the task, the projected conversation
    (messages, agent text, steps with their redacted views) and usage; it is
    written only through the user's save dialog. The Markdown export holds the
    messages, the agent's text and one line per call; PDF prints the window
    with every step open. None of them holds a secret or an account id.
13. **Dropped files.** The preload turns a dropped or pasted `File` into a path
    with `webUtils.getPathForFile`, which yields nothing for a file the page
    constructed; the main process accepts only absolute paths to regular files
    up to 4 GiB, at most ten at a time.
14. **Updates** come only from this repository's GitHub releases through
    `electron-updater`, in packaged builds. A missing update feed is shown as
    unavailable in Settings rather than failing silently.

## Threat notes

- **A hostile S3-compatible endpoint** can return huge XML, hostile bucket names
  or error text. Responses are read through the AWS SDK's typed shapes, every
  result is escaped inside the envelope and given to the model one piece at a
  time, and view strings are redacted. A custom-endpoint account sends every
  service, IAM and STS included, to its own endpoint; its credentials are
  never sent to AWS.
- **A hostile attached file or inventory** can be enormous or malformed.
  Imports stream, cap each string, and treat a giant line as data rather than
  loading it whole; inventory files stream to disk. There is no row cap. A
  CSV or log imports row by row; a Parquet file is read whole into memory. Attachment contents are not
  malware-scanned.
- **A hostile object body.** `GetObject` reads at most `max_bytes` (1 MiB
  unless the agent asks for more) and closes the stream; bytes that are not
  text come back as base64. A body is data inside the envelope, like any other
  result.
- **`probe`** sends one unsigned request, without credentials, only to the
  account's endpoint host or a host under it (on AWS, an S3 host).
- **The renderer is sandboxed**: `contextIsolation`, sandbox and no
  `nodeIntegration`, a CJS preload, and a CSP that forbids remote scripts. It
  never receives a credential, a raw provider message or a filesystem handle.
- **The model is untrusted**: it can write a change, never apply one, and its
  prose is never parsed as product state. The app does not check or correct
  the agent's text; the prompt tells it to say what it could not read, and
  every call it made, failed ones included, stays visible as a step where it
  happened. A citation link only opens a step the task holds; one that matches
  no call is shown as plain text, not a link. Links in model prose open in the
  system browser; the trusted window never navigates to one.
- **Notes are memory, not instructions.** A note is redacted when written and
  reaches the prompt inside a `<memory>` block marked as data.
- **The vault fallback is local**: without an OS keyring, the AES key file and
  the database both live under the user profile. Copying the database without
  the key file protects the ciphertext; copying both does not. Settings does not
  claim otherwise.
- **Crash dumps stay local**: `crashReporter` is configured with
  `uploadToServer: false`. The app does not send telemetry.
- **Signing is conditional**: with all release secrets present, macOS is signed
  and notarized and Windows is signed. Without them, macOS is ad-hoc signed and
  Windows is unsigned; the release notes say so. This is an installer trust
  limitation, not a runtime secret boundary.
- **Keychain prompts follow the app signature**: macOS `safeStorage` protects
  the vault key with the app's code identity. The app opens the model key only
  when a turn starts, never while the window is opening. An unsigned or ad-hoc
  build does not have a stable trusted identity, so macOS may still ask for
  Keychain access on first use or after an update. Signing and notarizing the
  app is the durable fix; "Always Allow" cannot be guaranteed for ad-hoc builds.

## Not claimed

- A change the agent writes is text. A later read can show the configuration
  changed; it cannot prove which command was run, and nothing applies one.
- The app does not verify the agent's answer. There are no grounding checks,
  citation validation or verdicts; the evidence is the steps in the
  conversation.
- The app makes no authorization claim. IAM, Organizations, KMS and Access
  Analyzer responses come back as the APIs return them, one page per call
  where the API pages; evaluating them is the agent's.
- No full accessibility certification is claimed. `scripts/contrast.mjs` guards
  the named secondary-text token pairs, and the E2E axe gate fails serious or
  critical violations only.
- No import from the previous app's database exists. A new install starts empty.
