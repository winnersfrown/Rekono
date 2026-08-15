import crypto from "node:crypto";
import { Router } from "express";
import { Resend } from "resend";
import { z } from "zod";
import * as auth from "../auth.js";
import { settings } from "../config.js";
import { Organization, User, AuditLog } from "../models/index.js";
import { serializeUser } from "../serializers.js";
import { PLANS } from "../plans.js";
import { documentsUsedThisMonth } from "../documentUsage.js";
import { createRateLimiter } from "../rateLimit.js";

const router = Router();

const signupSchema = z.object({
  org_name: z.string().min(1).max(256),
  full_name: z.string().min(1).max(256),
  email: z.string().email(),
  password: z.string().min(8).max(256),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(256),
});

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// Separate limiter per endpoint so exhausting one (e.g. retrying a typo'd
// login password) never locks out an unrelated one for the same IP. Login
// gets a slightly higher ceiling than the others -- a shared office/NAT IP
// with several legitimate people mistyping passwords is a lot more common
// than that many people all legitimately hitting forgot-password or signup
// in the same window.
const isSignupRateLimited = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
const isLoginRateLimited = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
const isForgotRateLimited = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5 });
const isResetRateLimited = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5 });

router.post("/api/auth/signup", async (req, res, next) => {
  try {
    if (isSignupRateLimited(req.ip)) {
      return res.status(429).json({ detail: "Too many signup attempts. Please try again later." });
    }
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({ detail: parsed.error.issues });
    }
    const { org_name, full_name, email, password } = parsed.data;
    const normalizedEmail = email.toLowerCase();

    const existing = await User.findOne({ where: { email: normalizedEmail } });
    if (existing) {
      return res.status(409).json({ detail: "An account with that email already exists" });
    }

    const org = await Organization.create({ name: org_name });
    const user = await User.create({
      orgId: org.id,
      email: normalizedEmail,
      hashedPassword: await auth.hashPassword(password),
      fullName: full_name,
    });

    await AuditLog.create({
      orgId: org.id,
      userId: user.id,
      action: "account_created",
      actor: user.email,
      details: { org_name: org.name },
    });

    res.status(201).json({ access_token: auth.createAccessToken(user.id), token_type: "bearer" });
  } catch (err) {
    next(err);
  }
});

router.post("/api/auth/login", async (req, res, next) => {
  try {
    if (isLoginRateLimited(req.ip)) {
      return res.status(429).json({ detail: "Too many login attempts. Please try again later." });
    }
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({ detail: parsed.error.issues });
    }
    const { email, password } = parsed.data;

    const user = await User.findOne({ where: { email: email.toLowerCase() } });
    if (!user || !(await auth.verifyPassword(password, user.hashedPassword))) {
      return res.status(401).json({ detail: "Incorrect email or password" });
    }

    res.json({ access_token: auth.createAccessToken(user.id), token_type: "bearer" });
  } catch (err) {
    next(err);
  }
});

// Always responds with the same generic message regardless of whether the
// email belongs to an account -- that's what stops this endpoint from being
// usable to enumerate registered emails. It has to hold even when
// RESEND_API_KEY isn't configured: returning a different status/message in
// that case would itself leak "this email exists but we couldn't email it",
// so a missing key just skips the send silently (logged server-side) rather
// than changing the response.
router.post("/api/auth/forgot-password", async (req, res, next) => {
  try {
    if (isForgotRateLimited(req.ip)) {
      return res.status(429).json({ detail: "Too many requests. Please try again later." });
    }
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({ detail: parsed.error.issues });
    }

    const user = await User.findOne({ where: { email: parsed.data.email.toLowerCase() } });
    if (user && settings.resendApiKey) {
      const token = crypto.randomBytes(32).toString("hex");
      user.passwordResetTokenHash = crypto.createHash("sha256").update(token).digest("hex");
      user.passwordResetExpiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
      await user.save();

      const resetUrl = `${req.protocol}://${req.get("host")}/?reset_token=${token}`;
      const resend = new Resend(settings.resendApiKey);
      const { error } = await resend.emails.send({
        from: `Rekono <${settings.contactFromEmail}>`,
        to: user.email,
        subject: "Reset your Rekono password",
        text:
          `We got a request to reset the password for your Rekono account.\n\n` +
          `Reset it here (this link expires in 1 hour):\n${resetUrl}\n\n` +
          `If you didn't request this, you can safely ignore this email -- your password won't change.`,
      });
      if (error) console.error("Resend send failed (forgot-password):", error);
    } else if (user) {
      console.warn("Password reset requested but RESEND_API_KEY isn't configured -- no email sent.");
    }

    res.status(202).json({ ok: true, detail: "If an account exists for that email, we've sent password reset instructions." });
  } catch (err) {
    next(err);
  }
});

