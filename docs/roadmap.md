# Roadmap

> **Baseline: Storage Agent v1.10.0.** This file is the plan for
> **v1.11.0 — Codex parity all the way down**: the turn model, approvals, the
> Task document, the Composer, the sidebar, the artifacts panel and the runtime
> core are rebuilt to Codex's shape. It is not a backlog of old UI concepts and
> it is not proof that an aspirational capability already exists. Every finding
> below was checked against the code and the visual-review captures on `main`
> at v1.10.0; every item carries a verdict: **keep**, **rebuild**, **new**, or
> **non-goal**.

## 1. Verdict on v1.10.0 — why it still does not read as an agent

v1.09 rebuilt the window and v1.10 made the shell native, but the **turn**
— what the user actually reads — is still the v0.2x chat contract wearing new
CSS. The audit found seven structural defects, not cosmetic ones.

| # | Finding (verified on `main`) | Consequence the user sees | Verdict |
| --- | --- | --- | --- |
| 1 | The runtime streams **one text buffer** per turn. Everything the model says between tool calls ("I'll check the bucket policy next…") is concatenated into the same buffer as the final answer (`session_agent.stream_events_for`, `raw_acc`). There is no notion of an assistant *message* between two actions. | The Work Result is one long blob: commentary, half-sentences written before a probe, and the conclusion all run together. Live, the document shows a spinner row (*The Agent is working on this task*) until the whole buffer starts, then dumps text. | **rebuild** |
| 2 | The model must end every answer with a **```json contract block** (`skills_used`, `evidence_used`, `evidence_gaps`, `next_action_proposals`) which a sanitizer holds back from the stream. | Truncated fences leak on stop; the model spends output on bookkeeping; a mis-parsed block silently blanks the persisted answer (`finalize_answer_text`). Nothing Codex-like exists here: Codex records actions, it does not ask the model to summarise them. | **remove** |
| 3 | **Decision required is raised from *suggestions*.** Any `next_action_proposal` whose type is in `DECISION_GATED_ACTION_TYPES` becomes a blocking pending Decision with Approve / Decline (`store.open_decisions_from_proposals`), the task flips to *Needs decision* and the sidebar paints a yellow mark — even though the Agent only *mentioned* that importing logs would help. | The "莫名其妙的 Decision required": a card demanding a decision about work nobody asked for, after the answer is already complete. Codex asks for permission only when the agent is *about to run* a gated action, inline, and continues the same run after Allow. | **rebuild** |
| 4 | Approval is **two-step**: Approve opens `EvidenceImportDialog` (plan → confirm → execute) as a second modal. | Two confirmations for one action; the run that raised it is long finished. | **rebuild** |
| 5 | The document is Direction-as-grey-block, then a page. User text is a full-width panel bubble with copy chrome; the answer is markdown with a *Report* chip row, a 64rem data track, tables that **fade out** with a *Show chart* toggle, and an Execution footer. | Nothing reads as a transcript of work. Wide tables are cut with a gradient; the reader cannot tell what was an action, what was a thought, and what is the conclusion. | **rebuild** |
| 6 | Review is a **sheet with three surfaces** (Evidence · Execution · Report) opened from chips. Execution detail is reachable only through a referenced run. | Artifacts are hidden behind chips; the equivalent of Codex's always-available Changes panel does not exist. | **rebuild** |
| 7 | `session_agent.py` is still a **2,677-line monolith** (prompt, loop, stream sanitizer, contract parser, steer queue, usage, guards, finalize). Deferred in v1.10. | Every one of the changes above touches it; it cannot be reviewed as a whole. | **rebuild (split, mandatory)** |

Smaller findings folded into the workstreams: the sidebar has no day grouping;
the empty start greeting is static; there is no elapsed timer while working;
Chinese copy still carries English tokens (`Decision required`, `Steer`);
the Report chip and Evidence chip count durable rows nobody asked to count;
`ExecutionMetrics` (tokens, duration) is a footer nobody reads; the window
does not remember its size; the updater is inert.

**Keep:** tokens, window composition, the OS shell bridge (v1.10), runtime
task titles, reasoning effort, provider panes, durable execution runtime
(`task_executions` / `execution_events` / Steer / Stop / Resume / queue),
read-only tool floor, vault, redaction, CI gates.

## 2. Codex detail checklist

Every row is a visible detail. "Codex" is the shape of the Codex desktop app;
"target" is what v1.11.0 ships. Rows marked non-goal stay out because they
would weaken the read-only floor or need a capability the runtime does not have.

| Element | Codex | v1.10.0 now | v1.11.0 target |
| --- | --- | --- | --- |
| Sidebar list | Threads grouped by recency (Today · Yesterday · Previous 7 days · Older), quiet rows, ⋯ on hover | One flat list, relative time on hover | Day groups; ⋯ on hover; state mark; runtime titles |
| New thread | Top of sidebar + ⌘N | Same | keep |
| Search | ⌘K palette | Same | keep |
| Archive | Archive from ⋯ | Delete only | non-goal (Delete stays) |
| Empty start | Greeting + composer centred | Same | Greeting rotates (3 lines); composer identical to in-task composer |
| Composer frame | Rounded panel, textarea, bottom row: `+`, model · effort, mode, send | Same minus mode | keep; add a fixed **Read-only** label where Codex shows the mode (never a switch) |
| Send / newline / stop | Enter · Shift+Enter · Esc | Enter · Shift+Enter · ⌘. | Esc stops when the Composer is empty; ⌘. stays |
| User turn | Compact bubble, right-aligned, ~70% max width, no chrome | Full-width grey block with copy button | Right-aligned bubble; copy on hover only |
| Agent turn | Plain markdown in the reading column, no bubble, no card | Same but polluted (finding 1) | Segments: commentary · worked group · approval · answer |
| Commentary between actions | Short assistant text before each action group | Merged into the answer | Own segment, muted ink, streamed as it arrives |
| Working indicator | Shimmer + elapsed timer ("Working · 12s") | Static sentence | Shimmer + live elapsed timer; first token replaces it |
| Worked for group | "Worked for 1m 12s" chevron row; collapsed after completion; rows are actions with a one-line result | Same but always expanded; no live elapsed | Collapsed when done, expanded live; live elapsed; row = glyph · tool · target · result |
| Action row detail | Click a row → the call's input/output inline | Same (`CallDetail`) | keep |
| Thinking summaries | Rendered | Never (security §6.10) | non-goal |
| Approval prompt | Inline card in the turn: "Codex wants to run …" · Allow / Deny (+ Allow for session); the run waits, then continues | Post-hoc Decision card from a suggestion; second dialog | Inline **Approval** raised by a gated tool call; Allow / Allow for this task / Deny; run continues in place; plan preview inside the card |
| Plan mode | Toggle; plan card with steps | None | non-goal (runtime emits no plan) |
| Changes panel | Right split panel: file list + diff, stays open | Sheet with three surfaces | **Artifacts** panel: right split, stays open, lists Evidence · Reports · Plans · Baselines with a viewer; ⌘I toggles |
| Review button | Per turn | Chips per Work Result | One **Open artifacts** affordance per turn only when the turn wrote one |
| Diff viewer | Yes | — | Report/plan viewer (markdown); Drift = before/after table |
| Thread title | Generated after first turn | Same (v1.10) | keep |
| Model picker | model · effort popover | Same (v1.10) | keep |
| Context meter | Small % under the composer | Footer metrics per result | One quiet meter under the Composer (tokens used of window); result footer removed |
| Notifications | On settle when unfocused | Same (v1.10) | keep; clicking opens the task (deep link from the notification) |
| Menu bar, deep links, summon | Yes | Same (v1.10) | keep; window size/position remembered |
| Automations | Scheduled runs UI | Engine only | non-goal (UI) |
| Skills / MCP | Settings actions | Same (v1.10) | keep |
| Chinese | — | Partial (`Decision required`, `Steer` in zh chrome) | Full parity, one copy table per surface |

## 3. v1.11.0 workstreams (all mandatory)

Each lands as one PR from `main` with code, tests, and docs together
(CLAUDE.md §11). Order is dependency order: the runtime turn model first,
everything visible after it. **Migration 029** (turn items) is expected; head
moves from 028 to 029.

### R1 — Runtime turn model and the `session_agent.py` split

- Split `session_agent.py` into `agent_runtime/{prompt,loop,stream,steer,usage,guards,finalize}.py`. `session_agent` keeps only the public seams the tests patch (`SESSION_LOOP`, `_streamed_session_loop`, `answer`, `build_stream`, `stream_events_for`) as re-exports. Tests unchanged.
- Replace the single text buffer with **turn items**: `message` (assistant text segment, closed when the model emits a tool call or finishes), `tool` (started/completed), `approval` (opened/resolved), `answer` (the final segment). Each item is appended to `execution_events` (`message.delta`, `message.completed`, `approval.opened`, …) and persisted as rows in `turn_items` (migration 029) so a reload reproduces the segments exactly.
- Delete the ```json contract block. `skills_used`, `evidence_used` and `evidence_gaps` are derived from the tool log (`read_skill`, evidence tools, `note_open_question`); `next_action_proposals` is removed. The contract parser, the hold-back sanitizer and `finalize_answer_text` go with it; the stream sanitizer keeps only CoT stripping and redaction.
- The prompt loses every line about proposals and the JSON block; it gains one line: write short commentary before an action when it helps the reader, and a complete answer at the end.

