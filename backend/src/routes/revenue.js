// Revenue recognition: running a month's release out of deferred revenue,
// and the reports that show what's still waiting. revenueRecognition.js
// owns the accounting; this is the HTTP surface.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { LedgerError, centsToDollars } from "../ledger.js";
import {
  computeDeferredRevenueWaterfall,
  pendingThrough,
  recognizeThrough,
  scheduleForInvoice,
} from "../revenueRecognition.js";
import { AuditLog, CustomerInvoice, RevenueScheduleEntry } from "../models/index.js";

const router = Router();

const PERIOD_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function currentPeriodMonth() {
  return new Date().toISOString().slice(0, 7);
}

// What a recognition run for this period would post, without posting it.
// Worth having as its own endpoint rather than only inside the run: this
// is a journal entry against a period someone may already have reported
// on, so seeing the number first is the difference between a review and a
// surprise.
router.get("/api/revenue/pending", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const periodMonth = PERIOD_MONTH.test(req.query.period_month || "") ? req.query.period_month : currentPeriodMonth();
    const rows = await pendingThrough(req.currentUser.orgId, periodMonth);

    const byMonth = new Map();
    for (const r of rows) byMonth.set(r.periodMonth, (byMonth.get(r.periodMonth) || 0) + r.amountCents);

    res.json({
      period_month: periodMonth,
      // Periods before the requested one are included: a month nobody ran
      // shouldn't stay stranded in deferred revenue, so a later run catches
      // it up. Listing them separately makes that visible rather than
      // surprising.
      periods: [...byMonth]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([period_month, cents]) => ({ period_month, amount: centsToDollars(cents) })),
      total: centsToDollars(rows.reduce((s, r) => s + r.amountCents, 0)),
      entry_count: rows.length,
    });
  } catch (err) {
    next(err);
  }
});

const recognizeSchema = z.object({ period_month: z.string().regex(PERIOD_MONTH).optional() });

router.post("/api/revenue/recognize", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = recognizeSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const periodMonth = parsed.data.period_month || currentPeriodMonth();

    const result = await recognizeThrough(req.currentUser.orgId, periodMonth, {
      postedByUserId: req.currentUser.id,
    });

    if (result.entries.length) {
      await AuditLog.create({
        orgId: req.currentUser.orgId,
        userId: req.currentUser.id,
        action: "revenue_recognized",
        actor: req.currentUser.email,
        details: { through: periodMonth, periods: result.periods, amount: centsToDollars(result.totalCents) },
      });
    }

    res.json({
      through: periodMonth,
      recognized: centsToDollars(result.totalCents),
      periods: result.entries,
    });
  } catch (err) {
    // A closed period is the expected refusal here: recognition posts a
    // real journal entry dated into the month it recognizes, so a month
    // that's been closed rejects it like any other backdated posting.
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

// The deferred revenue waterfall -- how much is sitting in the liability
// and which months release it. The report a subscription business gets
// asked for by anyone doing diligence on it.
router.get("/api/reports/deferred-revenue", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 60);
    res.json(await computeDeferredRevenueWaterfall(req.currentUser.orgId, { months }));
  } catch (err) {
    next(err);
  }
});

router.get("/api/customer-invoices/:id/revenue-schedule", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const schedule = await scheduleForInvoice(req.currentUser.orgId, req.params.id);
    if (!schedule) return res.status(404).json({ detail: "Invoice not found" });
    res.json(schedule);
  } catch (err) {
    next(err);
  }
});

// Every scheduled month across the org, recognized and pending, newest
// period first -- the flat view for reconciling the deferred revenue
// balance against what produced it.
router.get("/api/revenue/schedule", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const where = { orgId };
    if (PERIOD_MONTH.test(req.query.period_month || "")) where.periodMonth = req.query.period_month;
    if (req.query.recognized === "false") where.recognizedAt = null;

    const rows = await RevenueScheduleEntry.findAll({
      where,
      order: [
        ["periodMonth", "ASC"],
        ["id", "ASC"],
      ],
      limit: 1000,
    });

    const invoices = await CustomerInvoice.findAll({ where: { orgId }, attributes: ["id", "invoiceNumber"] });
    const numberById = new Map(invoices.map((i) => [i.id, i.invoiceNumber]));

    res.json({
      items: rows.map((r) => ({
        id: r.id,
        invoice_id: r.customerInvoiceId,
        invoice_number: numberById.get(r.customerInvoiceId) || "",
        period_month: r.periodMonth,
        amount: centsToDollars(r.amountCents),
        recognized: Boolean(r.recognizedAt),
      })),
      total: centsToDollars(rows.reduce((s, r) => s + r.amountCents, 0)),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
