# Design

One brief, one composer, one accent. The window should feel like a page you
read, not a console you operate.

## Tokens

Defined in `src/renderer/styles.css`. No component uses a raw colour.

| Token | Light | Dark |
|---|---|---|
| `--bg` | `#f8f7f4` | `#151413` |
| `--bg-sunken` | `#f2f0ec` | `#111110` |
| `--surface` | `#ffffff` | `#1d1c1a` |
| `--ink` | `#1b1a18` | `#ecebe6` |
| `--ink-2` | `#5f5b54` | `#a9a49b` |
| `--ink-3` | `#6b665e` | `#938e84` |
| `--line` | `#e6e2da` | `#2c2a27` |
| `--accent` | `#3b6ef5` | `#6f95ff` |
| `--danger` | `#b4423a` | `#e0766c` |
| `--warn` | `#9a6b1f` | `#d0a25c` |
| `--ok` | `#2f7d5c` | `#63b08c` |

Every text colour clears WCAG AA on every surface it appears on. `--ink-3` is
the quietest text that still does: 5.0:1 on `--bg-sunken` in light, 4.9:1 on
`--surface-2` in dark.

## Type

System UI. 20px for the Home heading, 16px for the verdict, 15px for body and
prose, 13px for UI and finding titles, 12px for meta and section labels, 11px
only for durations. Line height 1.6–1.7 for prose, 1.45 for rows. Prose is
capped at 66 characters. Mono is used for bucket names, keys and generated text.

## Shape

Four spacing steps are used everywhere: 4, 8, 12, 16 (plus 22 and 32 for
section rhythm). Radii: 6 for controls, 10 for panels, 14 for the composer. One
shadow level exists, and only the composer and menus use it.

The document is flat: hairline separators and space, no cards. The composer is
the only elevated surface on the page. Tables and code blocks keep their own
rules because they are data surfaces, not cards.

## Layout

- Sidebar 252px, `bg-sunken`: New task, ⌘K search, one list, Settings at the foot.
- Brief column 720px, centred. The task title appears once, in the sidebar (and
  in the small top bar below 860px).
- Composer docked at the bottom on every screen, 720px wide, on the same left
  edge as the brief.
- Below 860px the sidebar becomes an overlay; the composer stays.

## The brief

Top to bottom: a 12px meta line (`checked 2m ago · 5 findings`) with Copy and
Save revealed on hover; the verdict; notices; findings; the fix; one data
section; the checks receipt; the questions disclosure.

Findings use a severity dot, a 14px title and a 12px meta line. There is no
severity pill. Clicking a finding scrolls to its check and flashes it. Data and
Checks are disclosures; their headers are 12px labels, not buttons that look
like buttons.

## Motion

120ms for hover and focus, 180ms for an unfolding check or data section. Only
`transform` and `opacity`. `prefers-reduced-motion` disables all of it. No
reveal-on-scroll, no page transitions, no animation library.

## Icons and states

Lucide, 14–16px, 1.6 stroke. Six states exist: idle, hover, focus-visible,
working (a pulsing accent dot), attention (warn dot) and failure (danger).

## Writing

English and Chinese are written separately, not translated word for word. The
verdict is short: at most two sentences, no heading, no table, no restated
numbers. The interface never says "Let me know if…", "Here is what I found:" or
"Next steps".
