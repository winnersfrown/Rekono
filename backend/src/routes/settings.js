// Org-level settings that vary by plan: the review-queue confidence
// threshold, risk-based auto-approval, and statistical sampling of
// auto-approved invoices, all Business/Scale-only (see plans.js's
// customConfidenceThreshold/riskBasedAutoApproval) -- a real place to hang
// future per-org settings without inventing a new route file each time.

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
  // Same "always allowed to reset, only gated going non-default" shape as
  // confidence_threshold above.
  auto_approval_enabled: z.boolean().optional(),
  auto_approval_max_amount: z.number().min(0).nullable().optional(),
  // Same shape again, one more time -- see sample_review_enabled's gating
  // below. Rate is a fraction (0.05 = 5%), not a percentage.
  sample_review_enabled: z.boolean().optional(),
  sample_review_rate: z.number().min(0).max(1).nullable().optional(),
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
    auto_approval_enabled: Boolean(org.autoApprovalEnabled),
    auto_approval_max_amount: org.autoApprovalMaxAmount,
    risk_based_auto_approval_available: Boolean(plan?.riskBasedAutoApproval),
    sample_review_enabled: Boolean(org.sampleReviewEnabled),
    sample_review_rate: org.sampleReviewRate,
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

    if (parsed.data.auto_approval_max_amount !== undefined) {
      if (parsed.data.auto_approval_max_amount !== null && !plan?.riskBasedAutoApproval) {
        return res.status(403).json({
          detail: `Risk-based auto-approval is available on the Business and Scale plans. Your current plan is ${plan?.name || org.plan}.`,
        });
      }
      org.autoApprovalMaxAmount = parsed.data.auto_approval_max_amount;
    }

    if (parsed.data.auto_approval_enabled !== undefined) {
      if (parsed.data.auto_approval_enabled && !plan?.riskBasedAutoApproval) {
        return res.status(403).json({
          detail: `Risk-based auto-approval is available on the Business and Scale plans. Your current plan is ${plan?.name || org.plan}.`,
        });
      }
      org.autoApprovalEnabled = parsed.data.auto_approval_enabled;
    }

    // Single consistency check covering both ways this invalid combination
    // could arise (enabling with no ceiling set yet, or clearing the ceiling
    // while still enabled) -- an org can never end up "enabled" with nothing
    // actually bounding what gets auto-approved.
    if (org.autoApprovalEnabled && org.autoApprovalMaxAmount == null) {
      return res.status(422).json({ detail: "Set a maximum dollar amount before enabling risk-based auto-approval." });
    }

    if (parsed.data.sample_review_rate !== undefined) {
      if (parsed.data.sample_review_rate !== null && !plan?.riskBasedAutoApproval) {
        return res.status(403).json({
          detail: `Statistical sampling is available on the Business and Scale plans. Your current plan is ${plan?.name || org.plan}.`,
        });
      }
      org.sampleReviewRate = parsed.data.sample_review_rate;
    }

    if (parsed.data.sample_review_enabled !== undefined) {
      if (parsed.data.sample_review_enabled && !plan?.riskBasedAutoApproval) {
        return res.status(403).json({
          detail: `Statistical sampling is available on the Business and Scale plans. Your current plan is ${plan?.name || org.plan}.`,
        });
      }
      org.sampleReviewEnabled = parsed.data.sample_review_enabled;
    }

    if (org.sampleReviewEnabled && org.sampleReviewRate == null) {
      return res.status(422).json({ detail: "Set a sample rate before enabling statistical sampling." });
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
