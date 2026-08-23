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

Shared design tokens (colors, shadows, the glass-morphism recipe) live as
CSS custom properties in `src/index.css` and are re-exposed to Tailwind's
utility classes via `tailwind.config.js` -- e.g. `bg-ink-950`,
`text-blue-bright`. Same token names and values as the app's own design
system (`backend/public/styles.css`), kept in sync by hand so the marketing
site and the product read as one considered design.

## Build & deploy

```bash
cd website
npm run build
```

GitHub Pages serves this repo from the root of `main` with **no build step
and no GitHub Actions workflow** -- and changing that (to a proper CI-builds
pipeline) isn't something scriptable from inside a coding session; it's a
repository setting only an owner can flip in GitHub's UI. Rather than block
on that, `vite.config.js` is set up to build straight into the repo root
(`base: '/Rekono/'`, `outDir: '../'`, `emptyOutDir: false`): running the
build command above regenerates `/index.html`, `/assets/*.js`, `/assets/*.css`,
`/fonts/*.woff2`, and `/og-image.png` at the repo root -- the same static
files GitHub Pages already serves today. `robots.txt`, `sitemap.xml`, and
`404.html` are untouched by the build (`emptyOutDir: false` means it only
ever writes the specific files it generates, never clears the directory
first), so they stay hand-maintained at the root exactly as before.

**The workflow for any content or design change is therefore:** edit files
under `website/src/`, run `npm run build`, then commit both the source
changes and the regenerated root output together in the same commit. A
build whose root output isn't committed never reaches the live site --
there's no server-side build step to catch up on push.

Preview the actual production build (not just the dev server) with:

```bash
npm run preview
```

This serves the already-built root files under `/Rekono/`, matching what
`https://winnersfrown.github.io/Rekono/` will actually serve.

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

## Analytics (optional)

Off by default, same as before -- no analytics account exists for this
project. To add one: [Plausible](https://plausible.io) (privacy-respecting,
no cookie banner needed) or Google Analytics (GA4, which does set cookies --
check your jurisdiction's cookie-consent requirements first) both work the
same way any other site adds them -- drop the vendor's script tag into
`index.html`'s `<head>`, or load it from `src/main.jsx` before the app
renders if it needs to run before first paint.
