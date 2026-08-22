import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { settings } from "./config.js";
import authRoutes from "./routes/auth.js";
import dashboardRoutes from "./routes/dashboard.js";
import demoRoutes from "./routes/demo.js";
import onboardingRoutes from "./routes/onboarding.js";
import billingRoutes, { webhookRouter as billingWebhookRoutes } from "./routes/billing.js";
import ingestionRoutes from "./routes/ingestion.js";
import invoicesRoutes from "./routes/invoices.js";
import expensesRoutes from "./routes/expenses.js";
import vendorDocumentsRoutes from "./routes/vendorDocuments.js";
import leasesRoutes from "./routes/leases.js";
import matchingRoutes from "./routes/matching.js";
import exportRoutes from "./routes/export.js";
import contactRoutes from "./routes/contact.js";
import assistantRoutes from "./routes/assistant.js";
import settingsRoutes from "./routes/settings.js";
import teamRoutes from "./routes/team.js";
import integrationsRoutes from "./routes/integrations.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const app = express();

// Don't advertise the framework to every caller -- free fingerprinting for
// anyone probing for known Express-specific issues, for zero benefit.
app.disable("x-powered-by");

// Render/Fly terminate TLS and proxy requests, so without this req.ip
// would resolve to the proxy's own address for every request -- which
// would make the contact form's per-IP rate limit a global one instead.
app.set("trust proxy", 1);

// The marketing site (GitHub Pages) and the app (wherever it's deployed) are
// different origins, so the browser needs CORS to let the marketing site's
// login/signup calls reach this API. Restricted to settings.allowedOrigins
// rather than wide open -- an open policy would let any website make
// authenticated fetch/XHR calls using a token if one ever leaked via XSS
// elsewhere. A request with no Origin header at all (server-to-server
// calls, curl, the test suite's supertest requests) isn't something CORS
// applies to in the first place -- only a browser sends that header, to
// enforce its own same-origin policy client-side -- so those are let
// through unconditionally rather than rejected.
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || settings.allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error("Not allowed by CORS"));
    },
  })
);

// The review UI's actual script/style/resource footprint (verified by
// grepping backend/public/ rather than guessed): no inline <script> blocks
// and no inline event-handler attributes anywhere, only <script src="/*.js">
// -- so script-src can be 'self' with no 'unsafe-inline'/nonce needed at
// all. Inline style="..." attributes are used throughout (no build step to
// generate nonces/hashes for them), so style-src alone needs 'unsafe-inline'
// -- a much smaller trade than script-src would be, since CSS injection
// alone can't run arbitrary JS. fonts.googleapis.com/fonts.gstatic.com serve
// the Google Fonts in index.html's <head>. blob: is required for img-src and
// frame-src: the document preview never points an <iframe>/<img> straight at
// GET /api/invoices/:id/file (that request needs the bearer token, which a
// src="..." attribute can't carry), so app.js fetches it with the token and
// hands the element a URL.createObjectURL(blob) blob: URL instead (see
// public/app.js's own comment above loadDocPreview).
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "frame-src 'self' blob:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

// Baseline browser-security headers on every response.
app.use((req, res, next) => {
  // Stops browsers from MIME-sniffing a response into a different type
  // than its declared Content-Type (e.g. treating an uploaded file as
  // HTML/JS instead of the type we set).
  res.set("X-Content-Type-Options", "nosniff");
  // The review UI is never meant to be embedded in another site's frame;
  // this blocks clickjacking attempts that try anyway. frame-ancestors
  // 'none' above is the modern CSP equivalent -- kept both since older
  // browsers only honor this one.
  res.set("X-Frame-Options", "DENY");
  // Avoids leaking full internal URLs (invoice IDs, etc.) to third-party
  // sites via the Referer header when a link is followed off-site.
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  // Only meaningful over HTTPS -- Render terminates TLS in front of this
  // app, so req.protocol reflects the original scheme via trust proxy.
  if (req.protocol === "https") {
    res.set("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
});

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
app.use(dashboardRoutes);
app.use(demoRoutes);
app.use(onboardingRoutes);
app.use(billingRoutes);
app.use(billingWebhookRoutes);
app.use(ingestionRoutes);
app.use(invoicesRoutes);
app.use(expensesRoutes);
app.use(vendorDocumentsRoutes);
app.use(leasesRoutes);
app.use(matchingRoutes);
app.use(exportRoutes);
app.use(contactRoutes);
app.use(assistantRoutes);
app.use(settingsRoutes);
app.use(teamRoutes);
app.use(integrationsRoutes);

const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

// Multer errors (e.g. malformed multipart body) and any route's next(err)
// land here instead of Express's default HTML error page. Every deliberate
// error response in this app (validation, auth, plan gating, etc.) is sent
// directly by its own route via res.status(...).json(...) -- nothing ever
// sets err.status before throwing -- so anything that reaches this handler
// is a genuinely unexpected failure (a DB error, a bug, a malformed
// request). Its raw message can contain internal detail that was never
// meant to leave the server (file paths, library internals, occasionally a
// fragment of a connection string), so it's logged in full here and never
// echoed back to the caller -- only a generic message is.
export function handleUnexpectedError(err, req, res, next) {
  console.error(err);
  res.status(err.status || 500).json({ detail: "Internal server error" });
}

app.use(handleUnexpectedError);
