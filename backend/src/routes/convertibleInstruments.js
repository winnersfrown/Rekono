// SAFE and convertible note tracking. convertibleInstruments.js owns the
// accounting; this validates request shape, scopes everything to the
// caller's org, and writes the audit trail.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { LedgerError, centsToDollars, dollarsToCents } from "../ledger.js";
import { CONVERTIBLE_INSTRUMENT_TYPES, SAFE_TYPES } from "../models/ConvertibleInstrument.js";
import {
  recordConversion,
  recordIssuance,
  recordRepayment,
  serializeConvertibleInstrument,
  voidIssuance,
} from "../convertibleInstruments.js";
import { Account, AuditLog, ConvertibleInstrument, Shareholder } from "../models/index.js";

const router = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function handleLedgerError(err, res, next) {
  if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
  next(err);
}

async function loadLookups(orgId) {
  const [holders, accounts] = await Promise.all([
    Shareholder.findAll({ where: { orgId } }),
    Account.findAll({ where: { orgId } }),
  ]);
  return { shareholdersById: new Map(holders.map((h) => [h.id, h])), accountsById: new Map(accounts.map((a) => [a.id, a])) };
}

const issuanceSchema = z.object({
  shareholder_id: z.string().min(1),
  instrument_type: z.enum(CONVERTIBLE_INSTRUMENT_TYPES),
  safe_type: z.enum(SAFE_TYPES).nullable().optional(),
  issue_date: z.string().regex(ISO_DATE),
  principal: z.number().positive(),
  valuation_cap: z.number().positive().nullable().optional(),
  discount_rate_percent: z.number().min(0).max(100).nullable().optional(),
  interest_rate_percent: z.number().min(0).max(100).nullable().optional(),
  maturity_date: z.string().regex(ISO_DATE).nullable().optional(),
  cash_account_id: z.string().min(1),
  memo: z.string().max(512).optional(),
});

router.get("/api/convertible-instruments", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const where = { orgId };
    if (req.query.status) where.status = req.query.status;

    const [instruments, { shareholdersById, accountsById }] = await Promise.all([
      ConvertibleInstrument.findAll({ where, order: [["issueDate", "DESC"], ["id", "DESC"]] }),
      loadLookups(orgId),
    ]);

    const outstanding = instruments.filter((i) => i.status === "outstanding");
    res.json({
      items: instruments.map((i) => serializeConvertibleInstrument(i, { shareholdersById, accountsById })),
      outstanding_principal: centsToDollars(outstanding.reduce((sum, i) => sum + i.principalCents, 0)),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/api/convertible-instruments", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = issuanceSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;
    const d = parsed.data;

    const { instrument } = await recordIssuance(
      orgId,
      {
        shareholderId: d.shareholder_id,
        instrumentType: d.instrument_type,
        safeType: d.safe_type ?? null,
        issueDate: d.issue_date,
        principalCents: dollarsToCents(d.principal),
        valuationCapCents: d.valuation_cap == null ? null : dollarsToCents(d.valuation_cap),
        discountRatePercent: d.discount_rate_percent ?? null,
        interestRatePercent: d.interest_rate_percent ?? null,
        maturityDate: d.maturity_date ?? null,
        cashAccountId: d.cash_account_id,
        memo: d.memo || "",
      },
      { postedByUserId: req.currentUser.id }
    );

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "convertible_instrument_issued",
      actor: req.currentUser.email,
      details: { instrument_type: d.instrument_type, principal: d.principal },
    });

    const { shareholdersById, accountsById } = await loadLookups(orgId);
    res.status(201).json(serializeConvertibleInstrument(instrument, { shareholdersById, accountsById }));
  } catch (err) {
    handleLedgerError(err, res, next);
  }
});

const conversionSchema = z.object({
  transaction_date: z.string().regex(ISO_DATE),
  share_class_id: z.string().min(1),
  shares: z.number().int().positive(),
  par_value: z.number().min(0),
  memo: z.string().max(512).optional(),
});

router.post("/api/convertible-instruments/:id/convert", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = conversionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;
    const d = parsed.data;

    const { instrument } = await recordConversion(
      orgId,
      req.params.id,
      {
        transactionDate: d.transaction_date,
        shareClassId: d.share_class_id,
        shares: d.shares,
        // Millionths of a dollar -- see ShareClass.parValueMicros.
        parValueMicros: Math.round(d.par_value * 1000000),
        memo: d.memo || "",
      },
      { postedByUserId: req.currentUser.id }
    );

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "convertible_instrument_converted",
      actor: req.currentUser.email,
      details: { shares: d.shares, share_class_id: d.share_class_id },
    });

    const { shareholdersById, accountsById } = await loadLookups(orgId);
    res.json(serializeConvertibleInstrument(instrument, { shareholdersById, accountsById }));
  } catch (err) {
    handleLedgerError(err, res, next);
  }
});

const repaymentSchema = z.object({
  transaction_date: z.string().regex(ISO_DATE),
  amount: z.number().positive(),
  cash_account_id: z.string().min(1),
  memo: z.string().max(512).optional(),
});

router.post("/api/convertible-instruments/:id/repay", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = repaymentSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;
    const d = parsed.data;

    const { instrument } = await recordRepayment(
      orgId,
      req.params.id,
      {
        transactionDate: d.transaction_date,
        amountCents: dollarsToCents(d.amount),
        cashAccountId: d.cash_account_id,
        memo: d.memo || "",
      },
      { postedByUserId: req.currentUser.id }
    );

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "convertible_instrument_repaid",
      actor: req.currentUser.email,
      details: { amount: d.amount },
    });

    const { shareholdersById, accountsById } = await loadLookups(orgId);
    res.json(serializeConvertibleInstrument(instrument, { shareholdersById, accountsById }));
  } catch (err) {
    handleLedgerError(err, res, next);
  }
});

router.post("/api/convertible-instruments/:id/void", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const instrument = await voidIssuance(orgId, req.params.id, { postedByUserId: req.currentUser.id });

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "convertible_instrument_voided",
      actor: req.currentUser.email,
      details: {},
    });

    const { shareholdersById, accountsById } = await loadLookups(orgId);
    res.json(serializeConvertibleInstrument(instrument, { shareholdersById, accountsById }));
  } catch (err) {
    handleLedgerError(err, res, next);
  }
});

export default router;
