# Design

One conversation, one composer, one accent. The window should read like a
thread you can inspect, not a console you operate. Hierarchy comes from space,
weight and hairlines, not cards.

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
- Agent text: 15px / 1.62. User messages: 14.5px / 1.55.
- Step lines: 12.75px; step targets 12px mono; status words and durations
  11.75px.
- Controls and task rows: 12.5–13px; notices 13px.
- Section labels: 10.75px, weight 600, uppercase with 0.085em tracking.
- Status strip: 11.75px; task-group labels: 10px.
- Prose outside the conversation is capped at 64 characters; in the
  conversation the agent's text uses the column width.

## Shape

Spacing follows a 4/8/12/16/24 base. Radii are 6–8px for controls and rows,
14px for the composer and 16px for a user message. There are two shadow tokens; the composer, menus,
popovers and the active sidebar row are the only elevated surfaces.

The document is flat: hairline separators and space, no cards. Tables and code
blocks are data surfaces, not cards. Settings uses a navigation rail and form
fields, not a sequence of panels.

## Layout

- Sidebar 252px, `--bg-sunken`: mark and wordmark, New task, search, pinned /
  today / earlier task rows, Settings at the foot. There are no boxes around
  New task or search; the active task is one quiet surface.
- Conversation column up to 760px with 24px gutters, centred, items 14px apart.
  The task title appears once, in the sidebar (and as the page's visually
  hidden `h1`); below 860px the sidebar is an overlay reached from the compact
  top bar.
- Composer docked at the bottom on Home and task screens, 720px wide, with the
  status strip immediately above it while the agent works.
- Settings is a full-screen surface: a 200px navigation rail and a 620px form
  column inside a 1000px frame. Its close control is an X at the top-left, not a
  Done button at the top-right: the sheet reads as a page that recedes, and the
  exit stays clear of the form's primary actions. The rail becomes a horizontal
  tab row below 860px. On the rail, version and update state sit at the foot; in
  the compact layout they sit below the tab row.
- Below 860px the sidebar is a dismissable overlay with a visible X, a scrim
  and Escape, and Home gains the same Tasks button as a task screen. The
  conversation's gutters shrink to 16px and a user message may take 92% of the
  width.

## Home

A 30–36px heading (`What should I check?`), then the accounts the agent can
read: one hairline row each, its name and where it answers (the endpoint's
host, or `AWS`), nothing more. Home shows
no risk counts, coverage or "clear": what an account holds is for the agent to
read and say in a conversation. With no account, one lede line takes the
list's place (`No account yet. Add one, then ask.`, or, before a model exists,
`The agent needs a model to read your storage. Set one up and add an
account.`). **Add an account** is the primary button when there is no account
and a quiet text action once there is one. Before a model exists **Set up a
model** sits beside it as a secondary text action; with an account but no
model, the hint `Set up a model to ask a question.` follows. Local models
appear as quiet one-click chips (`Use <model>`) under `Running on this
machine`, not a dashboard. On desktop the sidebar owns the task list, so Home
does not repeat recent tasks; below 860px, where the sidebar is an overlay,
Home shows at most five one-line recent tasks.

No cards, charts, canned prompts, suggestion pills or large illustration.
Nothing on Home sends a message. The composer is inert until a model exists.

## The conversation

A task is one thread, top to bottom in the order things happened. The app
adds nothing of its own between the messages: no scope line, no evidence
strips, no summary of the work.

- **Overflow menu** — one `More actions` button, sticky at the top right of the
  column on its own row so it never covers the first message. It holds
  **Save as…** (Markdown), **Copy link**, **Export sources** (JSON) and **Save
  PDF**.
- **Load earlier entries** — a quiet centred line at the top when the task has
  more than the initial 200 entries.
- **User message** — right-aligned, at most 82% of the column, `--surface-2`
  with a hairline and a 16px radius. Attached files and `@` focus are small
  chips under the text. A steer has a dashed border, so it reads as said while
  the agent worked.
- **Steps** — the agent's thoughts and tool calls between two messages form one
  list with a hairline on its left. Each step is one line: a state mark (a
  spinning loader while running, a `--ok` check when done, a small circle when
  stopped, a `--danger` triangle for failed or refused), the tool's label
  (`Read`, `Ran a read-only query`, `Probed endpoint`, `Read more of a result`,
  `Discovered capabilities`, `Composed a view`, `Used memory`, `Used an agent
  method`, `Delegated to a child agent`), the target in mono
  (`s3 GetBucketPolicy · logs`), the
  note, a status word when it did not finish (`Running`, `Failed`, `Stopped`,
  `Refused`), the duration
  and a chevron. A running step is open and counts its elapsed time; a settled
  step folds to its line and opens on click. Open, it shows the argument summary
  and the typed result in a scroll area at most 420px high, then a folded
  `What the agent received` with the exact text the model got; a running step
  without a result says `Waiting for the first result.` When the agent got
  only the first piece of a long result, the note says so.
- **Thought** — a provider reasoning summary is a `Thought` step, `Thinking`
  while it streams. It opens to the summary as returned, in full; when the
  provider returned none it says `This model did not return a reasoning summary.` No
  replacement narrative is invented.
- **Agent text** — plain Markdown at 15px, no bubble. A citation
  `[1](#ev-<id>)` is a small superscript button on `--accent-soft`; clicking it
  opens that call's step and scrolls it to the centre. While text streams it
  grows in place; once settled, **Copy answer** appears on hover or focus.
  Names stay prose, not boxed chips. Links to the web open in the system
  browser.
