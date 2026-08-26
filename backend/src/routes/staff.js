// Rekono's own cross-org usage dashboard -- not a customer-facing feature.
// Every other analytics view in this app (dashboard.js, team.js) answers a
// question for one org about itself; this is the one place that looks
// across all of them, which is why it's gated by requireStaff (auth.js)
// instead of requireAuth: that middleware deliberately never narrows the
// request to a single org, so the plain Sequelize queries below see every
// tenant by design, not by accident.
//
// Aggregate-only, on purpose. This never returns a single customer's
// document contents, vendor names, or dollar amounts tied to one invoice --
// only counts, sums, and distributions. A cross-org *usage* dashboard is a
// reasonable thing for a vendor's own team to have; a way to browse any
// customer's actual paperwork is a much bigger exposure than "how many orgs
// signed up this week" calls for, so that line is drawn here at the query
// level rather than left to whoever builds the frontend for this later.
//
// Demo orgs (Organization.isDemo) and seeded sample invoices
// (Invoice.isSampleData, excluded automatically by Invoice's defaultScope)
// are excluded throughout -- both exist purely to make an empty product
// look populated, and would otherwise inflate every count here with
// activity nobody actually did.

import { Router } from "express";
import { Op } from "sequelize";
import { requireStaff } from "../auth.js";
import { PLANS } from "../plans.js";
import {
  AuditLog,
  ExpenseReceipt,
  Invoice,
  Lease,
  Organization,
  TaxDocument,
  VendorDocument,
} from "../models/index.js";

const router = Router();