### R2 — Approvals replace Decisions

- A gated tool (`plan_evidence_import`, `generate_session_report`, a full-scan listing over the bound) does not return a proposal; it **raises an approval**: the execution goes `waiting`, `approval.opened {tool, args, impact}` is logged, and the model loop is parked on the tool call.
- The Task shows the approval **inline in the turn** where it happened: "Storage Agent wants to download access logs from `acme-logs/logs/2026/` (312 files · 1.8 GiB)" with **Allow**, **Allow for this task**, **Deny**. Allow resumes the same execution with the tool's real result (the import runs under the existing bounded planner); Deny returns a structured refusal to the model, which finishes its answer. The second dialog is deleted (`EvidenceImportDialog` becomes the plan preview inside the card).
- `task_decisions` stays as the durable record (column `kind = 'approval'`); `DECISION_GATED_ACTION_TYPES`, `sessions/next_actions.py`, `nextActionFromDecision` and the *Needs decision* sidebar state are removed. A waiting approval is *Working · waiting for you* in the title bar, not a task state of its own.
- Revisits and Verify still never auto-approve: a gated call inside them opens the same inline approval and the execution waits.

### R3 — The Task document as a turn transcript

- One `Turn` renderer replaces `AgentTaskResult`, `AgentResultRenderer`, `AgentDecisionCard`, `AgentRuntimeArtifacts` and the live branch of `AgentTaskImplementation`: user bubble → segments (commentary · worked group · approval · answer) → artifact rows. Live and durable turns are the same component fed by the same items.
- User turn: right-aligned bubble, ≤ 70% width, copy on hover. Agent turn: reading column, 15px/1.6, markdown with headings, code blocks with copy, full-width tables that **scroll** (no fade, no chart toggle). Deterministic figures (cost, drift) render only as artifacts a tool wrote.
- Worked group: collapsed after completion, expanded live, live elapsed time, rows `✓ head_bucket acme-logs → 200 · 40ms`; a failed row never folds. Artifact rows inside the group: `Wrote report …`, `Imported 312 files …`.
- Working: shimmer + elapsed timer; the first commentary token replaces it. Queued Directions show as pending bubbles with a *Queued* tag and a cancel. Stop leaves a *Stopped* tag on the last segment.
- Remove `resultShape`, the 64rem data track, `ExecutionMetrics` footer, the Report / Evidence / Execution chip row, `native-decision*` CSS.

