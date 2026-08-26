import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

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
  },
});
