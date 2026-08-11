// Public "Talk to us" contact form from the marketing site. Unauthenticated
// on purpose -- visitors filling this out don't have an account yet.

import { Router } from "express";
import { Resend } from "resend";
import { z } from "zod";
import { settings } from "../config.js";

const router = Router();

const contactSchema = z.object({
  name: z.string().min(1).max(256),
  email: z.string().email(),
  message: z.string().min(1).max(5000),
  company: z.string().max(256).optional(), // honeypot -- real visitors never see/fill this field
});

// Minimal in-memory per-IP rate limit (5 submissions / 15 min). Good enough
// for a low-traffic contact form; resets on redeploy, which is fine here.
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const submissionsByIp = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (submissionsByIp.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  submissionsByIp.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

router.post("/api/contact", async (req, res, next) => {
  try {
    if (isRateLimited(req.ip)) {
      return res.status(429).json({ detail: "Too many messages sent recently. Please try again later." });
    }

    const parsed = contactSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({ detail: parsed.error.issues });
    }
    const { name, email, message, company } = parsed.data;

    // Honeypot tripped -> pretend success so bots don't learn to avoid it,
    // but don't actually send anything.
    if (company) {
      return res.status(202).json({ ok: true });
    }

    if (!settings.resendApiKey) {
      return res.status(503).json({
        detail: "The contact form isn't configured yet. Please email us directly instead.",
      });
    }

    const resend = new Resend(settings.resendApiKey);
    const { error } = await resend.emails.send({
      from: `Rekono contact form <${settings.contactFromEmail}>`,
      to: settings.contactToEmail,
      replyTo: email,
      subject: `Rekono contact form: ${name}`,
      text: `From: ${name} <${email}>\n\n${message}`,
    });

    if (error) {
      console.error("Resend send failed:", error);
      return res.status(502).json({ detail: "Couldn't send your message right now. Please email us directly instead." });
    }

    res.status(202).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