### R4 — Artifacts panel replaces the Review sheet

- A right split panel (resizable, remembered), toggled by ⌘I or the turn's *Open artifacts* affordance, that **stays open** while the user keeps working: Evidence (imports, uploads), Reports, Remediation Plans, Baselines / Drift, Execution log. Selecting an item opens a viewer in the panel (markdown for reports and plans, a table for drift, `CallDetail` for a tool call).
- `AgentReviewPanel`, `EvidenceReview`, `ExecutionReview`, `ReportArtifact`, `ExecutionDetailImplementation`, the `agent-review-overlay` CSS and the `review.open/close` commands are replaced by `ArtifactsPanel` + `artifacts.open(kind, id)`.

### R5 — Composer, sidebar and chrome details

- Sidebar day groups (Today · Yesterday · Previous 7 days · Older), ⋯ on hover, no yellow *Needs decision* mark (an approval is a Working task).
- Composer: fixed **Read-only** label beside the model chip (never a switch), Esc stops when empty, context meter under the Composer replaces the result footer.
- Empty start greeting rotates; still no cards, no wizard.
- Window size/position remembered; About dialog from the menu; notification click deep-links to the task; updater wired the day a signing key exists (documented, still inert).
- Chinese: one copy table per surface, no English tokens in zh chrome, E2E `zh.spec` extended to the turn transcript and the approval card.

