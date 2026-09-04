# Roadmap

> **Status: plan for v1.17.0.** v1.16.0 finished the true native Agent;
> v1.16.1 patched tables, search, wrapping, and a first Codex-grade polish
> pass (`docs/releases/1.16.1.md`). This file replaces that delivered work as
> the current plan. The v1.16.0 plan this file replaces is recorded in
> `docs/releases/1.16.0.md`.

> **Baseline: Storage Agent v1.16.1** (merge `c424e02`). This file is the plan
> for **v1.17.0 — Codex window**: the Task window's UI and UE match Codex's
> quiet Agent surface — same chrome, same transcript rhythm, same Composer
> craft — while remaining a storage Agent. The product invariant is unchanged:
> **the Agent Task is the application.** Every finding below was checked
> against the code on `main` at v1.16.1.

## Codex craft contract

v1.11 claimed "Codex parity all the way down" for the **transcript shape**.
v1.17 finishes the **window**: UI and UE replicate Codex's Agent client, not
Codex's coding product.

Replicate (the Codex Agent window):

| Surface | Codex | v1.17 target |
| --- | --- | --- |
| Window | sidebar · quiet title · one transcript · one Composer | unchanged topology |
| Title bar | task name + live state; Find/palette are keyboard | name + state only (⌘F / ⌘K stay) |
| Sidebar | New, day-grouped titles, Settings; ~36 px rows | keep day groups; Ready paints nothing |
| Empty start | one greeting + Composer, no glyph | drop the geometric mark |
| User turn | right-aligned fill, no card chrome | no border, no elevation shadow |
| Agent turn | flush Markdown, not a bubble | keep |
| Worked group | one line *Worked for 12s*; count lives inside | drop `· n tool calls` from the head |
| Plan | quiet checklist; folds to *Plan · n/n* | keep (already Codex) |
| Approval | sentence-case inline gate, hairline, no marketing eyebrow | drop uppercase + shield + card shadow |
| Composer | `+` · textarea · model · send; no second instrument | ContextMeter leaves the bar |
| Find | ⌘F bar only | un-paint title-bar icon and document ghost |
| Copy | Direction / Execution / Work Result | no *Runs*, no *Ask again*, no *Your message* |

Do **not** replicate Codex the coding Agent: worktrees, diffs, terminal,
browser/computer-use, file trees, PR review, multi-agent orchestration, or a
chat-application creation title. Runtime capability stays first; chrome never
invents a worker, plan, or submit path the Sidecar does not expose.

## 1. Verdict on v1.16.1 — what still is not native, and what is not Codex

The **runtime transcript is already Codex-shaped**: user bubble, commentary,
one *Worked for …* group, `update_plan` card, compacted marker, inline
Allow/Deny, Markdown on the 46 rem measure, one durable submit path. v1.16.1
made tables whole and search honest.

What remains is three layers of unfinished native-agent work:

1. **Canonical docs still teach retired IA.** Agents following `product.md`
   will rebuild a Review sheet, Approve/Decline, a tinted Direction block, and
   artifact chips — all removed since v1.11.
2. **Product vocabulary still says chat/run.** Empty-answer fallback, prompt
   framing, Artifacts "Runs", aria labels.
3. **The window still paints more than Codex.** ContextMeter on the Composer,
   Find in two extra places, a start glyph, card-elevation on bubble and
   approval, tool-call counts on the Worked head.

