# Stitch exports

This folder is the landing spot for raw exports from [Google Stitch](https://stitch.withgoogle.com) when connecting it to this repo — point Stitch's GitHub export at this repo and this folder (or a dedicated branch, if you'd rather keep exports off `main` entirely).

Stitch generates standalone HTML/CSS (and sometimes React) for a screen at a time. It doesn't know anything about Rekono's actual app — its output is a starting point, not something to serve directly. The live app UI is the plain HTML/CSS/JS in `backend/public/`, served straight from Express with no build step (see `README.md`'s "Frontend" section).

## Workflow

1. Export a screen from Stitch into this folder (e.g. `design/stitch/invoice-review/`).
2. Treat it as a visual reference, not production code: pull over the layout/spacing/color decisions that are worth keeping, but rewire any markup, class names, or state handling to match `backend/public`'s existing conventions and wire it up to the real API instead of Stitch's placeholder data.
3. Once a screen's changes have been folded into `backend/public/`, delete its subfolder here — this directory is meant to stay a working scratch space, not a permanent second copy of the UI.
