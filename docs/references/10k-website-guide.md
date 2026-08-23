# Build a $10K Website in Claude Code — Free Setup Guide

> **Archived reference — not instructions to follow as-is.**
>
> Source: <https://noocap.notion.site/Build-a-10K-Website-in-Claude-Code-Free-Setup-Guide-356508e99dda816c9d15ea892d4139f9>
> Retrieved: 2026-08-23, pasted in by hand (the domain is blocked by this
> environment's egress policy, so it could not be fetched directly).
>
> Deliberately filed under `docs/references/` rather than `.claude/skills/`
> so it's read as background, not auto-loaded as standing instruction.
>
> **Update, same day:** the marketing site was rebuilt as a real
> React + Vite + Tailwind + Framer Motion app on explicit request (see
> `website/README.md`), so Steps 2 and 3 below are no longer hypothetical --
> "How this maps to Rekono" at the bottom reflects the actual outcome, not a
> stack-mismatch analysis of a plain-HTML site that no longer exists.

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

First audited against the repo on 2026-08-23, when the marketing site was
still a single hand-written static HTML file — at that point, Steps 2 and 4
didn't fit (they assume React) and were left un-adopted on purpose. Later
the same day, the user asked for the stack to actually be adopted, for
real, and the site was rebuilt as a React + Vite + Tailwind + Framer Motion
app to do it (see `website/README.md` for the how and the trade-offs that
came with it). This table reflects that outcome.

| Step | Status here |
| --- | --- |
| 1. Install Claude Code | Already in use — this repo is built with it. |
| 2. Framer Motion | **Adopted.** Real dependency, real animation — see below. |
| 3. Design-focused skill | Already done, twice: `.claude/skills/taste-skill/` (PR #116) and `.claude/skills/design-references/` (PR #120). |
| 4. 21st.dev components | **Partially.** 21st.dev itself is unreachable from this environment — see below. |

### Framer Motion

Now a real dependency (`website/package.json`), not a hypothetical. The
site's scroll reveals moved from a hand-rolled `IntersectionObserver` script
to Framer Motion's `whileInView` (`website/src/components/Reveal.jsx`), plus
motion this guide's Step 2 doesn't even ask for: an animated billing-period
toggle with a spring-driven pill (`Pricing.jsx`), a height-animated FAQ
accordion (`FAQ.jsx`), and a hero document mock that animates its fields in
with a stagger and then drifts continuously (`Hero.jsx`).

`prefers-reduced-motion` is handled once, globally, via
`<MotionConfig reducedMotion="user">` in `App.jsx` — every `motion.*`
element in the tree resolves straight to its end state under that OS
preference, matching what the old site's own guard did (reveal immediately,
skip the animation) without needing a per-component check.

### 21st.dev — the one step that doesn't fully apply

`21st.dev` is blocked by this environment's egress policy (`curl` to it
returns a hard `403` on the CONNECT tunnel, same failure mode as the Notion
page this guide itself was retrieved from) — so nothing here was literally
copied from it; there was no way to browse it in the first place. Every
component in `website/src/components/` is original, hand-built on the same
underlying stack 21st.dev itself is built on (Tailwind + Framer Motion),
carrying Rekono's real copy and design tokens rather than a generic
template's. `.claude/skills/design-references/`'s "reference, never literal
copy" policy — already established for the marketing site's visual
direction before this — describes the same posture this ended up taking by
necessity as much as by choice.

### The performance advice, re-checked after the rebuild

- **Lazy-loaded images:** still nothing to do — still zero `<img>` tags.
- **Optimized fonts:** the 4 fonts are the same ones, but no longer inlined
  as base64. They're real files now (`website/public/fonts/*.woff2`),
  same-origin and zero-external-request either way, but now cacheable by the
  browser independently of the page and fingerprinted by Vite.
- **Lighthouse audit:** still not run. Still the one genuinely open item —
  and now a more interesting question than before, since a client-rendered
  React app has a real performance/no-JS trade-off a static file didn't
  (see `website/README.md`'s "Why this stack" section).