- **Clarifying question** — an `ask` call is an agent message, not a step: the
  question, its note, and while it waits one button per option. A click sends
  that option as the next message.
- **Notices** — one line with a dot (`--danger` for an error): `Stopped. What
  was read is kept.` with **Continue**; `The agent hit an error.` or `The agent
  stopped without replying.` with **Retry**, followed by the provider's error
  text when there is one; `The reply reached the model’s output limit and is
  cut off here.`
- **Dividers** — `Continued this task` where a stopped turn was resumed, and
  `Earlier steps were compacted` where pi compacted the context; quiet centred
  lines.
- **Task model** — at the end of the thread, a small `Model` select, shown when
  this machine runs a local model or the task already has its own: `Settings
  default` or one of those models. It applies to this task's next turn.

The view follows the thread as it grows unless the user scrolled up to read.
When the task is empty and nothing is running it says `The agent has not
composed an answer yet.`

A `call` or `probe` step opens as one JSON block: the service's response, or
what the endpoint answered. A failed call shows the service's error code, HTTP
status and message as its note. Nothing is summarised, coloured as risky or
marked clean.

A change the agent writes is part of its text: a fenced code block in its
Markdown, with no tabs, Apply button or applied state. The `Markdown` chunk is
lazy; while it loads, link targets, bold marks and backticks are stripped
rather than flashing raw syntax.

A call to a tool name the registry does not hold shows under that name as a
failed step; a call pi ended before the tool ran shows `Did not run`. Opened,
either shows what the agent received.

A code-mode result shows its chart, rows (eight at first, then `N more`; the
window keeps up to 10,000, the agent gets all), script and output under the
query's step. Byte columns render as human sizes; CSV keeps raw numbers.

A `render` result is a view document, not JSON: the app draws its Markdown,
tables, charts, trees, timelines, diffs, callouts, key-value rows and code.
Every block is data and follows the same typography and tokens as the rest of
the page. A `render` link shows its host after its text, and its whole URL on
hover. A `memory` result is a table of documents, each with the task that
wrote it. A `delegate` result is the child's conversation in place: its
request, its steps (each opens like any other step) and its text. While the
child works the step is open and its steps appear as they happen; past fifty,
earlier steps open with **Load earlier**.

The step's argument summary is shown for a storage read where its input helps
(`call`, `query`, `probe`, `more`). For `render`, `memory`, `tool`, `delegate`,
`discover` and `ask`, the step line and its typed view already say what
happened; raw JSON arguments are not repeated.

Printing (Save PDF) opens every step and hides the sidebar, composer, overflow
menu and copy buttons.

### Running

While the agent works, the status strip above the composer shows a pulsing
accent dot, the phase (`Thinking`, `Writing`, `Reading <target>`, or
`Working through the request` between calls), the running call's note and the
elapsed time; when the last call failed it says `<tool>: Failed`. Before the
first step arrives, a `Thinking` line sits under the message. The running call
is open in place; every earlier step stays above it. The send button becomes a
steer button, and **Stop** sits beside it. A stopped turn keeps its steps;
**Continue** resumes in the same task.

### Keyboard and pointer

- `Enter` sends; `Shift+Enter` adds a line. While the agent works, `Enter`
  steers the current turn.
- `@` opens the focus picker; `↑` / `↓` move in it, `Enter` picks, `Escape`
  closes it.
- `⌘K` focuses sidebar search; `↑` / `↓` and `Enter` choose a hit, `Escape`
  clears the query.
- `⌘N` starts a new task.
- `⌘,` opens Settings.
- `⌘.` stops the running turn.
- `Escape` closes Settings and the compact sidebar.

Dropping a file anywhere shows a dashed accent border and one centred line on
the composer (`Drop to attach`); nothing else moves. `@` opens one quiet picker
above the composer; selected names become chips and are focus, not
authorization.

## Settings

Five panes: Model, Storage accounts, Memory, Methods and Appearance. The active
pane is the top-bar title and the selected rail row. Model configuration is one
form: provider, model, base URL, key, Save and Test. Local models are one-click
chips. Accounts list read-only credentials and open one inline form for add or
edit (name, endpoint, region, path-style, access keys or AWS profile, bucket
scope); the key fields are never pre-filled.

Memory lists every document the agent wrote, with its key, scope, text, the
task that wrote it and when, and **Forget**. Methods lists every agent-authored method, with its scope,
description, code under **Raw**, and Delete. Appearance holds language, theme
and the background-notification switch.

Inputs and selects are styled consistently with visible focus rings; selects use
a drawn chevron. Checkboxes keep the native input for keyboard and screen
readers, with a 16px drawn box. No raw browser widget survives.

## Motion

120ms for hover and focus; 180ms for unfolding steps and data; 200ms for the
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

The running phase is a `status`; an error notice is an `alert`. Every action is
a real button reachable by keyboard: each step line is a button with
`aria-expanded`, citations are buttons, and hover-revealed task actions and
Copy answer also appear on focus. The page has one visually hidden `h1`. Focus
is trapped in the Settings sheet and returns to the trigger on close.

The E2E runs axe on Settings, Home and the conversation and fails on serious
or critical violations. This is a floor, not a certification.

## Writing

English and Chinese are written separately, not translated word for word. The
agent writes its own prose; the interface adds no heading, table or summary to
it. The interface never says "Let me know if…", "Here is what I found:" or
"Next steps". A change is the agent's text; there is no Apply button.
