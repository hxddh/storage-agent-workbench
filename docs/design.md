# Design

One run, one composer, one accent. The window should read like a page you
inspect, not a console you operate. Hierarchy comes from space, weight and
hairlines, not cards.

## Mark

`src/renderer/Logo.tsx` is a single flat tile and one open frame: a rounded
square with its upper-right corner left open. There is no accent, dot or second
element. The frame is drawn as a stroke path, scaled to hold its identity at
16px. `build/icon.svg` is the same geometry at app-icon scale; `build/icon.png`
is rendered from it at 1024×1024. In dark mode the tile inverts to paper and the
frame to ink.

## Tokens

Defined in `src/renderer/styles.css`. Components use variables; the CSS file is
the only place raw colours are declared.

| Token | Light | Dark |
|---|---|---|
| `--bg` | `#f7f5ef` | `#12110f` |
| `--bg-sunken` | `#efede6` | `#0c0c0b` |
| `--surface` | `#fcfbf8` | `#1b1a17` |
| `--surface-2` | `#f2efe8` | `#25231f` |
| `--ink` | `#1b1916` | `#f1eee6` |
| `--ink-2` | `#59554c` | `#b8b2a6` |
| `--ink-3` | `#6e685e` | `#9a9488` |
| `--line` | `#e3dfd4` | `#2d2a25` |
| `--line-strong` | `#d4cec1` | `#3e3932` |
| `--accent` | `#3d63dd` | `#8ea8ff` |
| `--accent-ink` | `#2e4eb3` | `#c0ceff` |
| `--accent-soft` | `#e9edfb` | `#1e2742` |
| `--danger` | `#b13b37` | `#e27a70` |
| `--warn` | `#875c12` | `#d8a861` |
| `--ok` | `#2f7458` | `#6ab894` |

`--ink-3` measures 5.06:1 on light `--bg`, 5.33:1 on `--surface`, and 6.26:1 on
dark `--bg`. Secondary text therefore clears WCAG AA at the sizes it is used.
`npm run contrast` guards these secondary-text token pairs; the E2E axe gate
fails serious or critical violations. This is a floor, not full certification.

## Type

Geist Variable and Geist Mono Variable ship with the app under
`@fontsource-variable`, with system and CJK fallbacks. No font is fetched at
runtime.

- Home heading: 30–36px, weight 570, tight tracking.
- Verdict: 17.5px / 1.64. Body and prose: 14.5px / 1.55.
- Finding titles: 14px; finding meta: 12px.
- Controls and task rows: 12.5–13px.
- Section labels: 10.75px, weight 600, uppercase with 0.085em tracking.
- Run scope: 12.5px; receipt lines: 11.75px; task-group labels: 10px.
- Prose is capped at 64 characters; long generated text is not set as one wide
  line.

## Shape

Spacing follows a 4/8/12/16/24 base. Radii are 6–8px for controls and rows and
14px for the composer. There are two shadow tokens; the composer, menus,
popovers and the active sidebar row are the only elevated surfaces.

The document is flat: hairline separators and space, no cards. Tables and code
blocks are data surfaces, not cards. Settings uses a navigation rail and form
fields, not a sequence of panels.

## Layout

- Sidebar 252px, `--bg-sunken`: mark and wordmark, New task, search, pinned /
  today / earlier task rows, Settings at the foot. There are no boxes around
  New task or search; the active task is one quiet surface.
- Run column 720px with 24px gutters, centred. The question is the run's largest
  line. The task title appears once, in the sidebar; below 860px it appears only
  in the compact top bar, not twice on the page.
- Composer docked at the bottom on Home and task screens, 720px wide, with the
  run status strip immediately above it.
- Settings is a full-screen surface: a 200px navigation rail and a 620px form
  column inside a 1000px frame. Its close control is an X at the top-left, not a
  Done button at the top-right: the sheet reads as a page that recedes, and the
  exit stays clear of the form's primary actions. The rail becomes a horizontal
  tab row below 860px. On the rail, version and update state sit at the foot; in
  the compact layout they sit below the tab row.
