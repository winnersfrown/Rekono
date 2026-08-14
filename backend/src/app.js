import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import authRoutes from "./routes/auth.js";
import onboardingRoutes from "./routes/onboarding.js";
import billingRoutes, { webhookRouter as billingWebhookRoutes } from "./routes/billing.js";
import ingestionRoutes from "./routes/ingestion.js";
import invoicesRoutes from "./routes/invoices.js";
import matchingRoutes from "./routes/matching.js";
import exportRoutes from "./routes/export.js";
import contactRoutes from "./routes/contact.js";
import assistantRoutes from "./routes/assistant.js";
import settingsRoutes from "./routes/settings.js";
import teamRoutes from "./routes/team.js";

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

// Stripe's webhook signature check needs the exact raw request bytes.
// Scoped to this one path (not app.use(middleware, router), which would
// apply express.raw() to every request reaching this point in the stack,
// not just the webhook's -- the same unscoped-middleware footgun that once
// gated the whole homepage behind auth in this codebase) so express.json()
// below still parses every other route's body normally. body-parser
// middleware skips re-parsing once an earlier one has already claimed the
// body, so running raw() first here and json() globally right after is
// safe: for this one path raw() claims it and json() no-ops, and for every
// other path raw() never even runs.
app.use("/api/billing/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

app.use(authRoutes);
app.use(onboardingRoutes);
app.use(billingRoutes);
app.use(billingWebhookRoutes);
app.use(ingestionRoutes);
app.use(invoicesRoutes);
app.use(matchingRoutes);
app.use(exportRoutes);
app.use(contactRoutes);
app.use(assistantRoutes);
app.use(settingsRoutes);
app.use(teamRoutes);

const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

// Multer errors (e.g. malformed multipart body) and any route's next(err)
// land here instead of Express's default HTML error page.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ detail: err.message || "Internal server error" });
});
