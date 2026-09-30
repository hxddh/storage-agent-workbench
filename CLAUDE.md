# CLAUDE.md

> **Implementation contract for Storage Agent v10.0.0.**
>
> Before changing product structure, read `docs/README.md`, `docs/product.md`,
> `docs/architecture.md` and `docs/security.md`. Current code and the
> executable contracts (`frontend/src/contracts.test.ts`, `sidecar/tests/test_v500_*.py`,
> `sidecar/tests/test_v600_kernel.py`, `sidecar/tests/test_v700_followups.py`,
> `sidecar/tests/test_v800_*.py`, `sidecar/tests/test_v900_*.py`, `sidecar/tests/test_v1000_*.py`) are authoritative. v5 was a clean rewrite; v6–v10 build on it: do not reconstruct earlier information architecture, tables or routes
> from git history or release notes. No plan mode, todo lists, approvals, mode switches,
> sub-agents or workflow builders — new capability lands on Task, item stream and estate.

Storage Agent is a local-first desktop Agent for object storage and S3-compatible systems. It is not a generic chatbot, storage admin console, ticket system, or coding Agent.

The product invariant:

> **The estate is the object; Agent Tasks are how work is done. One item stream is the truth.**

What the Agent learns about the user's storage — accounts, buckets, their posture, and the Issues found there — outlives the Task that learned it. Everything that happens in a Task is one ordered, append-only stream of **items**; the page, the report, the audit and the trace are projections of it.

## 1. The model

