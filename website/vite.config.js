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
    rollupOptions: {
      output: {
        // Fixed names, not Vite's default content hash in the filename
        // (index-Cx7fK2.js, a new one every build). With emptyOutDir:false
        // a hashed build can only ever *add* files -- there is no cleanup
        // step to remove the previous build's now-unreferenced
        // index-<oldhash>.js, so every rebuild would silently accumulate
        // one more orphaned bundle in assets/ forever. Fixed filenames make
        // each build overwrite the same two files in place instead, which
        // trades away hash-based long-term cache-busting for a build that's
        // self-cleaning by construction -- the right trade here, since
        // index.html itself is committed fresh on every deploy anyway and
        // already forces a re-fetch of whatever it references.
        entryFileNames: "assets/index.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/index[extname]",
      },
    },
  },
});
