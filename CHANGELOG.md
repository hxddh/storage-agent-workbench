# Changelog

## 25.0.0

Memory that can answer what happened, and a reading that says when it is
closed. No new surface, no new tool, no write path.

### Added

- **Estate history.** `estate(history: true)` reads remembered Issue life-cycle
  events (opened, resolved, recurred, gone, accepted, reopened) and posture
  changes, newest first, with optional `bucket`, `code` and `since` filters.
  It is rendered under the existing Data section; raw requests and search-index
  text are never part of memory.
- **A deterministic read status.** The scope line says `Reads complete` or
  `Reads open: n · m blocked`; failed, stopped, blind, pending, truncated,
  undecided and partial access reads keep it open. The Not read section names
  them.
- **A clean-claim correction.** The model gets one correction if it calls the
  account clean while the current run still has open reads.

### Fixed

- A narrowed survey no longer replaces account-wide coverage. A one-bucket
  re-read updates its own bucket, but a pending or blind account read stays
  visible; the same rule applies to the agent's per-run coverage.
- A failed or stopped storage read can no longer sit beside a `Reads complete`
  line.
- Access coverage is now shown on the access chain and counted in the scope
  status. Query access coverage is included too.

### Verification

- Added Issue-event history and filter tests, scoped-survey coverage tests,
  failed-read UI tests, history rendering tests and clean-claim correction tests.
- Added `history-recall` and `blind-clean-claim` evaluation scenarios. The
  real-model evaluation still requires `EVAL_*` credentials; this checkout has
  no model key or local model.

## 24.0.0

A quieter window and a new identity. The read-only agent, durable task model,
storage reads and evidence boundaries are unchanged; this release is about how
the product presents them.

### Changed

- **A new mark.** The app icon and sidebar brand are one flat tile with an open
  rounded frame. There is no gradient, dot or secondary element. The geometry is
  sized to keep the opening legible from 16px up.
- **A real type system.** Geist and Geist Mono ship with the app instead of
  falling back to a generic system sans. The warm paper/graphite palette, single
  cobalt accent, hairline sections and flat surfaces now hold across light and
  dark themes.
- **Home is a start surface, not a setup page.** Account state, **Check account**,
  demo storage and **Add an account** are the main path; model setup is a quiet
  secondary action and the composer states that a model is only needed to ask a
  question.
- **Settings is navigable.** Model, Storage accounts, Memory and Appearance are
  four panes in a rail instead of one long web form. The rail becomes a
  horizontal tab row below 860px, and account add/edit lives in one inline form.
  Inputs, selects, checkboxes, focus rings and the first-run key hint are styled
  consistently.
- **The brief is easier to read.** The verdict is set at 17.5px, findings group
  by bucket with hairline separators, and **N more findings** is a real
  disclosure control. The latest request stays a quiet line above the verdict.
- **Running work is visible.** A status strip above the composer names the
  current phase and target, the latest note and elapsed time; checks still fold
  to their receipt when the task settles.
- **The compact window works as a window.** Home gains the same Tasks button as
  a task screen, the sidebar is dismissable with a scrim, and Settings preserves
  its version/update state below 860px.
- **Documentation is current.** `README`, `CLAUDE.md` and every `docs/` page now
  describe the 24.0.0 tree; the screenshot and 17-state visual baseline set are
  current.

### Fixed

- A narrow Home screen previously hid the sidebar without a way to reach tasks
  or Settings. The compact header now provides it on every screen.
- First-run Settings told users to leave the API key empty “to keep the saved
  one” even when no key had ever been saved. The initial hint now explains the
  vault write.
- The task actions button and the brief overflow no longer share an accessible
  name, and task titles with an ellipsis get a themed tooltip only when needed.

## 23.0.1

A test-fixture correction for the released 23.0.0.

### Fixed

- The smoke model now reads the bucket names the survey actually returned
  instead of hardcoding the E2E demo buckets. The `public-aws` smoke scenario
  is 7/7 again, with no failed config call and a grounded verdict. This does
  not change product behavior; it makes the release report truthful.

## 23.0.0

A version about making the task surface explicit, observable and honest about
what it did not read.

### Changed

- **First run is explicit.** With no account, Home offers **Try with demo
  storage** and **Set up a model / Add an account**. Check account never adds
  demo storage silently; the demo is a choice.
- **Check account is observable.** It opens its task immediately, streams
  survey and access progress, and leaves the deterministic checks and verdict
  in the durable task. A repeated check gets an account-named title with the
  minute, so two checks on the same day stay distinct.
