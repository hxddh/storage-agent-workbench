# Product

Storage Agent is a local-first desktop Agent that looks after object storage — AWS S3 and every S3-compatible service (R2, MinIO, OSS, COS, BOS, TOS, B2, GCS interop, custom endpoints). The user delegates work in plain language; the Agent investigates with read-only, bounded tools, answers with evidence, and remembers what it learned about the storage *estate* between tasks.

It is not a chatbot, a storage console, a ticket system or a coding agent. It never writes to storage: fixes are text the user applies with their own credentials.

## What people use it for

- **Diagnose**: an access error, a slow bucket, a presigned URL that fails, a TLS or addressing problem.
- **Review**: one bucket's configuration, or a survey of every bucket in an account — exposure, encryption, public access block, lifecycle, versioning, logging.
- **Analyze**: an access log or inventory the user attaches, or evidence the Agent imports from a source the survey discovered (bounded).
- **Estimate**: storage-class mix over time under candidate lifecycle rules; dollars only with a price table the user confirmed.
- **Look after**: the estate keeps known buckets and Issues; a watch can sweep an account on a schedule and open a task only when something new turns up.

## The window

**Sidebar · title bar · one document · one Composer**, plus one closable side pane.

- The **sidebar** is the task list (grouped by day, searchable in place), New task, Home and Settings. A row shows state as a mark: working (pulsing), queued, needs attention; a task the watch opened carries a shield.
- The **title bar** names the task and shows its real state; a hairline runs under it while work is live; its right-hand button opens the side pane.
- The **Composer** is the only way to give the Agent work: *Delegate* at rest, *Steer* and *Stop* while it works. Files attach by button or drop (access logs, inventories); a file always makes a new Direction. The model chip shows which model the next turn uses.

### Home — what to care about now

The greeting, the Composer, three starters (*Diagnose an access error*, *Survey my storage account*, *Analyze an access log*) that only fill the Composer, then:

- **Before the first task** — when no model or no storage account is configured, one card each, opening the right Settings pane.
- **Your storage** — each account with its known buckets, when it was last checked and whether it is watched.
- **Needs care** — open Issues, most severe first. Each expands to its detail, the generated fix (a command to copy, never applied), **Verify** (a read-only re-check that can resolve it), **Open task** (the task that found it) and **Accept risk**.

### The Task page — result-first

From the top: banners (a queued Direction with *Withdraw*; *Resume* or *Open Settings* when the last Turn needs attention), the **work in progress** while a Turn runs (its Direction, the Agent's short commentary, live tool groups with real progress counts, the answer as it streams, the conclusion as soon as it is recorded), the latest **Result**, then the **Work log**.

The **Result** leads with the conclusion the Agent recorded — the direct answer, findings with severity badges, up to four next steps that fill the Composer — then the full answer (tables sort and fold in place), figures computed from the deterministic analyses, and the outputs: **Evidence · Report · Activity**, each opening the side pane. A turn without a recorded conclusion shows its answer; nothing is guessed.

The **Work log** keeps every earlier Direction as a document section: the user's words as the heading, the commentary, folded *Worked for …* groups, the answer folded to one line. A Direction can be **edited**: that sends a new version of it — a fork of the task at that point — and ‹ 1 of 2 › switches between the versions. A task with one Direction has no Work log.

### The side pane

- **Evidence** — every finding the task recorded, deduplicated, most severe first (each expands to its detail and which Direction it came from), and the attached or imported evidence.
- **Report** — the task report in the reader's language, conclusion first; saved as Markdown.
- **Activity** — every tool call; one opens as a document with its arguments and output.

### Quick Ask

A small always-on-top window (⌘⇧Space, the tray, View › Quick Ask) for one question. It becomes an ordinary task through the same submit path; the answer streams there, and *Open in the main window* continues it in full.

### Settings

General (theme, language, the safety floor in three points) · Models (presets for OpenAI, Anthropic, DeepSeek, OpenRouter, Ollama, LM Studio, vLLM, llama.cpp, any OpenAI-compatible endpoint; masked keys; a live test) · Storage accounts (presets for the common services; scope by bucket and prefix; each account's **Watch**: Off · 6 h · Daily · Weekly, Check now) · Skills & bridges (skills, the standing-instructions file, the MCP server).

## Principles

- **The estate outlives the task.** Every task starts knowing the accounts, the known buckets and the open Issues.
- **Nothing is invented.** Findings, Issues, progress and figures come from tool results and deterministic engines; a gap stays a gap.
- **Read-only, bounded, stoppable.** No approval prompts: the one data-moving tool runs inside hard server-side bounds, and Stop ends any work.
- **One of everything**: one Agent, one submit path, one stream, one Composer, one side pane.
- **Native and quiet**: the platform's own chrome, one accent colour, English and Chinese throughout.
