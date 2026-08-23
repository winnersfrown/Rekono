# Build a $10K Website in Claude Code — Free Setup Guide

> **Archived reference — not instructions to follow as-is.**
>
> Source: <https://noocap.notion.site/Build-a-10K-Website-in-Claude-Code-Free-Setup-Guide-356508e99dda816c9d15ea892d4139f9>
> Retrieved: 2026-08-23, pasted in by hand (the domain is blocked by this
> environment's egress policy, so it could not be fetched directly).
>
> Deliberately filed under `docs/references/` rather than `.claude/skills/`.
> A skill is auto-loaded and treated as guidance; two of this guide's four
> steps assume a React/Tailwind stack and would be actively wrong applied to
> this repo, which has no build step at all. See "How this maps to Rekono"
> at the bottom before acting on anything here.

---

## Why this works

You don't need a designer. You don't need a dev team. You need the right
setup before you start prompting — because Claude Code is only as good as the
environment, animations, design taste, and components you give it access to.

This guide is the exact stack that turns Claude Code from a generic code
generator into a senior-level web designer.

## Step 1 — Install Claude Code

Claude Code runs locally on your machine through your terminal. One command
and you're in.

Install command:

Then run:

> (The original page rendered these as empty code blocks; no commands were
> captured in the copy this was transcribed from.)

Requirements: Node.js 18+ installed. Sign in with your Anthropic account when
prompted.

**Why this matters:** Claude Code can read your full project, edit multiple
files at once, run commands, and iterate — that's what makes it different from
copy-pasting code from a chat window.

## Step 2 — Add Animation Support (Framer Motion)

Default AI-generated sites look static and lifeless. Animation is the #1 thing
that makes a site feel premium.

Install Framer Motion:

Then tell Claude Code in your project context:

> "Use Framer Motion for all animations. Apply scroll-triggered fades,
> staggered reveals, and smooth hover transitions on interactive elements."

**What changes:** Hero sections breathe. Cards slide in on scroll. Buttons feel
alive. This single addition is what separates "AI website" from "agency
website."

## Step 3 — Add a Design-Focused Skill

Claude Code supports Skills — reusable instruction sets that guide how Claude
approaches a task. A frontend design skill teaches Claude taste: spacing,
hierarchy, typography, color systems, and layout principles.

How to add it:

- Create a `.claude/skills/` folder in your project root
- Add a `SKILL.md` file with design rules (or use the public frontend-design skill)
- Claude Code will automatically reference it when building UI

What to include in the skill:

- Typography scale (use a real type system — not random font sizes)
- Spacing system (8px base grid)
- Color tokens (primary, neutral, accent — no random hex codes)
- Component patterns (button states, card structure, form layouts)
- "Avoid generic AI aesthetic" instructions

**Why this matters:** Without a design skill, Claude Code defaults to generic
Tailwind patterns. With one, every component follows a consistent design
system — the kind agencies charge $10K to build.

## Step 4 — Integrate a Component Library (21st.dev)

Don't reinvent the wheel. 21st.dev is a library of production-ready,
beautifully designed components you can drop straight into your project.

How to use it:

- Visit 21st.dev
- Browse components (heroes, pricing tables, testimonials, navbars, footers)
- Copy the component code
- Paste into your project and tell Claude Code to integrate it

Prompt to use:

> "Integrate this 21st.dev component into our landing page. Match it to our
> design tokens, replace the placeholder content with our copy, and add Framer
> Motion entrance animations."

**Why this matters:** Every component is already designed by professionals.
Claude Code adapts it to your brand. You skip 80% of the design work and end up
with a site that looks expensive.

## The Full Stack at a Glance

| Layer | Tool | What it does |
| --- | --- | --- |
| Code generation | Claude Code | Builds and edits your site locally |
| Animation | Framer Motion | Adds polish and motion |
| Design system | Frontend Design Skill | Teaches Claude design taste |
| Components | 21st.dev | Production-ready UI blocks |

## Starter Prompt to Use After Setup

Once all 4 layers are in place, drop this into Claude Code to kick off your
site:

> (The original page rendered this as an empty code block; no prompt text was
> captured in the copy this was transcribed from.)

## Common Mistakes to Avoid

- **Skipping the design skill.** Without it, you'll get a generic site that
  screams "AI-generated."
- **Vague prompts.** Be specific about sections, animations, and content.
  Claude Code is only as good as your brief.
- **Not iterating.** First output is rarely the final output. Ask Claude Code
  to refine spacing, contrast, and motion.
- **Forgetting performance.** Always ask for lazy-loaded images, optimized
  fonts, and a Lighthouse audit at the end.

## What You Just Saved

| Traditional route | Cost | Time |
| --- | --- | --- |
| Hire a web designer | $5K–$15K | 4–8 weeks |
| Hire an agency | $10K–$30K | 6–12 weeks |
| Claude Code + this stack | $20/month | 1–3 days |

## Next Steps

- Install Claude Code today
- Set up Framer Motion + a frontend design skill in your starter template
- Bookmark 21st.dev
- Build your first site this week

That's it. No fluff, no upsell. Just the stack.

---

## How this maps to Rekono

Audited against the repo on 2026-08-23. Three of the four steps were already
satisfied before this guide arrived; the fourth doesn't fit the stack.

| Step | Status here |
| --- | --- |
| 1. Install Claude Code | Already in use — this repo is built with it. |
| 2. Framer Motion | **Does not apply.** See below. |
| 3. Design-focused skill | Already done, twice: `.claude/skills/taste-skill/` (PR #116) and `.claude/skills/design-references/` (PR #120). |
| 4. 21st.dev components | **Does not apply directly.** See below. |

### Why Framer Motion doesn't fit

Framer Motion is a React library. `website/index.html` is a single hand-written
static file — no React, no npm, no bundler, no build step; it deploys as-is to
GitHub Pages. Adopting Framer Motion would mean adding React, a bundler, and a
build pipeline in order to ship behavior the site already has.

The site already implements exactly what Step 2 asks for, natively:

- Scroll-triggered reveals via `IntersectionObserver` (see the bottom of
  `website/index.html`), with `observer.unobserve` after firing so each element
  animates once.
- A `prefers-reduced-motion: reduce` guard, plus a no-`IntersectionObserver`
  fallback that marks everything visible rather than leaving content hidden —
  a failure mode Framer Motion would not protect against for free.
- Hover/entrance transitions through CSS `transition` and `@keyframes` on a
  shared `--ease` token.

### Why 21st.dev doesn't fit directly

21st.dev components ship as React + Tailwind. Same stack mismatch. The
underlying idea — work from professionally designed components rather than
inventing every block — is already served by `.claude/skills/design-references/`,
which captures the *principles* from 14 real design systems without importing
anyone's markup or tokens (see that skill's "reference, never literal copy"
policy).

### The performance advice, checked

- **Lazy-loaded images:** nothing to do. The marketing site has zero `<img>`
  tags; all imagery is CSS and inline SVG.
- **Optimized fonts:** already handled, and then some. Every face is embedded
  directly in the HTML as a base64 `data:font/woff2` URI with
  `font-display: swap` — zero external font requests, not even a `preconnect`
  to warm up, because there is no font host to reach.
- **Lighthouse audit:** not yet run as a tracked artifact. This is the one
  genuinely open item from the guide.