- Below 860px the sidebar is a dismissable overlay with a visible X, a scrim
  and Escape, and Home gains the same Tasks button as a task screen.

## Home

A quiet estate ledger: a 30–36px heading, one row per account with remembered
bucket count, the last complete reading and high/total risk, a line for new
risks since the latest complete reading, and **Check account**. The compact
layout stacks the row's metadata; the bucket count carries its unit. With no
account, the explicit choices are **Try with demo storage**
and **Add an account**; **Set up a model** is a secondary text action and the
composer explains that a model is only needed to ask a question. A configured
account with no model still offers Check account and model setup. Local models
appear as quiet one-click chips, not a dashboard. On desktop the sidebar owns
the task list, so Home does not repeat recent runs; below 860px, where the
sidebar is an overlay, Home shows at most five one-line recent runs.

No cards, charts, suggestion pills, follow-up prompts or large illustration.
The composer is inert until a model exists; the account can still be checked.

## The run

Top to bottom: a 12.5px scope line (`Demo · All 2 buckets checked · 2m ago`),
the question at 24px, Copy answer and the overflow menu, a collapsed **Earlier
in this task** history, notices, an optional clarification, the answer, the
**Trace**, one compact evidence strip, and a footer naming the model, calls and
tokens. The page follows the agent's phase: planning and investigating put the
trace first; answering puts the answer first; clarifying puts the question
first; stopped and failed put the notice and its Retry/Continue first. The
answer never moves once it settles. A citation opens an in-place evidence peek,
not a permanent proof table. The run header is sticky. Save, Check again,
Re-check, Copy link, Export evidence and Save PDF live in the overflow.

**Trace** is one ordered record, not a chat transcript or a card stack. A
provider reasoning summary is a `Thought` row; when the provider omits it, the
row says so and no replacement narrative is invented. Each tool row keeps one
identity from running to done, with a state mark, `verb target`, shaped argument
summary, note, duration and one chevron. The current row is open while live;
completed rows collapse. A failed, stopped or timed-out row stays in place with
its status and note. A validation row says the harness rejected a claim and the
model was asked to rewrite it. A steer, resume or re-check is a row in the same
trace. A tool result opens in a bounded scroll area using the same typed views
as the answer's evidence peek. Plan revisions are a block at the top of the
trace; there is no separate plan section. At settle, the answer leads and the
trace is a single `Worked for … · n calls` line; opening it restores the same
order.

The scope line is the one place that makes coverage visible before the user
reads the answer. It says `Not fully checked: n` (plus `m blocked` when some
reads were denied) for a failed, stopped, blind, pending or truncated read. When
every bucket was surveyed but access questions remain, it says
`All n buckets checked · x open questions · y blocked` instead of pairing
`Not fully checked` with a complete bucket count. Those details stay in the
**Not checked** strip. It says `From memory · …`, `Live read · …`,
`Based on a reading · …` or `Not read yet` when there is no account-wide check
to report. It never says `Reads complete` or counts severity. A narrowed re-read
never turns an account-wide gap into `All n buckets checked`. There is no
next-step row and no chat transcript. When a task has more than the initial 200
entries, **Load earlier entries** fetches the next slice on demand.

Estate history stays inside the `estate` tool's typed result: the remembered
bucket table, then the history table. It is not a second panel or a timeline.

The evidence strip is two compact buttons, only when they have content:
**Findings** and **Not checked**. Findings are a safety summary, not a second
answer: severity, bucket, title and an on-hover **Accept risk**, grouped by
bucket with a hairline. A memory finding carries `remembered`. Accepted and
proved-fixed findings are one-line folds; the fixed label uses `--ok`. The strip
keeps a blind spot visible even when the answer does not mention it, but the
agent's citations decide what the answer itself uses.

A name the checks never showed gets a dashed `--warn` underline and one quiet
line under the answer. Names in the answer are prose, not boxed code chips. A
citation the task cannot resolve is left as plain text with one quiet warning;
no empty evidence frame is rendered.

