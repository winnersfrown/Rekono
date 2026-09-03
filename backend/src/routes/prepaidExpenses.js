// Prepaid expenses: recording money paid up front for something consumed
// over time, and amortizing it month by month. prepaidExpenses.js owns the
// accounting; this is the HTTP surface, the AP mirror of routes/revenue.js.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { settings } from "../config.js";
import { rateLimitMiddleware } from "../rateLimit.js";
import { LedgerError, centsToDollars, dollarsToCents } from "../ledger.js";
import { isValidPaymentAccount } from "../accountsPayable.js";
import {
  amortizeThrough,
  amountRecognizedCents,
  computePrepaidExpenseWaterfall,
  createScheduleForPrepaidExpense,
  dropUnrecognizedSchedule,
  pendingThrough,
  postPrepaidExpense,
  scheduleForPrepaidExpense,
  voidPrepaidExpenseEntry,
} from "../prepaidExpenses.js";
import { Account, AuditLog, PrepaidExpense } from "../models/index.js";

const router = Router();

// Same rate limit routes/payables.js applies to its own write routes, in
// each handler's own middleware chain rather than relying only on the
// blanket per-org one app.js mounts ahead of every router.
const writeRateLimit = rateLimitMiddleware({
  windowMs: 15 * 60 * 1000,
  max: settings.rateLimitExpensiveMax,
  message: "Too many requests. Please slow down and try again shortly.",
});

const PERIOD_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function currentPeriodMonth() {
  return new Date().toISOString().slice(0, 7);
}

function serializePrepaidExpense(p, { unamortizedCents } = {}) {
  return {
    id: p.id,
    vendor_name: p.vendorName,
    memo: p.memo,
    expense_account_id: p.expenseAccountId,
    expense_account_name: p.expenseAccount?.name,
    payment_account_id: p.paymentAccountId,
    payment_account_name: p.paymentAccount?.name,
    payment_date: p.paymentDate,
    service_start_date: p.serviceStartDate,
    service_end_date: p.serviceEndDate,
    total: centsToDollars(p.totalCents),
    status: p.status,
    ...(unamortizedCents !== undefined ? { unamortized: centsToDollars(unamortizedCents) } : {}),
  };
}

async function getOwnedPrepaidExpense(id, orgId) {
  return PrepaidExpense.findOne({
    where: { id, orgId },
    include: [
      { model: Account, as: "expenseAccount", attributes: ["id", "name"] },
      { model: Account, as: "paymentAccount", attributes: ["id", "name"] },
    ],
  });
}

router.get("/api/prepaid-expenses", requireAuth, requireActivePlan, writeRateLimit, async (req, res, next) => {
  try {
    const where = { orgId: req.currentUser.orgId };
    if (req.query.status) where.status = req.query.status;

    const items = await PrepaidExpense.findAll({
      where,
      include: [
        { model: Account, as: "expenseAccount", attributes: ["id", "name"] },
        { model: Account, as: "paymentAccount", attributes: ["id", "name"] },
      ],
      order: [["paymentDate", "DESC"], ["createdAt", "DESC"]],
    });

    const serialized = await Promise.all(
      items.map(async (p) => {
        const recognized = await amountRecognizedCents(p.id);
        return serializePrepaidExpense(p, { unamortizedCents: p.status === "void" ? 0 : p.totalCents - recognized });
      })
    );
    res.json({ items: serialized });
  } catch (err) {
    next(err);
  }
});

const prepaidExpenseSchema = z.object({
  vendor_name: z.string().min(1).max(512),
  memo: z.string().max(512).optional(),
  expense_account_id: z.string().min(1),
  payment_account_id: z.string().min(1),
  payment_date: z.string().regex(ISO_DATE),
  amount: z.number().positive(),
  service_start_date: z.string().regex(ISO_DATE),
  service_end_date: z.string().regex(ISO_DATE),
});