- **The brief has a scope line.** It names the account, `read / total` buckets,
  blind reads, survey-cap buckets and the read time. A capped survey is no
  longer invisible, and the model-free verdict refuses to call it clean.
- **Actions are discoverable.** Copy and an overflow menu are always visible;
  Save, Check again, Re-verify, link, evidence and PDF live in the overflow.
  The task list no longer reserves a hidden 28px More button below every row.
- **Findings read as prose.** Bucket group headings use body-copy size, detail
  lines wrap instead of truncating, and the composer dock leaves room for the
  last disclosure.
- **Test tests the form.** Settings tests the provider, model, base URL and key
  currently typed, not the previously saved model. A typed key fetches the
  provider's model list automatically; the manual Fetch action remains only
  when no key is in the field. Section headings use the same sentence-case
  hierarchy as the brief.

### Fixed

- **CloudTrail attribution** uses each bucket's region instead of the account's
  default region.
- **Access paths** state that policy and ACL rows are grants, not a merged
  effective-access verdict.
- **Markdown fallback** no longer flashes raw backticks while the lazy renderer
  loads.

### Known limits

- The Settings sheet is still one long form; its visual simplification is not
  part of this pass.
- Policy/ACL grants are labelled as evidence, not yet intersected with every
  identity and SCP Deny into one effective verdict.
- Real-model evaluation and signed installers remain release-channel work.

## 22.0.0

A version about finishing the answer without a model, and about the access
engine telling the truth at its edges.

### Added

- **Check account.** Home and the brief run a deterministic survey plus access
  reads through `harness.audit()` and write one `sa.audit` entry. The verdict is
  generated by `shared/audit.ts` from the same views the window renders; no
  model is called. On a first run with no account, Check account adds demo
  storage. `scripts/e2e-audit.mjs` proves the path with no model and no key.
- **Access evidence at the edges.** A bucket policy's explicit Deny is
  intersected with identity grants; a conditional Deny is undecided instead of
  an allow; object and bucket actions use their matching resource form; ARNs are
  case-sensitive; a grant to another account is marked with an unread identity
  policy. Policy display truncation is reported as coverage truncation.
- **Shared access session.** IAM details and SCPs are read once per task across
  buckets and reverse principal queries; code mode charges only the request
  delta. Reverse queries show `bucketsExamined / bucketsTotal`.
- **Unavailable update feed.** A missing `latest*.yml` is reported in Settings
  as a platform without an update source instead of failing silently.

### Changed

- **A quieter window.** Home no longer shows rule-derived suggestion pills; the
  brief no longer shows next checks or a folded question history. The latest
  request is one quiet line above the verdict. The setup action appears once,
  and findings say “N more findings” instead of an unlabeled count.
- **First run without a model.** The home copy distinguishes checking from
  asking, and the disabled composer says a model is needed to ask, not to run
  the check.
- **Release line.** The release workflow runs every platform or publishes
  nothing, falls back to ad-hoc macOS signing and unsigned Windows when
  credentials are unavailable, and writes the evaluation and signing facts into
  the release notes. A missing update feed is a visible state, not a silent
  failure.
- **Tests.** Access tests cover array and `NotPrincipal` matching, another
  principal's Deny, conditional Deny, action/resource pairing, ARN case and
  policy truncation. The deterministic audit verdict has unit tests; the no-model
  first run has an E2E test.

### Known limits

- A release without `EVAL_API_KEY` attaches a harness smoke report, not a
  real-model quality result; the release notes say so.
- Without signing certificates, macOS is ad-hoc signed and Windows unsigned.
- The access engine reports IAM users and roles, not AWS service principals or
  every federated identity; an external principal's identity policy is a named
  blind spot.

## 21.0.0

A version about completeness and proof. Access is no longer a sample, CloudTrail
has a stated window, Inventory can cover its whole manifest, and a first run can
start from a local model and demo storage.

### Added

- **Access coverage.** `access` reads all IAM users, groups, roles, managed and
  inline policies, trust policies and permission boundaries with paginated
  `GetAccountAuthorizationDetails`, evaluates them locally, and reports
  `evaluated / total`, undecided conditions and truncation.
- **SCP awareness.** Organizations policies are read from the account, its OUs
  and root when permissions allow; otherwise SCPs are a named blind spot.
- **`principal()` code mode.** Ask which buckets a principal reaches, or which
  principals reach one bucket.
- **Full Inventory.** `inventory({full: true})` imports every file in the latest
  manifest into a local dataset; `aggregate` queries it. CSV and Parquet are
  supported; coverage is explicit.
- **90-day CloudTrail.** The attribution window is shown, event lookup paginates,
  and an empty successful lookup says “no matching management event” instead of
  “unavailable”.
