// Writing a check against an approved bill -- check number, payee, memo,
// posted the same way "Record payment" already is. See writtenChecks.js
// for the accounting; models/WrittenCheck.js for why this is a separate
// record from the scanned-check pipeline in routes/checks.js.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { LedgerError, dollarsToCents } from "../ledger.js";
import { serializeWrittenCheck, voidWrittenCheck, writeCheck } from "../writtenChecks.js";
import { Account, AuditLog, Invoice, WrittenCheck } from "../models/index.js";

const router = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function loadContext(orgId, checks) {
  const [invoices, accounts] = await Promise.all([
    Invoice.scope("withSamples").findAll({ where: { orgId, id: checks.map((c) => c.invoiceId) } }),
    Account.findAll({ where: { orgId, id: checks.map((c) => c.paymentAccountId) } }),
  ]);
  return {
    invoiceById: new Map(invoices.map((i) => [i.id, i])),
    accountById: new Map(accounts.map((a) => [a.id, a])),
  };
}

router.get("/api/written-checks", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const checks = await WrittenCheck.findAll({ where: { orgId }, order: [["checkDate", "DESC"], ["checkNumber", "DESC"]] });
    const { invoiceById, accountById } = await loadContext(orgId, checks);
    res.json({
      items: checks.map((c) => serializeWrittenCheck(c, invoiceById.get(c.invoiceId), accountById.get(c.paymentAccountId))),
    });
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  invoice_id: z.string().min(1),
  check_number: z.string().min(1).max(32),
  payee_name: z.string().min(1).max(256),
  check_date: z.string().regex(ISO_DATE),
  amount: z.number().positive(),
  memo: z.string().max(512).optional(),
  payment_account_id: z.string().min(1),
});

router.post("/api/written-checks", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const d = parsed.data;
    const orgId = req.currentUser.orgId;

    const check = await writeCheck(orgId, {
      invoiceId: d.invoice_id,
      checkNumber: d.check_number,
      payeeName: d.payee_name,
      checkDate: d.check_date,
      amountCents: dollarsToCents(d.amount),
      memo: d.memo,
      paymentAccountId: d.payment_account_id,
      postedByUserId: req.currentUser.id,
    });

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      invoiceId: d.invoice_id,
      action: "check_written",
      actor: req.currentUser.email,
      details: { check_number: d.check_number, payee: d.payee_name, amount: d.amount },
    });

    const { invoiceById, accountById } = await loadContext(orgId, [check]);
    res.status(201).json(serializeWrittenCheck(check, invoiceById.get(check.invoiceId), accountById.get(check.paymentAccountId)));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

// Voids the bill payment the check made (a real reversal, not a delete of
// history) and removes the check record -- same semantics as removing a
// payment from the Bill Payments tab, just reached from the check instead.
router.delete("/api/written-checks/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const check = await WrittenCheck.findOne({ where: { id: req.params.id, orgId } });
    if (!check) return res.status(404).json({ detail: "Check not found" });

    await voidWrittenCheck(orgId, check.id, { postedByUserId: req.currentUser.id });

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      invoiceId: check.invoiceId,
      action: "check_voided",
      actor: req.currentUser.email,
      details: { check_number: check.checkNumber, amount: check.amountCents / 100 },
    });

    res.json({ ok: true });
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

export default router;