router.post("/api/auth/reset-password", async (req, res, next) => {
  try {
    if (isResetRateLimited(req.ip)) {
      return res.status(429).json({ detail: "Too many requests. Please try again later." });
    }
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({ detail: parsed.error.issues });
    }
    const { token, password } = parsed.data;
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({ where: { passwordResetTokenHash: tokenHash } });
    if (!user || !user.passwordResetExpiresAt || user.passwordResetExpiresAt < new Date()) {
      return res.status(400).json({ detail: "This reset link is invalid or has expired. Request a new one." });
    }

    user.hashedPassword = await auth.hashPassword(password);
    user.passwordResetTokenHash = null;
    user.passwordResetExpiresAt = null;
    await user.save();

    await AuditLog.create({
      orgId: user.orgId,
      userId: user.id,
      action: "password_reset",
      actor: user.email,
      details: {},
    });

    res.json({ access_token: auth.createAccessToken(user.id), token_type: "bearer" });
  } catch (err) {
    next(err);
  }
});

// ---- Sign in with Google ----
// Standard server-side OAuth2 authorization-code flow: /google redirects to
// Google's consent screen, Google redirects back to /google/callback with a
// code, we exchange it server-side for an access token and call Google's
// userinfo endpoint with it (simpler than verifying an ID token's JWT
// signature ourselves, and just as trustworthy -- the access token itself
// only exists because Google already authenticated the user).
//
// No account-linking table: a Google login is matched to an existing User
// purely by verified email, and creates a new Organization + User (same
// shape as a normal signup) if there's no match yet. That keeps this
// feature's schema footprint at zero -- no new columns on User or
// Organization, so no migration risk at all, which matters given how many
// of this app's past incidents have come from schema-alter edge cases.
//
// The callback never puts the real bearer token in a URL (server logs,
// browser history, and any Referer header would all see it) -- it redirects
// with a short-lived, single-use handoff code instead, which the frontend
// immediately exchanges for the real token via /google/exchange.
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const GOOGLE_STATE_COOKIE = "google_oauth_state";
const GOOGLE_HANDOFF_TTL_MS = 60 * 1000;

const pendingGoogleLogins = new Map(); // handoff code -> { userId, expiresAt }

// Given a userinfo profile from Google, finds or creates the matching User
// (same shape as a normal signup) and returns it -- or an error reason if
// the email isn't verified. Pulled out of the route handler so it's testable
// against the real (test) database without needing to mock Google's actual
// OAuth endpoints, mirroring how billing.js's cancelReplacedSubscription/
// createCheckoutSession are unit-tested independently of a real Stripe call.
export async function completeGoogleLogin(profile) {
  if (!profile.email || !profile.email_verified) {
    return { error: "email_unverified" };
  }
  const normalizedEmail = profile.email.toLowerCase();

  let user = await User.findOne({ where: { email: normalizedEmail } });
  if (!user) {
    const fullName = profile.name || normalizedEmail.split("@")[0];
    const org = await Organization.create({ name: `${fullName}'s Organization` });
    // Never given to the user or usable to log in with a password -- Google
    // is (so far) the only way into this account. hashedPassword stays
    // NOT NULL with zero schema changes because of it.
    user = await User.create({
      orgId: org.id,
      email: normalizedEmail,
      hashedPassword: await auth.hashPassword(crypto.randomBytes(32).toString("hex")),
      fullName,
    });
    await AuditLog.create({
      orgId: org.id,
      userId: user.id,
      action: "account_created",
      actor: user.email,
      details: { org_name: org.name, via: "google" },
    });
  }
  return { user };
}

