# Roadmap

> **Status: delivered in v3.1.0 — Outputs made real.** The Task report is
> rebuilt conclusion-first in the reader's language; the Result and the
> Evidence tab read one findings list with an Evidence link per finding; ⌘I
> toggles the side pane; the model chip says *Runtime offline* when the
> runtime cannot be reached; and the design system is finished — no raw colour
> or type utility in a component (`docs/releases/3.1.0.md`). Before it, v3.0.0
> — Design system v3 / Refined native. A full
> UI redesign on an unchanged runtime: a five-step type scale, a calibrated
> neutral ladder, one restrained indigo accent, one component library, the
> Task's durable outputs in a resizable, closable side pane, an empty start
> with Composer-filling starters, redesigned figures, a Recent · Actions palette
> and compact Settings panes (`docs/releases/3.0.0.md`). Before it, v2.2.0 —
> Native agent depth: every tool is
> callable from the first step, the Direction is durable from the moment its
> execution starts, a continuation picks up where it stopped, and the long
> bounded operations show real progress on their tool rows
> (`docs/releases/2.2.0.md`). Before it, v2.1.0 — Native agent: nothing pauses
> the Task for approval and the model keeps no plan: the one data-moving tool
> runs inside hard server-side bounds, Stop is the brake, and work a restart
> interrupted continues on its own (`docs/releases/2.1.0.md`). Before that, v2.0.0 —
> Result-first Task: the Task opens on its latest Result — the conclusion the
> model recorded with `record_conclusion`, then the full answer and detail rows
> that expand in place — with the Work log below (`docs/releases/2.0.0.md`).
> Before that, v1.19.0 — Document-native window. v1.16.0 finished
> the true native Agent; v1.17.0 shipped
> the Codex window; v1.18.0 the native core underneath it
> (`docs/releases/1.18.0.md`). v1.19.0 reviewed the rendered window against
> "native, simple, elegant, not a chat tool" and rebuilt the turn as a
> document section (`docs/releases/1.19.0.md`).

> **Baseline: Storage Agent v3.1.0.** The product invariant is unchanged:
> **the Agent Task is the application.** The window is sidebar · title bar ·
> one Task document · one Composer, plus one closable side pane for outputs.

## Outputs made real (shipped in v3.1.0)

| Surface | v3.1 |
| --- | --- |
| Task report | conclusion first: title + meta · Goal · Conclusion · one Findings list · Next steps · per-Direction record · Coverage and gaps · the record (tools, analyses, attached evidence, triage, rule-derived suggestions, usage, audit) · Safety; empty sections not written; `?lang=en\|zh` localizes only the module's own words |
| Findings | one list for the Result and the Evidence tab (`lib/findings.ts`): the conclusion's findings + those recorded while working, deduplicated, most severe first; an Evidence link per finding or *No direct evidence*; the provenance-mark list under figures removed |
| Side pane | ⌘I toggles it; a selection with nothing behind it settles on the output shown, so the Report loads; Evidence reads Findings → Current understanding → Attached evidence |
| Chrome | the model chip reads *Runtime offline* when the runtime cannot be reached |
| Design system | no raw colour or type utility in a component; `frontend/src/styles/`; five sizes, five names; `.ui-scrim` the one scrim; status as dot/badge beside neutral text |
| Figures | light `--viz-2…5` stepped darker in the same hues (every series ≥ 3:1); ranked bars top-aligned |

No migration (head stays **031**); runtime, security floor and the single submit path unchanged.

## Design system v3 (shipped in v3.0.0)

| Surface | v3.0 |
| --- | --- |
| Tokens | five type sizes (11 · 13 · 15 · 20 · 28); cool-neutral ladder, every text step AA on `--hover`; one indigo accent (`--accent`, `--accent-text`, `--accent-dim`, `--accent-fg`) for primary action, selection, focus, links and live progress; status apart; 4px grid; radii 6 / 10 / 14; `--shadow-elev` / `--shadow-pop`; motion 120 / 200 / 280ms, reduced-motion honoured |
| Components | `components/ui.tsx` (Button primary / secondary / ghost / selected / danger, IconButton, Kbd, Badge, StatusDot, SectionLabel, Segmented, Field / TextInput / Select), styled only in `native-components.css` |
| Window | sidebar · title bar · one Task document · one Composer + one side pane for outputs |
| Sidebar | raised New task with key caps; in-place title search (Esc clears); selected row in the accent tint |
| Title bar | sidebar toggle · centred name + state pill · side-pane toggle; progress hairline while working |
| Outputs | an outputs bar under the Result opens a resizable (352–880px), closable (close, Esc, ⌘I) side pane with tabs; overlays below ~1100px; replaces rows that expand in place |
| Empty start | greeting `<h1>` · sub line · Composer · three starters that only fill the Composer |
| Result | accent *Result* badge + meta; 20px answer; findings with severity badges; next steps as suggestion cards that fill the Composer |
| Figures | full-width cards, Chart/Table toggle, y-axis ticks, dashed gridlines, per-column tooltip, legends for ≥ 2 series, `--viz-1…6` |
| Palette | Recent (≤ 8 tasks) · Actions, fuzzy ranking with matched letters, key-hint footer; engine catalog removed |
| Settings | compact preference panes; the safety floor as three points |

No Sidecar, API, security or migration change (head stays **031**).

## Native agent depth (shipped in v2.2.0)

| Surface | v2.2 |
| --- | --- |
| Tools | every tool callable from the first step; the `load_tools` group gate only for context windows ≤ 16k tokens, decided by the runtime |
| Direction | persisted when its execution starts (`direction.recorded`); a reload mid-run reads it from the document |
| Continuation | resume/retry store the Direction as written; the model's copy carries a bounded, redacted digest of calls already completed |
| Progress | survey and evidence import emit durable, throttled `tool.progress` counts; the running row reads *120 of 500 buckets* over a hairline meter |
| Stop | ends an evidence import between files; nothing from it is kept |
| Result | the latest Result stays while a newer Direction works; a one-Direction Task has no Work log (its work sits under the Result) |
| Reveal | `revealInScroller()` replaces `scrollIntoView`; opening a detail row never moves the window or the Composer |
| Execution detail | no empty findings section, no default kind label |
| Resume banner | a quiet note; Resume is a default button beside Open Settings |
| Report | Task vocabulary: *Task report* · *Goal* · *Analyses* · Directions |
| Tests | runtime contracts on the streamed path (`test_v220_streamed_agent.py`) |

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

Follow-up: a figure hover layer. (Persisting a Direction when its execution
starts shipped in v2.2.)

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

Follow-up delivered in v2.2: the v2.x runtime contracts moved off the
blocking `SESSION_LOOP` / `answer()` seam onto the streamed path production
uses; persistence/unit tests keep the seam.

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
the native, result-first contract, design system v3, and the unchanged
security floor (read-only storage, bounded data movement). Non-goals remain:
coding-Agent features, a second submit path, slash SKUs, starters or next-step
cards that submit on their own, a painted engine grid or palette engine
catalog, the historical Review sheet, artifact chips, a grey Direction block,
Next Actions, a metrics footer, table pagination, a second Agent, a Settings
price-table UI, a Verify control, a second side pane or an overlay dialog for
artifacts, a conclusion guessed from prose, an approval pause, or a plan card.
The figure hover layer shipped in v3.0 (a tooltip per column); the light-theme
series contrast gap closed in v3.1. Migration head
**031**.
