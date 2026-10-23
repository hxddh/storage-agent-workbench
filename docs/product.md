# Product

Storage Agent is a local-first desktop Agent for object storage — AWS S3 and every S3-compatible service (R2, MinIO, OSS, COS, BOS, TOS, B2, GCS interop, custom endpoints). The user delegates work in plain language; the Agent investigates with read-only, bounded tools, answers with evidence, and remembers what it learned about the storage estate between tasks.

It is not a chatbot, a storage console, a ticket system or a coding agent. It never writes to storage: fixes are text the user applies with their own credentials.

## What people use it for

- **Diagnose**: an access error, a slow bucket, a presigned URL that fails, a TLS or addressing problem.
- **Review**: one bucket's configuration, or a survey of every bucket in an account — exposure, encryption, public access block, lifecycle, versioning, logging.
- **Analyze**: an access log or inventory the user attaches, or evidence the Agent imports from a source the survey discovered (bounded).
- **Estimate**: storage-class mix (bytes per class) over time under candidate lifecycle rules. It never quotes a price.
- **Look after**: the Agent's estate memory keeps known accounts, buckets, posture changes, Issues and notes. A watch can sweep an account on a schedule and open a task only when something new turns up. Ask the Agent for a fix, a re-check or what changed; those are work, not a separate admin console.

## The window

**Sidebar · title bar · one Agent workspace · one Composer**, plus one closable **Evidence** pane.

> The Task is the window's object. The estate is the Agent's memory. Storage is a capability, not a page.

- The **sidebar** is New task, an in-place search, the task list grouped by day, and Settings — nothing else. There is no Storage or Bucket entry. In a narrow window it overlays the page. A row shows state as a mark: working (pulsing), queued, needs attention; a task the watch opened carries a shield.
- **⌘K** focuses the sidebar search.
- The **title bar** is chrome: the task name appears there only when the sidebar is collapsed, and its right-hand button opens **Evidence**. Work state lives in the sidebar row, the live workspace and Stop — never as a second pill or progress hairline.
- The **Composer** is the only way to give the Agent work. It is centred on Home and docked at the foot of a task; one component, one behaviour. *Send* at rest; while it works, *Add to the request* (a steer) and *Stop*. It has a paperclip for files, the model chip and Send. An upload shows real progress and can be cancelled; a failed first upload removes the empty task it created. There is no `@` estate picker and no account/bucket tree: the user names what they mean, and the Agent resolves it from the estate; if the request is ambiguous it asks.
- The model chip shows which model the next turn uses; with none set up, Send waits and the chip says where to add one. Stopping keeps what was written so far as the answer.

### Home — an empty Task

Home is the same workspace before its first Direction: one small Agent mark, one sentence as the page's one `<h1>`, and one Composer directly beneath it, centred together. There are no starter cards, prompt links, readiness paragraphs, account lines, issue tables, connection rows or bucket indexes. The Agent resolves the estate from the request; nothing on Home submits work on its own.

### A task — one conversation

A Turn is the objective, then one assistant section:

1. **Receipt** — `2 checks · 1s` (one click opens Evidence). While work is live, the real calls that already returned, progress, commentary and steers are shown in order; the running call is the one head line, never repeated.
2. **Answer** — the model's final message, streamed while live and kept whole once settled. It interprets the work instead of retyping it.
3. **Findings** — a flat list of severity dots, when the Agent recorded them.
4. **Data** — the deterministic artifact the tool returned (survey table, listing, configuration view, fix preview), folded beneath the answer. A fix opens by default because it is the deliverable; everything else waits until asked for.

There is no next-step prompt and no second suggestions block. A queued request shows *Queued* with *Withdraw*; a request that needs attention offers *Continue* or *Open Settings*. A turn without a recorded conclusion shows its answer; nothing is guessed.

A message can be **edited**: that sends a new version of it — a fork of the task at that point — and *1 / 2* switches between versions. The fork keeps its attached files. Reloading, reconnecting or following up never reorders, drops or duplicates anything: the page is the item stream, merged by sequence. A long task's first snapshot is bounded to its newest 60 Turns; *Load earlier turns* reads the rest in pages without moving the head.

### Evidence

The one side pane for a task, in one scroll: a meta line (`2 checks · 5 model requests`), then one row per call. A row opens in place to a compact human summary of its result and its arguments/output behind *Raw*; there is no second page and no Back control. *Save report* (the task report in the reader's language, as Markdown), attached files and folded usage stay below. The full deterministic table belongs to the task's *Data* fold, not to Evidence.

### Settings

General (theme, language, and one folded Safety line — read-only storage, keys stay on this computer, stop any time; *Advanced*: skills, the standing-instructions file, the MCP server) · Models (presets for OpenAI, Anthropic, DeepSeek, OpenRouter, Ollama, LM Studio, vLLM, llama.cpp, any OpenAI-compatible endpoint; masked keys; a local model's context window prefilled with 16 384, a hosted one's under *Advanced*; a live test) · **Connections** (the configured storage services; each account's **Watch** first: Off · 6 h · Daily · Weekly, Check now; the session token and bucket/prefix scope under *Advanced*). Save stays on what was saved and shows its test result. Connections is configuration, not a second navigation surface. On a narrow window Settings takes the whole screen, with one row of section tabs above one scrolling body.

## Principles

- **The Task is the window's object; the estate is the Agent's memory.** Accounts, buckets, posture, Issues and notes are what the Agent knows, not a tree the reader has to browse.
- **Nothing is invented.** Findings, Issues, progress and figures come from tool results and deterministic engines; a gap stays a gap.
- **Read-only, bounded, stoppable.** No approval prompts, no plan mode, no modes: the one data-moving tool runs inside hard server-side bounds, and Stop ends any work — a stopped or timed-out tool ends at its next check.
- **The run is legible.** Real calls and progress while they happen; the answer leads; deterministic data is a quiet fold; Evidence is the record, not a duplicate.
- **One of everything**: one Agent, one submit path, one stream, one Composer, one workspace, one Evidence pane.
- **Native and quiet**: the platform's own chrome, one accent colour, English and Chinese throughout.
