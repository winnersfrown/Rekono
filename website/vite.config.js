import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves this repo from the root of `main` with no build step
// and no Actions workflow -- and there's no tool access in this session to
// change that repository setting. So rather than adopting the "build in CI,
// deploy the artifact" pattern a fresh Vite project would normally reach
// for, this instead builds straight into the repo root: `npm run build`
// here produces the same kind of static files (index.html + assets/) Pages
// already serves, committed like any other change. Zero settings to flip,
// same deploy mechanism as before.
export default defineConfig({
  plugins: [react()],
  // The site is published at https://winnersfrown.github.io/Rekono/ (a
  // project page, not a custom domain -- there's no CNAME file) -- so every
  // asset URL needs the /Rekono/ prefix or it 404s once deployed.
  base: "/Rekono/",
  build: {
    // One level up from this project (website/) is the repo root, where
    // GitHub Pages actually looks.
    outDir: "../",
    // Never let Vite clear the output directory first -- that directory is
    // the repo root. Emptying it would delete backend/, docs/, .git/,
    // everything. Vite only ever *writes* the specific files it generates
    // (index.html, assets/*), so leaving existing files alone is both safe
    // and exactly what's wanted: robots.txt, sitemap.xml, and 404.html stay
    // untouched because the build never touches them in the first place.
    emptyOutDir: false,
  },
});