- **First run.** Home lists running local models, can add demo storage and ask
  the first survey without a key. A first run without a model no longer offers
  a demo button that cannot yet answer.
- **Access tests and coverage UI.** Policy/ACL/IAM trust and truncation are
  covered; the brief shows principal coverage and unread sources.

### Changed

- Provider kind migration v10 repairs legacy R2/MinIO/Aliyun/other accounts that
  v7 had labelled AWS.
- Re-verification replays the aspects the task actually read, preserves accepted
  issues, marks truncation, and surfaces errors.
- Model settings infer context and thinking from the chosen model; blank keys
  are not reused across providers.
- Findings are grouped by bucket; the home and brief columns align with the
  composer; Settings uses the wider reading column; the data summary is no
  longer monospaced; stray sidebar gaps are removed.
- `untrusted-data` boundaries escape stored `<`/`>` so object metadata cannot
  close them.
- Visual regression uses a diff mask, so unchanged pixels no longer count as
  hot regions.

### Release

- Real-model Eval is a release job; two model reports are attached to the release.
- Signing is required; the release fails before build when certificates or
  notarization secrets are missing. macOS notarization is enabled explicitly.
- Visual regression adds per-region hot-tile checks.

## 20.0.0

From answering a question to keeping an account legible. The window stays one
task, one brief and one composer; the agent gains the reads and receipts that
make a conclusion checkable.

### Added

- **Re-verify, without a model.** The task re-reads the buckets it touched and
  writes a report of what changed. No prose is regenerated; blind reads stay
  blind and are counted.
- **Evidence pack.** Findings, controls, read timestamps, the redacted tool
  views and the re-verification report export as JSON in one action.
- **Access paths.** `config` aspect `access` reads the bucket policy and ACL
  locally, simulates bounded IAM identities, reads a KMS key policy when the
  bucket uses SSE-KMS, and attaches Access Analyzer findings. A denied read is
  a blind spot, not an empty grant list.
- **Changes and attribution.** A survey compares its reading with the last
  remembered posture, records the differences, and asks CloudTrail who made
  them. A denied lookup is reported as unknown, never as nobody.
- **S3 Inventory.** Code mode reads the latest inventory manifest and a bounded
  page of CSV or Parquet rows, for buckets ListObjects cannot enumerate cheaply.
- **Batch fixes.** Omit bucket and code to generate one fix per open issue class;
  the page still shows each change as text the user applies.
- **Provider capability matrix.** AWS, R2, MinIO, Aliyun OSS, GCS interop and a
  generic S3-compatible provider each declare which account, IAM, KMS,
  CloudTrail, inventory and policy-status reads exist.
- **Permission diagnosis.** An access-denied read names the exact IAM action it
  needs; a provider capability gap does not pretend to be a missing permission.
- **Model setup in one step.** Fetch the provider's models, infer the context
  window, and leave reasoning on automatic. No hand-typed context window.
- **Model tiers.** Small, mid and large context models get different prompt
  detail and tool-round budgets.
- **A home that is an estate summary.** Accounts, last read, unresolved risk,
  changes since the last visit and three questions derived from open issues.
- **Pinned tasks, Today/Earlier groups, relative times and a state dot.**
- **`@` context.** Point at a remembered account, bucket or issue; the names
  travel with the request as focus, never as authorization.
- **Rule-derived next checks.** Two or three questions come from finding codes,
  not from the model, and clicking one asks it.
- **Freshness.** Remembered findings older than a configurable number of days
  are marked possibly stale.
- **More native.** macOS vibrancy, Windows Mica, notification Open action,
  drag a finding out as Markdown, and Save PDF.
- **Dependency audit, SBOM, bundle budget and axe in CI.**
- **Analysis belongs to code mode.** The separate file-analysis tool is gone:
  `dataset` and `aggregate` are query primitives, so the product has ten tools.

### Changed

- Schema head 9: provider kind, pinned tasks and posture changes.
- The brief's inline names are text, not code chips; the activity line is still
  a receipt, and the composer remains in one position.
- The first paint ships only Home, the sidebar and the composer; Markdown,
  Brief and Settings load on demand. Initial JavaScript is under 500 KiB.
- Re-verification and evidence export are quiet actions on the brief, not a
  second screen.

### Removed

- `analyze` as a tool (moved into `query`).
- Hand-entered context-window and thinking controls.
- The separate `home`/`empty` visual language.

## 19.0.0

From a checker to an agent that can answer the question asked. Same product —
one task, one brief — with eleven read-only tools.

### Added

