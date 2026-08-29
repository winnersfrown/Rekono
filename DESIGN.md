# Design System — Rekono

Read this before any visual or UI decision, on either surface. Every token
below is defined once in code: `backend/public/styles.css` `:root` for the
product, `website/src/index.css` `:root` for the marketing site. Those two
files must agree.

## Product Context

- **What this is:** Accrual accounting and financial close software. A real
  double-entry general ledger with AR, AP, revenue recognition (ASC 606),
  adjusting entries, year-end close, a share register and cap table, option
  pool and stock compensation (ASC 718), and an income tax provision.
- **Who it's for:** Controllers, accountants and finance leads at scaling
  companies. People whose job is to close the books and who are personally
  accountable when a number is wrong.
- **Space:** AI-native ERP / accounting. The named competitor is **Rillet**,
  not QuickBooks. Adjacent visual peers: Ramp, Mercury, Brex.
- **Project type:** Hybrid. A data-dense web app plus a marketing site.

## The memorable thing

**Serious software for people who actually close books.**

Every decision below serves that one sentence. When a future choice is
ambiguous, this is the tiebreaker.

## Aesthetic Direction

- **Direction:** Editorial / Technical. The visual language of a printed
  financial statement and an audit workpaper, brought up to date.
- **Decoration level:** minimal. Type and hairline rules do all the work.
- **Mood:** Precise, quietly authoritative, unhurried. A careful person
  produced this document.

**The structure is the argument, not the palette.** What makes this look
like a workpaper is the ruled schedule, the right-aligned money column, the
double rule under a total, and the room to breathe. Those hold whatever
colour and typeface sit on top of them. The palette below is the product's
own blue, restored by explicit request after a spell in oxblood; the
layout, spacing and rules underneath it are the ones the editorial pass
introduced, and they stay.

## Typography

Three faces, three jobs. Self-hosted as woff2 under `fonts/` (root),
`website/public/fonts/`, and `backend/public/fonts/`, so no page makes a
cross-origin font request.

- **Display/Hero:** **Bitter** — a slab serif with a single weight axis and
  no optical size, so unlike an optically-sized face there is nothing to set
  per heading level and no minimum size below which the drawing falls apart.
  Headings only.
- **Body / UI / Data:** **IBM Plex Sans** — neutral, holds up at small
  sizes, has tabular lining figures. Money and any aligned column uses
  `font-variant-numeric: tabular-nums lining-nums`.
- **Codes / References:** **IBM Plex Mono** — reserved for things that are
  codes rather than words: account numbers, journal entry references, period
  labels (`2026-05`), IDs. Not for prose.

**Scale**

| Role | Size | Notes |
|---|---|---|
| Display | `clamp(2.6rem, 5.5vw, 4.1rem)` | line-height 1.06, -0.022em |
| Section | `clamp(1.6rem, 3vw, 2.15rem)` | -0.015em |
| Panel title | 1.2rem marketing / 1.25rem product | sized for the space around it |
| Body | 0.94rem / 15px base | line-height 1.6 |
| Table | 0.92rem | rows 52px |
| Label | 0.68rem | mono, uppercase, 0.1em tracking |

## Color

**Approach:** restrained. Ink on warm paper, one accent, semantic colors
held strictly in reserve.

| Token | Value | Use |
|---|---|---|
| `--paper` | `#F4F7FD` | Page ground |
| `--paper-sunk` | `#F2F5FB` | Recessed rows, table headers, banners |
| `--paper-rise` | `#FFFFFF` | Panels, cards |
| `--paper-deep` | `#E7EDFB` | Pressed/active on a sunk surface (product only) |
| `--ink` | `#101A33` | Primary text |
| `--ink-soft` | `#3B4964` | Lede, secondary |
| `--muted` | `#5B6B8C` | Hints, labels |
| `--rule` | `#D8E0F2` | Borders, dividers |
| `--rule-soft` | `#E7ECF7` | Table row dividers |
| `--accent` | `#4B86F7` | Primary button **fill** |
| `--accent-deep` | `#1D4ED8` | Accent hover |
| `--accent-text` | `#2C68D6` | Accent **text**, links, tags |
| `--accent-ink` | `#101A33` | The **label on** an `--accent` fill |
| `--accent-wash` | `#E7EDFB` | Accent backgrounds |
| `--pos` | `#178048` | Gain, reconciled, passing |
| `--neg` | `#D43A41` | Loss, out of balance |
| `--warn` | `#96650F` | Flagged, needs a human (product only) |

**Light only.** There is no dark theme, and adding one is its own change:
the product stylesheet still carries semi-transparent literals that assume
a light ground, so a `prefers-color-scheme` block that only redefined the
tokens would leave it half-converted.

**`--warn` exists on the product only.** "Flagged, needs a human" is not a
loss and not an accent, and folding it into either would lie about what it
means. The marketing site has nothing to flag, so it doesn't define it.

**`--accent`, `--accent-text` and `--accent-ink` are three tokens on
purpose.** They do three jobs no single value can do at once:

