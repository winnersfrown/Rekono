import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import authRoutes from "./routes/auth.js";
import ingestionRoutes from "./routes/ingestion.js";
import invoicesRoutes from "./routes/invoices.js";
import matchingRoutes from "./routes/matching.js";
import exportRoutes from "./routes/export.js";
import contactRoutes from "./routes/contact.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const app = express();

// Render/Fly terminate TLS and proxy requests, so without this req.ip
// would resolve to the proxy's own address for every request -- which
// would make the contact form's per-IP rate limit a global one instead.
app.set("trust proxy", 1);

// The marketing site (GitHub Pages) and the app (wherever it's deployed) are
// different origins, so the browser needs CORS to let the marketing site's
// login/signup calls reach this API.
app.use(cors());
app.use(express.json());

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

app.use(authRoutes);
app.use(ingestionRoutes);
app.use(invoicesRoutes);
app.use(matchingRoutes);
app.use(exportRoutes);
app.use(contactRoutes);

const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

// Multer errors (e.g. malformed multipart body) and any route's next(err)
// land here instead of Express's default HTML error page.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ detail: err.message || "Internal server error" });
});
