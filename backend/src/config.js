import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

// Resolved to an absolute path: multer writes uploads under this directory
// and stores that path verbatim as each invoice's storagePath, and
// Express's res.sendFile() (used to serve the file back) requires an
// absolute path -- a relative STORAGE_DIR (the default) made every file
// request throw "path must be absolute or specify root to res.sendFile".
const storageDir = path.resolve(process.env.STORAGE_DIR || "./storage");
fs.mkdirSync(storageDir, { recursive: true });

function loadOrCreateSecretKey() {
  if (process.env.SECRET_KEY) return process.env.SECRET_KEY;
  const keyPath = path.join(path.dirname(path.resolve(storageDir)), ".rekono_secret_key");
  if (fs.existsSync(keyPath)) return fs.readFileSync(keyPath, "utf8").trim();
  const key = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(keyPath, key);
  return key;
}

export const settings = {
  databaseUrl: process.env.DATABASE_URL || `sqlite:${path.resolve("./rekono.db")}`,
  storageDir,

  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.6-flash",

  reviewConfidenceThreshold: Number(process.env.REVIEW_CONFIDENCE_THRESHOLD ?? 0.85),

  matchAmountTolerancePct: Number(process.env.MATCH_AMOUNT_TOLERANCE_PCT ?? 0.02),
  matchAmountToleranceAbs: Number(process.env.MATCH_AMOUNT_TOLERANCE_ABS ?? 5.0),
  matchDateWindowDays: Number(process.env.MATCH_DATE_WINDOW_DAYS ?? 5),
  matchVendorScoreThreshold: Number(process.env.MATCH_VENDOR_SCORE_THRESHOLD ?? 80),

  secretKey: loadOrCreateSecretKey(),
  accessTokenExpiresIn: "14d",

  // Contact form (marketing site "Talk to us"). Unset RESEND_API_KEY ->
  // POST /api/contact responds 503 rather than crashing, so the form can
  // ship before the account exists and fail loudly (not silently) until
  // it's configured.
  resendApiKey: process.env.RESEND_API_KEY || "",
  contactToEmail: process.env.CONTACT_TO_EMAIL || "wfrownusa@yahoo.com",
  contactFromEmail: process.env.CONTACT_FROM_EMAIL || "onboarding@resend.dev",

  // Billing (Stripe Checkout + webhooks for paid-plan onboarding). Unset
  // STRIPE_SECRET_KEY -> billing routes respond 503 rather than crashing,
  // same graceful-degradation pattern as Resend/Gemini above. Prices are
  // built inline at checkout time from plans.js (see routes/billing.js), so
  // no Stripe Product/Price objects need to be pre-created in the dashboard
  // -- only an account and its API/webhook keys.
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",

  // "Sign in with Google" (routes/auth.js). Unset GOOGLE_CLIENT_ID ->
  // GET /api/auth/google redirects straight back with an error instead of
  // crashing, same graceful-degradation pattern as Resend/Stripe above.
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",

  // QuickBooks Online integration (routes/integrations.js, quickbooks.js).
  // Unset QUICKBOOKS_CLIENT_ID -> those routes respond 503 instead of
  // crashing, same graceful-degradation pattern as Resend/Stripe/Google
  // above. Defaults to Intuit's Sandbox environment (no app-review needed)
  // -- set QUICKBOOKS_ENVIRONMENT=production only once the Intuit app has
  // passed production review.
  quickbooksClientId: process.env.QUICKBOOKS_CLIENT_ID || "",
  quickbooksClientSecret: process.env.QUICKBOOKS_CLIENT_SECRET || "",
  quickbooksEnvironment: process.env.QUICKBOOKS_ENVIRONMENT || "sandbox",

  // Origins allowed to make cross-origin browser requests (app.js's CORS
  // setup) -- the marketing site's own origin (its login/signup calls) and
  // the app's own deployed origin (the review UI's own fetch calls
  // include an Origin header on state-changing requests same as any other
  // origin's would). Comma-separated so a self-hosted deployment can add
  // its own origin without a code change. Deliberately NOT wide open
  // (`cors()` with no restriction): any website could otherwise make
  // authenticated fetch/XHR calls using a token if one ever leaked via XSS
  // elsewhere.
  allowedOrigins: (
    process.env.ALLOWED_ORIGINS || "https://winnersfrown.github.io,https://rekono-ai-new.onrender.com,http://localhost:8000"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),

  // Ceilings for the API-wide rate limits in app.js, per client IP per 15
  // minutes. Tunable because the right number depends on the deployment,
  // not on the code: an office where everyone shares one NAT address spends
  // this budget far faster than the same number of people on separate
  // connections, so a shared-egress deployment may need to raise them. The
  // narrower per-account limits in the route files (login, password change,
  // the assistant) are deliberately not tunable -- those are security
  // limits on specific abuse, not capacity limits.
  rateLimitApiMax: Number(process.env.RATE_LIMIT_API_MAX ?? 5000),
  rateLimitExpensiveMax: Number(process.env.RATE_LIMIT_EXPENSIVE_MAX ?? 300),
};
