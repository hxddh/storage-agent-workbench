# Product

Storage Agent is a local-first desktop Agent that looks after object storage — AWS S3 and every S3-compatible service (R2, MinIO, OSS, COS, BOS, TOS, B2, GCS interop, custom endpoints). The user delegates work in plain language; the Agent investigates with read-only, bounded tools, answers with evidence, and remembers what it learned about the storage *estate* between tasks.

It is not a chatbot, a storage console, a ticket system or a coding agent. It never writes to storage: fixes are text the user applies with their own credentials.

## What people use it for

- **Diagnose**: an access error, a slow bucket, a presigned URL that fails, a TLS or addressing problem.
- **Review**: one bucket's configuration, or a survey of every bucket in an account — exposure, encryption, public access block, lifecycle, versioning, logging.
- **Analyze**: an access log or inventory the user attaches, or evidence the Agent imports from a source the survey discovered (bounded).
- **Estimate**: storage-class mix (bytes per class) over time under candidate lifecycle rules. It never quotes a price.
- **Look after**: the estate keeps known accounts, buckets, how their posture changed, Issues and notes; each Issue has a fix to apply (CLI, Terraform or the document) with a preview of what it would change, a read-only Verify that closes it, and it reopens when the problem comes back. A watch can sweep an account on a schedule and open a task only when something new turns up.

## The window

**Sidebar · title bar · one conversation · one Composer**, plus one closable side pane.

- The **sidebar** is New task, an in-place search, the task list grouped by day, and Settings — nothing else. In a narrow window it overlays the page. A row shows state as a mark: working (pulsing), queued, needs attention; a task the watch opened carries a shield.
- **⌘K** focuses the sidebar search.
- The **title bar** names the task and shows its real state; a hairline runs under it while work is live; its right-hand button opens **Details**.
- The **Composer** is the only way to give the Agent work: *Send* at rest; while it works, *Add to the request* (a steer) and *Stop*. Files attach by button or drop (access logs, inventories); a file always makes a new request. The model chip shows which model the next turn uses.

### Home — a new conversation, and what needs attention

The greeting, the Composer, three starters (*Diagnose an access error*, *Survey my storage account*, *Analyze an access log*) that only fill the Composer, then:

- **Getting started** — one sentence when a model or a storage account is missing, each part a link to the right Settings pane.
- **Needs attention** — one row per kind of open Issue, most severe first, naming every bucket it was found on (three, then *+N*); a bucket opens in the side pane. Below, one quiet line per account: its buckets, when it was last checked, whether it is watched — storage never checked reads *name · not checked yet · Survey* (Survey fills the Composer), with no bucket count.

### A bucket

The **bucket sheet** (the side pane) is where the storage itself is the subject: what needs attention (the resolved Issues folded below), its configuration as last checked (only what deviates: exposure that is on, a read that failed, a missing protection), the notes kept about it, and its history (posture changes and Issue events, folded). *Ask about this bucket* fills the Composer; it never submits.

An Issue shows **Show fix** and **Verify** (a read-only re-check that can resolve it); its *More* menu holds *Open task* and *Accept risk* (with an optional reason, kept as a note). The **fix** is the AWS CLI command, a Terraform resource or the API document — copy whichever you apply changes with — with an **impact preview**: one verdict sentence on what applying it would change, from the evidence the estate holds, with its reasons folded under it. For a public access block it counts the anonymous requests in the bucket's attached S3 server access logs; for lifecycle rules it says whether existing rules would be replaced. When the evidence cannot tell, it says so and what would answer it.

**Notes** are what you and the Agent want remembered — an owner, an intent, why a setting is deliberate. You add them on a bucket (Enter saves), on an account or for all storage in Settings; the Agent keeps them with its `note` tool; accepting a risk with a reason keeps the reason. Every task starts with the most recent notes as context.

### A task — one conversation, oldest first

Every request reads top to bottom in the order it was made: the user's words as a message, one **activity line** (*Running: Reviewed bucket configuration acme-www* while live; *3 steps · 12s* when done, expanding to the commentary and each call), the answer as it streams, then the answer itself with the recorded findings as severity dots and figures from the deterministic analyses. A queued request shows *Queued* with *Withdraw*; a request that needs attention offers *Continue* or *Open Settings*. After the latest answer, up to three of its recorded next steps appear as suggestions that fill the Composer. A turn without a recorded conclusion shows its answer; nothing is guessed.

A message can be **edited**: that sends a new version of it — a fork of the task at that point — and *1 / 2* switches between versions. Reloading, reconnecting or following up never reorders, drops or duplicates anything: the page is the item stream, merged by sequence.

### Details

The one side pane for a task: *Save report* (the task report in the reader's language, as Markdown), token usage, every tool call (one opens with its arguments and output), and the attached files.

### Quick Ask

A small always-on-top window (⌘⇧Space, the tray, View › Quick Ask) for one question. It becomes an ordinary task through the same submit path; the answer streams there, and *Open in the main window* continues it in full.

### Settings

General (theme, language, the safety floor in three points; *Advanced*: skills, the standing-instructions file, the MCP server) · Models (presets for OpenAI, Anthropic, DeepSeek, OpenRouter, Ollama, LM Studio, vLLM, llama.cpp, any OpenAI-compatible endpoint; masked keys; a local model's context window prefilled with 16 384, a hosted one's under *Advanced*; a live test) · Storage accounts (presets for the common services; each account's **Watch** first: Off · 6 h · Daily · Weekly, Check now; the session token and bucket/prefix scope under *Advanced*). Save stays on what was saved and shows its test result.

## Principles

- **The estate outlives the task.** Every task starts knowing the accounts, the known buckets, the open Issues and the notes.
- **Nothing is invented.** Findings, Issues, progress and figures come from tool results and deterministic engines; a gap stays a gap.
- **Read-only, bounded, stoppable.** No approval prompts, no plan mode, no modes: the one data-moving tool runs inside hard server-side bounds, and Stop ends any work — a stopped or timed-out tool ends at its next check.
- **One of everything**: one Agent, one submit path, one stream, one Composer, one side pane, one conversation.
- **Native and quiet**: the platform's own chrome, one accent colour, English and Chinese throughout.
