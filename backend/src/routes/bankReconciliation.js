// Bank reconciliation -- see bankReconciliation.js for the accounting.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { LedgerError, centsToDollars, dollarsToCents } from "../ledger.js";
import {
  completeReconciliation,
  eligibleCashAccounts,
  getReconciliationDetail,
  listReconciliations,
  reopenReconciliation,
  setLineCleared,
  startReconciliation,
} from "../bankReconciliation.js";
import { AuditLog } from "../models/index.js";
import { serializeAccount } from "../serializers.js";

const router = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function serializeLine(l) {
  return {
    journal_line_id: l.journal_line_id,
    journal_entry_id: l.journal_entry_id,
    entry_date: l.entry_date,
    memo: l.memo,
    doc_number: l.doc_number,
    source: l.source,
    debit: centsToDollars(l.debit_cents),
    credit: centsToDollars(l.credit_cents),
  };
}

function serializeReconciliation(r) {
  return {
    id: r.id,
    cash_account_id: r.cash_account_id,
    cash_account_name: r.cash_account_name,
    statement_date: r.statement_date,
    statement_ending_balance: centsToDollars(r.statement_ending_balance_cents),
    status: r.status,
    completed_at: r.completed_at,
    book_balance: centsToDollars(r.book_balance_cents),
    cleared_balance: centsToDollars(r.cleared_balance_cents),
    difference: centsToDollars(r.difference_cents),
    outstanding_checks_total: centsToDollars(r.outstanding_checks_cents),
    deposits_in_transit_total: centsToDollars(r.deposits_in_transit_cents),
    outstanding_checks: r.outstanding_checks.map(serializeLine),
    deposits_in_transit: r.deposits_in_transit.map(serializeLine),
    cleared_lines: r.cleared_lines.map(serializeLine),
  };
}

router.get("/api/bank-reconciliations/accounts", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const accounts = await eligibleCashAccounts(req.currentUser.orgId);
    res.json({ items: accounts.map(serializeAccount) });
  } catch (err) {
    next(err);
  }
});

router.get("/api/bank-reconciliations", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const items = await listReconciliations(req.currentUser.orgId, { cashAccountId: req.query.cash_account_id || null });
    res.json({
      items: items.map((r) => ({
        id: r.id,
        cash_account_id: r.cashAccountId,
        statement_date: r.statementDate,
        statement_ending_balance: centsToDollars(r.statementEndingBalanceCents),
        status: r.status,
        completed_at: r.completedAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

const startSchema = z.object({
  cash_account_id: z.string().min(1),
  statement_date: z.string().regex(ISO_DATE),
  statement_ending_balance: z.number(),
});

router.post("/api/bank-reconciliations", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const d = parsed.data;
    const orgId = req.currentUser.orgId;

    const reconciliation = await startReconciliation(
      orgId,
      {
        cashAccountId: d.cash_account_id,
        statementDate: d.statement_date,
        statementEndingBalanceCents: dollarsToCents(d.statement_ending_balance),
      },
      { postedByUserId: req.currentUser.id }
    );

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "bank_reconciliation_started",
      actor: req.currentUser.email,
      details: { cash_account_id: d.cash_account_id, statement_date: d.statement_date },
    });

    res.status(201).json(serializeReconciliation(await getReconciliationDetail(orgId, reconciliation.id)));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

router.get("/api/bank-reconciliations/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    res.json(serializeReconciliation(await getReconciliationDetail(req.currentUser.orgId, req.params.id)));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

const clearSchema = z.object({
  journal_line_id: z.string().min(1),
  cleared: z.boolean(),
});

router.post("/api/bank-reconciliations/:id/clear", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = clearSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const d = parsed.data;

    const detail = await setLineCleared(req.currentUser.orgId, req.params.id, d.journal_line_id, d.cleared, {
      postedByUserId: req.currentUser.id,
    });
    res.json(serializeReconciliation(detail));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

router.post("/api/bank-reconciliations/:id/complete", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const detail = await completeReconciliation(orgId, req.params.id);

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "bank_reconciliation_completed",
      actor: req.currentUser.email,
      details: { reconciliation_id: req.params.id, difference: detail.difference_cents },
    });

    res.json(serializeReconciliation(detail));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

router.post("/api/bank-reconciliations/:id/reopen", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const detail = await reopenReconciliation(orgId, req.params.id);

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "bank_reconciliation_reopened",
      actor: req.currentUser.email,
      details: { reconciliation_id: req.params.id },
    });

    res.json(serializeReconciliation(detail));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

export default router;
