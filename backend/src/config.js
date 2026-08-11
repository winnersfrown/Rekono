import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

const storageDir = process.env.STORAGE_DIR || "./storage";
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

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",

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
  contactToEmail: process.env.CONTACT_TO_EMAIL || "aiden.lai@yahoo.com",
  contactFromEmail: process.env.CONTACT_FROM_EMAIL || "onboarding@resend.dev",
};