// Posts immediately -- see PrepaidExpense.js for why this is recorded
// directly rather than through the bill-approval pipeline.
router.post("/api/prepaid-expenses", requireAuth, requireActivePlan, writeRateLimit, async (req, res, next) => {
  try {
    const parsed = prepaidExpenseSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;
    const data = parsed.data;

    if (data.service_end_date < data.service_start_date) {
      return res.status(422).json({ detail: "The service period can't end before it starts." });
    }

    const expenseAccount = await Account.findOne({ where: { id: data.expense_account_id, orgId, type: "expense" } });
    if (!expenseAccount) {
      return res.status(422).json({ detail: "This must amortize into an expense account in your chart of accounts." });
    }
    const paymentAccount = await Account.findOne({ where: { id: data.payment_account_id, orgId } });
    if (!isValidPaymentAccount(paymentAccount)) {
      return res.status(422).json({
        detail: "Payment account must be an asset or liability account you own, and not Accounts Payable itself.",
      });
    }

    const prepaid = await PrepaidExpense.create({
      orgId,
      vendorName: data.vendor_name,
      memo: data.memo || "",
      expenseAccountId: expenseAccount.id,
      paymentAccountId: paymentAccount.id,
      paymentDate: data.payment_date,
      totalCents: dollarsToCents(data.amount),
      serviceStartDate: data.service_start_date,
      serviceEndDate: data.service_end_date,
    });

    try {
      await postPrepaidExpense(prepaid, { postedByUserId: req.currentUser.id });
      await createScheduleForPrepaidExpense(prepaid);
    } catch (err) {
      await prepaid.destroy();
      throw err;
    }

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "prepaid_expense_recorded",
      actor: req.currentUser.email,
      details: { vendor: prepaid.vendorName, amount: data.amount, period: `${data.service_start_date} to ${data.service_end_date}` },
    });

    prepaid.expenseAccount = expenseAccount;
    prepaid.paymentAccount = paymentAccount;
    res.status(201).json(serializePrepaidExpense(prepaid, { unamortizedCents: prepaid.totalCents }));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

router.get("/api/prepaid-expenses/:id", requireAuth, requireActivePlan, writeRateLimit, async (req, res, next) => {
  try {
    const prepaid = await getOwnedPrepaidExpense(req.params.id, req.currentUser.orgId);
    if (!prepaid) return res.status(404).json({ detail: "Prepaid expense not found" });
    const recognized = await amountRecognizedCents(prepaid.id);
    res.json(serializePrepaidExpense(prepaid, { unamortizedCents: prepaid.totalCents - recognized }));
  } catch (err) {
    next(err);
  }
});

router.get("/api/prepaid-expenses/:id/schedule", requireAuth, requireActivePlan, writeRateLimit, async (req, res, next) => {
  try {
    const prepaid = await getOwnedPrepaidExpense(req.params.id, req.currentUser.orgId);
    if (!prepaid) return res.status(404).json({ detail: "Prepaid expense not found" });
    res.json(await scheduleForPrepaidExpense(req.currentUser.orgId, prepaid.id));
  } catch (err) {
    next(err);
  }
});

// A prepaid expense with any month already amortized can't be voided from
// here -- same reasoning voiding a credit memo already applied is refused:
// unwinding history that's already fed into a closed or reported-on period
// is a conversation, not something to silently reverse.
router.post("/api/prepaid-expenses/:id/void", requireAuth, requireActivePlan, writeRateLimit, async (req, res, next) => {
  try {
    const prepaid = await getOwnedPrepaidExpense(req.params.id, req.currentUser.orgId);
    if (!prepaid) return res.status(404).json({ detail: "Prepaid expense not found" });
    if (prepaid.status === "void") return res.status(409).json({ detail: "This prepaid expense is already void." });

    if ((await amountRecognizedCents(prepaid.id)) > 0) {
      return res.status(409).json({
        detail: "Part of this prepaid expense has already been amortized. That can't be undone from here.",
      });
    }

    await voidPrepaidExpenseEntry(req.currentUser.orgId, prepaid.id, { postedByUserId: req.currentUser.id });
    await dropUnrecognizedSchedule(req.currentUser.orgId, prepaid.id);
    prepaid.status = "void";
    await prepaid.save();

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      action: "prepaid_expense_voided",
      actor: req.currentUser.email,
      details: { vendor: prepaid.vendorName, amount: centsToDollars(prepaid.totalCents) },
    });

    res.json(serializePrepaidExpense(prepaid, { unamortizedCents: 0 }));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

router.get("/api/prepaid-expenses-pending", requireAuth, requireActivePlan, writeRateLimit, async (req, res, next) => {
  try {
    const periodMonth = PERIOD_MONTH.test(req.query.period_month || "") ? req.query.period_month : currentPeriodMonth();
    const rows = await pendingThrough(req.currentUser.orgId, periodMonth);

    const byMonth = new Map();
    for (const r of rows) byMonth.set(r.periodMonth, (byMonth.get(r.periodMonth) || 0) + r.amountCents);

    res.json({
      period_month: periodMonth,
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

const amortizeSchema = z.object({ period_month: z.string().regex(PERIOD_MONTH).optional() });

router.post("/api/prepaid-expenses-amortize", requireAuth, requireActivePlan, writeRateLimit, async (req, res, next) => {
  try {
    const parsed = amortizeSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const periodMonth = parsed.data.period_month || currentPeriodMonth();

    const result = await amortizeThrough(req.currentUser.orgId, periodMonth, { postedByUserId: req.currentUser.id });

    if (result.entries.length) {
      await AuditLog.create({
        orgId: req.currentUser.orgId,
        userId: req.currentUser.id,
        action: "prepaid_expense_amortized",
        actor: req.currentUser.email,
        details: { through: periodMonth, periods: result.periods, amount: centsToDollars(result.totalCents) },
      });
    }

    res.json({ through: periodMonth, amortized: centsToDollars(result.totalCents), periods: result.entries });
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

router.get("/api/reports/prepaid-expenses", requireAuth, requireActivePlan, writeRateLimit, async (req, res, next) => {
  try {
    const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 60);
    res.json(await computePrepaidExpenseWaterfall(req.currentUser.orgId, { months }));
  } catch (err) {
    next(err);
  }
});

export default router;