const TREND_WEEKS = 13; // ~90 days -- same window and reasoning as dashboard.js's weeklyTrends.
const RECENTLY_CANCELED_DAYS = 30;

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function daysFromNow(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

async function nonDemoOrgIds() {
  const orgs = await Organization.findAll({ where: { isDemo: false }, attributes: ["id"], raw: true });
  return orgs.map((o) => o.id);
}

// Buckets a set of rows with a createdAt into TREND_WEEKS weekly counts.
// Bucketed in JS rather than a GROUP BY for the same cross-dialect reason
// as dashboard.js's weeklyTrends -- this app runs on both SQLite and
// Postgres, and a date-truncating GROUP BY is written differently on each.
function bucketByWeek(rows, since) {
  const weeks = Array.from({ length: TREND_WEEKS }, (_, i) => ({
    week_start: isoDate(daysFromNow(-(TREND_WEEKS * 7 - 1) + i * 7)),
    count: 0,
  }));
  for (const row of rows) {
    const days = Math.floor((new Date(row.createdAt) - since) / 86400000);
    const idx = Math.min(TREND_WEEKS - 1, Math.max(0, Math.floor(days / 7)));
    weeks[idx].count += 1;
  }
  return weeks;
}

// Org counts and where they sit in the funnel, plus a plan breakdown --
// the first thing anyone asking "how is Rekono doing" wants to see.
async function orgSummary(orgIds) {
  const orgs = await Organization.findAll({ where: { id: orgIds }, raw: true });

  const planCounts = {};
  for (const org of orgs) {
    const key = org.plan || "no_plan_yet"; // hasn't finished onboarding
    planCounts[key] = (planCounts[key] || 0) + 1;
  }

  return {
    total_orgs: orgs.length,
    completed_onboarding: orgs.filter((o) => o.onboardingCompletedAt).length,
    plan_breakdown: planCounts,
  };
}

async function signupTrend(orgIds) {
  const since = daysFromNow(-(TREND_WEEKS * 7 - 1));
  since.setUTCHours(0, 0, 0, 0);
  const orgs = await Organization.findAll({
    where: { id: orgIds, createdAt: { [Op.gte]: since } },
    attributes: ["createdAt"],
    raw: true,
  });
  return bucketByWeek(orgs, since);
}

// Documents created per week across all 5 types, all non-demo orgs --
// same shape as dashboard.js's volumeTrend, but longer (13 weeks, since
// this is asking about product-wide trajectory rather than "what came in
// recently") and summed across every tenant instead of one.
async function documentVolumeTrend(orgIds) {
  const since = daysFromNow(-(TREND_WEEKS * 7 - 1));
  since.setUTCHours(0, 0, 0, 0);
  const where = { orgId: orgIds, createdAt: { [Op.gte]: since } };
  const attributes = ["createdAt"];

  const [invoices, receipts, vendorDocs, leases, taxDocs] = await Promise.all([
    Invoice.findAll({ where, attributes, raw: true }), // defaultScope excludes isSampleData rows
    ExpenseReceipt.findAll({ where, attributes, raw: true }),
    VendorDocument.findAll({ where, attributes, raw: true }),
    Lease.findAll({ where, attributes, raw: true }),
    TaxDocument.findAll({ where, attributes, raw: true }),
  ]);

  return bucketByWeek([...invoices, ...receipts, ...vendorDocs, ...leases, ...taxDocs], since);
}

// Which orgs have at least one row matching `where`, across all 5 document
// types -- the building block for the activation funnel below. Grouping by
// orgId (rather than DISTINCT in raw SQL) works identically on SQLite and
// Postgres, same cross-dialect concern as the rest of this file.
async function orgIdsWithAnyDocument(where) {
  const [invoices, receipts, vendorDocs, leases, taxDocs] = await Promise.all([
    Invoice.findAll({ where, attributes: ["orgId"], group: ["orgId"], raw: true }),
    ExpenseReceipt.findAll({ where, attributes: ["orgId"], group: ["orgId"], raw: true }),
    VendorDocument.findAll({ where, attributes: ["orgId"], group: ["orgId"], raw: true }),
    Lease.findAll({ where, attributes: ["orgId"], group: ["orgId"], raw: true }),
    TaxDocument.findAll({ where, attributes: ["orgId"], group: ["orgId"], raw: true }),
  ]);
  return new Set([...invoices, ...receipts, ...vendorDocs, ...leases, ...taxDocs].map((r) => r.orgId));
}

// signed_up -> completed_onboarding -> uploaded a real document ->
// approved a real document. Each stage is a subset of the one before it in
// spirit (you can't approve without uploading), but counted independently
// from the actual data rather than assumed, so a bug in one stage doesn't
// silently distort another.
async function activationFunnel(orgIds) {
  const orgs = await Organization.findAll({ where: { id: orgIds }, raw: true });
  const onboardedOrgIds = orgs.filter((o) => o.onboardingCompletedAt).map((o) => o.id);

  const [uploaded, approved] = await Promise.all([
    orgIdsWithAnyDocument({ orgId: orgIds }),
    orgIdsWithAnyDocument({ orgId: orgIds, status: "approved" }),
  ]);

  return {
    signed_up: orgs.length,
    completed_onboarding: onboardedOrgIds.length,
    uploaded_first_real_document: uploaded.size,
    approved_first_real_document: approved.size,
  };
}

// Active/trialing/recently-canceled counts -- the health of the paid base,
// as distinct from the funnel above (which is about activation, not
// retention). "Recently" canceled is its own bucket rather than lumped into
// a generic "canceled" total: a cancellation from a year ago says nothing
// about current health, but one from the last 30 days is a signal worth
// looking at.
async function subscriptionHealth(orgIds) {
  const orgs = await Organization.findAll({ where: { id: orgIds }, raw: true });
  const recentCutoff = daysFromNow(-RECENTLY_CANCELED_DAYS);

  let active = 0;
  let trialing = 0;
  let recentlyCanceled = 0;
  for (const org of orgs) {
    if (org.subscriptionStatus === "active") active += 1;
    else if (org.subscriptionStatus === "trialing") trialing += 1;
    else if (org.subscriptionStatus === "canceled" && org.updatedAt && new Date(org.updatedAt) >= recentCutoff) {
      recentlyCanceled += 1;
    }
  }
  return { active, trialing, recently_canceled: recentlyCanceled, window_days: RECENTLY_CANCELED_DAYS };
}

router.get("/api/staff/overview", requireStaff, async (req, res, next) => {
  try {
    const orgIds = await nonDemoOrgIds();

    const [summary, signups, volume, funnel, subscriptions] = await Promise.all([
      orgSummary(orgIds),
      signupTrend(orgIds),
      documentVolumeTrend(orgIds),
      activationFunnel(orgIds),
      subscriptionHealth(orgIds),
    ]);

    // No cross-org audit target exists for this (AuditLog rows all belong
    // to one org), so this is logged against the staff member's own org --
    // enough to answer "who looked at this and when" without inventing a
    // new table for a single event type.
    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      action: "staff_metrics_viewed",
      actor: req.currentUser.email,
      details: {},
    });

    res.json({
      org_summary: summary,
      signup_trend: signups,
      document_volume_trend: volume,
      activation_funnel: funnel,
      subscription_health: subscriptions,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