- **Code mode.** `query` answers what no fixed check can — the largest prefixes,
  data untouched for years, versions piling up — with a short script over six
  read-only primitives in a QuickJS sandbox: no network, files, process or
  timers; 2,000 calls, 500,000 listed items, 120 s and 256 MiB per script. The
  rows become a table or a bar chart; the script stays as the evidence.
- **The whole account.** The account-wide public access block is read (STS,
  S3 Control) and cancels bucket exposure the way AWS does; the account id is
  never stored. A survey reaches 5,000 buckets, reads the longest-unread first
  and continues where it stopped.
- **Twelve rules, mapped to Security Hub.** New: account block (S3.1), TLS not
  enforced (S3.5), ACLs still deciding access (S3.12), access logging off
  (S3.9), large Standard-only buckets. Findings name their control. Every new
  rule has a CLI, Terraform and API fix.
- **Capacity and cost.** CloudWatch storage metrics per bucket — size, objects,
  class mix, 14-day growth — and a labelled list-price monthly estimate.
- **Claim checks.** A verdict that calls a bucket public, or not public, against
  the readings gets the same one correction as an ungrounded name, then a mark.
- **Demo storage and local models.** Six believable buckets answered in process,
  no port; Ollama and LM Studio models one click away.
- **Native.** `storage-agent://task/<id>` links open a task; Copy link on the
  brief; `j`/`k`/`a` walk findings by keyboard; Settings loads lazily.
- **Compatibility CI.** A `compat` job runs survey against moto, an independent
  AWS emulator, for exposure and the account block.

### Changed

- Schema head 5: `providers.account_json`, `account_at`. Bucket posture keeps
  capacity numbers.
- Survey shows the first 1,000 Issues and the total; the brief no longer
  replaces what it knew from an incomplete list.
- ACL and logging advisories became rules.

## 18.0.0

Proven, measured, native. A rebuild of every layer under the same product: one
task, one brief, ten read-only tools.

### Added

- **One reading per bucket.** Survey and review read through the same typed
  facts (`s3/facts.ts`); the seven rules decide from facts by code. A survey now
  decides every rule, including wildcard principal, CORS and noncurrent
  versions, and the two can no longer disagree.
- **Local policy evaluation.** S3-compatible stores without GetBucketPolicyStatus
  are judged from the policy document; a source-IP, VPC, organization or account
  condition narrows an Allow to everyone. The bucket's public access block
  cancels exposure.
- **AWS profiles.** An account can use a named profile — SSO,
  `credential_process` and assume-role resolve through the AWS SDK; nothing is
  copied into the app. Multi-region accounts read each bucket from its region.
- **Verify after a fix.** `survey` takes `buckets` to re-read only what the user
  changed; the brief shows what the task proved fixed and drops the fix.
- **Accept risk.** The user can accept an Issue from its finding; it folds
  away and stays accepted until a reading proves it gone. The model never can.
- **Grounded verdicts.** Every bucket, key and account the verdict names must
  appear in a tool result of the task. The agent gets one correction; what is
  still ungrounded is marked on the page.
- **Reasoning models.** OpenAI through the Responses API, Anthropic thinking,
  and a thinking level in Settings. Prompt caching where supported. The checks
  receipt shows the run's tokens.
- **Native.** A notification when a run finishes in the background, a dock
  badge or taskbar progress while anything runs, files dropped or pasted onto
  the composer, Stop on ⌘., Search on ⌘K in the menu, the last task reopened at
  launch, and background updates from GitHub releases.
- **Evals.** `scripts/eval.mjs` scores a real model in the real window against
  fake S3 profiles; CI runs it in smoke mode. Domain tests run the real SDK and
  tools over HTTP into a real estate.

### Changed

- The brief shows current state: a later reading that proves a rule clean
  removes its finding; findings from memory say when they were read; several
  fixes are kept, the newest open.
- A survey remembers each bucket as it is read, honours Stop at once, stops
  starting buckets before its time budget, and reports what it did not read.
- A bucket a complete listing no longer shows resolves its Issues as gone.
- Tool status is written by `agentTool()` and never parsed from result text.
- Notices are codes the window words in the user's language. Retry carries the
  request's files; Continue is a boundary, not a question.
- Every run uses the model in Settings, so a model change reaches old tasks.
- The step cap is 24 rounds and says so on the page; a repeated storage read is
  blocked and left off the checks.
- Redaction also covers model API keys, shared-credentials lines, tool targets
  and error notes.
- Schema head 4: account auth kinds, bucket region and `gone_at`, Issue
  `detail` and `accepted_at`.

### Fixed

- A bucket whose name contained "aborted" or "timed out" marked its survey as
  stopped and hid its data.
