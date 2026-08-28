import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { settings } from "./config.js";
import { rateLimitMiddleware } from "./rateLimit.js";
import { rlsRequestContext } from "./rls.js";
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
import taxDocumentsRoutes from "./routes/taxDocuments.js";
import matchingRoutes from "./routes/matching.js";
import closeRoutes from "./routes/close.js";
import transactionsRoutes from "./routes/transactions.js";
import exportRoutes from "./routes/export.js";
import contactRoutes from "./routes/contact.js";
import assistantRoutes from "./routes/assistant.js";
import settingsRoutes from "./routes/settings.js";
import teamRoutes from "./routes/team.js";
import staffRoutes from "./routes/staff.js";
import integrationsRoutes from "./routes/integrations.js";
import netWorthRoutes from "./routes/netWorth.js";
import accountsRoutes from "./routes/accounts.js";
import journalEntriesRoutes from "./routes/journalEntries.js";
import financialStatementsRoutes from "./routes/financialStatements.js";
import receivablesRoutes from "./routes/receivables.js";
import payablesRoutes from "./routes/payables.js";
import vendorsRoutes from "./routes/vendors.js";
import revenueRoutes from "./routes/revenue.js";
import adjustmentsRoutes from "./routes/adjustments.js";
import equityRoutes from "./routes/equity.js";
import shareRegisterRoutes from "./routes/shareRegister.js";
import equityAwardRoutes from "./routes/equityAwards.js";
import stockCompensationRoutes from "./routes/stockCompensation.js";

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
// Rejecting by passing an Error hands it to the generic error handler,
// which reports it as a 500 "Internal server error" -- a misleading status
// for a request that was understood perfectly and refused on policy, and
// one that makes a misconfigured ALLOWED_ORIGINS look like a server bug.
// Passing `false` instead just omits the CORS headers, so the browser
// blocks the response on its own (which is what actually enforces this),
// and the request still gets a truthful status from whatever handles it.
app.use(
  cors({
    origin(origin, callback) {
      callback(null, !origin || settings.allowedOrigins.includes(origin));
    },
  })
);

// A preflight for a disallowed origin gets no CORS headers from the
// middleware above and would otherwise fall through to the SPA's catch-all
// and return 200 with an HTML body. Answering it 403 is both truthful and
// far easier to diagnose than a silent browser-side block.
app.options(/.*/, (req, res) => {
  const origin = req.headers.origin;
  if (origin && !settings.allowedOrigins.includes(origin)) {
    return res.status(403).json({ detail: "Origin not allowed." });
  }
  res.sendStatus(204);
});

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

// Volumetric backstop across the whole API. Individual routes that need a
// tighter or better-keyed limit still set their own (login, signup,
// password reset, the assistant, the contact form); this one exists so that
// every *other* endpoint -- including any added later that forgets to think
// about it -- can't be hammered from a single source. Set well above what
// the review UI generates in normal use, so it only ever bites abuse.
// Mounted after /api/health so uptime checks are never rejected.
app.use(
  "/api",
  rateLimitMiddleware({
    windowMs: 15 * 60 * 1000,
    max: settings.rateLimitApiMax,
    message: "Too many requests. Please slow down and try again shortly.",
  })
);

// The three genuinely expensive categories, which cost real CPU and disk
// per call rather than a single indexed query: document uploads (OCR plus a
// model round-trip per file), spreadsheet exports (whole-table reads
// rendered into a workbook), and a matching run (fuzzy-compares every
// invoice against every candidate entry). Plan-level monthly document caps
// already bound uploads in business terms; this bounds the rate.
const EXPENSIVE_PATHS = [
  "/api/invoices/upload",
  "/api/expenses/upload",
  "/api/vendor-documents/upload",
  "/api/leases/upload",
  "/api/tax-documents/upload",
  "/api/matching/sources",
  "/api/matching/run",
  "/api/export",
];

app.use(
  EXPENSIVE_PATHS,
  rateLimitMiddleware({
    windowMs: 15 * 60 * 1000,
    max: settings.rateLimitExpensiveMax,
    message: "Too many uploads or exports in a short period. Please try again in a few minutes.",
  })
);

// Everything below runs inside a per-request transaction carrying the
// database-level tenant context (see rls.js). Mounted after /api/health so
// the health check stays a pure no-database ping, and before the routers so
// every one of them inherits it. Static assets below don't touch the
// database and so aren't wrapped.
app.use("/api", rlsRequestContext);

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
app.use(taxDocumentsRoutes);
app.use(matchingRoutes);
app.use(closeRoutes);
app.use(transactionsRoutes);
app.use(exportRoutes);
app.use(contactRoutes);
app.use(assistantRoutes);
app.use(settingsRoutes);
app.use(teamRoutes);
app.use(staffRoutes);
app.use(integrationsRoutes);
app.use(netWorthRoutes);
app.use(accountsRoutes);
app.use(journalEntriesRoutes);
app.use(financialStatementsRoutes);
app.use(receivablesRoutes);
app.use(payablesRoutes);
app.use(vendorsRoutes);
app.use(revenueRoutes);
app.use(adjustmentsRoutes);
app.use(equityRoutes);
app.use(shareRegisterRoutes);
app.use(equityAwardRoutes);
app.use(stockCompensationRoutes);

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
