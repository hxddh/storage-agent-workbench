# Changelog

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
