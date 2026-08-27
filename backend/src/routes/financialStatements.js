// The three financial statements. financialStatements.js owns the
// accounting; this is the HTTP surface over it, same division of labor as
// ledger.js/routes/journalEntries.js.
//
// All three are read-only -- there's no statement to create, edit, or
// store, since every figure is derived from posted journal lines on each
// request. That's deliberate: a stored statement is a second copy of the
// truth that can drift from the ledger it came from.

import { Router } from "express";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { computeBalanceSheet, computeCashFlow, computeProfitAndLoss } from "../financialStatements.js";

const router = Router();

// Statement dates arrive as ?from=/&to=/&as_of= query strings. Anything
// that isn't a plain YYYY-MM-DD is dropped rather than passed through to
// Sequelize -- an unparseable date should mean "no bound" (the report's
// own default window), not a 500 from the query layer.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDateParam(value) {
  return typeof value === "string" && ISO_DATE.test(value) ? value : null;
}

// A P&L or cash flow with no explicit window covers the current calendar
// year to date -- the period a finance person means by default when they
// open one without saying otherwise.
function defaultPeriod() {
  const now = new Date();
  return {
    from: `${now.getUTCFullYear()}-01-01`,
    to: now.toISOString().slice(0, 10),
  };
}

router.get("/api/statements/profit-and-loss", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const period = defaultPeriod();
    const from = isoDateParam(req.query.from) || period.from;
    const to = isoDateParam(req.query.to) || period.to;
    res.json(await computeProfitAndLoss(req.currentUser.orgId, { from, to }));
  } catch (err) {
    next(err);
  }
});

router.get("/api/statements/balance-sheet", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    // Unlike the P&L, a balance sheet has no start date -- it's a snapshot
    // of everything posted up to `as_of`, defaulting to today.
    const asOf = isoDateParam(req.query.as_of) || new Date().toISOString().slice(0, 10);
    res.json(await computeBalanceSheet(req.currentUser.orgId, { asOf }));
  } catch (err) {
    next(err);
  }
});

router.get("/api/statements/cash-flow", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const period = defaultPeriod();
    const from = isoDateParam(req.query.from) || period.from;
    const to = isoDateParam(req.query.to) || period.to;
    res.json(await computeCashFlow(req.currentUser.orgId, { from, to }));
  } catch (err) {
    next(err);
  }
});

export default router;
