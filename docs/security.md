# Security

## The floor

1. **Read-only.** No tool calls a mutating S3 API. There is no generic shell, no
   raw HTTP proxy for storage, no filesystem access beyond the conversation's
   uploads and datasets directories.
2. **Scope.** A provider may name a bucket allow-list. `assertInScope()` runs
   before every bucket-scoped read and refuses anything outside it. An empty list
   means every bucket the credentials can see.
3. **Secrets.** Cloud keys live in the OS keychain through Electron
   `safeStorage`; without a keyring they are sealed with AES-256-GCM under a
   locally generated 0600 key. SQLite stores only the sealed reference. The
   window receives a masked key id and a `hasSessionToken` boolean. A profile
   account stores only the profile name; the AWS SDK resolves it from the
   user's own `~/.aws` files at call time (SSO, `credential_process`,
   assume-role), and the app lists profile names without reading keys.
4. **Redaction.** `security/redact.ts` removes access-key shapes, `X-Amz-*`
   signatures and credentials, authorization headers, bearer tokens, secret JSON
   fields, account ids inside ARNs, signature query parameters, model API keys
   (`sk-…`) and shared-credentials lines. It runs before a value is stored,
   shown or sent to the model — including tool targets, progress lines and
   error notes.
5. **Envelope.** Every tool result the model sees is wrapped in
   `<untrusted-data source="storage">…</untrusted-data>` and bounded. Stored
   `<` and `>` are escaped before wrapping, so an object tag, metadata value or
   error message cannot close the envelope. Bucket names, object keys and log
   lines can contain hostile text; the envelope tells the model it is data.
6. **No model-facing raw rows.** Logs and inventories are parsed into a local
   SQLite file; the model receives only aggregates and bounded samples.
7. **Audit.** Every tool call writes `audit(tool, target, outcome, conversation)`.
   A refused scope call is recorded as `refused`, a stopped one as `stopped`.
   A re-verification replays only read tools; it never asks the model and never
   writes storage.
8. **Status is structured.** A call's status is written by `agentTool()` into
   `details`; nothing parses result text, which a bucket name or an error body
   could forge.
9. **Code mode.** `query` scripts run in a QuickJS VM in a worker thread with
   no network, filesystem, process, timers or modules, and with model access
   off. The ten primitives check the account scope on every bucket, call only
   List, Head, configuration, inventory and dataset reads, and count against
   budgets of 2,000 calls, 500,000 listed items, 120 seconds and 256 MiB.
   Returned rows are redacted before the model or the window sees them.
10. **Access paths.** Policy and ACL evaluation is local. All IAM principals and
    policies are read through `GetAccountAuthorizationDetails` and evaluated
    locally; SCPs are read from the account/OU/root chain when Organizations
    permits; KMS and Access Analyzer are bounded AWS reads. A denied read is a
    blind spot, and coverage is shown. Scope is checked before the inventory
    destination is read.
11. **Evidence.** The JSON pack contains redacted views, finding controls and
    read timestamps; it is written only through the user's save dialog.
    Re-verify never calls a write API.
12. **Account id.** The account-wide block needs the account id (STS); it is
   passed to S3 Control and dropped. Fixes use `<account-id>`.
13. **Demo storage** answers in process through an SDK request handler: no
   port is opened and nothing leaves the machine.
14. **Dropped files.** The preload turns a dropped or pasted `File` into a path
   with `webUtils.getPathForFile`, which yields nothing for a file the page
   constructed; the main process accepts only absolute paths to regular files
   up to 4 GiB.

## Threat notes

- **A hostile S3-compatible endpoint** can return huge XML, hostile bucket names
  or error text. Responses are read through the AWS SDK's typed shapes, posture
  is projected onto enums and booleans, and generated fix text only accepts a
  bucket name matching `[A-Za-z0-9][A-Za-z0-9._-]{0,254}` — anything else has no
  generated fix because no single quoting rule is safe across POSIX shells,
  PowerShell and cmd.exe.
- **A hostile attached file** can be enormous or malformed. Imports stream, cap
  rows at 2,000,000, cap each string, and treat a giant line as data rather than
  loading it whole.
- **The renderer is sandboxed**: `contextIsolation`, no `nodeIntegration`, a CJS
  preload, and a CSP that forbids remote script. It never receives a credential,
  a raw provider message or a filesystem handle.
- **The model is untrusted**: it can propose a fix, never apply one; it cannot
  open, resolve or accept Issues, and its prose is never parsed as product
  state. A name in the verdict that no tool returned is marked on the page.
- **Updates** come from this repository's GitHub releases through
  `electron-updater`, in packaged builds only. Unsigned macOS builds cannot
  update themselves; the release workflow signs and notarizes when its secrets
  are configured. Signing is a release requirement, not something the app can
  prove from inside the build.

## Not claimed

- Fixes are text. Storage Agent does not verify that a fix was applied; a later
  survey observes the result.
- Vault security depends on the OS keychain when available. The AES fallback
  protects a database copied off the machine only if the key file is not copied
  with it; Settings does not claim otherwise.
