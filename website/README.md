# Rekono marketing site

A single self-contained landing page (`index.html`) for Rekono — no build step, no external requests by default (fonts are embedded as base64). Covers How It Works, Features, Pricing, and FAQ.

## Analytics (optional)

Off by default -- there's no analytics account for this project, so nothing to wire up out of the box. Near the end of `index.html` there's a commented-out, ready-to-uncomment `<script>` tag for [Plausible](https://plausible.io) (privacy-respecting, no cookie banner needed): sign up (or self-host it), add the site's real domain there, uncomment the line, and fill in that same domain. Any similar tool (Fathom, Simple Analytics, self-hosted Umami/PostHog) is a one-tag swap for it -- nothing else in the file needs to change. Remember to make the same edit to both `website/index.html` and the root `index.html` mirror.

Preview it locally with any static file server, e.g.:

```bash
python3 -m http.server -d website 8080
```

then open http://localhost:8080.

## Live on GitHub Pages

The repo root also has a copy of this file (`/index.html`) purely so GitHub Pages — which serves from the repo root — can publish it at https://winnersfrown.github.io/Rekono/. `website/index.html` is the source of truth; keep the root copy in sync when editing.

The repo root also has `/robots.txt` and `/sitemap.xml` for the same reason (GitHub Pages needs them at the root to serve them at `/robots.txt` and `/sitemap.xml`) — these aren't mirrored into `website/` since they're only meaningful at the live site's root.