| # | Finding (verified in code) | Where | Verdict |
| --- | --- | --- | --- |
| F1 | **`product.md` Design rules describe the pre-v1.11 Task.** Tinted Direction, 64 rem data track, artifact chips, Approve/Decline; Review is a **sheet**. First-viewport still says "open an artifact chip". Provenance "opens Review". | `docs/product.md` L90, L100–104, L206, L220 | **rebuild** — docs tell transcript + Artifacts + Allow/Deny truth |
| F2 | **Architecture banner is v1.10.0 / migration 028.** Body already mentions v1.12–v1.16 and 030. Forbids day buckets the sidebar paints. Still lists Next Actions on `AgentTaskImplementation`. | `docs/architecture.md` L3, L98, L129; `AgentTaskNavigation.tsx` `dayGroups()` | **rebuild** — banner v1.16.1 / 030; day groups are Codex; drop Next Actions |
| F3 | **Token/security/data-model/README banners lag.** Tokens still say Approve; README Review = "light overlay"; data-model index says migrations through 027. | `docs/design-tokens.md`, `docs/security.md`, `docs/data-model.md`, `docs/README.md` | **rebuild** — banners match stamps; Review row is Artifacts |
| F4 | **Documentation contract does not catch F1–F3.** It requires `v1.16.0` somewhere and forbids chat-application creation titles, but Approve/Decline, Review-as-sheet, tinted Direction, and `v1.10.0` / `028` all pass. | `frontend/src/agent/documentation-contract.test.ts` | **new** — fail those phrases in product-contract docs |
| F5 | **Artifacts section title is "Runs".** ZH is already 执行记录. Empty: "No runs yet". Resume EN: "starts a new run". | `agentCopy.ts` L20, L27; `taskCopy.ts` L63 | **rebuild** — Execution vocabulary |
| F6 | **Empty Work Result is chatbot copy.** Persisted into the Task document. | `sidecar/app/agent_runtime/finalize.py` `_EMPTY_ANSWER_FALLBACK` ("Ask again, or rephrase") | **rebuild** — work language; no "Ask again" |
| F7 | **Prompt still frames a chat.** `INSTRUCTIONS` = "user's question"; volatile half labeled `User question:`; context key `conversation_summary`. `FINALIZE_INSTRUCTIONS` (tools=`[]`) still teaches `update_plan` and "before each tool call" commentary. | `sidecar/app/agent_runtime/prompt.py` L56–65, L163–172, L666 | **rebuild** — Direction / Task / recent turns; strip tool/plan coaching from finalize |
| F8 | **Composer comment vs chrome.** Comment: "Attach, textarea, model, and those actions — nothing else is painted." JSX mounts `ContextMeter` on the bar. | `Composer.tsx` L103–106, L401–402 | **rebuild** — meter lives on the model menu (or Execution detail only) |
| F9 | **Find is painted three times.** Title-bar search + palette icons; document ghost "Find in this task"; ⌘F bar. Codex is keyboard + bar. | `App.tsx` L79–84; `TaskDocument.tsx` L271–284 | **rebuild** — un-paint title-bar icons and the document ghost; ⌘F / ⌘K remain |
| F10 | **Empty start paints a 30×30 glyph** above the greeting. Contract is greeting + Composer. | `AgentTaskImplementation.tsx` L244–250; `.native-start-mark` | **rebuild** — remove the mark |
| F11 | **User bubble is a raised card.** Border + `--shadow-elev` + 12/16 padding. Codex is a quiet fill. | `native-document.css` `.turn-user-bubble` | **rebuild** — fill only, tighter pad, no shadow |
| F12 | **Approval card is marketing chrome.** `text-transform: uppercase`, `letter-spacing: 0.04em`, shield, `--shadow-elev`, `radius-2xl`. | `native-document.css` `.approval-card*`; `ApprovalCard.tsx` L55–57 | **rebuild** — sentence-case *Waiting for approval*, hairline, no shield |
| F13 | **Worked head denser than Codex.** `"Worked for {t} · {n} tool calls"`. | `i18n.tsx` `turn.workedFor` / `turn.worked` | **rebuild** — *Worked for {t}*; count stays inside the group |
| F14 | **Chat aria on the turn.** `turn.userLabel` = "Your message"; `turn.answerLabel` = "Agent answer"; `turn.longRunning` = "Still running — …". | `i18n.tsx` L284–285, L307 | **rebuild** — Direction / Work Result; long-run line in work language |
| F15 | **ZH Artifacts empty copy says 输入框.** EN correctly says Composer. | `agentCopy.ts` L105–109 | **rebuild** — 委派 / Composer, not 输入框 |
| F16 | **Steer + attach is a second submit in UE.** A file cannot ride a steer, so the UI still paints Steer then queues a new Direction after settle. Attachment state is not cleared on task switch, so a file can ride onto a busy Task. | `TaskComposerHost.tsx` L73–76, L99–104; `useTaskComposer` session effect | **rebuild** — attach is task-scoped; with a file the action is Delegate, never a lying Steer |
| F17 | **Find highlight is yellow.** Status colour is for state, not search. Settings tags are `border-radius: 999px` pills. | `index.css` `::highlight(saw-find)`; `.native-settings-tag` | **rebuild** — selection-token highlight; hairline tags |
| F18 | **CLAUDE.md vs product.md on the title bar.** CLAUDE: name + state only. product.md L224: painted Find + Palette. Code follows product.md. v1.16 bullet still claims table pagination (removed in 1.16.1) and Review in the product-to-persistence table. | `CLAUDE.md` L27 vs L127 vs `product.md` L224 | **rebuild** — one contract: Codex-quiet title bar; tables whole; Artifacts not Review |

Already Codex-correct (do not re-litigate): one durable execution submit
path; no activity/status/inspector chrome; assistant is not a bubble; plan
card only from `plan.updated`; Allow · Allow for this task · Deny; no
metadata JSON / proposal list / import dialog; no Verify control; Composer
Delegate / Steer+Stop; stalled stream is a quiet reconnecting line; 40 px
title bar; 36 px sidebar rows; ink primary; day groups.

## 2. Workstreams (all mandatory for v1.17.0)

### W1 — Canonical docs tell the truth (F1–F4, F18)

Rewrite, in one PR with the code:

