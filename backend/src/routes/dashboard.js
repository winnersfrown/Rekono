// One aggregated read for the dashboard's landing view (the "Ask Rekono"
// tab). Deliberately a single endpoint rather than the frontend firing a
// dozen parallel list requests and counting client-side: every number here
// is a COUNT/SUM the database can answer directly, and the previous
// approach would have meant shipping whole invoice lists over the wire just
// to call `.length` on them.
//
// Every figure is derived from this org's real rows -- there are no
// placeholder or illustrative numbers anywhere in this file. An org with no
// documents yet gets honest zeroes, which the frontend renders as an empty
// state rather than a wall of "$0.00".

import { Router } from "express";
import { Op } from "sequelize";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { PLANS } from "../plans.js";
import { documentsUsedThisMonth, startOfCurrentMonthUtc } from "../documentUsage.js";
import { AuditLog, ExpenseReceipt, Invoice, Lease, MatchResult, TaxDocument, VendorDocument } from "../models/index.js";

const router = Router();

// Windows the "needs attention" rollups use. Vendor documents get a tighter
// one than leases on purpose: a lapsed certificate of insurance is an
// immediate compliance problem, while a lease renewal decision is a slower
// conversation that needs lead time to act on (see Lease.js's comment on
// renewalNoticeDeadline).
const VENDOR_DOC_EXPIRY_WINDOW_DAYS = 30;
const LEASE_DEADLINE_WINDOW_DAYS = 60;
const VOLUME_TREND_DAYS = 14;

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function daysFromNow(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// Documents created per day over the trailing two weeks, bucketed in JS
// rather than with a GROUP BY. A date-truncating GROUP BY is written
// differently on SQLite (`date(...)`) than on Postgres (`date_trunc`), and
// this app runs on both (SQLite for tests/local, Postgres in production) --
// bucketing here keeps one code path that behaves identically on each. Only
// the createdAt column is selected, and only for a 14-day window, so this
// stays a narrow read even for a high-volume org.
async function volumeTrend(orgId) {
  const since = daysFromNow(-(VOLUME_TREND_DAYS - 1));
  since.setUTCHours(0, 0, 0, 0);
  const where = { orgId, createdAt: { [Op.gte]: since } };
  const attributes = ["createdAt"];

  const [invoices, receipts, vendorDocs, leases, taxDocs] = await Promise.all([
    Invoice.findAll({ where, attributes, raw: true }),
    ExpenseReceipt.findAll({ where, attributes, raw: true }),
    VendorDocument.findAll({ where, attributes, raw: true }),
    Lease.findAll({ where, attributes, raw: true }),
    TaxDocument.findAll({ where, attributes, raw: true }),
  ]);

  const buckets = new Map();
  for (let i = 0; i < VOLUME_TREND_DAYS; i++) {
    buckets.set(isoDate(daysFromNow(-(VOLUME_TREND_DAYS - 1 - i))), 0);
  }
  for (const row of [...invoices, ...receipts, ...vendorDocs, ...leases, ...taxDocs]) {
    const key = isoDate(new Date(row.createdAt));
    if (buckets.has(key)) buckets.set(key, buckets.get(key) + 1);
  }

  return [...buckets].map(([date, count]) => ({ date, count }));
}

// Approved invoices that no matching run has tied to a PO or bank-statement
// line yet -- the reconciliation gap, and the whole reason the Matching tab
// exists. Pulled as a set of ids rather than a NOT EXISTS subquery for the
// same cross-dialect reason as volumeTrend above, and narrowed to just the
// invoiceId column.
async function unmatchedApprovedCount(orgId) {
  const approved = await Invoice.findAll({
    where: { orgId, status: "approved" },
    attributes: ["id"],
    raw: true,
  });
  if (!approved.length) return 0;

  const matched = await MatchResult.findAll({
    where: { invoiceId: approved.map((i) => i.id), status: "matched" },
    attributes: ["invoiceId"],
    raw: true,
  });
  const matchedIds = new Set(matched.map((m) => m.invoiceId));
  return approved.filter((i) => !matchedIds.has(i.id)).length;
}

// Share of this month's approvals that never needed a human to click
// Approve -- the metric that actually says whether the product is saving
// anyone time. Counted from audit entries rather than invoice columns
// because "was this auto-approved" is an event that happened at a point in
// time (pipeline.js writes an `auto_approved` entry), not a state a later
// edit could overwrite.
async function touchlessRate(orgId, since) {
  const where = { orgId, createdAt: { [Op.gte]: since } };
  const [autoApproved, allApprovals] = await Promise.all([
    AuditLog.count({ where: { ...where, action: "auto_approved" } }),
    AuditLog.count({ where: { ...where, action: { [Op.in]: ["approved", "auto_approved"] } } }),
  ]);
  return { auto_approved: autoApproved, total_approvals: allApprovals, rate: allApprovals ? autoApproved / allApprovals : null };
}

router.get("/api/dashboard", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const org = req.currentUser.organization;
    const monthStart = startOfCurrentMonthUtc();
    const today = isoDate(new Date());

    const needsReviewWhere = { orgId, status: "needs_review" };
    const failedWhere = { orgId, status: "failed" };
    // "In flight" is queued + processing: uploaded, not finished extracting.
    // Worth its own number so a dashboard that looks empty right after a
    // bulk upload explains itself instead of looking broken.
    const inFlightWhere = { orgId, status: { [Op.in]: ["queued", "processing"] } };

    const [
      invoicesNeedingReview,
      expensesNeedingReview,
      vendorDocsNeedingReview,
      leasesNeedingReview,
      taxDocsNeedingReview,
      failedCount,
      inFlightCount,
      outstandingAp,
      outstandingApCount,
      overdueCount,
      approvedThisMonthValue,
      qaPending,
      expiringVendorDocs,
      leaseDeadlines,
      taxDocsMissingTin,
      documentsUsed,
      avgConfidence,
      unmatched,
      trend,
      touchless,
    ] = await Promise.all([
      Invoice.count({ where: needsReviewWhere }),
      ExpenseReceipt.count({ where: needsReviewWhere }),
      VendorDocument.count({ where: needsReviewWhere }),
      Lease.count({ where: needsReviewWhere }),
      TaxDocument.count({ where: needsReviewWhere }),

      Promise.all([
        Invoice.count({ where: failedWhere }),
        ExpenseReceipt.count({ where: failedWhere }),
        VendorDocument.count({ where: failedWhere }),
        Lease.count({ where: failedWhere }),
        TaxDocument.count({ where: failedWhere }),
      ]).then((counts) => counts.reduce((a, b) => a + b, 0)),

      Promise.all([
        Invoice.count({ where: inFlightWhere }),
        ExpenseReceipt.count({ where: inFlightWhere }),
        VendorDocument.count({ where: inFlightWhere }),
        Lease.count({ where: inFlightWhere }),
        TaxDocument.count({ where: inFlightWhere }),
      ]).then((counts) => counts.reduce((a, b) => a + b, 0)),

      // Approved but not yet recorded as paid -- money the org still owes.
      // quickbooksPaidAt is only ever set once a human confirms the payment
      // (see routes/integrations.js), so a null here genuinely means unpaid
      // rather than just "not synced".
      Invoice.sum("total", { where: { orgId, status: "approved", quickbooksPaidAt: null } }),
      Invoice.count({ where: { orgId, status: "approved", quickbooksPaidAt: null } }),
      Invoice.count({
        where: { orgId, status: "approved", quickbooksPaidAt: null, dueDate: { [Op.ne]: null, [Op.lt]: today } },
      }),

      Invoice.sum("total", { where: { orgId, status: "approved", updatedAt: { [Op.gte]: monthStart } } }),

      Invoice.count({ where: { orgId, sampledForQa: true, qaReviewedAt: null } }),

      VendorDocument.count({
        where: {
          orgId,
          status: { [Op.ne]: "rejected" },
          expirationDate: { [Op.ne]: null, [Op.lte]: isoDate(daysFromNow(VENDOR_DOC_EXPIRY_WINDOW_DAYS)) },
        },
      }),
      Lease.count({
        where: {
          orgId,
          status: { [Op.ne]: "rejected" },
          [Op.or]: [
            { expirationDate: { [Op.ne]: null, [Op.lte]: isoDate(daysFromNow(LEASE_DEADLINE_WINDOW_DAYS)) } },
            { renewalNoticeDeadline: { [Op.ne]: null, [Op.lte]: isoDate(daysFromNow(LEASE_DEADLINE_WINDOW_DAYS)) } },
          ],
        },
      }),
      // A form still in review might simply not have been read yet, and a
      // rejected one isn't going to be filed -- neither is a compliance
      // problem, so neither belongs in a count that's asking "what will
      // bite us at filing time".
      TaxDocument.count({
        where: {
          orgId,
          status: { [Op.in]: ["extracted", "approved"] },
          recipientTinLast4: "",
        },
      }),

      documentsUsedThisMonth(orgId),

      // Only over documents that actually finished extracting -- averaging
      // in a queued row's default 0 would drag the number down for a reason
      // that has nothing to do with extraction quality.
      Invoice.aggregate("overallConfidence", "avg", {
        where: { orgId, status: { [Op.notIn]: ["queued", "processing", "failed"] } },
      }),

      unmatchedApprovedCount(orgId),
      volumeTrend(orgId),
      touchlessRate(orgId, monthStart),
    ]);

    const plan = PLANS[org.plan];
    const reviewQueue =
      invoicesNeedingReview + expensesNeedingReview + vendorDocsNeedingReview + leasesNeedingReview + taxDocsNeedingReview;

    res.json({
      org_name: org.name,
      // Sequelize's SUM returns null (not 0) when nothing matches, and its
      // AVG returns null on an empty set -- normalized here so the frontend
      // never has to special-case one shape for "no data" and another for
      // "genuinely zero".
      kpis: {
        outstanding_ap: outstandingAp || 0,
        outstanding_ap_count: outstandingApCount,
        overdue_count: overdueCount,
        approved_this_month_value: approvedThisMonthValue || 0,
        review_queue: reviewQueue,
        in_flight: inFlightCount,
        failed: failedCount,
        avg_confidence: avgConfidence === null || avgConfidence === undefined ? null : Number(avgConfidence),
        documents_used_this_month: documentsUsed,
        document_cap: plan ? plan.docCapPerMonth : null,
        touchless: touchless,
      },
      // Each entry maps to a tab the user can act on, which is the whole
      // point of the panel -- a count with nowhere to go is just decoration.
      workflow: [
        { key: "invoices", label: "Invoices to review", count: invoicesNeedingReview, tab: "review" },
        { key: "expenses", label: "Expenses to review", count: expensesNeedingReview, tab: "expenses" },
        { key: "vendordocs", label: "Vendor docs to review", count: vendorDocsNeedingReview, tab: "vendordocs" },
        { key: "leases", label: "Leases to review", count: leasesNeedingReview, tab: "leases" },
        { key: "taxdocs", label: "Tax docs to review", count: taxDocsNeedingReview, tab: "taxdocs" },
        { key: "unmatched", label: "Approved, not yet matched", count: unmatched, tab: "matching" },
        { key: "qa", label: "Spot-checks pending", count: qaPending, tab: "settings" },
      ],
      // Deadline- and failure-driven items, kept separate from `workflow`
      // above: those are steady-state queue depth, these are things that get
      // worse if ignored. Severity drives the frontend's color treatment.
      attention: [
        {
          key: "overdue",
          label: "Invoices past their due date",
          count: overdueCount,
          severity: "critical",
          tab: "review",
        },
        {
          key: "failed",
          label: "Extractions that failed",
          count: failedCount,
          severity: "critical",
          tab: "review",
        },
        {
          key: "vendor_docs_expiring",
          label: `Vendor docs expiring within ${VENDOR_DOC_EXPIRY_WINDOW_DAYS} days`,
          count: expiringVendorDocs,
          severity: "warning",
          tab: "vendordocs",
        },
        {
          key: "lease_deadlines",
          label: `Lease dates within ${LEASE_DEADLINE_WINDOW_DAYS} days`,
          count: leaseDeadlines,
          severity: "warning",
          tab: "leases",
        },
        {
          key: "tax_docs_missing_tin",
          label: "Tax forms missing a recipient TIN",
          count: taxDocsMissingTin,
          severity: "warning",
          tab: "taxdocs",
        },
      ],
      volume_trend: trend,
      integrations: {
        quickbooks: Boolean(org.quickbooksRealmId),
        // Surfaced so the dashboard can say "AI extraction active" vs
        // "running on the heuristic fallback" -- see extraction.js. It's
        // the difference between the confidence numbers above meaning a
        // model's self-report and meaning a regex's flat guess.
        ai_extraction: Boolean(process.env.GEMINI_API_KEY),
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
