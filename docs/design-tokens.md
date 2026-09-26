# Design tokens

> **Storage Agent v3.1.0 — Design system v3, finished.** Presentation contract for the
> native Agent Task window. Tokens do not invent runtime state, progress, or
> capabilities.

v3.0 replaces the v1.09–v2.2 system (an achromatic ladder, an ink primary,
status as the only colour) with a calibrated cool-neutral ladder, **one
restrained indigo accent** for what is actionable, selected, focused or in
progress, and a status palette kept apart from it. Components must not
introduce ad-hoc px font sizes, corner radii, z-index numbers, or
`transition-all`; controls come from the component library instead of being
restyled per surface.

v3.1 finishes the system: no component (`*.tsx`) carries a raw colour or type
utility any more (guarded by `frontend/src/components/v310.test.tsx`);
surfaces compose `components/ui.tsx` and semantic classes defined in the
stylesheets below; the type aliases are gone (five sizes, five names); and
`.ui-scrim` is the one scrim.

## Source of truth

| Layer | File |
| --- | --- |
| CSS variables (color, type, spacing, radius, shadow, motion, measure) | `frontend/src/index.css` |
| Tailwind mapping | `frontend/tailwind.config.js` |
| Component library (Button, IconButton, Kbd, Badge, StatusDot, SectionLabel, Segmented, Field / TextInput / Select) | `frontend/src/components/ui.tsx` |
| Component styles (`ui-*` only), menus, the activity bar, the `ui-rise-in` / `ui-pop-in` keyframes | `frontend/src/agent/native-components.css` |
| Window, sidebar, title bar, side pane, Settings | `frontend/src/agent/native-shell.css` |
| Result, outputs bar, Work log turns, tool rows, tables, figures, Composer, banners, empty start, the `reveal-in` keyframe | `frontend/src/agent/native-document.css` |
| Surface stylesheets (v3.1), imported after `agent/native-*.css`: rendered Markdown · Settings panes · side-pane outputs · palette and sheets | `frontend/src/styles/markdown.css` · `settings-panes.css` · `artifacts.css` · `overlays.css` |
| Figures (`ChartFrame`, marks, legend, tooltip) | `frontend/src/viz/marks.tsx` |
| Enforcement | `frontend/src/design-tokens.test.ts`, `frontend/src/theme.tokens.test.ts`, `frontend/src/agent/architecture.test.ts`, `frontend/src/components/v310.test.tsx`, `e2e/contrast.spec.ts` |

Both themes are first-class. Dark is the default; light is not an inversion of
foregrounds on a white page. Every text step (`--gray-100` … `--gray-500`)
clears WCAG AA (4.5:1) against `--hover`, the worst ground text can land on.

## Color

### Neutral ladder

Surfaces (cool, low chroma; dark theme, darkest first):
`--canvas #0e0e10` < `--sidebar #161619` < `--panel #1b1b1f` < `--elevated #232327` < `--hover #2c2c32`;
edges `--edge #25252a`, `--edge-strong #34343b`. Light: `--canvas #ffffff`,
`--sidebar #f4f4f5`, `--panel #f7f7f8`, `--elevated #ffffff`, `--hover #ebebee`,
edges `#e8e8eb` / `#d6d6db`.

Ink: `--gray-100` primary · `--gray-200` strong secondary · `--gray-300`
secondary · `--gray-400` tertiary · `--gray-500` meta. No `--gray-600/700`
as text.

### Accent — the one hue

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--accent` | `#5d5bd4` | `#4f46e5` | fill of the primary action (one per surface), Composer send |
| `--accent-soft` | `#6b69e0` | `#5b52f0` | hover step of the fill |
| `--accent-fg` | `#ffffff` | `#ffffff` | label on an accent fill |
| `--accent-text` | `#a4a2ff` | `#4338ca` | accent ink: links, the *Result* badge, live progress, the working dot |
| `--accent-dim` | 16% tint | 9% tint | selection tint (selected sidebar row, selected Settings nav, accent badges) |

