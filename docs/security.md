# Security

## The floor

1. **Read-only.** No product tool calls a mutating storage or cloud API. There
   is no generic shell, raw HTTP proxy for storage, write endpoint or apply
   action. A change the agent writes (a CLI command, a policy) is text for the
   user; the app never runs it.
2. **Scope.** A provider may name a bucket allow-list. `assertInScope()` runs in
   the main process before every bucket-scoped read — `objects`, `object`,
   `config`, `account` with a bucket, `probe` with a bucket, and every `query`
   primitive that takes a bucket, an inventory destination bucket included —
   and refuses anything outside it. `buckets` and `query`'s `buckets()` filter
   the listing to the scope. An empty list means every bucket the credentials
   can see. Composer focus is not scope.
3. **Secrets.** Cloud keys live in the OS keychain through Electron
   `safeStorage`; without a keyring they are sealed with AES-256-GCM under a
   locally generated 0600 key. SQLite stores only sealed references. The window
   receives a masked key id and a `hasSessionToken` boolean, never a key. A
   profile account stores only the profile name; the AWS SDK resolves it from
   the user's `~/.aws` files at call time (SSO, `credential_process`,
   assume-role), and the app lists profile names without reading keys.
4. **Account ids.** `scrub()` (`s3/raw.ts`) replaces every 12-digit number in a
   value, keys included, with `<account>`. Every `config` and `account` read,
   and their `query` primitives, return scrubbed values, and `agentTool()`
   scrubs every tool's error text. The id STS returns is used only as the
   argument of the account-wide block and SCP reads and is never returned.
5. **Redaction.** `security/redact.ts` removes access-key shapes, `X-Amz-*`
   signatures and credentials, authorization headers, bearer tokens, secret JSON
   fields, account ids inside ARNs (`arn:aws:s3:[account]:`), signature query
   parameters, model API keys (`sk-…`), shared-credentials lines and
   token-shaped keys. It runs before a value is stored, shown or sent to the
   model, including tool targets, argument summaries, progress lines and error
   notes. Tool views are walked and every string is redacted.
6. **Envelope.** Every tool result the model sees is redacted, bounded by
   `bound()` (24,000 characters) and wrapped in
   `<untrusted-data source="storage" evidence="…">…</untrusted-data>`. `<`, `>`
   and `&` are escaped before wrapping, so an object tag, policy, metadata value
   or error message cannot close the envelope. When `bound()` cut a result, the
   step says the agent got part of it. Bucket names, object keys and log lines
   are data, not instructions.
7. **Attached data is parsed, masked and redacted before the model reads it.**
   Logs and inventories are parsed into a local SQLite file with client IPs
   masked at import. The agent reads it with whitelisted `aggregate`s or one
   redacted page of `rows` at a time (≤1,000); there is no SQL.
8. **Audit.** Every executed call through `agentTool()` writes
   `audit(tool, target, outcome, conversation)`. A refused scope call is
   `refused`, a user-stopped call is `stopped`, and other failures are `error`.
   `ask` reads nothing and is not audited.
9. **Status is structured.** A call's status is written by `agentTool()` into
   `details`; nothing parses result text, which a bucket name or an error body
   could forge.
10. **Code mode.** `query` scripts run in a QuickJS VM with no network,
    filesystem, process, timers or modules, and with model access off. The nine
    primitives check account scope on every bucket, call only List, Head,
    configuration, account-level, inventory and dataset reads, and count
    against budgets of 2,000 calls, 500,000 listed items, 120 seconds and
    256 MiB. Returned rows are redacted before the model or window sees them.
11. **Tools return data.** A read returns what the API returned, as
    `{ status, value }` or `{ status, error }`. The app computes no exposure,
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
  result is bounded and escaped inside the envelope, and view strings are
  redacted. The full view reaches the window; only the model's copy is
  bounded.
- **A hostile attached file** can be enormous or malformed. Imports stream, cap
  rows at 2,000,000, cap each string, and treat a giant line as data rather than
  loading it whole. Inventory full import is additionally capped by manifest
  file count, per-file bytes and total bytes. Attachment contents are not
  malware-scanned.
- **A hostile object body.** `object.preview` reads at most the first 8 KiB;
  bytes that are not text are reported as binary, not shown. Metadata values
  are never returned, only their names.
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
- The app makes no authorization claim. Account-level reads return IAM, SCP,
  KMS and Access Analyzer data as the APIs return them, one page at a time
  where the API pages; evaluating them is the agent's.
- No full accessibility certification is claimed. `scripts/contrast.mjs` guards
  the named secondary-text token pairs, and the E2E axe gate fails serious or
  critical violations only.
- No import from the previous app's database exists. A new install starts empty.
