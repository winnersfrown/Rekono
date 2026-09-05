// Import an opening trial balance from a CSV export of another system.
// openingBalanceImport.js owns the parsing/matching/posting; this
// validates request shape, scopes to the caller's org, and writes the
// audit trail.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { LedgerError } from "../ledger.js";
import { importOpeningBalances, parseTrialBalanceCsv, previewOpeningBalances } from "../openingBalanceImport.js";
import { AuditLog } from "../models/index.js";

const router = Router();
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function handleLedgerError(err, res, next) {
  if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
  next(err);
}

const csvSchema = z.object({ csv: z.string().min(1) });

// Parses and matches without writing anything -- account matches, which
// rows will create a new account, and whether the file balances -- so a
// bad export gets fixed before it touches the ledger, not after.
router.post("/api/onboarding/import-trial-balance/preview", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = csvSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    const rows = parseTrialBalanceCsv(parsed.data.csv);
    res.json(await previewOpeningBalances(req.currentUser.orgId, rows));
  } catch (err) {
    handleLedgerError(err, res, next);
  }
});

const importSchema = csvSchema.extend({ as_of_date: z.string().regex(ISO_DATE) });

router.post("/api/onboarding/import-trial-balance", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;

    const rows = parseTrialBalanceCsv(parsed.data.csv);
    const result = await importOpeningBalances(orgId, {
      asOfDate: parsed.data.as_of_date,
      rows,
      postedByUserId: req.currentUser.id,
    });

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "opening_balances_imported",
      actor: req.currentUser.email,
      details: {
        accounts_matched: result.accountsMatched,
        accounts_created: result.accountsCreated,
        journal_entry_id: result.entry.id,
      },
    });

    res.status(201).json({
      journal_entry_id: result.entry.id,
      accounts_matched: result.accountsMatched,
      accounts_created: result.accountsCreated,
    });
  } catch (err) {
    handleLedgerError(err, res, next);
  }
});

export default router;