`--focus-ring` and `--selection` derive from the same hue. The accent is used
**only** for the primary action, selection, focus, links and live progress —
never for decoration, headings or status.

### Status

`--danger` / `--warn` / `--success` with matching `-bg` and `-border`;
`--warn-fg` for warning text; `--danger-bg-strong` for an error slab. Status
is carried by a dot (`StatusDot`) or a badge (`Badge` tone) — never coloured
prose or a coloured number (v3.1 carries this into settings test results, the
cloud tester, S3 error cards, call detail and tool results: a dot or badge
beside neutral text). Severity badges read High / Medium / Low / Info.
*Needs attention* is a warn dot. Status colours are never series colours.

### Figures

`--viz-1` … `--viz-6` is a categorical order — indigo, orange, aqua, gold,
magenta, blue — validated for CVD and normal-vision separation in both themes
(dark `#6c6af2 #d95926 #199e70 #c98500 #d55181 #3987e5`; light
`#4f46e5 #e05a26 #11906a #ad7d00 #d24e86 #2a78d6`). In v3.1 the light theme's
orange, aqua, gold and magenta (`--viz-2…5`, formerly
`#eb6834 #1baf7a #eda100 #e87ba4`) were stepped darker in the same hues so
every series clears 3:1 on white and on the panel surfaces; CVD separation and
the normal-vision floor were re-validated and all hard checks pass in both
themes. Series take them in order; text in figures uses ink tokens, never a
series colour. Inventory ranked bars align to the top of their column.

### Code

`--code-bg` plus `--syn-*` slots (`str`, `num`, `kw`, `com`, `name`, `tag`,
`punct`), AA against the slab in both themes.

Never use a raw palette step (`red-950` or similar). Meaning is a token.

## Type

Five sizes, each with one job, and (since v3.1) five names. The v3.0 aliases
`--text-xs`, `--text-base` and `--text-lg` (and the Tailwind `xs` / `base` /
`lg` sizes) are removed; use the names below (Tailwind `text-2xs` · `text-sm`
· `text-prose` · `text-xl` · `text-2xl`, inside stylesheets rather than
component class lists).

