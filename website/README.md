# Rekono marketing site

A React + Vite + Tailwind + Framer Motion site — real animation, real
component structure, replacing the earlier single hand-written static HTML
file. See "Why this stack" below for what changed and why.

## Develop

```bash
cd website
npm install
npm run dev
```

Opens a dev server with hot reload. Component source lives in `src/`:
`App.jsx` composes the page from `src/components/*.jsx`, one file per
section (`Hero`, `Features`, `Pricing`, `FAQ`, ...). Copy, pricing numbers,
and FAQ content are inline in their component's own file rather than a
separate content/data layer -- there's one page, editing a section's text
means editing that section's file.

Shared design tokens (colours, spacing, radius, the three type faces) live
as CSS custom properties in `src/index.css` and are re-exposed to
Tailwind's utility classes via `tailwind.config.js` -- e.g. `bg-paper-sunk`,
`text-accent-text`, `py-3xl`. Same token names and values as the app's own
stylesheet (`backend/public/styles.css`), kept in sync by hand so the
marketing site and the product read as one considered design.

**`DESIGN.md` at the repo root is the source of truth for every one of
those values** -- read it before changing anything visual here. It also
records what the system deliberately refuses: no gradients, no glass, no
shadows used as decoration, no bubble radius, no `system-ui` as a display
or body face.

## Build & deploy

```bash
cd website
npm run build
```

Deployed on Vercel now, replacing the earlier GitHub Pages setup. Vercel's
dashboard is pointed at this `website/` directory as the project's Root
Directory and runs the build command above itself, in its own CI, on every
push to `main` -- there's nothing to commit besides source: `vite.config.js`
builds to a normal disposable `dist/` (gitignored), Vercel serves that
output from its own domain root, and `outDir`/`emptyOutDir` never need to
special-case avoiding the rest of the repo the way building into the repo
root under GitHub Pages did.

That also means Vite's default content-hashed filenames
(`assets/index-<hash>.js`) are used as-is rather than the fixed names the
old GitHub Pages setup needed -- each Vercel build is fresh, so there's no
risk of orphaned old bundles accumulating the way there was when builds
wrote into a persistent, committed directory. Hashed names also mean the
JS/CSS bundle gets real long-term browser caching.

`robots.txt`, `sitemap.xml`, and `404.html` live in `public/`, where Vite
copies anything it contains straight into the build output unchanged.

Preview the actual production build (not just the dev server) with:

```bash
npm run preview
```

## Why this stack

Earlier version of this README described a single self-contained
`index.html` with zero build step and zero external requests. That's gone
now, on request, in favor of real Framer Motion animation and a proper
component structure. Worth knowing what that traded away:

- **No-JS visitors and simple crawlers now see an empty page.** The old
  static file was readable content on arrival, no JavaScript required. This
  is now a client-rendered React app -- content only appears after the JS
  bundle downloads and runs. The `<head>` meta tags (title, description,
  Open Graph, Twitter Card) are still static in `index.html` and unaffected,
  so link previews and search snippets still work; it's the page body that
  now depends on JS.
