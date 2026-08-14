// Org-level settings that vary by plan. Currently just the review-queue
// confidence threshold (Business/Scale-only, see plans.js's
// customConfidenceThreshold) -- a real place to hang future per-org
// settings without inventing a new route file each time.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { PLANS } from "../plans.js";
import { settings } from "../config.js";

const router = Router();

const settingsSchema = z.object({
  // null resets to the server-wide default -- always allowed, even on a
  // plan without the feature, so downgrading never leaves someone stuck
  // with a value they can no longer clear.
  confidence_threshold: z.number().min(0).max(1).nullable(),
});

router.get("/api/org/settings", requireAuth, requireActivePlan, (req, res) => {
  const org = req.currentUser.organization;
  const plan = PLANS[org.plan];
  res.json({
    confidence_threshold: org.confidenceThreshold,
    effective_confidence_threshold: plan?.customConfidenceThreshold && org.confidenceThreshold !== null
      ? org.confidenceThreshold
      : settings.reviewConfidenceThreshold,
    custom_confidence_threshold_available: Boolean(plan?.customConfidenceThreshold),
    default_confidence_threshold: settings.reviewConfidenceThreshold,
  });
});

router.patch("/api/org/settings", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    const org = req.currentUser.organization;
    const plan = PLANS[org.plan];
    if (parsed.data.confidence_threshold !== null && !plan?.customConfidenceThreshold) {
      return res.status(403).json({
        detail: `Custom confidence thresholds are available on the Business and Scale plans. Your current plan is ${plan?.name || org.plan}.`,
      });
    }

    org.confidenceThreshold = parsed.data.confidence_threshold;
    await org.save();

    res.json({
      confidence_threshold: org.confidenceThreshold,
      effective_confidence_threshold: plan?.customConfidenceThreshold && org.confidenceThreshold !== null
        ? org.confidenceThreshold
        : settings.reviewConfidenceThreshold,
      custom_confidence_threshold_available: Boolean(plan?.customConfidenceThreshold),
      default_confidence_threshold: settings.reviewConfidenceThreshold,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
