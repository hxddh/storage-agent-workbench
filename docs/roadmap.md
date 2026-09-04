# Roadmap

> **Status: delivered in v1.17.1.** v1.16.0 finished the true native Agent;
> v1.17.0 shipped the Codex window (`docs/releases/1.17.0.md`). v1.17.1
> patches queue honesty, Settings container layout, and title-bar Find
> (`docs/releases/1.17.1.md`).

> **Baseline: Storage Agent v1.17.1.** The product invariant is unchanged:
> **the Agent Task is the application.** The window is sidebar · title bar ·
> one Task document · one Composer. UI and UE match Codex's quiet Agent
> surface — same chrome, same transcript rhythm, same Composer craft —
> while remaining a storage Agent.

## Codex window (shipped)

v1.11 claimed "Codex parity all the way down" for the **transcript shape**.
v1.17 finished the **window**: UI and UE replicate Codex's Agent client, not
Codex's coding product.

Shipped:

| Surface | v1.17 |
| --- | --- |
| Window | sidebar · quiet title · one transcript · one Composer |
| Title bar | task name + live state; quiet Find / palette icons (⌘F / ⌘K stay) |
| Sidebar | New, day-grouped titles, Settings; Ready paints nothing |
| Empty start | one greeting + Composer, no glyph |
| User turn | right-aligned fill, no card chrome |
| Agent turn | flush Markdown, not a bubble |
| Worked group | one line *Worked for {t}*; count lives inside |
| Plan | quiet checklist; folds to *Plan · n/n* |
| Approval | sentence-case *Waiting for approval*; hairline; Allow / Deny |
| Composer | `+` · textarea · model · send; ContextMeter in the model menu |
| Find | title-bar icon + strip under the title bar on the reading column (⌘F); no document ghost |
| Copy | Direction / Execution / Work Result |

Do **not** replicate Codex the coding Agent: worktrees, diffs, terminal,
browser/computer-use, file trees, PR review, multi-agent orchestration, or a
chat-application creation title. Runtime capability stays first; chrome never
invents a worker, plan, or submit path the Sidecar does not expose.

## Next

No next version is planned in this file. Follow-up is ordinary defects against
the Codex window contract and the v1.17.1 security floor. Non-goals remain:
coding-Agent features, a second submit path, slash SKUs, suggestion cards, a
painted engine grid, the historical Review sheet, artifact chips, a grey
Direction block, Next Actions, a metrics footer, table pagination, a second
Agent, a Settings price-table UI, or a Verify control. No migration (head
stays **030**).