- **A JS bundle ships instead of zero.** ~290KB uncompressed / ~92KB gzipped
  (React + Framer Motion + this page's own code) has to download and run
  before anything renders, versus the old file's instant, dependency-free
  paint.
- **Fonts moved from inlined base64 to real files** (`public/fonts/*.woff2`,
  same 4 fonts as before) -- strictly better, not a trade-off: still
  same-origin, zero external requests, but now cacheable independently by
  the browser and fingerprinted by Vite, instead of re-downloaded as part of
  the page's own markup on every visit.

If a Lighthouse audit ever gets run against this (see
`docs/references/10k-website-guide.md`), the JS-dependent-render trade-off
above is exactly the kind of thing it would flag.

## 21st.dev

The setup guide this rebuild followed (`docs/references/10k-website-guide.md`)
calls for pulling components from [21st.dev](https://21st.dev). That domain
is blocked by this environment's network egress policy, so nothing was
literally copied from it. Every component here is original, hand-built on
the same underlying stack 21st.dev itself uses (Tailwind + Framer Motion),
carrying Rekono's actual copy and design tokens rather than a generic
template's.

## Logo & favicons

The brand mark (`src/components/Logomark.jsx`, and the standalone
`public/favicon.svg` used for the favicon/app icons) is an "R" traced
directly from Fraunces' own outline at the optical size and weight the
"Rekono" wordmark next to it is already set in (opsz 120, wght 600), not a
generic geometric letterform or icon-font glyph. It's shipped as a static SVG
`<path>`, not live `<text>`, because a favicon or home-screen icon has no
guarantee the page's own `@font-face` has loaded, or ever will.

To regenerate it (e.g. if the wordmark's weight or typeface ever changes),
trace the glyph out of the actual font file with `fontTools`:

```python
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen

font = TTFont("public/fonts/fraunces.woff2")
# Match the wordmark: opsz 120, wght 600. Fraunces' own default instance is
# opsz 9 / wght 900, so leaving either out gives a much heavier letter drawn
# for caption sizes.
instantiateVariableFont(font, {"wght": 600, "opsz": 120}, inplace=True)
glyph_set = font.getGlyphSet()
glyph = glyph_set[font.getBestCmap()[ord("R")]]
pen = SVGPathPen(glyph_set)
glyph.draw(pen)
# pen.getCommands() is the raw path -- center it in a 32x32 box (flip Y,
# scale, translate) the same way Logomark.jsx's `transform` does.
```

`favicon-32.png`, `favicon-16.png`, `apple-touch-icon.png` (180x180,
full-bleed, no rounded corners -- iOS applies its own squircle mask, so a
pre-rounded icon there double-rounds and gets an awkward transparent
margin), and `icon-192.png`/`icon-512.png` (referenced by `manifest.json`)
are all rendered from that same SVG via a headless browser screenshot, not
hand-exported -- regenerate them the same way if the mark ever changes.
`og-image.png` (the social-preview card) is a standalone 1200x630 HTML page
rendered the same way, setting the headline in Fraunces on the same warm
paper. One headless-Chromium quirk to know when regenerating it: shooting
at a window height exactly equal to the page height clips the last painted
line, so render taller and crop.

## Analytics (optional, off until configured)

`src/lib/analytics.js` wires up Google Analytics 4 -- genuinely free with no
usage cap or trial period, unlike Plausible's hosted option, which matters
since no analytics account exists for this project yet and self-hosting an
open-source alternative would mean standing up a server this static site
doesn't have. It's a no-op until `VITE_GA_MEASUREMENT_ID` is set (Vercel
project settings -> Environment Variables, from a GA4 property's Admin ->
Data Streams): create the property, drop the Measurement ID in, redeploy.
GA4 sets cookies -- check your jurisdiction's cookie-consent requirements
before turning it on.

Once configured it tracks more than pageviews: every "Get started"/"Sign
in"/demo link fires a `cta_click` event (`src/lib/analytics.js`'s
`trackEvent`, called from each CTA's `onClick` -- see Nav.jsx, Hero.jsx,
Pricing.jsx, FinalCTA.jsx, MobileStickyCTA.jsx) with a `cta` param naming
where it was clicked, and a successful contact-form submission
(ContactModal.jsx) fires GA4's recommended `generate_lead` event -- the one
signal here that's an actual conversion, not just a click. `transport_type:
"beacon"` on the initial config call keeps CTA-click events from being
dropped by the browser cancelling the request mid-flight when the click
also navigates the tab away, which is what every one of these CTAs does.

To add a different provider (Plausible, etc.) instead: replace the
contents of `analytics.js`'s `initAnalytics`/`trackEvent` -- every call site
already goes through those two functions, so nothing else needs to change.