- `docs/product.md` Design rules / Review / first-viewport: Artifacts panel
  (right split, overlay only under 960 px), Direction is copy-only, Work
  Result has no chips and no 64 rem track, buttons are Allow/Deny, title bar
  is name + state, empty start is greeting + Composer, Find is ⌘F.
- `docs/architecture.md` banner **v1.16.1 / v1.17.0**, migration **030**;
  day groups are painted; drop Next Actions / Review-sheet ownership.
- `docs/design-tokens.md`, `docs/security.md`, `docs/data-model.md`,
  `docs/README.md` banners and the Review vocabulary row.
- `CLAUDE.md` to v1.17.0: Composer has no ContextMeter; tables are whole (no
  pagination); title bar is name + state; Artifacts not Review in the
  persistence table.
- `documentation-contract.test.ts`: product-contract docs must not contain
  Approve/Decline as current buttons, Review-as-sheet, tinted Direction,
  artifact chips, architecture banner `v1.10.0` / migration `028`.

### W2 — Work language end to end (F5–F7, F14, F15)

- Artifacts section `Runs` → `Execution`; empty "No executions yet — …";
  Resume "starts a new Execution from the same Direction."
- `_EMPTY_ANSWER_FALLBACK`: the trace above is the work; invite another
  Direction — never "Ask again".
- Prompt: Direction, Task, recent turns — not "User question" /
  `conversation_summary` as a product word (keep the JSON key only if tests
  pin it; the visible label and INSTRUCTIONS change). Finalize prompt drops
  `update_plan` and per-tool commentary coaching.
- Aria: `turn.userLabel` / `turn.answerLabel` → Direction / Work Result.
  Long-run line: the Execution is still working; Steer and Stop remain.
- ZH Artifacts empty states: Composer / 委派, not 输入框.

### W3 — Chrome quietness (F8–F10)

- ContextMeter leaves `.native-composer-bar`. Honest remaining homes: the
  model menu, and Execution detail (already renders usage). Fresh tasks still
  paint nothing.
- Title bar: task name + real state. Collapsed-sidebar New/toggle stay.
  `titlebar-find` / `titlebar-palette` go; ⌘F / ⌘K / palette engine asks stay.
- Document ghost Find control goes; the Find bar still opens from ⌘F and the
  palette.
- Empty start: greeting + Composer. `.native-start-mark` is deleted.

### W4 — Transcript craft (F11–F13, F17)

Codex rhythm, token-native:

- **User bubble:** `background: var(--elevated)`; no border; no
  `box-shadow`; padding `8px 14px`; keep right alignment and 70% / 46 rem cap.
- **Approval:** hairline `--edge`, `radius-xl`, no shadow, no uppercase, no
  shield. Eyebrow copy matches the title bar: *Waiting for approval*.
- **Worked head:** `Worked for {t}` / `Working · {t}` / `Worked`. Expanded
  rows still show each tool.
- **Find highlight:** `--selection` (or a 2.5 L* ink step), never yellow.
- **Settings tags:** `radius-md`, not pills.
- Composer card stays elevated (`--shadow-elev` / focus `--shadow-pop`) —
  that already matches Codex; do not flatten it.

### W5 — Composer honesty (F16)

- Attachment is per-task: switching Tasks clears or restores that Task's
  file, never a leftover from the previous one.
- While busy, attach stays disabled (already). If a file is somehow present,
  the primary action is Delegate (queued Direction after settle), labeled
  that way — never Steer.
- Dead copy: drop unused Composer `readOnly`; drop unused
  `.native-composer-hint`.

### W6 — Contracts, gallery, release

- Frontend `architecture.test.ts` v1.17 block + `components/v117.test.tsx`
  pinning: no ContextMeter in Composer, no `titlebar-find` / `task-find-open`,
  no `start-mark`, Worked head without tool-call count, bubble without
  `box-shadow`, approval without `uppercase`.
- Legacy UI contract: "Your message", "Ask again", Artifacts "Runs",
  `titlebar-find`.
- Sidecar: empty-fallback + prompt label tests in the native-turns suite.
- Visual-review gallery recapture of empty start, transcript (bubble +
  Worked + approval + plan), Composer, title bar, Artifacts Execution list.
- `releases/1.17.0.md`, CHANGELOG, version stamps. No migration (head stays
  **030**).

## 3. Non-goals for v1.17.0

- Codex coding-Agent features (worktrees, diffs, terminal, browser, PRs).
- A second submit path, slash SKUs, suggestion cards, a painted engine grid.
- Reintroducing the Review sheet, artifact chips, grey Direction, Approve /
  Decline, Next Actions, a metrics footer, or table pagination.
- Reasoning / chain-of-thought in the transcript (rule 10 / §22 stands).
- Renaming the git repository or the `com.storageagent.workbench` bundle id
  (compatibility; Help may keep the real GitHub URL).
- Signed/notarised builds (operations; the updater path stays wirable).
- A second Agent, a Settings price-table UI, or a Verify control.
