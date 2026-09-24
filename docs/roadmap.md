# Roadmap

> **Status: delivered in v1.19.0 — Document-native window.** v1.16.0 finished
> the true native Agent; v1.17.0 shipped
> the Codex window; v1.18.0 the native core underneath it
> (`docs/releases/1.18.0.md`). v1.19.0 reviewed the rendered window against
> "native, simple, elegant, not a chat tool" and rebuilt the turn as a
> document section (`docs/releases/1.19.0.md`).

> **Baseline: Storage Agent v1.19.0.** The product invariant is unchanged:
> **the Agent Task is the application.** The window is sidebar · title bar ·
> one Task document · one Composer.

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
| Data movement | only the gated `import_evidence` tool behind a Decision; no `/evidence-imports` plan/confirm/run |
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
| Plan | quiet checklist; folds to *Plan · n/n* |
| Approval | sentence-case *Waiting for approval*; hairline; Allow / Deny |
| Composer | `+` · textarea · model · send; ContextMeter in the model menu |
| Find | ⌘F bar only |
| Copy | Direction / Execution / Work Result |

Do **not** replicate Codex the coding Agent: worktrees, diffs, terminal,
browser/computer-use, file trees, PR review, multi-agent orchestration, or a
chat-application creation title. Runtime capability stays first; chrome never
invents a worker, plan, or submit path the Sidecar does not expose.

## Next

No next version is planned in this file. Follow-up is ordinary defects against
the Codex window contract and the v1.18.0 security floor. Non-goals remain:
coding-Agent features, a second submit path, slash SKUs, suggestion cards, a
painted engine grid, the historical Review sheet, artifact chips, a grey
Direction block, Next Actions, a metrics footer, table pagination, a second
Agent, a Settings price-table UI, or a Verify control. No migration (head
stays **030**).
