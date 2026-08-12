import crypto from "node:crypto";
import { Router } from "express";
import { Resend } from "resend";
import { z } from "zod";
import * as auth from "../auth.js";
import { settings } from "../config.js";
import { Organization, User, AuditLog } from "../models/index.js";
import { serializeUser } from "../serializers.js";

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

// Minimal in-memory per-IP rate limit, same pattern as the contact form.
// Two separate maps -- one per endpoint -- so exhausting the limit on
// forgot-password (e.g. someone retrying a typo'd email) doesn't also lock
// out reset-password for the same IP, and vice versa.
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const forgotRequestsByIp = new Map();
const resetRequestsByIp = new Map();

function isRateLimited(store, ip) {
  const now = Date.now();
  const timestamps = (store.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  store.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

router.post("/api/auth/signup", async (req, res, next) => {
  try {
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
    if (isRateLimited(forgotRequestsByIp, req.ip)) {
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
    if (isRateLimited(resetRequestsByIp, req.ip)) {
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

router.get("/api/auth/me", auth.requireAuth, (req, res) => {
  const org = req.currentUser.organization;
  res.json({
    ...serializeUser(req.currentUser),
    plan: org.plan,
    billing_period: org.billingPeriod,
    subscription_status: org.subscriptionStatus,
    onboarding_completed: Boolean(org.plan),
  });
});

export default router;