- A finding resolved by a later survey stayed on the page.
- A lifecycle review of a bucket without lifecycle rules resolved the
  multipart and noncurrent-version Issues it should have kept open.
- A model change could leave earlier tasks pointing at a model that no longer
  existed.

## 17.0.0

The brief. A task is one page, not a transcript.

### Added

- **The brief.** A task renders as a verdict, findings, one data section, the
  fix, the checks that proved it and the folded questions. One deterministic
  projection (`shared/brief.ts`) feeds both the window and the search index.
- **Evidence on demand.** A finding opens the check that produced it; findings
  are searchable and open highlighted.
- **Memory in Settings.** Notes the agent keeps are listed and can be forgotten.
- **A real delete.** Deleting a task purges its pi conversation, entries, tasks,
  submissions, documents, revisions, datasets, audit rows and task directory.

### Changed

- The model writes only the verdict, at most two sentences. Findings, tables,
  fixes and checks are rendered from tool results, never retyped.
- Findings are merged by rule and bucket, then ordered by severity.
- Data folds when findings already answer; it opens by default when the table is
  the answer.
- The agent reads the estate first and surveys only when memory is empty, stale,
  or the question is about current exposure.
- The brief and composer share one 720px column; Home shows one readiness action.

### Removed

- Watch, scheduled checks and Check now.
- The chat transcript, bubbles, per-block Copy/Save duplication and the
  developer-inspector look.
- The `watch` table and `task_meta.origin` (schema head 3).

## 16.0.1

Secondary text now meets WCAG AA in both themes. `--ink-3`, used for
durations, Copy / Save as and account meta, measured 3.15:1 on the light
background and 3.8:1 in dark; both now clear 4.5:1 with headroom.

## 16.0.0

The interaction release. No new tools, no new storage capability.

### Added

- **Running tool rows.** A call appears when it starts, shows its real progress
  (`3 of 12 buckets`) and settles in place. The bottom live line is gone.
- **Search.** ⌘K searches task titles, requests and answers; results show the
  matching fragment, and opening one jumps to that message.
- **Deliverables.** Any table copies as CSV or saves to a file; any answer copies
  as Markdown or saves.
- **Retry / Continue.** A failed run offers Retry; a stopped run offers Continue.
- Window size and position are remembered. Settings traps focus and gives it
  back on close.

### Changed

- Results are flat sections separated by hairlines instead of cards nested in
  the document.
- The task title is no longer repeated above the document; the sidebar is the
  one place it appears.
- The home heading sits above the composer at 20px instead of a centred hero.
- The composer no longer repeats the live tool state.
- Delete and remove use an inline confirmation instead of a native dialog.

## 15.0.2

Intel Mac builds alongside Apple silicon. No functional change.

## 15.0.1

The first published build. 15.0.0 was tagged but never released: the Linux
package and the end-to-end job failed on packaging and build order, both fixed
here.

## 15.0.0

A complete rebuild. The Python FastAPI sidecar, the Tauri shell and the previous
window are gone; the product is one Electron application in TypeScript.

### Added

- Read-only agent runtime on `pi-durable`: durable submits, steering, abort,
  resume after a crash, compaction and per-call tool tasks.
- Ten tools: `survey`, `buckets`, `objects`, `object`, `config`, `probe`,
  `estate`, `fix`, `analyze`, `note`.
- Seven deterministic Issue rules with tri-state evaluation: a read that could
  not see something decides nothing.
- Estate memory: recorded bucket posture, Issue history, notes and an audit row
  per tool call.
- Fix generation in AWS CLI, Terraform and API-document formats, with an impact
  preview that names its own gaps.
- Local analysis of attached access logs and inventories (CSV, TSV, JSONL,
  Parquet) in a per-dataset SQLite file; only aggregates reach the model.
- A watch per account (off / 6 h / daily / weekly) that opens a task and
  notifies when new Issues appear.
- One window: task list, one document, one docked composer, a full-screen
  Settings sheet. Dark and light from the same tokens.

### Changed

- The answer is short prose; tables, findings and fixes are rendered by the
  window from typed tool results instead of being retyped by the model.
- Model access through pi-ai: OpenAI, Anthropic and any OpenAI-compatible
  endpoint. Context windows drive compaction.
- One SQLite database through Node's built-in `node:sqlite`. No native addons.

### Removed

- The turn tree, forks and version switching; a task is one linear stream.
- The Evidence side pane, report export and trace export.
- The MCP bridge, user skills, standing instructions and the skill loader.
- Downloading S3 access logs; attach a log instead.
- Import of data from earlier versions.
