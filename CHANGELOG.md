## 37.0.0 — 2026-10-29

Storage Agent is a local, read-only agent for object storage. The agent reads,
judges and says what it found; the app gives it read-only tools that return
what the services return, keeps the safety boundaries, and shows every call in
the conversation where it happened.

- **One read-only `call`.** Any operation of S3, S3 Control, STS, IAM,
  Organizations, KMS, Access Analyzer, CloudWatch or CloudTrail whose name says
  it reads (Get, List, Head, Describe, Lookup, Search, Select, Simulate), except
  the few that hand out credentials, with the operation's own input. The
  response comes back as JSON, or the service's error code, HTTP status and
  message. A body or event stream is read up to `max_bytes` (default 1 MiB, the
  agent's choice). A custom-endpoint account answers every service at its own
  endpoint; its credentials are never sent to AWS.
- **`query`** runs a read-only JavaScript script in a QuickJS sandbox with
  `call()`, `dataset()`, `inventory()` and read-only `sql()`. It runs until it
  returns or the user stops it; sandbox memory defaults to 1 GiB and the agent
  can raise it.
- **`probe`** sends one unsigned request to the account's endpoint and returns
  what came back: addresses, status, headers, certificate and timing.
- **`more`** reads the rest of a result longer than 24,000 characters; nothing
  a tool returned is out of the agent's reach.
- **`note`** remembers text and forgets the agent's own notes; every note is in
  the prompt with its id. **`ask`** asks the user.
- **No harness limits.** No round ceiling, no tool timeout, no fixed output cap
  (each model's maximum is learned from its provider). Stop is the user's
  control.
- **Safety.** Read-only by operation name; bucket scope checked before any
  bucket call; secrets sealed in the vault; account ids scrubbed from every
  response; tool output inside `<untrusted-data>`, redacted.
- **Data.** One schema; a database of any other layout starts over.
