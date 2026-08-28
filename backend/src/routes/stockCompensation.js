// ASC 718 stock compensation expense. stockCompensation.js owns the
// recognition arithmetic; this is the HTTP surface.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { LedgerError } from "../ledger.js";
import { computeAwardCosts, computeSchedule, recognizeThrough } from "../stockCompensation.js";
import { AuditLog } from "../models/index.js";

const router = Router();

const ISO_MONTH = /^\d{4}-\d{2}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function monthParam(req) {
  return ISO_MONTH.test(req.query.through || "") ? req.query.through : null;
}

// The schedule, month by month, with each month flagged as already posted
// or still to post.
router.get("/api/stock-compensation", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    res.json(await computeSchedule(req.currentUser.orgId, { throughMonth: monthParam(req) }));
  } catch (err) {
    next(err);
  }
});

// Per-award cost and the unrecognized balance -- the disclosure every set
// of audited financials carries.
router.get("/api/stock-compensation/awards", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const asOf = ISO_DATE.test(req.query.as_of || "") ? req.query.as_of : null;
    res.json({ items: await computeAwardCosts(req.currentUser.orgId, { asOf }) });
  } catch (err) {
    next(err);
  }
});

const runSchema = z.object({ through: z.string().regex(ISO_MONTH) });

router.post("/api/stock-compensation/run", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = runSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;

    const result = await recognizeThrough(orgId, parsed.data.through, { postedByUserId: req.currentUser.id });

    if (result.entries.length) {
      await AuditLog.create({
        orgId,
        userId: req.currentUser.id,
        action: "stock_compensation_recognized",
        actor: req.currentUser.email,
        details: { through: parsed.data.through, months: result.entries.length, amount: result.total },
      });
    }

    res.json(result);
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

export default router;
