// Stripe Checkout for paid plans, plus the webhook that keeps subscription
// status in sync afterward. Two routers are exported on purpose: the
// webhook needs Stripe's raw request bytes for signature verification, so
// app.js mounts webhookRouter with express.raw() *before* the app-wide
// express.json() runs, and everything else (which does want parsed JSON)
// through the default export mounted normally alongside the other routers.

import { Router } from "express";
import Stripe from "stripe";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { settings } from "../config.js";
import { PAID_PLAN_IDS, PLANS, priceUsd } from "../plans.js";
import { Organization } from "../models/index.js";

const router = Router();
const webhookRouter = Router();

function getStripe() {
  return new Stripe(settings.stripeSecretKey);
}

function requireStripeConfigured(req, res, next) {
  if (!settings.stripeSecretKey) {
    return res.status(503).json({ detail: "Billing isn't configured yet. Please contact us to upgrade." });
  }
  next();
}

// Shared by /api/onboarding (a brand new org's first plan choice) and
// /api/billing/checkout (changing plans later) -- both need an identical
// Checkout Session. Built from plans.js's price_data inline rather than
// Stripe dashboard-configured Price objects, so standing this up only ever
// needs a Stripe account + API keys, never a matching manual product/price
// setup step to keep in sync with plans.js by hand.
export async function createCheckoutSession({ org, email, planId, billingPeriod, baseUrl }) {
  const stripe = getStripe();
  const plan = PLANS[planId];
  const amountCents = Math.round(priceUsd(planId, billingPeriod) * 100);
  const periodLabel = billingPeriod === "annual" ? "annual" : "monthly";

  return stripe.checkout.sessions.create({
    mode: "subscription",
    customer_email: email,
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: `Rekono ${plan.name} (${periodLabel})` },
          unit_amount: amountCents,
          recurring: { interval: billingPeriod === "annual" ? "year" : "month" },
        },
        quantity: 1,
      },
    ],
    success_url: `${baseUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/?checkout=cancelled`,
    // Read back on the success redirect (/api/billing/confirm) and by the
    // webhook -- this is how we know which org and which plan a given
    // Checkout Session was for, since Stripe has no idea about either.
    metadata: { org_id: org.id, plan: planId, billing_period: billingPeriod },
  });
}

const checkoutSchema = z.object({
  plan: z.enum(PAID_PLAN_IDS),
  billing_period: z.enum(["monthly", "annual"]),
});

// For changing plans after onboarding (not used by onboarding itself --
// see routes/onboarding.js, which saves personalization answers alongside
// the very first plan choice via its own call to createCheckoutSession).
// Validates the request body before checking Stripe is configured (not the
// other way around, via middleware) so a malformed request always gets 422
// regardless of billing configuration -- same order assistant.js already
// established for its own "is the external service configured" check.
router.post("/api/billing/checkout", requireAuth, async (req, res, next) => {
  try {
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    if (!settings.stripeSecretKey) {
      return res.status(503).json({ detail: "Billing isn't configured yet. Please contact us to upgrade." });
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const session = await createCheckoutSession({
      org: req.currentUser.organization,
      email: req.currentUser.email,
      planId: parsed.data.plan,
      billingPeriod: parsed.data.billing_period,
      baseUrl,
    });
    res.json({ checkout_url: session.url });
  } catch (err) {
    next(err);
  }
});

// Called by the frontend immediately after Stripe redirects back to
// success_url -- more reliable than waiting on the webhook alone, since
// webhook delivery isn't guaranteed to land before the user's browser does.
// The webhook (below) still handles this same activation as a fallback, and
// is the only path for later lifecycle events (renewals, cancellations).
router.get("/api/billing/confirm", requireAuth, requireStripeConfigured, async (req, res, next) => {
  try {
    const sessionId = req.query.session_id;
    if (!sessionId || typeof sessionId !== "string") {
      return res.status(422).json({ detail: "Missing session_id." });
    }

    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["subscription"] });

    // A signed-in user could hand-craft this URL with someone else's real
    // session_id -- without this check they could activate billing status
    // onto their own org using a stranger's completed payment.
    if (session.metadata?.org_id !== req.currentUser.orgId) {
      return res.status(403).json({ detail: "This checkout session doesn't belong to your organization." });
    }
    if (session.status !== "complete") {
      return res.status(402).json({ detail: "Payment hasn't completed yet." });
    }

    const org = req.currentUser.organization;
    org.plan = session.metadata.plan;
    org.billingPeriod = session.metadata.billing_period;
    org.stripeCustomerId = typeof session.customer === "string" ? session.customer : session.customer?.id || org.stripeCustomerId;
    org.stripeSubscriptionId =
      typeof session.subscription === "string" ? session.subscription : session.subscription?.id || org.stripeSubscriptionId;
    org.subscriptionStatus = session.subscription?.status || "active";
    org.onboardingCompletedAt = org.onboardingCompletedAt || new Date();
    await org.save();

    res.json({ ok: true, plan: org.plan, billing_period: org.billingPeriod });
  } catch (err) {
    next(err);
  }
});

// Stripe's hosted subscription-management UI -- avoids needing to build a
// custom "change plan / update card / view invoices / cancel" screen.
router.get("/api/billing/portal", requireAuth, requireStripeConfigured, async (req, res, next) => {
  try {
    const org = req.currentUser.organization;
    if (!org.stripeCustomerId) {
      return res.status(400).json({ detail: "No billing account found for your organization yet." });
    }
    const stripe = getStripe();
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: org.stripeCustomerId,
      return_url: `${baseUrl}/`,
    });
    res.json({ url: portalSession.url });
  } catch (err) {
    next(err);
  }
});

webhookRouter.post("/api/billing/webhook", async (req, res) => {
  if (!settings.stripeSecretKey || !settings.stripeWebhookSecret) {
    // Stripe is the only caller here -- there's no user to show an error
    // to. 503 tells Stripe's own retry logic to try again later instead of
    // recording this as a permanent delivery failure.
    return res.status(503).end();
  }

  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, req.headers["stripe-signature"], settings.stripeWebhookSecret);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const org = session.metadata?.org_id ? await Organization.findByPk(session.metadata.org_id) : null;
      if (org) {
        org.plan = session.metadata.plan;
        org.billingPeriod = session.metadata.billing_period;
        org.stripeCustomerId = typeof session.customer === "string" ? session.customer : session.customer?.id || org.stripeCustomerId;
        org.stripeSubscriptionId =
          typeof session.subscription === "string" ? session.subscription : session.subscription?.id || org.stripeSubscriptionId;
        org.subscriptionStatus = "active";
        org.onboardingCompletedAt = org.onboardingCompletedAt || new Date();
        await org.save();
      }
    } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const org = await Organization.findOne({ where: { stripeSubscriptionId: subscription.id } });
      if (org) {
        org.subscriptionStatus = event.type === "customer.subscription.deleted" ? "canceled" : subscription.status;
        await org.save();
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error("Stripe webhook handler error:", err);
    res.status(500).json({ detail: "Webhook handler error" });
  }
});

export { webhookRouter };
export default router;