// Sweeps expired entries opportunistically (called on every new handoff
// code) rather than running a background timer -- this map only ever holds
// a few unredeemed codes at once, each single-use and expiring in a minute.
export function createGoogleHandoffCode(userId) {
  const now = Date.now();
  for (const [code, entry] of pendingGoogleLogins) {
    if (entry.expiresAt < now) pendingGoogleLogins.delete(code);
  }
  const code = crypto.randomBytes(24).toString("hex");
  pendingGoogleLogins.set(code, { userId, expiresAt: now + GOOGLE_HANDOFF_TTL_MS });
  return code;
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  const match = header
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function googleRedirectUri(req) {
  return `${req.protocol}://${req.get("host")}/api/auth/google/callback`;
}

router.get("/api/auth/google", (req, res) => {
  if (!settings.googleClientId) {
    return res.redirect("/?google_auth=error&reason=not_configured");
  }

  const state = crypto.randomBytes(16).toString("hex");
  res.cookie(GOOGLE_STATE_COOKIE, state, {
    httpOnly: true,
    maxAge: 10 * 60 * 1000,
    sameSite: "lax",
    secure: req.protocol === "https",
    path: "/",
  });

  const params = new URLSearchParams({
    client_id: settings.googleClientId,
    redirect_uri: googleRedirectUri(req),
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  res.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
});

router.get("/api/auth/google/callback", async (req, res, next) => {
  try {
    const cookieState = readCookie(req, GOOGLE_STATE_COOKIE);
    res.clearCookie(GOOGLE_STATE_COOKIE, { path: "/" });

    if (!settings.googleClientId || !settings.googleClientSecret) {
      return res.redirect("/?google_auth=error&reason=not_configured");
    }
    if (req.query.error) {
      // e.g. the user clicked "Cancel" on Google's consent screen.
      return res.redirect("/?google_auth=error&reason=denied");
    }
    if (
      typeof req.query.code !== "string" ||
      typeof req.query.state !== "string" ||
      !cookieState ||
      req.query.state !== cookieState
    ) {
      return res.redirect("/?google_auth=error&reason=state_mismatch");
    }

    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: settings.googleClientId,
        client_secret: settings.googleClientSecret,
        code: req.query.code,
        redirect_uri: googleRedirectUri(req),
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) {
      console.error("Google token exchange failed:", await tokenRes.text());
      return res.redirect("/?google_auth=error&reason=oauth_failed");
    }
    const { access_token: googleAccessToken } = await tokenRes.json();

    const userinfoRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${googleAccessToken}` },
    });
    if (!userinfoRes.ok) {
      console.error("Google userinfo fetch failed:", await userinfoRes.text());
      return res.redirect("/?google_auth=error&reason=oauth_failed");
    }
    const profile = await userinfoRes.json();

    const result = await completeGoogleLogin(profile);
    if (result.error) {
      return res.redirect(`/?google_auth=error&reason=${result.error}`);
    }

    const handoffCode = createGoogleHandoffCode(result.user.id);
    res.redirect(`/?google_auth=success&code=${handoffCode}`);
  } catch (err) {
    next(err);
  }
});

router.get("/api/auth/google/exchange", (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const entry = code ? pendingGoogleLogins.get(code) : null;
  if (code) pendingGoogleLogins.delete(code); // single-use regardless of outcome

  if (!entry || entry.expiresAt < Date.now()) {
    return res.status(400).json({ detail: "This sign-in link has expired. Please try again." });
  }
  res.json({ access_token: auth.createAccessToken(entry.userId), token_type: "bearer" });
});

router.get("/api/auth/me", auth.requireAuth, async (req, res, next) => {
  try {
    const org = req.currentUser.organization;
    const plan = PLANS[org.plan];
    res.json({
      ...serializeUser(req.currentUser),
      plan: org.plan,
      billing_period: org.billingPeriod,
      subscription_status: org.subscriptionStatus,
      trial_ends_at: org.trialEndsAt,
      onboarding_completed: Boolean(org.plan),
      // Same cap ingestion.js enforces at upload time (documentUsage.js is
      // the one shared definition of "this month" both agree on) -- null
      // before onboarding, since there's no plan/cap to measure against yet.
      documents_used_this_month: plan ? await documentsUsedThisMonth(org.id) : null,
      document_cap: plan ? plan.docCapPerMonth : null,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