- `--accent` is a **fill**. It is light enough that a white label on it
  measures 3.47:1, which fails AA. Its label is `--accent-ink`, the dark
  navy, at 4.97:1. On `--accent-deep` (the hover) the fill is dark enough
  that the label has to flip back to white.
- `--accent-text` is **text on a light ground**, so it has to be dark
  enough to pass AA at label sizes. It is one step darker than the
  palette's own `#2F6FE0`, which measures 4.38:1 on the page ground and
  misses the bar; `#2C68D6` is visually the same blue and clears it on the
  page ground, a panel, and a sunk row alike.

Collapsing any two of them puts unreadable text somewhere. Check with a
contrast calculation, not by eye — 4.38:1 and 4.82:1 look identical.

**Semantic colours never decorate.** Green means gain, red means loss.
Destructive confirmations use `--neg`, never `--accent` — unambiguous here,
since a red confirm against a blue accent reads instantly.

In the product the filled accent button means "this is the one thing to do
on this screen", so anything in a table row (Void, Delete, Retry) is the
quiet outline button instead. A table whose every row carries a filled
accent button is a wall of accent, and the accent stops meaning anything.

## Spacing

- **Base unit:** 4px
- **Density:** **spacious**. This is a deliberate reversal of the previous
  system, which was cramped.
- **Scale:** `2xs 2` · `xs 4` · `sm 8` · `md 16` · `lg 24` · `xl 32` ·
  `2xl 48` · `3xl 64` · `4xl 96`

Concrete floors, so "spacious" is checkable rather than a feeling:

- Table rows: **52px** minimum height, 16px cell padding
- Panel padding: **32px** (24px below 720px)
- Between sections: **48–64px**
- Between page sections on marketing: **96px**

## Layout

- **Approach:** hybrid. Grid-disciplined in the product (data needs
  predictable alignment); editorial asymmetry on the marketing site.
- **Max content width:** 1180px product, 1320px marketing
- **Border radius:** `sm 3px` · `md 5px` · `lg 8px`. Deliberately tight.
  Bubble radius reads as consumer app.
- **Elevation:** hairline rules, **not** shadows. A statement is ruled, it
  is not floated. Shadows only for genuinely floating layers (modals).

## Motion

- **Approach:** minimal-functional. This is accounting software; motion must
  never make someone wait.
- **Duration:** micro 80–120ms, short 140–200ms. Nothing longer in the
  product.
- **Easing:** enter `ease-out`, exit `ease-in`, move `ease-in-out`.
- The marketing site may use subtle entrance reveals. The product may not.
- Respect `prefers-reduced-motion`.

## Anti-patterns

Never, on either surface: purple or violet gradients; three-column icon
grids with circles; centered-everything; gradient CTA buttons; uniform
bubble radius; `system-ui` as a display or body face; soft drop shadows used
as decoration; decorative use of the semantic green and red; a translucent
blurred "glass" surface (the previous system's material — it read as a
floating consumer app, which is the one thing this is not).

## Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-08-28 | Initial design system created | `/design-consultation`. Replaces Bitter + IBM Plex on cool blue. Competitor research limited to WebSearch: the egress proxy blocks browsing competitor sites directly (403 on CONNECT), so claims about specific competitor visuals are from category knowledge, not from inspecting their CSS. |
| 2026-08-28 | Split `--accent` from `--accent-text` | Rendering the preview showed a single lightened accent turns the dark-mode primary button pink, reading as disabled. |
| 2026-08-28 | Density raised from compact to spacious | Explicit user request: everything on the Render app to be more spread out. |
| 2026-08-28 | Dark palette specified but not wired | The product stylesheet still holds semi-transparent literals that assume a light ground; a token-only dark block would render half-converted. |
| 2026-08-28 | Added `--warn`, product only | The review queue needs a third semantic that is neither gain nor loss. |
| 2026-08-28 | Glass and shadow tokens neutralised rather than deleted | ~40 selectors ask for `--glass-*` and `--shadow-*`. Redefining the recipe turned every translucent panel opaque in one edit instead of forty, and kept the diff readable. |
| 2026-08-28 | In-table action buttons are the quiet outline style | A row of filled accent buttons is a wall of accent, and Void sits one click from a `--neg` confirmation. |
| 2026-08-29 | **Reverted to Bitter + IBM Plex on the blue palette** | Explicit user request. Superseded the 2026-08-28 typeface and colour decisions; every other decision in this table stands. |
| 2026-08-29 | Kept the layout, spacing, rules and marketing copy from the editorial pass | What makes the product read as a workpaper is the ruled schedule, right-aligned money and the room to breathe, none of which depend on the palette. Only the two things asked for changed. |
| 2026-08-29 | Added `--accent-ink`; darkened `--accent-text` to `#2C68D6` | The blue fill is light enough that white on it is 3.47:1 and fails AA, so the accent's label is the dark navy at 4.97:1. The palette's own `#2F6FE0` is 4.38:1 on the page ground, just under the bar. |
