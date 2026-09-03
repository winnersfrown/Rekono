// Budget vs actual -- see budget.js for the accounting.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { LedgerError, dollarsToCents } from "../ledger.js";
import { DEFAULT_FISCAL_YEAR_END_MONTH, fiscalYearFor } from "../fiscalYear.js";
import {
  computeBudgetVsActual,
  ensureBudget,
  removeAccountBudget,
  setAccountBudget,
  splitAnnualBudgetCents,
} from "../budget.js";
import { AuditLog, Budget, Organization } from "../models/index.js";

const router = Router();

const PERIOD_MONTH = /^\d{4}-\d{2}$/;

async function currentFiscalYearEndYear(orgId) {
  const org = await Organization.findByPk(orgId, { attributes: ["fiscalYearEndMonth"], raw: true });
  const endMonth = org?.fiscalYearEndMonth ?? DEFAULT_FISCAL_YEAR_END_MONTH;
  const today = new Date().toISOString().slice(0, 10);
  return Number(fiscalYearFor(today, endMonth).end.slice(0, 4));
}

// The fiscal year a budget belongs to is looked up server-side rather
// than trusted from the request, so a client can't split an annual amount
// against the wrong year's month count.
async function requireOwnedBudget(orgId, budgetId) {
  const budget = await Budget.findOne({ where: { id: budgetId, orgId } });
  if (!budget) throw new LedgerError("Budget not found.", 404);
  return budget;
}

router.get("/api/budget", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const fiscalYearEndYear = /^\d{4}$/.test(req.query.fiscal_year_end_year || "")
      ? Number(req.query.fiscal_year_end_year)
      : await currentFiscalYearEndYear(orgId);
    const throughMonth = PERIOD_MONTH.test(req.query.through_month || "") ? req.query.through_month : null;

    res.json(await computeBudgetVsActual(orgId, fiscalYearEndYear, { throughMonth }));
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  fiscal_year_end_year: z.number().int().min(2000).max(2100),
  name: z.string().max(256).optional(),
});

router.post("/api/budget", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;
    const d = parsed.data;

    const budget = await ensureBudget(orgId, d.fiscal_year_end_year, { name: d.name || "", postedByUserId: req.currentUser.id });

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "budget_created",
      actor: req.currentUser.email,
      details: { fiscal_year_end_year: d.fiscal_year_end_year },
    });

    res.status(201).json(await computeBudgetVsActual(orgId, budget.fiscalYearEndYear));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

const accountBudgetSchema = z.object({
  account_id: z.string().min(1),
  annual_amount: z.number(),
});

router.post("/api/budget/:budgetId/accounts", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = accountBudgetSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;
    const d = parsed.data;

    const budget = await requireOwnedBudget(orgId, req.params.budgetId);
    const lines = await splitAnnualBudgetCents(orgId, budget.fiscalYearEndYear, dollarsToCents(d.annual_amount));
    await setAccountBudget(orgId, budget.id, d.account_id, lines);

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "budget_account_set",
      actor: req.currentUser.email,
      details: { budget_id: budget.id, account_id: d.account_id, annual_amount: d.annual_amount },
    });

    res.json(await computeBudgetVsActual(orgId, budget.fiscalYearEndYear));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

router.delete("/api/budget/:budgetId/accounts/:accountId", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const budget = await requireOwnedBudget(orgId, req.params.budgetId);
    await removeAccountBudget(orgId, budget.id, req.params.accountId);

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "budget_account_removed",
      actor: req.currentUser.email,
      details: { budget_id: budget.id, account_id: req.params.accountId },
    });

    res.json(await computeBudgetVsActual(orgId, budget.fiscalYearEndYear));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

export default router;
