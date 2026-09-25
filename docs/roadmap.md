# Roadmap

> **Status: delivered in v2.1.0 — Native agent.** Nothing pauses the Task for
> approval and the model keeps no plan: the one data-moving tool runs inside
> hard server-side bounds, Stop is the brake, and work a restart interrupted
> continues on its own (`docs/releases/2.1.0.md`). Before it, v2.0.0 —
> Result-first Task: the Task opens on its latest Result — the conclusion the
> model recorded with `record_conclusion`, then the full answer and detail rows
> that expand in place — with the Work log below (`docs/releases/2.0.0.md`).
> Before that, v1.19.0 — Document-native window. v1.16.0 finished
> the true native Agent; v1.17.0 shipped
> the Codex window; v1.18.0 the native core underneath it
> (`docs/releases/1.18.0.md`). v1.19.0 reviewed the rendered window against
> "native, simple, elegant, not a chat tool" and rebuilt the turn as a
> document section (`docs/releases/1.19.0.md`).

> **Baseline: Storage Agent v2.1.0.** The product invariant is unchanged:
> **the Agent Task is the application.** The window is sidebar · title bar ·
> one Task document · one Composer.

## Native agent (shipped in v2.1.0)

| Surface | v2.1 |
| --- | --- |
| Approval | none: no approval card, no approval policy, no Safety section, no *needs decision* state; Decisions are read-only history |
| Evidence import | runs in the turn: discovered source only, ≤ 500 files / 256 MiB per call (clamped), refused without 1 GiB free disk, audited `approved_by=agent`, Stop ends it |
| Survey | runs to its 500-bucket hard cap without asking; `truncated` reports coverage |
| Plan | none: no `update_plan`, no plan card |
| Restart | interrupted work continues once on its own (`kind=resume`); manual Resume only when no model is usable |
| Details | Evidence · Report · Execution (Plans and Baselines rows removed; engines remain) |
| Reading | tool rows as localized verbs; one Result meta line; lead-paragraph answer; next steps as a list of asks; live groups open until the turn settles; title and state centred; `reveal-in` honours reduced motion |

## Result-first Task (shipped in v2.0.0)

| Surface | v2.0 |
| --- | --- |
| Opening a Task | lands at the top, on the latest Result; nothing follows the end; no *Jump to latest* |
| Result | the recorded conclusion (answer · findings by severity · next steps) · grounding · full answer · figures · detail rows |
| Conclusion | runtime-recorded (`record_conclusion` → `conclusion.recorded`, migration 031); never guessed from prose |
| Details | Evidence · Report · Execution · Plans · Baselines expand in place (Plans/Baselines removed in v2.1); no side panel, no empty placeholders |
| Work log | every turn below the Result; older answers fold to one line |
| Tables | preview 8 rows, expand, sort by column; folded rows stay findable |

Follow-ups: persist a Direction when its execution starts (so a reload
mid-finish shows it at once); a figure hover layer; move the runtime tests
off the blocking `SESSION_LOOP` seam.

## Document-native window (shipped in v1.19.0)

| Surface | v1.19 |
| --- | --- |
| Turn | a document section: the Direction is its heading; hairline between turns |
| Type | platform UI face first (SF / Segoe UI), Inter fallback |
| Status | one dot (title bar, banners, model chip, Execution detail, figures); text stays ink |
| Palette | opaque sheet, transform-only entry, key caps |
| Sidebar | titles only; day groups carry time |
| Figures | ink-first, legends above the plot, no coloured numbers |

## Native core (shipped in v1.18.0)

| Boundary | v1.18 |
| --- | --- |
| Submit | one path: `POST /agent-tasks/{id}/executions`; no `/runs` POST/message/events/upload, no run event bus |
| Data movement | only the `import_evidence` tool (behind a Decision until v2.1; bounded server-side since); no `/evidence-imports` plan/confirm/run |
| Reads | never submit work; revisits run on the Sidecar's own clock |
| Steer | a `steer` turn item (*Steered* line), never a tool row |
| Frontend | `AgentTask` is the one composition root; `liveTasks` / `useTaskDocument` / `taskId`; Task-named `api/` adapters |

Follow-up: move the runtime tests off the blocking `SESSION_LOOP` /
`answer()` seam onto the streamed path production uses.

## Codex window (shipped)

v1.11 claimed "Codex parity all the way down" for the **transcript shape**.
v1.17 finished the **window**: UI and UE replicate Codex's Agent client, not
Codex's coding product.

Shipped:

| Surface | v1.17 |
| --- | --- |
| Window | sidebar · quiet title · one transcript · one Composer |
| Title bar | task name + live state; Find/palette are keyboard (⌘F / ⌘K) |
| Sidebar | New, day-grouped titles, Settings; Ready paints nothing |
| Empty start | one greeting + Composer, no glyph |
| User turn | right-aligned fill, no card chrome |
| Agent turn | flush Markdown, not a bubble |
| Worked group | one line *Worked for {t}*; count lives inside |
| Plan | quiet checklist; folds to *Plan · n/n* (removed in v2.1) |
| Approval | sentence-case hairline card; Allow / Deny (removed in v2.1 — no approval) |
| Composer | `+` · textarea · model · send; ContextMeter in the model menu |
| Find | ⌘F bar only |
| Copy | Direction / Execution / Work Result |

Do **not** replicate Codex the coding Agent: worktrees, diffs, terminal,
browser/computer-use, file trees, PR review, multi-agent orchestration, or a
chat-application creation title. Runtime capability stays first; chrome never
invents a worker, plan, or submit path the Sidecar does not expose.

## Next

No next version is planned in this file. Follow-up is ordinary defects against
the native, result-first contract and the v2.1.0 security floor (read-only storage, bounded data movement). Non-goals remain:
coding-Agent features, a second submit path, slash SKUs, suggestion cards, a
painted engine grid, the historical Review sheet, artifact chips, a grey
Direction block, Next Actions, a metrics footer, table pagination, a second
Agent, a Settings price-table UI, a Verify control, a side panel, or a
conclusion guessed from prose, an approval pause, or a plan card. Migration head **031**.
