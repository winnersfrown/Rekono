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

**Why this and not the category default.** Every AI-native accounting
product sells speed ("zero-day close") and dresses like consumer fintech:
geometric sans, cool blue-grey, soft shadows, generous radius. That visual
language says *this will be easy*. Rekono's actual differentiator is the
opposite: it refuses to value an option, compute a tax rate, or book a
benefit on a loss. Its personality is *we will not guess on your behalf*.
A controller is accountable when the numbers are wrong, so trust comes from
looking like the profession's own reference material, not like a banking
app. **Design toward the workpaper, not the wallet.**

## Typography

Three faces, three jobs. Self-hosted as woff2 under `fonts/` (root),
`website/public/fonts/`, and `backend/public/fonts/` — same
zero-external-request rule the previous system had.

- **Display/Hero:** **Fraunces** — an optical-sized variable serif. Reads as
  publication and standard-setting rather than app. Headings only.
  **Never below 20px, never inside a table.**
- **Body / UI / Data:** **Geist** — neutral with real character, holds up at
  small sizes, has tabular lining figures. Money and any aligned column uses
  `font-variant-numeric: tabular-nums lining-nums`.
- **Codes / References:** **Geist Mono** — reserved for things that are
  codes rather than words: account numbers, journal entry references, period
  labels (`2026-05`), IDs. Not for prose.

**Scale**

| Role | Size | Notes |
|---|---|---|
| Display | `clamp(2.6rem, 5.5vw, 4.1rem)` | `opsz` 120, line-height 1.04 |
| Section | `clamp(1.6rem, 3vw, 2.15rem)` | `opsz` 60 |
| Panel title | 1.25rem (20px) | `opsz` 24 -- the floor, not a suggestion |
| Body | 0.94rem / 15px base | line-height 1.6 |
| Table | 0.92rem | rows 52px |
| Label | 0.68rem | mono, uppercase, 0.1em tracking |

## Color

**Approach:** restrained. Ink on warm paper, one accent, semantic colors
held strictly in reserve.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--paper` | `#FAF8F4` | `#14161A` | Page ground |
| `--paper-sunk` | `#F3F0E9` | `#0F1114` | Recessed rows, banners |
| `--paper-rise` | `#FFFFFF` | `#1B1E23` | Panels, cards |
| `--ink` | `#14161A` | `#F2EFE9` | Primary text |
| `--ink-soft` | `#3A3E45` | `#CFCBC3` | Lede, secondary |
| `--muted` | `#5C5F66` | `#989BA2` | Hints, labels |
| `--rule` | `#E3DED4` | `#2B2F36` | Borders, dividers |
| `--rule-soft` | `#EFEBE3` | `#23262C` | Table row dividers |
| `--accent` | `#7A2E33` | `#8E353B` | Primary button **fill** |
| `--accent-deep` | `#5E2126` | `#A03F45` | Accent hover |
| `--accent-text` | `#7A2E33` | `#D99A9B` | Accent **text**, links, tags |
| `--accent-wash` | `#F2E7E6` | `#2E2022` | Accent backgrounds |
| `--pos` | `#1F6B4A` | `#5FBF8E` | Gain, reconciled, passing |
| `--neg` | `#C4462F` | `#E08163` | Loss, out of balance |
| `--warn` | `#96650F` | `#D9A441` | Flagged, needs a human (product only) |

**The dark column is specified, not wired.** Both surfaces ship light-only
today. The values above are the palette a dark theme must use when one is
built; nothing reads them yet, and a `prefers-color-scheme` block that only
redefined the tokens would leave the product half-converted, because the
stylesheet still carries semi-transparent literals that assume a light
ground. Wiring it is its own change, not a side effect of one.

**`--warn` exists on the product only.** "Flagged, needs a human" is not a
loss and not an accent, and folding it into either would lie about what it
means. The marketing site has nothing to flag, so it doesn't define it.

**Warm paper, not cool white.** The whole category is cool blue-grey. Warm
`#FAF8F4` reads as document at a glance. It demands discipline in the greys
or it looks dated.

**Oxblood, not blue.** Blue is the fintech default and was Rekono's own
colour. Oxblood is ledger binding and legal seal, and nobody in this
category owns it.

**`--accent` and `--accent-text` are separate on purpose.** Found by
rendering: lightening one accent token for dark mode turns the primary
button washed-out pink, which reads as *disabled*. A fill sits against the
page ground and a label sits against a panel; they need opposite treatment.
Never collapse them back into one.

**Semantic colours never decorate.** Green means gain, red means loss. The
negative red is deliberately pushed toward orange so it can never be
mistaken for the oxblood accent. A red-family accent on a destructive
action needs care: destructive confirmations use `--neg`, not `--accent`.

That care extends to what *triggers* a destructive action. In the product,
the filled accent button means "this is the one thing to do on this
screen", so anything in a table row (Void, Delete, Retry) is the quiet
outline button instead. A table whose every row carries a filled oxblood
button is a wall of accent, and the accent stops meaning anything.

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
as decoration; decorative use of the semantic green and red.

## Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-08-28 | Initial design system created | `/design-consultation`. Replaces Bitter + IBM Plex on cool blue. Competitor research limited to WebSearch: the egress proxy blocks browsing competitor sites directly (403 on CONNECT), so claims about specific competitor visuals are from category knowledge, not from inspecting their CSS. |
| 2026-08-28 | Split `--accent` from `--accent-text` | Rendering the preview showed a single lightened accent turns the dark-mode primary button pink, reading as disabled. |
| 2026-08-28 | Density raised from compact to spacious | Explicit user request: everything on the Render app to be more spread out. |
| 2026-08-28 | Dark palette specified but not wired | The product stylesheet still holds semi-transparent literals that assume a light ground; a token-only dark block would render half-converted. |
| 2026-08-28 | Added `--warn`, product only | The review queue needs a third semantic that is neither gain nor loss. |
| 2026-08-28 | Glass and shadow tokens neutralised rather than deleted | ~40 selectors ask for `--glass-*` and `--shadow-*`. Redefining the recipe turned every translucent panel opaque in one edit instead of forty, and kept the diff readable. |
| 2026-08-28 | In-table action buttons are the quiet outline style | A row of filled oxblood buttons is a wall of accent, and Void sits one click from a `--neg` confirmation. |