| Token | Size / leading | Use |
| --- | --- | --- |
| `--text-2xs` | 11px / 16px | labels (`SectionLabel`), meta, key caps, badges |
| `--text-sm` | 13px / 20px | interface: sidebar rows, title bar, controls, tool rows, Composer |
| `--text-prose` | 15px / 1.7 | reading: Work Result, Evidence, Report |
| `--text-xl` | 20px / 28px | the conclusion's answer, the Result's focal point |
| `--text-2xl` | 28px / 34px | page title: the empty-start greeting (the page's one `<h1>`) |

Faces (v1.19): the **platform UI face first** — SF Pro on macOS, Segoe UI
Variable on Windows — with vendored **Inter Variable** as the fallback where
the platform face is not a UI face (Linux); **JetBrains Mono Variable** (93%
size-adjusted) for tool names, keys, payloads, and code. CJK falls through to
the platform face. Rank comes from size, weight, and space — not from fading
text.

## Spacing, radius, elevation, icons

Spacing is a **4px grid**: `--space-1` (4) · `-2` (8) · `-3` (12) · `-4` (16) ·
`-5` (20) · `-6` (24) · `-8` (32) · `-10` (40) · `-12` (48).

Radii are three: **6px** controls (`--radius-sm` / `--radius` / `--radius-md`),
**10px** cards and menus (`--radius-lg` / `--radius-xl`), **14px** panels and
dialogs (`--radius-2xl` / `--radius-3xl`). Dots and round controls are `full`.

Shadows are two: `--shadow-elev` for menus and popovers, `--shadow-pop` for
dialogs, the palette and the overlaid side pane (`--shadow-glow` is an alias of
`--shadow-pop`). The canvas itself has hairline depth only.

Icons are 16px (14px in dense rows) at a 1.5 stroke with rounded joins
(`components/icons.tsx`).

## Measure and layout

`--doc-measure: 46rem` is the reading column for Direction, prose and banners;
`--doc-track: 64rem` is the document track for tables, code and figure cards.
`--sidebar-w: 16.25rem` is the sidebar; `--sidepane-w: 30rem` the default side
pane (resizable 352–880px; below 1100px it overlays the document);
`--header-h: 2.75rem` the title bar; `--control-h: 2rem` controls.

The window is `sidebar · title bar · document`, plus the one side pane when an
output is open.

## Components

`components/ui.tsx` is the only place a control's look is decided; the look
lives in `agent/native-components.css`:

- `Button` (`ui-btn`, `data-variant`): `primary` (accent fill, one per
  surface) · `secondary` (raised neutral) · `ghost` (text only) · `selected`
  · `danger`; sizes `sm` / `md` / `lg`.
- `IconButton` (`ui-icon-btn`): square, its label is the accessible name and
  tooltip.
- `Kbd` (`ui-kbd`): one cap per key.
- `Badge` (`ui-badge`, `data-tone` neutral / accent / success / warn / danger
  / outline) and `StatusDot` (`ui-dot`, pulses only while work is live).
- `SectionLabel` (`ui-label`): the one 11px section eyebrow.
- `Segmented` (`ui-segmented`), `Field` + `TextInput` / `Select`
  (`ui-field`, `ui-input`).

## Motion

| Token | Value | Use |
| --- | --- | --- |
| `--duration-fast` | 120ms | hover, controls, chrome (`--duration-instant` is an alias) |
| `--duration-base` | 200ms | menus, palette, `reveal-in`, the progress meter |
| `--duration-slow` | 280ms | sheets, dialogs, the side pane, sidebar collapse |

Easing: `--ease-out` `cubic-bezier(0.2, 0.8, 0.2, 1)`, `--ease-emphasized`
`cubic-bezier(0.3, 0, 0, 1)`, `--ease-in-out` for cycles.

Things that open in place — finding details, folded answers, worked rows, new
live items — ease in with the `reveal-in` keyframe. Menus pop in
(`ui-pop-in`). **Sheets rise without fading** (`ui-rise-in`): an opaque
surface never shows what is behind it. `.ui-scrim` (`--scrim`) is the one
scrim: it fades in as a sibling of the opaque sheet, never as its parent, so
the sheet itself does not fade.

`prefers-reduced-motion` zeros animation and transition durations, stops the
pulsing dot and the activity bar, and replaces skeletons and shimmer with
static surfaces.

Loading uses **skeletons**, not spinners. Live work is a pulsing
`StatusDot` / `.working-mark` in `--accent-text` with a live elapsed timer;
the title bar shows a thin indeterminate `ui-activity` hairline while the
runtime reports work. The one determinate bar is real (v2.2): a running survey
or import row whose runtime reported `tool.progress` counts carries a hairline
meter (`.native-tool-meter`, `role=progressbar`, `--hover` track,
`--accent-text` fill) whose width is `done / total` of units actually
finished, never time.

## Keyboard and focus

Focus is a 2px `--focus-ring` (accent) outside a 1px canvas gap, following the
element's own radius. Opt out only with `data-focus-ring="container"` when an
ancestor already draws the ring (the Composer card draws an accent focus
ring). ⌘K / Ctrl+K is a combobox/listbox palette (Recent · Actions, a
key-hint footer), not a destination: only runtime-true work.

## Non-goals

Tokens must not be used to imply a second Agent, a synthetic plan/stepper, an
approval pause, a status bar, a permanent inspector column, or a second
presentation lifecycle. The accent never signals status; status colours never
mark series or decoration. The side pane is the one place the Agent Task's
durable outputs open.
