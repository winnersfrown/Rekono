// The income tax provision. incomeTax.js owns the arithmetic and the
// boundary of what this does and doesn't claim to be; this is the HTTP
// surface.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { LedgerError, centsToDollars, dollarsToCents } from "../ledger.js";
import { computeProvision, recordProvision, recordTaxPayment, taxPayableCents } from "../incomeTax.js";
import { AuditLog } from "../models/index.js";

const router = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function handleLedgerError(err, res, next) {
  if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
  next(err);
}

const previewSchema = z.object({
  as_of: z.string().regex(ISO_DATE),
  rate_percent: z.coerce.number().min(0).max(100),
});

// What a provision would be, without posting anything. Deliberately a
// preview endpoint rather than a side effect of loading a page -- the
// number depends on a rate the user supplies, and guessing a default rate
// would be exactly the kind of invention this feature refuses to make.
router.get("/api/income-tax/provision", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = previewSchema.safeParse(req.query);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    const orgId = req.currentUser.orgId;
    const preview = await computeProvision(orgId, {
      asOf: parsed.data.as_of,
      ratePercent: parsed.data.rate_percent,
    });
    res.json({ ...preview, payable: centsToDollars(await taxPayableCents(orgId, { asOf: parsed.data.as_of })) });
  } catch (err) {
    handleLedgerError(err, res, next);
  }
});

const provisionSchema = z.object({
  as_of: z.string().regex(ISO_DATE),
  rate_percent: z.number().min(0).max(100),
  memo: z.string().max(512).optional(),
});

router.post("/api/income-tax/provision", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = provisionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;
    const d = parsed.data;

    const result = await recordProvision(
      orgId,
      { asOf: d.as_of, ratePercent: d.rate_percent, memo: d.memo || "" },
      { postedByUserId: req.currentUser.id }
    );

    if (result.entry) {
      await AuditLog.create({
        orgId,
        userId: req.currentUser.id,
        action: "income_tax_provision_recorded",
        actor: req.currentUser.email,
        details: { fiscal_year: result.fiscal_year, rate_percent: d.rate_percent, amount: result.to_post },
      });
    }

    res.status(result.entry ? 201 : 200).json({
      ...result,
      entry: undefined,
      journal_entry_id: result.entry?.id ?? null,
    });
  } catch (err) {
    handleLedgerError(err, res, next);
  }
});

const paymentSchema = z.object({
  amount: z.number().positive(),
  payment_date: z.string().regex(ISO_DATE),
  cash_account_id: z.string().min(1),
  memo: z.string().max(512).optional(),
});

router.post("/api/income-tax/payments", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = paymentSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;
    const d = parsed.data;

    const entry = await recordTaxPayment(
      orgId,
      {
        amountCents: dollarsToCents(d.amount),
        paymentDate: d.payment_date,
        cashAccountId: d.cash_account_id,
        memo: d.memo || "",
      },
      { postedByUserId: req.currentUser.id }
    );

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "income_tax_paid",
      actor: req.currentUser.email,
      details: { amount: d.amount, payment_date: d.payment_date },
    });

    res.status(201).json({
      journal_entry_id: entry.id,
      amount: d.amount,
      payment_date: d.payment_date,
      payable: centsToDollars(await taxPayableCents(orgId)),
    });
  } catch (err) {
    handleLedgerError(err, res, next);
  }
});

export default router;
