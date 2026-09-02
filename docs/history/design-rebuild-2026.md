> **Historical.** This is a v1.04-era review note kept for the record. It is superseded by the v1.09.0 native Agent window and the v1.10.0 native shell; see `docs/README.md` for the current documents.

# Design Rebuild 2026 — Codex / Cursor Native

> **Goal**: From a functional but generic web-app shell to a calm, editorial, native agent. Warm, not cold. Magazine voice, not SaaS bombast. One accent voltage, hairline depth, and a document that reads like a well-set technical paper.

## What we keep

- **Agent Task is the application**. The durable runtime (v0.94) is the product. No second agent, no synthetic plans.
- **Inter + JetBrains Mono** vendored, optically matched. The right faces for this product.
- **The durable execution contract**: `after=<seq>`, `Delegate / Steer+Stop`, `Decision`, `Work Result` provenance. The UI must not invent what the runtime does not emit.

## What changes — the Codex/Cursor lesson

Cursor and Codex do not win by having more features. They win by restraint.

1.  **Warm canvas, not cold IDE.** Cursor’s marketing canvas is warm cream `#f7f7f4` on warm near-black `#26251e`. Our app has lived at h=268 (a cool, technical grey) with a 12.5 L* ladder. It is correct but it is also generic: every AI tool defaults to that cool dark. A native storage agent should feel like a native macOS app — warm, calm, and quiet — with the technical cool reserved for code and data surfaces.

2.  **One accent voltage.** Cursor Orange `#f54e00` appears only on primary CTAs and the wordmark. We have used `--accent #6d8bff` everywhere a selection lives. A filled accent says “press this.” When everything selected wears it, nothing does. Keep the accent for the Composer’s Delegate/Steer and for a single selected task mark. Everything else is surface + weight.

3.  **Hairline-only depth.** Cursor has no drop shadows; cards float on 1px borders and white-on-cream contrast. Our app uses `--shadow-elev` and `--shadow-pop` as elevation cues. For a native agent, depth should be a hairline and a subtle surface step, not a scrim.

4.  **Display at weight 400.** Cursor’s 72px hero is weight 400 with -2.16px tracking — a quietly-confident magazine voice, never bold. Our `--text-2xl` (23px) was set at weight 700 in many places. Rank should come from size, tracking, and space, not from bold.

5.  **Efficient, keyboard-first chrome.** Cursor and Codex are built for `j/k`, `⌘K`, `⌘N`, `⌘.` — the hands never leave the keyboard. Our chrome already has those bindings but it still paints them. Native chrome is quiet: the affordance is there, but it is not painted.

## New token system (v1.03 → v1.04)

### Surfaces — warm, not cool

Dark (default) stays dark, but the hue moves from 268 (cool) to 32 (warm). The four surfaces still clear `dL* >= 2.5` per neighbour (same test, same floor), but the ladder now reads as warm charcoal rather than technical blue-grey. The light theme moves from `h=268` to warm cream `#fbf8f1` on `#fffdf9` — Cursor’s cream, but desaturated for a desktop app that must hold code.

### Accent — single voltage

`--accent` becomes warm orange `#f54e00` in light and a softer `#ff6b35` in dark (dark orange at full saturation would be too aggressive against `#111317`). `--accent-soft` is the hover, `--accent-dim` the wash. The blue `#6d8bff` is kept as `--viz-1` for data, not for chrome.

### Type — editorial

Display (`--text-2xl`, `--text-xl`) moves to weight 400 with `-0.02em` tracking. The body measure stays 46rem, but the prose leading moves from `1.75` to `1.8` for a calmer page. Code retains JetBrains Mono at 93% size-adjust; the adjustment is now applied to the variable face, not to each use site.

### Motion — native, not web

Timings tighten: `--duration-fast` 140→120, `--duration-base` 200→180, `--duration-slow` 280→240. The easing moves from `cubic-bezier(0.21, 0.6, 0.35, 1)` to `cubic-bezier(0.16, 1, 0.3, 1)` — the iOS spring. The Composer no longer fades in; it slides 4px with the spring. The Review overlay no longer slides 10px; it scales 98→100 with the same spring.

## New layout — Codex / Cursor native

The v1.02 shell was a quiet two-pane (navigation + task). It was correct but it was also inefficient: the navigation took 260px even when the user was reading, and the task document had no contextual rail. A native agent should be a three-pane that can be one-pane when the user is reading.

```
┌──────────────────────────────────────────────────────────────┐
│ Title bar (native, vibrancy) — traffic lights + title + ⌘K │
├──────┬──────────────────────────────────────┬───────────────┤
│ Icon │ Task document (46rem)                │ Inspector     │
│ bar  │ Direction → Execution → Decision →   │ (Evidence /   │
│ 56px │ Work Result → Artifact               │  Execution /  │
│      │                                      │  Report)      │
│      │ Composer (sticky, 44px)              │ 240px,        │
│      │                                      │  collapsible  │
├──────┴──────────────────────────────────────┴───────────────┤
│ Status bar (native, 22px) — model, scope, task state        │
└──────────────────────────────────────────────────────────────┘
```

- **Icon bar** (56px, like Cursor’s activity bar) holds New task, navigation toggle, model, and settings. It is always visible, even when the navigation is collapsed. The task titles live in the navigation pane that slides out, not in the icon bar.
- **Navigation** is now a true explorer: it can be collapsed to the icon bar (56px) or opened to 260px. When collapsed, the task list is reachable via `⌘K` and `j/k` still works in the document.
- **Document** is the product. It has no header, no status strip, no second presentation mode. It is a single 46rem column with a sticky Composer. The Composer is now 44px tall (was 32px) with a single, unified Delegate/Steer control and a more generous tap target.
- **Inspector** is the Review, but it is now a native inspector (like Xcode’s right pane), not an overlay. It is 240px, collapsible, and it shows the selected Execution, Evidence, or Report without covering the document. `Esc` still closes it.

## What we delete

- The painted `⌘K`, `⌘N`, `⌘.` legends on buttons. The shortcuts remain; they are not painted.
- The `box-shadow` elevation on cards. Depth is a hairline (`--edge`) and a surface step.
- The `font-weight: 700` on display. Display is weight 400, tracking `-0.02em`.
- The `transition-all` on interactive elements. Only `background-color`, `border-color`, `transform`, and `opacity` transition.

## How we know it works

- The existing `theme.tokens.test.ts` still holds `dL* >= 2.5` per neighbour and WCAG AA (4.5:1) per ink step, but the hues are now warm.
- `architecture.test.ts` still asserts the Agent Task ownership, but the navigation is now an icon bar + collapsible explorer.
- `documentation-contract.test.ts` still anchors to the Agent Task, but the design tokens doc is now v1.04.
- Visual review (`npm run shots`) is now 6 states × 2 themes, with the new warm palette, and the gallery page shows the cream/dark pair side-by-side.

This is the difference between a program with a UI and an app with a voice.
