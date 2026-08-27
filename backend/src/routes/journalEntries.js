// Manual journal entries + the trial balance report. postJournalEntry and
// voidJournalEntry (ledger.js) own the actual double-entry invariants;
// this file is just the HTTP surface over them, same division of labor as
// pipeline.js/routes/invoices.js.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { LedgerError, centsToDollars, computeTrialBalance, dollarsToCents, postJournalEntry, voidJournalEntry } from "../ledger.js";
import { Account, AuditLog, JournalEntry, JournalLine } from "../models/index.js";
import { serializeJournalEntryDetail, serializeJournalEntryListItem, serializeJournalLine } from "../serializers.js";

const router = Router();

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

async function loadLinesWithAccountNames(journalEntryId) {
  const lines = await JournalLine.findAll({
    where: { journalEntryId },
    include: [{ model: Account, attributes: ["name"] }],
    order: [["position", "ASC"]],
  });
  return lines.map((l) =>
    serializeJournalLine({
      id: l.id,
      accountId: l.accountId,
      account: l.Account,
      debit: centsToDollars(l.debitCents),
      credit: centsToDollars(l.creditCents),
      memo: l.memo,
    })
  );
}


router.get("/api/journal-entries", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const where = { orgId: req.currentUser.orgId };
    if (req.query.status) where.status = req.query.status;

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.page_size, 10) || DEFAULT_PAGE_SIZE));

    const { rows, count } = await JournalEntry.findAndCountAll({
      where,
      order: [["entryDate", "DESC"], ["createdAt", "DESC"]],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    // total = the debit side's sum, which always equals the credit side's
    // by construction -- a quick "how big was this entry" figure for the
    // list view without shipping every line over the wire for it.
    const totals = await JournalLine.findAll({
      where: { journalEntryId: rows.map((r) => r.id) },
      attributes: ["journalEntryId", "debitCents"],
      raw: true,
    });
    const totalByEntry = new Map();
    for (const line of totals) {
      totalByEntry.set(line.journalEntryId, (totalByEntry.get(line.journalEntryId) || 0) + line.debitCents);
    }

    res.json({
      items: rows.map((entry) => serializeJournalEntryListItem(entry, centsToDollars(totalByEntry.get(entry.id) || 0))),
      total: count,
      page,
      page_size: pageSize,
    });
  } catch (err) {
    next(err);
  }
});

const lineSchema = z.object({
  account_id: z.string().min(1),
  debit: z.number().min(0).default(0),
  credit: z.number().min(0).default(0),
  memo: z.string().max(512).optional(),
});

const createSchema = z.object({
  entry_date: z.string().min(1),
  memo: z.string().max(512).optional(),
  lines: z.array(lineSchema).min(2),
});

router.post("/api/journal-entries", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const { entry_date, memo = "", lines } = parsed.data;

    const entry = await postJournalEntry(req.currentUser.orgId, {
      entryDate: entry_date,
      memo,
      source: "manual",
      postedByUserId: req.currentUser.id,
      lines: lines.map((l) => ({
        accountId: l.account_id,
        debitCents: dollarsToCents(l.debit),
        creditCents: dollarsToCents(l.credit),
        memo: l.memo || "",
      })),
    });

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      action: "journal_entry_posted",
      actor: req.currentUser.email,
      details: { journal_entry_id: entry.id, memo },
    });

    const serializedLines = await loadLinesWithAccountNames(entry.id);
    res.status(201).json(serializeJournalEntryDetail(entry, serializedLines));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

router.get("/api/journal-entries/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const entry = await JournalEntry.findOne({ where: { id: req.params.id, orgId: req.currentUser.orgId } });
    if (!entry) return res.status(404).json({ detail: "Journal entry not found" });
    const lines = await loadLinesWithAccountNames(entry.id);
    res.json(serializeJournalEntryDetail(entry, lines));
  } catch (err) {
    next(err);
  }
});

router.post("/api/journal-entries/:id/void", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const entry = await JournalEntry.findOne({ where: { id: req.params.id, orgId: req.currentUser.orgId } });
    if (!entry) return res.status(404).json({ detail: "Journal entry not found" });

    const reversal = await voidJournalEntry(req.currentUser.orgId, entry.id, { postedByUserId: req.currentUser.id });

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      action: "journal_entry_voided",
      actor: req.currentUser.email,
      details: { journal_entry_id: entry.id, reversal_entry_id: reversal?.id ?? null },
    });

    await entry.reload();
    const lines = await loadLinesWithAccountNames(entry.id);
    res.json(serializeJournalEntryDetail(entry, lines));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

router.get("/api/ledger/trial-balance", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const asOf = typeof req.query.as_of === "string" && req.query.as_of ? req.query.as_of : null;
    res.json(await computeTrialBalance(req.currentUser.orgId, asOf));
  } catch (err) {
    next(err);
  }
});

export default router;
