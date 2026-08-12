// One-time step after signup: collects the personalization questions and
// the org's plan choice together, since asking twice (once for
// personalization, again for plan) would just be two round trips for what
// the frontend already presents as a single wizard.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { settings } from "../config.js";
import { PAID_PLAN_IDS, TRIAL_DAYS, isValidPlanId } from "../plans.js";
import { createCheckoutSession } from "./billing.js";

const router = Router();

const onboardingSchema = z.object({
  role: z.string().min(1).max(128),
  company_size: z.string().min(1).max(64),
  primary_use_case: z.string().min(1).max(256),
  monthly_invoice_volume: z.string().min(1).max(64),
  plan: z.string().min(1),
  billing_period: z.enum(["monthly", "annual"]).optional(),
});

router.post("/api/onboarding", requireAuth, async (req, res, next) => {
  try {
    const parsed = onboardingSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const { role, company_size, primary_use_case, monthly_invoice_volume, plan, billing_period } = parsed.data;

    if (!isValidPlanId(plan)) {
      return res.status(422).json({ detail: "Not a recognized plan." });
    }

    const org = req.currentUser.organization;
    org.role = role;
    org.companySize = company_size;
    org.primaryUseCase = primary_use_case;
    org.monthlyInvoiceVolume = monthly_invoice_volume;

    if (plan === "free") {
      org.plan = "free";
      org.onboardingCompletedAt = new Date();
      await org.save();
      return res.json({ checkout_required: false, onboarding_completed: true });
    }

    if (!PAID_PLAN_IDS.includes(plan)) {
      return res.status(422).json({ detail: "Not a valid paid plan." });
    }
    if (!billing_period) {
      return res.status(422).json({ detail: "billing_period is required for a paid plan." });
    }
    if (!settings.stripeSecretKey) {
      // Save the personalization answers even though checkout can't
      // proceed -- no reason to lose them, and they'll still be there once
      // billing is configured and the user retries.
      await org.save();
      return res
        .status(503)
        .json({ detail: "Billing isn't configured yet. Please contact us to upgrade, or choose the Free plan for now." });
    }

    await org.save();
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const session = await createCheckoutSession({
      org,
      email: req.currentUser.email,
      planId: plan,
      billingPeriod: billing_period,
      baseUrl,
      // A brand new org's first paid plan choice gets a trial before Stripe
      // charges the card entered at checkout -- see createCheckoutSession
      // for why this isn't also applied to a later plan change/upgrade.
      trialDays: TRIAL_DAYS,
    });
    res.json({ checkout_required: true, checkout_url: session.url });
  } catch (err) {
    next(err);
  }
});

export default router;