A change plan is one hairline list, not a stack of cards. Its summary names the
baseline, steps, buckets, manual merges and residual risks; the baseline is one
quiet line; a step row carries a severity dot, bucket, title and ready/manual
status. Only the selected step opens the exact tabs, code and impact. A manual
step shows its blocker above the code. Re-verification uses the same hairline
rows with a short status before the step: confirmed uses `--ok`, not applied
uses `--danger`, still unknown uses `--warn`. The `Markdown` chunk is lazy;
while it loads, backticks are stripped rather than flashing raw syntax.

A scripted run (an account check or a re-check) uses the same page. It has no
question; a quiet tag says `Deterministic account check` or `Re-check`, and its
calls are ordinary trace rows. A re-check is its own run in the task: the earlier
answer moves under **Earlier in this task**, and the re-check opens with its
trace expanded, because the comparison row is its result. A tool row whose
reading changed Issues says so in its note (`rules: 1 opened · 0 resolved`); the
model never does this.

A paragraph that names a bucket the run read without citing the result that
shows it gets one quiet line under the answer, like an unresolved citation.

A code-mode result shows its rows, chart, script and output under the query's
trace row. Byte columns render as human sizes; CSV keeps raw numbers.

The trace is the audit receipt: every settled call, its status, target, note and
duration, with all typed views expandable. Blocked calls are not listed.
Printing expands the trace and the evidence strip.

### Running

While a run is live, the trace is open and the status strip above the composer
shows a pulsing accent dot, the current phase and target and elapsed time. The
current call is open in place; every earlier call stays above it. When the
answer starts streaming it becomes primary; at settle the trace folds to
`Worked for … · n calls`. A stopped run keeps the trace and its plan; Continue
resumes in the same task. A citation's in-place peek is the only evidence
surface that opens inside the answer.

### Keyboard and pointer

- `j` / `k` or arrow keys move between risks.
- `Enter` opens the evidence for a focused risk.
- `a` accepts or reopens the focused risk.
- `⌘K` focuses sidebar search.
- `⌘N` starts a new task.
- `⌘,` opens Settings.
- `⌘.` stops the active run.
- `⌘⇧R` re-checks the open task.

Dropping a file anywhere shows a dashed accent border and one centred line on
the composer; nothing else moves. `@` opens one quiet picker above the composer;
selected names become chips and are focus, not authorization.

## Settings

Four panes: Model, Storage accounts, Memory and Appearance. The active pane is
the top-bar title and the selected rail row. Model configuration is one form:
provider, model, base URL, key, Save and Test. Local models are one-click
chips. Accounts list read-only credentials and open one inline form for add or
edit; the key fields are never pre-filled. Each account has an opt-in
off/daily/weekly read-only check schedule.

Memory controls freshness and lists the 100 most recent forgettable notes; the
store itself is capped at 500.
Appearance holds language, theme and the background-notification switch.

Inputs and selects are styled consistently with visible focus rings; selects use
a drawn chevron. Checkboxes keep the native input for keyboard and screen
readers, with a 16px drawn box. No raw browser widget survives.

## Motion

120ms for hover and focus; 180ms for unfolding checks and data; 200ms for the
sidebar overlay on narrow windows. Colour, opacity and transform transitions are
small and local. `prefers-reduced-motion` disables them. There is no
reveal-on-scroll, page transition or animation library.

## Icons and states

Lucide icons at 14–16px with 1.6–1.8 stroke. Task rows use a small state dot
only when work needs attention: working, attention or failed. A ready task has
no dot. Hovering a task reveals one task-actions button and hides its relative
time, so the two never collide. The composer shows focused and
dragging states. Icons next to text are `aria-hidden`.

## Accessibility

The answer and notices sit in a polite live region; the running phase is a
`status`; an error notice is an `alert`. Every action is a real button reachable
by keyboard; hover-revealed finding and task actions also appear on
`:focus-visible`. The page has one visually hidden `h1`. Focus is trapped in the
Settings sheet and returns to the trigger on close.

The E2E runs axe and fails on serious or critical violations. This is a floor,
not a certification.

## Writing

English and Chinese are written separately, not translated word for word. The
summary is direct: no heading, no table and no restated table; the block
carries the detail. The interface never says "Let me know if…", "Here is what I found:" or
"Next steps". A change plan is text; there is no Apply button.