### R6 — Contracts, docs, release

- `architecture.test.ts` rewritten for the v1.11 file set (turn renderer, artifacts panel, no proposals, no review sheet, no contract parser, runtime modules); `legacy-ui-contracts.test.ts` rejects `Decision required`, `next_action`, `agent-review-overlay`, `resultShape`; `orphan-modules.test.ts` stays.
- E2E: every spec that drives the document (17 today) moves to the turn transcript; new `approval.spec.ts` (gated tool → inline approval → Allow continues → Deny finishes), `transcript.spec.ts` (commentary segments, worked group folding, elapsed timer), `artifacts.spec.ts`; gallery captures for each state.
- Sidecar: `test_v111_turn_model.py` (segments, migration 029, approval raise/resume/deny through the real streamed runtime), `test_no_contract_block.py`.
- Docs: `docs/product.md` Product objects rewritten (Decision → Approval; Turn; Artifacts panel), CLAUDE.md §1/§3/§4/§8, architecture §3–§5, data-model (029), api (approvals endpoints replace decisions resolve), security (approval floor), release notes.

## 4. Non-goals (unchanged)

Multi-agent orchestration, coding projects/worktrees, terminal/browser/computer
control, workflow canvas, plan mode or checklists the runtime did not emit,
destructive storage mutation, a scheduler UI, approval-mode switches that
weaken the read-only floor, chain-of-thought rendering, a page per backend
table, multi-user semantics, archive.

## 5. Release plan

- v1.11.0 ships R1–R6 as one release; R1 and R2 first (they change what every
  later PR renders), then R3–R5 in one or two PRs, then R6 with the release.
- Acceptance for the release: a real Task with two turns, one gated import and
  one report reads top to bottom as a transcript (bubble · commentary · worked
  group · approval · answer · artifact rows), with no chip row, no Decision
  card, no fade, in both languages and both themes; visual-review captures for
  every state; all gates green on the three desktop builds.

## 6. Roadmap principles

1. **Capability before chrome.** Add UI only for runtime state/capability that actually exists. A listener for an event nothing sends is chrome.
2. **Agent Task remains the organizing object.** New evidence, tools, reports, and execution detail attach to the Task.
3. **Read-only autonomy, explicit mutation/data-movement boundaries.** More autonomy must not weaken the safety floor. Remediation Plans stay operator-applied.
4. **Evidence over confidence.** Improve what the Agent can prove, correlate, and explain; do not hide gaps. Estimates always carry coverage.
5. **Storage depth over generic-Agent breadth.** Prefer real S3/object-storage capabilities over generic terminal/browser/workflow features.
6. **Provider realism matters.** S3-compatible behavior and capability gaps must be tested explicitly rather than assumed from AWS semantics.
