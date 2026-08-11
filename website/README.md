# Rekono marketing site

A single self-contained landing page (`index.html`) for Rekono — no build step, no external requests (fonts are embedded as base64). Covers How It Works, Features, Pricing, and FAQ.

Preview it locally with any static file server, e.g.:

```bash
python3 -m http.server -d website 8080
```

then open http://localhost:8080.

## Live on GitHub Pages

The repo root also has a copy of this file (`/index.html`) purely so GitHub Pages — which serves from the repo root — can publish it at https://winnersfrown.github.io/Rekono/. `website/index.html` is the source of truth; keep the root copy in sync when editing.
