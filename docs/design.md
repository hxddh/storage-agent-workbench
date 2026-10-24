# Design

One document, one composer, one accent. The window should feel like a page you
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
| `--ink-3` | `#918b81` | `#7c776e` |
| `--line` | `#e6e2da` | `#2c2a27` |
| `--accent` | `#3b6ef5` | `#6f95ff` |
| `--danger` | `#b4423a` | `#e0766c` |
| `--warn` | `#9a6b1f` | `#d0a25c` |
| `--ok` | `#2f7d5c` | `#63b08c` |

## Type

System UI at 15px for prose, 13px for UI, 11px for meta, 20px for the Home
heading. The task page has no heading: the request is the first line. Line height 1.6–1.7 for prose, 1.35 for rows. Prose is capped at 68
characters. Mono is used for bucket names, keys and generated text.

## Shape

Four spacing steps are used everywhere: 4, 8, 12, 16 (plus 24 and 32 for
section rhythm). Radii: 6 for controls, 10 for panels, 14 for the composer. One
shadow level exists, and only the composer and menus use it.

The document is flat: hairline separators and space, no cards. The composer is
the only elevated surface on the page. A tool result is a section under its row,
separated by a hairline — never a bordered card inside the document. Tables and
code blocks keep their own rules because they are data surfaces.

## Layout

- Sidebar 252px, `bg-sunken`: New task, ⌘K search, one list, Settings at the foot.
- Document column 760px, centred; 68ch prose inside it. The task title appears
  once, in the sidebar.
- Composer docked at the bottom on every screen, 760px wide.
- Below 860px the sidebar becomes an overlay; the composer stays.

## Motion

120ms for hover and focus, 200ms for an expanding tool result. Only `transform`
and `opacity`. `prefers-reduced-motion` disables all of it. No reveal-on-scroll,
no page transitions, no animation library.

## Icons and states

Lucide, 14–16px, 1.6 stroke. Six states exist: idle, hover, focus-visible,
working (a pulsing accent dot), attention (warn dot) and failure (danger).

## Writing

English and Chinese are written separately, not translated word for word. The
answer is short: a lead sentence, then at most two paragraphs. The interface
never says "Let me know if…", "Here is what I found:", or "Next steps".
