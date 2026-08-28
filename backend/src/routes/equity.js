// Equity transactions and the statement of stockholders' equity.
// equity.js and stockholdersEquity.js own the accounting; this is the
// HTTP surface.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { LedgerError, centsToDollars, dollarsToCents } from "../ledger.js";
import { EQUITY_TRANSACTION_TYPES } from "../models/EquityTransaction.js";
import { recordEquityTransaction, serializeEquityTransaction, voidEquityTransaction } from "../equity.js";
import { computeStockholdersEquity } from "../stockholdersEquity.js";
import { Account, AuditLog, EquityTransaction } from "../models/index.js";

const router = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Types that move cash and so need an account named. `dividend_declared`
// is the exception: it creates the obligation without paying it.
const CASHLESS_TYPES = new Set(["dividend_declared"]);

const equitySchema = z
  .object({
    type: z.enum(EQUITY_TRANSACTION_TYPES),
    transaction_date: z.string().regex(ISO_DATE),
    amount: z.number().positive(),
    cash_account_id: z.string().min(1).optional(),
    shares: z.number().int().positive().optional(),
    par_value: z.number().min(0).optional(),
    cost_basis: z.number().positive().optional(),
    memo: z.string().max(512).optional(),
  })
  .refine((d) => CASHLESS_TYPES.has(d.type) || Boolean(d.cash_account_id), {
    message: "This transaction moves cash, so it needs an account to move it through.",
  })
  .refine((d) => d.type !== "treasury_reissue" || d.cost_basis !== undefined, {
    message: "Reissuing treasury stock needs the original cost of those shares.",
  })
  .refine((d) => Boolean(d.shares) === (d.par_value !== undefined), {
    message: "Share count and par value go together -- give both or neither.",
  });

router.get("/api/equity/transactions", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const where = { orgId };
    if (EQUITY_TRANSACTION_TYPES.includes(req.query.type)) where.type = req.query.type;

    const [transactions, accounts] = await Promise.all([
      EquityTransaction.findAll({ where, order: [["transactionDate", "DESC"], ["id", "DESC"]], limit: 500 }),
      Account.findAll({ where: { orgId } }),
    ]);
    const byId = new Map(accounts.map((a) => [a.id, a]));

    res.json({
      items: transactions.map((t) => serializeEquityTransaction(t, byId)),
      total: centsToDollars(transactions.reduce((s, t) => s + t.amountCents, 0)),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/api/equity/transactions", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = equitySchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;
    const d = parsed.data;

    const { transaction } = await recordEquityTransaction(
      orgId,
      {
        type: d.type,
        transactionDate: d.transaction_date,
        amountCents: dollarsToCents(d.amount),
        cashAccountId: d.cash_account_id || null,
        shares: d.shares ?? null,
        // Millionths of a dollar -- see EquityTransaction.parValueMicros.
        parValueMicros: d.par_value === undefined ? null : Math.round(d.par_value * 1000000),
        costBasisCents: d.cost_basis === undefined ? null : dollarsToCents(d.cost_basis),
        memo: d.memo || "",
      },
      { postedByUserId: req.currentUser.id }
    );

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "equity_transaction_recorded",
      actor: req.currentUser.email,
      details: { type: d.type, amount: d.amount },
    });

    const accounts = await Account.findAll({ where: { orgId } });
    res.status(201).json(serializeEquityTransaction(transaction, new Map(accounts.map((a) => [a.id, a]))));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

// Reverses the posting. The record itself is kept -- an owner distribution
// that happened and was corrected is history someone may need to explain.
router.post("/api/equity/transactions/:id/void", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const transaction = await voidEquityTransaction(orgId, req.params.id, { postedByUserId: req.currentUser.id });
    if (!transaction) return res.status(404).json({ detail: "Equity transaction not found" });

    // Cleared so the statement stops attributing this movement -- the
    // ledger no longer reflects it, and counting it would push a phantom
    // difference onto the statement's `other` line.
    transaction.journalEntryId = null;
    await transaction.save();

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "equity_transaction_voided",
      actor: req.currentUser.email,
      details: { type: transaction.type, amount: centsToDollars(transaction.amountCents) },
    });

    res.json(serializeEquityTransaction(transaction));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

router.get("/api/statements/stockholders-equity", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const from = ISO_DATE.test(req.query.from || "") ? req.query.from : null;
    const to = ISO_DATE.test(req.query.to || "") ? req.query.to : null;
    res.json(await computeStockholdersEquity(req.currentUser.orgId, { from, to }));
  } catch (err) {
    next(err);
  }
});

export default router;
