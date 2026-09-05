// The board report. boardReport.js owns the assembly of already-computed
// statements into one package; this is the HTTP surface over it, same
// division of labor as financialStatements.js/routes/financialStatements.js.
//
// Read-only, same reasoning as the statements it's built from: nothing
// here is stored, so there's no report to drift out of sync with the
// ledger it was generated from.

import { Router } from "express";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { computeBoardReport } from "../boardReport.js";

const router = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

router.get("/api/reports/board", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const asOf = ISO_DATE.test(req.query.as_of || "") ? req.query.as_of : null;
    res.json(await computeBoardReport(req.currentUser.orgId, { asOf }));
  } catch (err) {
    next(err);
  }
});

export default router;
