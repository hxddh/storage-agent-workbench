# Changelog

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