- A **Task** is a tree of **Turns**. A Turn is one **Direction** and the work it caused. `turns.parent_turn_id` links a branch; `tasks.head_turn_id` is the branch being read. Editing a Direction submits a new Turn with the same parent — a **fork** — and the reader can switch between versions (`‹ 1 of 2 ›`).
- **Items** (`items`, global monotonic `seq`) are the only record of work: `user_message`, `agent_message`, `tool_call`, `tool_progress`, `tool_output`, `conclusion`, `steer`, `compaction`, `notice`, `error`. Turn lifecycle is `notice` items (`started`, `completed`, `failed`, `cancelled`, `interrupted`, `resumed`, `stopped`, `finalized`, `compacted`, `titled`, `imported`, `reprompted`). Nothing else is a source of truth for what happened.
- The model's history for a Turn is the item chain from that Turn to the root of its branch, converted to model input by `agent/session.py:to_input` in branch order (each Turn's items by `seq`; a batch of parallel calls replays as all calls then all outputs, so a strict Chat Completions endpoint accepts it; commentary is an assistant output message; a dangling call gets an "interrupted" output; a recorded conclusion replays as its call with "Conclusion recorded."; the latest `compaction` stands in for the Turns it folded; the running Turn's own steers are left to the input filter, so each reaches the model once; a steer recorded while a tool batch was still running replays after that batch's outputs; steers `carried` into the next Direction are read there only).
- The **estate** sits beside tasks and is a primary surface (v6): `estate_buckets` (+ a bounded `posture_history`, appended only when the posture changed, last 50 per bucket), `issues` + `issue_events`, `watch_schedules`, and `notes`. Issues are opened, resolved and marked `recurred` only by deterministic observations (`estate/rules.py`) — never by model prose. A read that could not see something decides nothing.
- **Fixes** are text the user applies — Storage Agent never writes to storage. Each generated fix (`rules.generate_fix`; none for a bucket name outside `[A-Za-z0-9._-]`, which no shell quoting protects everywhere) is regenerated on every read — stored text is never served — and carries **formats** (the AWS CLI command, a Terraform resource, the API document; `estate/fixpacks.py`) with the bucket name, endpoint and region shell-quoted / HCL-escaped, and an **impact preview** (`GET /issues/{id}/impact`) built only from evidence the estate holds (it reads access logs already analyzed; it never ingests) — anonymous requests counted from attached S3 server access logs (aggregates only), the recorded posture, and what the change itself does — with verdict `low | caution | unknown` and an explicit gap when the evidence cannot tell. Verify (read-only) resolves an Issue; the next observation that sees it again marks it `recurred`.
- **Notes** are what the user and the Agent want remembered about the estate, an account or a bucket: written by the user, by the Agent (`note` tool) or as the reason a risk was accepted; visible, editable and deletable; redacted with eager secret masking, ≤ 1 000 chars, ≤ 500 kept (the Agent's oldest trimmed first, audited; never the note just written — when only the user's notes remain, the Agent's note is refused), audited. The 12 most recent reach every turn as an `estate_notes` block inside the untrusted-data envelope — remembered context, never instructions (a hostile source could talk a model into keeping a note). Un-accepting a risk, or the risk resolving, drops its reason.

## 2. Runtime architecture

- Desktop shell: **Tauri v2** (menu bar, tray, Quick Ask window, deep links, notifications, global shortcuts).
- Frontend: **React 19 + Vite + TypeScript + Tailwind CSS v4**.
- Local backend: **Python + FastAPI + Uvicorn** Sidecar.
- Agent runtime: **OpenAI Agents SDK for Python** (0.22.x) — the thin layer only: `Runner.run_streamed` over an SDK `Session` (`agent/session.py:ItemsSession`, the branch read from items), `FunctionTool` with input guardrails and timeouts, `RunConfig.call_model_input_filter`, `RunErrorHandlers` (`max_turns`, `model_refusal`), `ToolOutputTrimmer` (plus in-Turn shrinking of earlier outputs on Chat Completions), model retry, tracing processors; on the Responses backend the websocket transport (`OpenAIResponsesWSModel`, falling back to HTTP once refused; side steps stay HTTP), `tool_namespace` + `defer_loading` + `ToolSearchTool` and server-side compaction.
- Model backends: **Responses API** for the official OpenAI endpoint (`api_style = responses`), **Chat Completions** for every other OpenAI-compatible endpoint (hosted or local).
- S3-compatible access: **boto3 / botocore**. Analytics: **DuckDB + PyArrow + pandas**.
- Metadata: **SQLite** (`storage-agent.db`, WAL), append-only migrations (head **2**).
- Secrets: **AES-256-GCM encrypted local vault** through `security/keyring_store`.
- Streaming: **Server-Sent Events** via `sse-starlette`, resumable by item `seq`.
- MCP: the **official MCP Python SDK** (2.x) serves an opt-in read-only bridge.
- Packaging: **PyInstaller one-dir Sidecar** embedded as a Tauri resource.

```text
Tauri shell ── React window (main) · Quick Ask window · tray
        │ localhost HTTP / SSE + per-launch token
Python Sidecar ── one Agent runtime ── model endpoint configured by the user
        │                            └─ S3-compatible storage configured by the user
        └── SQLite items stream · estate · vault
```

The frontend never receives cloud/model secret values. The Sidecar resolves secret references server-side.

## 3. One Agent, one submit path

There is one model-driven Agent: `sidecar/app/agent/runtime.py` (`RUNTIME`). It runs on its own event-loop thread; each task has one worker that drains its queued Turns in order.

- **Submit** (`POST /tasks`, `POST /tasks/{id}/turns`) creates a Turn and records the Direction as a `user_message` item at once; a Direction submitted while another runs is **queued** durably and can be withdrawn (`DELETE /tasks/{id}/turns/{turn_id}`). There is no other submit path; the watch opens its task through `RUNTIME.submit` too.
- **Steer** (`POST /tasks/{id}/steer`) records a `steer` item and is injected into the running loop by the model-input filter (re-inserted at a stable position on every model call). With nothing running, a steer is a new Direction; one that arrives after the model's last call becomes the next Direction when the Turn completes (a `carried` notice) — a steer is never acknowledged and dropped.
- **Stop** (`POST /tasks/{id}/stop`) sets the Turn's cancel event and cancels the SDK run; each tool call carries a `StopSignal` set by the Turn's Stop **or** that call's own timeout, and bodies check it between units of work (a bucket, a file, a check); the partial work is kept (`cancelled`).
- **Task state** follows the Turn the task is read at (`tasks.head_turn_id`): a failure on a branch the user has moved away from never makes the task need attention.
- **Recovery**: on start, Turns left `running` are stamped `interrupted` and continued **once** as a `resume` Turn on the same branch (never a crash loop), before any Direction queued after it; the reader's head follows the continuation only if they were on that branch; without a usable model the task offers **Resume**.
- **Finalize**: when the step budget (60) runs out (the SDK's `max_turns` error handler) or a recoverable provider error ends the loop, one tool-less call writes the answer from the work so far, reading a history fitted to the input budget; if even that fails the Turn is `failed` with a recorded error (never a canned answer); a model refusal becomes the answer as recorded (`model_refusal` handler); both are marked `finalized`.
- **Budget** (v10): `agent/budget.plan(creds)` is the one place the window, `max_tokens` and the input budget (window − `max_tokens`) are decided; every char→token estimate uses `CHARS_PER_TOKEN` = 3.2. A window ≤ 32k reserves ~2 048 completion tokens; Ollama is sent the planned window as `num_ctx`. On Chat Completions, a running Turn near 85 % of the input budget shrinks its **earlier** tool outputs (oldest first) to enveloped previews; the latest batch stays whole and items keep everything. Request 0 of a first survey fits an 8k window.
- **Small-model guards** (v10): a call identical to one this Turn already made answers “Already called…” without running; arguments that are not JSON are answered, not run; a string where a list/number/boolean belongs is coerced; a final message that is a tool call written as text gets one correction (`reprompted`).
- **Compaction**: before a Turn, when the fixed prefix (instructions + tool definitions) plus the branch history nears 80 % of the **input budget**, one tool-less summary step (reading a fitted history) folds earlier Turns into a `compaction` item — one, several or all of them, down to 60 %, so it does not fire every Turn; the current Direction always stays. The Responses backend also compacts server-side inside a long Turn. The window is the declared one, else the model table (longest match wins); a local / self-hosted endpoint without a declared window is planned as **16 384** tokens.
- **Title**: after a task's first answer, one tool-less step names it (≤ 8 words); a user rename wins forever (`title_source`).
- **Conclusion**: the model records a turn's findings and next steps with the typed tool `record_conclusion`, once, right before the final answer (≤ 8 findings with severity `high|medium|low|info`, ≤ 4 next steps; either may be omitted, not both — v9 has no `answer` field: the answer is the Turn's final message, and an older item's `answer` is read, never written). It becomes a `conclusion` item, never a tool row, shown under the answer. A turn without it has no conclusion; nothing is guessed from prose.
- **Tracing**: a local trace processor writes safe span attributes (names, durations — never payloads) to `spans`; `GET /tasks/{id}/trace` exports OTel-shaped spans.

Do not add a second planner/narrator Agent, hidden orchestration, handoffs, or a simulated multi-agent UI. If the runtime does not implement a capability, the UI must not pretend it exists.

## 4. Tools

Tools are declared once with `@tool(group=…, scope=Scope(…), bounds=…, timeout=…)` in `sidecar/app/agent/tools/` and registered in `registry.REGISTRY`. Groups: `core`, `probes`, `objects`, `config`, `account`, `files`, `advice`. Every call:

1. is scope-checked by an SDK input guardrail before it runs (provider bucket/prefix scope; a refusal is a `tool_output` the model reads);
2. has its integer arguments clamped to `bounds` and runs with a timeout in a worker thread, reading its context through `registry.current()` (connection, progress, per-turn budgets — spent under a lock, since parallel calls run in threads — cancel); a thread that outlives its Stop or timeout writes nothing after the Turn's record is closed;
3. is recorded as `tool_call` → (`tool_progress`…) → `tool_output` items and one `audit` row;
4. returns a redacted result, bounded for the model (≤ 60 000 chars, and ≤ a quarter of a small window) and the UI (≤ 24 000 chars), inside the untrusted-data envelope.

Schemas are not strict (optional arguments stay optional), carry real `enum`s for fixed choices and no pydantic titles; descriptions are one or two sentences and never repeat the instructions (`agent/prompt.py`), which keep only method and the safety rules. `provider_id` is optional: with one storage account it is that account; with several the scope check asks for it. A result that names an estate Issue carries the rule's title and severity. Tool-row notes are one short English clause (≤ 60 chars, real plurals).

Storage tools are read-only. `import_evidence` is the only data-moving tool: a survey-discovered inventory or access-log source only, ≤ 500 files / 256 MiB per call (clamped), refused without 1 GiB free disk after the download — decompressed output included, re-checked while combining — audited `approved_by=agent`, stoppable between files. `survey_account` is capped at 500 buckets and reports coverage; its output leads with issue kinds (title, severity, count), estate changes and coverage, and only its bucket rows are cut to fit. The registry is **15 tools** (v10), one per job: always loaded — `survey_account`, `query_estate` (`survey_filter`, `since_last_survey`), `fix_preview` (the generated fix in every format plus its impact preview; read-only), `note` (≤ 5 per turn; never over MCP), `record_conclusion` (never over MCP), `read_skill`, `list_buckets` (filtered by the bucket scope), `triage_error` (an error message or a presigned URL), `analyze_uploaded_file` (typed `metric` / `group_by` / `filters`; the attachment line carries its `dataset_id`); on demand — `probe_endpoint(check=reach|location|addressing|tls|latency)`, `list_objects(kind=keys|versions|uploads)`, `inspect_object(aspects=…; head, attributes, acl, tags, preview, range, conditional)`, `review_bucket_config(aspects=…, detail=…)`, `import_evidence`, `simulate_storage_cost` (bytes per storage class, never a dollar figure). Bundled skills are **5 method cards** (≤ 1 200 chars each: account posture, security/IAM, protocol compatibility, access logs, lifecycle cost); old skill names load their card. `docs/tools.md` must agree with the registry.

## 5. Sidecar API

- `/tasks` — list/create/rename/delete; `POST …/turns` (submit, `parent_turn_id` forks), `…/steer`, `…/stop`, `DELETE …/turns/{id}` (withdraw queued), `…/turns/{id}/resume`, `PUT …/head` (switch branch), `…/files` (upload an access log or inventory), `…/report?lang=en|zh`, `…/trace`.
- `GET /tasks/{id}` — the snapshot (task, branch turns, items, forks, live segment, files, artifacts, `last_seq`); `GET /tasks/{id}/events?after=<seq>` — SSE: durable `item` events (id = seq), live `delta`, `state` (with `head_turn_id`; the current state is sent whenever a stream opens), `turn` (a Turn's public row whenever it is created, starts, settles or is re-parented), `live`. The window opens the stream `after` the snapshot's `last_seq` and merges a reloaded snapshot with what it already holds — nothing is replaced, dropped or duplicated. `GET /events` — the global task feed for the sidebar. Items served to the UI never carry `model_output`.
- `/estate`, `/estate/providers/{id}/buckets` (an account's buckets with open-issue counts, + its notes), `/estate/providers/{id}/buckets/{bucket}` (the bucket page: posture, every Issue, the timeline of posture changes and Issue events, notes), `/issues` (list · one · `fix` · `impact` · `verify` · `accept {accepted, reason}` — a reason is kept as a note), `/notes` (list · create · edit · delete), `/estate/watch/{provider_id}` (`GET` / `PUT {enabled, interval_hours}` / `POST …/run`).
- `/providers/models` (+ `activate`, `test`), `/providers/clouds` (+ `test`).
- `/settings` (language, theme, vault status, standing-instructions status), `/skills`, `/health`, `/health/selfcheck`.
- `/mcp` — only with `STORAGE_AGENT_ENABLE_MCP=1`: Streamable HTTP (stateless) over the registry's stateless read-only subset + `list_providers`, audited as `actor=mcp`.

When `STORAGE_AGENT_AUTH_TOKEN` is set (the packaged app), every route except `/health` requires `X-Sidecar-Token` (or `?token=` for `EventSource`). See `docs/api.md`.

## 6. Non-negotiable security rules

1. Never place cloud access keys, secret keys, session tokens, model API keys, Authorization headers, cookies, signatures, or presigned credentials in model prompts.
2. Never persist plaintext secrets in SQLite, items, logs, reports, traces, screenshots, or frontend state.
3. Store secrets only through `security/keyring_store`; SQLite stores opaque `keyring://…` references only.
4. No generic shell, raw subprocess, raw boto3 client, unrestricted filesystem, terminal, browser/computer control, or arbitrary SQL for the Agent.
5. Storage is read-only. There is no destructive/mutating S3 tool. An Issue's fix is text the user applies; names from a listing are shell-quoted / HCL-escaped in that text.
6. Provider bucket/prefix scopes are enforced server-side (tool guardrail, Verify, MCP bridge).
7. Data movement runs inside hard server-side bounds (above); a survey never exceeds 500 buckets; the watch is opt-in per provider, off by default, read-only, bounded (≤ 500 buckets surveyed, ≤ 25 re-checked) and stops between phases when turned off.
8. Tool inputs/outputs, items, audit rows, reports and model context are sanitized and bounded; tool output reaches the model inside the untrusted-data envelope.
9. Raw access-log/inventory rows never enter model context — deterministic analysis produces bounded aggregates and findings.
10. Chain-of-thought is never persisted, exposed or modeled as an item.
11. Capability gaps on S3-compatible providers are explicit (`provider_unsupported`), never fabricated success.
12. Missing evidence stays a gap. Never manufacture evidence to complete a narrative.

See `docs/security.md`.

## 7. The window

The main window is **sidebar · title bar · one conversation · one Composer**, plus one closable, resizable **side pane** (Details for a task, or one bucket).

- **Sidebar**: New task, an in-place title search (Esc clears), one chronological list grouped by day, Settings — nothing else. State is a mark on the row (Working pulses, Queued, Needs attention; Ready paints nothing; a watch-opened task carries the shield). Rename (double-click / More) and Delete. ↑/↓ move between tasks. Below 720 px it overlays the page (closed by default and whenever a page is chosen or the window narrows; a scrim closes it), and the side pane covers the page and closes back to the conversation.
- **Title bar**: the task name and its real state pill, centred; the Details toggle; a thin progress hairline while work is live. Empty on home.
- **Home** (a new conversation): the greeting as the page's one `<h1>`, the Composer, three starters that only fill it (the survey starter only with storage), one readiness sentence with links when a model or storage account is missing, then **Needs attention** (one row per kind of open Issue, most severe first then by title, naming every bucket it was found on by name — three, then *+N*; a bucket opens its sheet; an accepted Issue's dot goes quiet) and one quiet line per account (buckets · last checked · watched; storage never checked reads *name · not checked yet · Survey*, with no bucket count and no heading, and *Survey* only fills the Composer). The home re-reads the estate when the bucket sheet changes an Issue. Nothing on the home submits work except the Composer. There is no separate estate area.
- **Bucket sheet** (`estate/BucketSheet.tsx`, the side pane): meta line, *Ask about this bucket* (fills the Composer only), its Issues (resolved ones folded), Configuration (only what deviates: exposure that is on, a read that failed, a missing protection — public access block, encryption, versioning, lifecycle, logging), Notes (Enter adds), History (posture changes and Issue events, folded). An Issue offers Show fix and Verify, and a *More* menu with Open task and Accept risk (optional reason, kept as a note); the actions stay in place and the fix opens under them. The fix shows CLI · Terraform · JSON with Copy (code scrolls, never wraps) and the impact preview as one verdict sentence with its reasons folded. A verified resolution also updates the bucket's recorded configuration.
- **Task page** — one conversation, oldest first (answers carry no outline and no heading ids): each Turn on the branch renders as the user's message (a bubble with Edit — a fork — Copy and the version switcher *1 / 2*), *Queued* with Withdraw, one **activity line** (the running tool's verb and target, *Writing* while text streams, or *Thinking*, while live — a steer shows as *You added: …*; *n steps · t* when done, expanding to commentary, steers and each call), the live text, then the answer with the recorded findings as severity dots and figures from deterministic analyses, and, when the Turn needs attention, the recorded reason with *Continue* (and *Open Settings* when it failed). A stopped Turn keeps what it had written as the answer so far. After the last completed answer, up to three recorded next steps show as suggestions that fill the Composer. The page sticks to the bottom while work is live unless the reader scrolled up.
- **Tool rows** read as what the Agent did (labels in `lib/toolLabels.ts`) (a localized verb, the target in mono — a storage account by its name — the result as a muted note; the raw tool name on `data-tool`); running survey/import rows show real counts.
- **Details** (`inspector/Inspector.tsx`): Save report (the task report in the reader's language, Markdown), usage, every tool call (one opens with its arguments — a storage account by its name — and output), attached files. ⌘I and the title-bar toggle close whatever pane is open; Esc closes the pane; drag its edge or use ←/→ on it (352–880 px). A pane opened from a button takes focus and gives it back on close.
- **Composer** is the only Agent input: Send at rest (waiting while no model is set up — the chip says where); *Add to the request* (steer) + Stop while work is live; a file makes the action Send (a queued Direction), never a steer. Attach by button or drop; the **model chip** (real provider list; *Set up a model…* with none; *Runtime offline* when the Sidecar cannot be reached; reasoning effort only for known-reasoning models).
- **⌘K** focuses the sidebar search (there is no command palette). **Settings**: General (theme, language — following the system until chosen — the safety floor as three points, and a folded *Advanced*: skills, the standing-instructions file, the MCP bridge) · Models (a local model's context window is asked for, prefilled with 16 384; a hosted one keeps it under *Advanced*) · Storage accounts (each account's Watch first: Off · 6 h · Daily · Weekly, Check now; the session token and bucket/prefix scope under *Advanced*; notes on the account and on all storage). Saving stays on the saved item and shows its connection test in the sticky save row; a save that finishes after the reader moved on leaves them there; deleting a model or account asks first. Below 720 px Settings is one column.
- **Quick Ask**: a second, small always-on-top window (⌘⇧Space, the tray, the View menu). One question becomes one ordinary task (`origin = quick_ask`) through the same submit path; the answer streams there; *Open in the main window* hands the task over via the deep-link event.
- **Native shell**: menu bar (App · Edit · Task · View · Window · Help) emitting `menu-command`, `storage-agent://task/<id>` deep links, OS notifications when a followed task settles in the background or the watch opens a task, a tray item (Open · Quick Ask · Quit, tooltip = what needs attention), global shortcuts (⌘⇧S summon, ⌘⇧Space Quick Ask). All of it reaches the window through `frontend/src/hooks/useNativeAgent.ts`; a plain browser is a no-op.

Frontend structure: `api/` (the only module that talks to the Sidecar), `store/task.ts` (one reducer: all known turns + head, items by seq, merged snapshots, SSE), `store/derive.ts` (pure projections: sections, tool rows, findings, figures, versions), `shell/`, `home/`, `estate/` (bucket sheet, issue card, notes), `task/`, `composer/`, `inspector/`, `settings/`, `quick/`.

## 8. Design system

Tokens live in `frontend/src/index.css` (see `docs/design-tokens.md`): a calibrated cool-neutral ladder, one restrained indigo accent (primary action, selection, focus, links, live progress), a separate status palette, five type sizes (11 · 13 · 15 · 20 · 28), a 4 px grid, three radii, two shadows, motion 120/200/280 ms honouring `prefers-reduced-motion`. Controls come from `components/ui.tsx`, styled in `styles/components.css`; surfaces live in `styles/app.css` and `styles/document.css`. No component carries a raw colour; status reads as a dot or badge beside neutral text. Motion uses CSS and View Transitions; there is no animation library.

## 9. Data ownership

SQLite (`storage-agent.db`) stores application metadata and the items stream; migrations are append-only (never edit a shipped entry). DuckDB/local files hold datasets (`<data>/tasks/<task>/datasets/<id>/`). User data lives under the application data directory, never the install directory. On first start the one-shot importer (`app/importer.py`) copies providers (vault references carry over), the estate and each v4 task's Directions/answers/conclusions from a sibling `app.db`, which it never modifies. See `docs/data-model.md`.

## 10. Non-goals

Multi-agent orchestration (bounded parallel tool calls, ≤ 6, are the alternative), coding projects/worktrees, synthetic plans or checklists, generic terminal/browser/computer control, workflow canvas, LangGraph/LiteLLM/Langfuse/n8n, Postgres/Redis, destructive storage repair or mutation, a page per backend table, multi-user SaaS/RBAC.

Gated, opt-in extensions that keep the same floor: user skills (`STORAGE_AGENT_DATA_DIR/skills/*/SKILL.md`, guidance only), standing instructions (`AGENTS.md` / `STORAGE_AGENT_INSTRUCTIONS`, bounded, redacted), local model providers (Ollama, LM Studio, vLLM, llama.cpp, OpenAI-compatible), the read-only MCP server, the proactive watch.

## 11. Development workflow

Work in focused PRs. For architecture or behavior changes: inspect the implementation and its tests first; update the canonical docs in the same PR; add or update executable contracts for boundaries that matter; validate the real rendered/runtime state (the E2E suite and the contact sheet run against the real Sidecar), not only component code.

## 12. Verification expectations

Run the checks relevant to the change and never claim checks you did not execute. CI gates: frontend typecheck, Vitest (unit + contracts + surfaces), production build; Sidecar `ruff` + `pytest` (including the live golden estate/watch tasks against moto S3 and the fake OpenAI-compatible model); an opt-in scenario eval against a **real** model (`sidecar/tests/live_eval/`: 15 seeded moto scenarios with known answers, N runs, deterministic scoring, hard floors on leaked secrets / followed injections / out-of-scope reads; any OpenAI-compatible endpoint via `STORAGE_AGENT_LIVE_EVAL=1` + endpoint env vars, the key needed only for hosted endpoints; the manual `Live model eval` workflow) — never in the default gates, while default CI replays small-model failure shapes and checks request 0 fits 8k/16k/32k; packaged Sidecar smoke; real-Sidecar Playwright E2E and the visual contact sheet; macOS, Linux and Windows desktop builds. Dependency versions actually verified are pinned in `sidecar/requirements.lock` (`scripts/lock-sidecar-deps.py`).

When reporting completion include: what changed; what contract it changes or preserves; what checks ran and their result; what was not run; known gaps.

## 13. Documentation discipline

`docs/README.md` defines precedence. Release notes and the CHANGELOG are history and may carry retired vocabulary; never use them as the specification.
