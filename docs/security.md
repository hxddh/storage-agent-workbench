# Security

## The floor

1. **Read-only.** No product tool calls a mutating S3 API. There is no generic
   shell, raw HTTP proxy for storage, write endpoint or apply action. Generated
   fix text is data for the user, not a command the app runs.
2. **Scope.** A provider may name a bucket allow-list. `assertInScope()` runs in
   the main process before every bucket-scoped read and refuses anything outside
   it. An empty list means every bucket the credentials can see. Composer focus
   is not scope.
3. **Secrets.** Cloud keys live in the OS keychain through Electron
   `safeStorage`; without a keyring they are sealed with AES-256-GCM under a
   locally generated 0600 key. SQLite stores only sealed references. The window
   receives a masked key id and a `hasSessionToken` boolean, never a key. A
   profile account stores only the profile name; the AWS SDK resolves it from
   the user's `~/.aws` files at call time (SSO, `credential_process`,
   assume-role), and the app lists profile names without reading keys.
4. **Redaction.** `security/redact.ts` removes access-key shapes, `X-Amz-*`
   signatures and credentials, authorization headers, bearer tokens, secret JSON
   fields, account ids inside ARNs, signature query parameters, model API keys
   (`sk-…`), shared-credentials lines and token-shaped keys. It runs before a
   value is stored, shown or sent to the model, including tool targets, progress
   lines and error notes. Tool views are walked and every string is redacted.
5. **Envelope.** Every tool result the model sees is wrapped in
   `<untrusted-data source="storage">…</untrusted-data>` and bounded. Stored
   `<`, `>` and `&` are escaped before wrapping, so an object tag, metadata
   value or error message cannot close the envelope. Bucket names, object keys
   and log lines are data, not instructions.
6. **No model-facing raw rows.** Logs and inventories are parsed into a local
   SQLite file; the model receives only aggregates and bounded samples. A query
   script's rows are capped at 500 on the page and 40 in the model prompt.
   Estate history is likewise structured: Issue-event kinds, dates, bucket,
   rule and redacted evidence, plus posture changes. Raw user requests and the
   `search_docs` text are not part of memory and never enter a prompt.
7. **Audit.** Every executed tool call writes
   `audit(tool, target, outcome, conversation)`. A refused scope call is
   `refused`, a user-stopped call is `stopped`, and other failures are `error`.
   Re-verification replays the read operations directly; it never asks the model
   and never writes storage.
8. **Status is structured.** A call's status is written by `agentTool()` into
   `details`; nothing parses result text, which a bucket name or an error body
   could forge.
9. **Code mode.** `query` scripts run in a QuickJS VM in a worker thread with no
   network, filesystem, process, timers or modules, and with model access off.
   The ten primitives check account scope on every bucket, call only List, Head,
   configuration, inventory and dataset reads, and count against budgets of
   2,000 calls, 500,000 listed items, 120 seconds and 256 MiB. Returned rows are
   redacted before the model or window sees them.
10. **Access evidence.** Policy and ACL evaluation is local. IAM users, groups,
    roles, managed and inline policies and permission boundaries are read with
    paginated `GetAccountAuthorizationDetails` and evaluated locally; SCPs are
    read from the account/OU/root chain when Organizations permits; KMS and
    Access Analyzer are bounded AWS reads. Identity grants are intersected with
    bucket-policy Denies and, when read, SCPs and boundaries. Object and bucket
    actions use their matching resource form; ARNs are case-sensitive. A grant
    to another account is marked as an unread external identity policy. A denied
    read is a blind spot, and coverage is shown. Scope is checked before an
    inventory destination bucket is read.
11. **Evidence.** The JSON pack contains redacted views, finding controls,
    coverage and read timestamps; it is written only through the user's save
    dialog. PDF uses the same redacted page. Re-verify never calls a write API.
12. **Account id.** The account-wide block needs the account id (STS); it is
    passed to S3 Control and SCP lookup and dropped. It is never stored, shown,
    sent to the model or put in a fix. Fixes use `<account-id>`.
13. **Demo storage** answers in process through an SDK request handler: no port
    is opened and nothing leaves the machine. The demo account is added only by
    the explicit demo action.
14. **Dropped files.** The preload turns a dropped or pasted `File` into a path
    with `webUtils.getPathForFile`, which yields nothing for a file the page
    constructed; the main process accepts only absolute paths to regular files
    up to 4 GiB, at most ten at a time.
15. **Updates** come only from this repository's GitHub releases through
    `electron-updater`, in packaged builds. A missing update feed is shown as
    unavailable in Settings rather than failing silently.

## Access is evidence

The access view is deliberately not presented as a definitive authorization
answer:

- Bucket-policy and ACL rows are grants. They are not merged with every
  identity, SCP and condition into one verdict.
- Conditions are listed but not evaluated. A conditional grant or Deny can make
  an answer undecided.
- IAM evaluation covers users, groups and roles returned by account
  authorization details. Service principals, federated identities and an
  external account's identity policy are not enumerated.
- Display is capped at 120 paths; IAM pagination, SCP pages, Access Analyzer
  pages and role trust have their own bounds. Truncation is reported.
- A model-free account check reads access paths for up to 24 buckets per
  account. When that is fewer than the account has, the run states
  `examined / total`.
- A missing permission is a named blind spot, not an empty grant list.

The user can therefore say "these grants are visible and this is what stayed
unread", not "this is the complete set of principals who can reach the bucket".

## Threat notes

- **A hostile S3-compatible endpoint** can return huge XML, hostile bucket names
  or error text. Responses are read through the AWS SDK's typed shapes, posture
  is projected onto enums and booleans, and generated fix text only accepts a
  bucket name matching `[A-Za-z0-9][A-Za-z0-9._-]{0,254}` — anything else has no
  generated fix because no single quoting rule is safe across POSIX shells,
  PowerShell and cmd.exe.
- **A hostile attached file** can be enormous or malformed. Imports stream, cap
  rows at 2,000,000, cap each string, and treat a giant line as data rather than
  loading it whole. Inventory full import is additionally capped by manifest
  file count, per-file bytes and total bytes. Attachment contents are not
  malware-scanned.
- **The renderer is sandboxed**: `contextIsolation`, sandbox and no
  `nodeIntegration`, a CJS preload, and a CSP that forbids remote scripts. It
  never receives a credential, a raw provider message or a filesystem handle.
- **The model is untrusted**: it can propose a fix, never apply one; it cannot
  open, resolve or accept Issues, and its prose is never parsed as product
  state. A name in the answer summary that no tool returned is marked on the page.
  A clean account claim while a run still has open reads is corrected once; the
  page's `Reads open` status remains authoritative. Tool output is wrapped as
  untrusted data before the model sees it.
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

## Not claimed

- Fixes are text. Re-verification observes the account after the user applies a
  plan and can confirm that the planned codes are now clear; it cannot prove
  which command was run, and it never applies one.
- The access view is not a complete IAM authorization proof. Conditions,
  service principals, federated identities and external identity policies can
  remain unread or undecided.
- No automated contrast or full accessibility certification is claimed; the
  E2E runs axe and fails on serious or critical violations only.
- No import from the previous app's database exists. A new install starts empty.
