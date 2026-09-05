import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// __dirname isn't defined in native ESM (this package is "type": "module"),
// so it's derived from import.meta.url the standard way instead.
const __dirname = dirname(fileURLToPath(import.meta.url));

// Deployed on Vercel now, which builds this in CI and serves the output
// itself -- unlike the old GitHub Pages setup, there's no need to build
// straight into the repo root or commit the result. Vercel's dashboard
// points at this directory as the project root and runs `npm run build`.
export default defineConfig({
  plugins: [react()],
  // Vercel serves from its own domain's root, not a /Rekono/ subpath --
  // that prefix was only needed for GitHub Pages' project-page URL shape.
  build: {
    outDir: "dist",
    // A multi-page build, not a router: vs-rillet.html is its own static
    // page with its own React root (VsRilletApp.jsx), the same way
    // index.html is -- adding client-side routing for one extra page
    // would be a bigger change than the page itself. Vite's default
    // single-entry `rollupOptions.input` has to be restated explicitly
    // once a second entry is added, or index.html itself drops out of
    // the build.
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        vsRillet: resolve(__dirname, "vs-rillet.html"),
      },
    },
  },
});
