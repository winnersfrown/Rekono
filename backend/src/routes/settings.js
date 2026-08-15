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
import { AuditLog } from "../models/index.js";

const router = Router();

const settingsSchema = z.object({
  // null resets to the server-wide default -- always allowed, even on a
  // plan without the feature, so downgrading never leaves someone stuck
  // with a value they can no longer clear. Optional (rather than required
  // like it used to be) so a PATCH can touch just org_name without also
  // having to resend the confidence threshold, and vice versa.
  confidence_threshold: z.number().min(0).max(1).nullable().optional(),
  org_name: z.string().min(1).max(256).optional(),
});

function settingsResponse(org) {
  const plan = PLANS[org.plan];
  return {
    confidence_threshold: org.confidenceThreshold,
    effective_confidence_threshold: plan?.customConfidenceThreshold && org.confidenceThreshold !== null
      ? org.confidenceThreshold
      : settings.reviewConfidenceThreshold,
    custom_confidence_threshold_available: Boolean(plan?.customConfidenceThreshold),
    default_confidence_threshold: settings.reviewConfidenceThreshold,
    org_name: org.name,
  };
}

router.get("/api/org/settings", requireAuth, requireActivePlan, (req, res) => {
  res.json(settingsResponse(req.currentUser.organization));
});

router.patch("/api/org/settings", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    const org = req.currentUser.organization;
    const plan = PLANS[org.plan];

    if (parsed.data.confidence_threshold !== undefined) {
      if (parsed.data.confidence_threshold !== null && !plan?.customConfidenceThreshold) {
        return res.status(403).json({
          detail: `Custom confidence thresholds are available on the Business and Scale plans. Your current plan is ${plan?.name || org.plan}.`,
        });
      }
      org.confidenceThreshold = parsed.data.confidence_threshold;
    }

    if (parsed.data.org_name !== undefined) {
      // Org identity, not a per-user preference -- same "owner only" bar
      // team.js holds invites/removals to.
      if (req.currentUser.role !== "owner") {
        return res.status(403).json({ detail: "Only the account owner can rename the organization." });
      }
      org.name = parsed.data.org_name;
      await AuditLog.create({
        orgId: org.id,
        userId: req.currentUser.id,
        action: "org_renamed",
        actor: req.currentUser.email,
        details: { org_name: org.name },
      });
    }

    await org.save();

    res.json(settingsResponse(org));
  } catch (err) {
    next(err);
  }
});

export default router;
