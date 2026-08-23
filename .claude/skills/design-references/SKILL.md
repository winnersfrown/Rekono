---
name: design-references
description: A curated library of real companies' design systems (colors, type scales, spacing, components) to read as reference material for principles before a marketing-site design decision. Not a design system to copy -- see the policy below before using any file here.
---

# Design References

Fourteen `DESIGN.md` files, each one an extracted analysis of a specific
real company's actual website design system: colors, type scale, spacing
tokens, component specs, do's-and-don'ts, responsive behavior. Sourced
from [voltagent/awesome-design-md](https://github.com/voltagent/awesome-design-md)
(see `NOTICE.md` for the source commit and full curation rationale) and
narrowed from that repo's 70+ brands down to the ones that share Rekono's
own genre -- B2B SaaS, fintech, developer tools -- since a car
manufacturer's or a sneaker brand's design language has nothing useful to
say about an invoice-automation product's marketing page.

## The policy -- read this before opening any DESIGN.md here

**These are reference material for principles, never a source to copy
tokens from.** Rekono's marketing site (`website/index.html`) has its own
considered visual identity -- a "virtual ledger" theme with a slab-serif
display face, a blue accent, and liquid-glass panels -- arrived at
deliberately, not defaulted into. Lifting a specific named company's exact
color hex values, font pairing, or component specs into Rekono's own site
would make it read as derivative of that company, not as Rekono. That's a
materially different (and worse) outcome than being *inspired* by how a
well-regarded product handles restraint, hierarchy, or a domain-specific
detail.

The right use of a file here: read it, extract the *principle* behind a
choice (why does Stripe use tabular figures on money? why does Linear
resist drop shadows?), then decide whether that principle is genuinely
missing from Rekono's own site -- the way the tabular-nums gap was found
and fixed by comparing against Stripe's stated reasoning, not by copying
Stripe's indigo (`#533afd`) onto Rekono's own buttons.

**Pair this with the `taste-skill` skill for any actual redesign work.**
`design-references` supplies inspiration and comparison points;
`taste-skill` supplies the audit-first process, the anti-genericness
checklist, and the explicit reminder that its own rules are contextual --
apply the same judgment here. `taste-skill` also scopes itself to
landing/marketing pages, not the app dashboard (`backend/public/`); that
scope carries over to this library too.

## Available references

| Brand | Genre angle | Notable principle |
|---|---|---|
| `stripe` | Fintech infrastructure | Tabular-figure money type as a "quiet financial-data signal"; single-indigo CTA discipline |
| `wise` | Consumer fintech | Bold weight + one saturated brand color can read as trustworthy, not just navy restraint |
| `linear.app` | SaaS product craft | Single type family across all weights; surface-ladder elevation over drop shadows; eyebrow tracking as taxonomy |
| `vercel` | Developer tool | Dark-canvas product marketing; screenshot-as-protagonist layout |
| `notion` | B2B SaaS (broad) | Flexible, componentized marketing system at scale |
| `slack` | B2B SaaS (mainstream) | Approachable-but-serious enterprise tone |
| `intercom` | B2B SaaS (customer-facing) | Product-led marketing narrative |
| `zapier` | B2B automation | Same "automate a business process" pitch shape as Rekono's own |
| `superhuman` | Premium productivity SaaS | Trust-first, exclusivity-inflected tone without looking cold |
| `sentry` | Developer tool SaaS | Technical-audience marketing that stays warm, not just terminal-dark |
| `resend` | Developer tool (email infra) | Rekono's own transactional-email provider; minimal, dev-focused marketing |
| `mastercard` | Payments infrastructure | Enterprise trust signaling in a regulated-adjacent category |
| `revolut` | Consumer/SMB fintech | Bold color used deliberately in a compliance-heavy category |
| `figma` | Design tool | Product-craft benchmark from a company whose own product is design |

## Checking for updates

This is a point-in-time curated copy, not a live sync. See `NOTICE.md`
for the source commit; re-check upstream occasionally and re-copy specific
files if a brand's system has materially changed.
