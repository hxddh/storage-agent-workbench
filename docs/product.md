# Product

Storage Agent is a local-first desktop Agent that looks after object storage — AWS S3 and every S3-compatible service (R2, MinIO, OSS, COS, BOS, TOS, B2, GCS interop, custom endpoints). The user delegates work in plain language; the Agent investigates with read-only, bounded tools, answers with evidence, and remembers what it learned about the storage *estate* between tasks.

It is not a chatbot, a storage console, a ticket system or a coding agent. It never writes to storage: fixes are text the user applies with their own credentials.

## What people use it for

- **Diagnose**: an access error, a slow bucket, a presigned URL that fails, a TLS or addressing problem.
- **Review**: one bucket's configuration, or a survey of every bucket in an account — exposure, encryption, public access block, lifecycle, versioning, logging.
- **Analyze**: an access log or inventory the user attaches, or evidence the Agent imports from a source the survey discovered (bounded).
- **Estimate**: storage-class mix over time under candidate lifecycle rules; dollars only with a price table the user confirmed.
- **Look after**: the estate keeps known accounts, buckets, how their posture changed, Issues and notes; each Issue has a fix to apply (CLI, Terraform or the document) with a preview of what it would change, a read-only Verify that closes it, and it reopens when the problem comes back. A watch can sweep an account on a schedule and open a task only when something new turns up.

## The window

**Sidebar · title bar · one document · one Composer**, plus one closable side pane.

- The **sidebar** is the task list (grouped by day, searchable in place), New task, Home, **Estate** and Settings. In a narrow window it overlays the document. A row shows state as a mark: working (pulsing), queued, needs attention; a task the watch opened carries a shield.
- The **title bar** names the task and shows its real state; a hairline runs under it while work is live; its right-hand button opens the side pane.
- The **Composer** is the only way to give the Agent work: *Delegate* at rest, *Steer* and *Stop* while it works. Files attach by button or drop (access logs, inventories); a file always makes a new Direction. The model chip shows which model the next turn uses.

### Home — what to care about now

The greeting, the Composer, three starters (*Diagnose an access error*, *Survey my storage account*, *Analyze an access log*) that only fill the Composer, then:

- **Before the first task** — when no model or no storage account is configured, one card each, opening the right Settings pane.
- **Your storage** — each account with its known buckets, when it was last checked and whether it is watched; an account opens the estate.
- **Needs care** — open Issues, most severe first. Each expands to its detail, the generated fix (never applied), **Verify** (a read-only re-check that can resolve it), **Open task** (the task that found it), **Accept risk** (with an optional reason, kept as a note) and **Open bucket**.

### The estate

The estate is where the storage itself is the subject: every account, an account's buckets (most in need of care first), and a **bucket page** — what needs care (the resolved Issues folded below), what is known (its posture, as last checked), the notes kept about it, and how it changed (posture changes and Issue events, newest first, each with its source and the task behind it). *Ask about this bucket* fills the Composer with the bucket; it never submits.

An Issue's **fix pack** shows the fix as the AWS CLI command, a Terraform resource or the API document — copy whichever you apply changes with — with its notes, and an **impact preview**: what applying it would change, from the evidence the estate holds. For a public access block it counts the anonymous requests in the bucket's attached S3 server access logs; for lifecycle rules it says whether the bucket's existing rules would be replaced. When the evidence cannot tell, it says so and what would answer it.

**Notes** are what you and the Agent want remembered — an owner, an intent, why a setting is deliberate. You write, edit and delete them on the estate, an account or a bucket; the Agent keeps them with its `note` tool; accepting a risk with a reason keeps the reason. Every task starts with the most recent notes as context.

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

- **The estate outlives the task.** Every task starts knowing the accounts, the known buckets, the open Issues and the notes.
- **Nothing is invented.** Findings, Issues, progress and figures come from tool results and deterministic engines; a gap stays a gap.
- **Read-only, bounded, stoppable.** No approval prompts, no plan mode, no modes: the one data-moving tool runs inside hard server-side bounds, and Stop ends any work — a stopped or timed-out tool ends at its next check.
- **One of everything**: one Agent, one submit path, one stream, one Composer, one side pane.
- **Native and quiet**: the platform's own chrome, one accent colour, English and Chinese throughout.
