// Manual journal entries + the trial balance report. postJournalEntry and
// voidJournalEntry (ledger.js) own the actual double-entry invariants;
// this file is just the HTTP surface over them, same division of labor as
// pipeline.js/routes/invoices.js.

import { Router } from "express";
import { Op } from "sequelize";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { LedgerError, centsToDollars, computeTrialBalance, dollarsToCents, postJournalEntry, voidJournalEntry } from "../ledger.js";
import { Account, AuditLog, JournalEntry, JournalLine } from "../models/index.js";
import { serializeJournalEntryDetail, serializeJournalEntryListItem, serializeJournalLine } from "../serializers.js";

const router = Router();

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

// The four traditional special-purpose journals a manual set of books
// keeps alongside the general journal, expressed as the JournalEntry
// `source` values that already tag every entry Rekono posts -- these are
// filters over the one ledger, not a second place transactions get
// written to. "General" is everything left over once the other four are
// carved out (manual entries, adjustments, closes, comp, non-cash equity,
// voids), matching the traditional meaning: whatever doesn't belong in one
// of the specialized books.
//
// The rule that matters here: anything that actually moves cash belongs in
// cash_receipts or cash_payments, never in the general journal, even when
// it's otherwise an "equity" or "tax" event. A capital contribution and a
// treasury reissue both bring cash in; a distribution, a paid dividend, and
// a treasury purchase all pay cash out; an income tax payment pays cash
// out. The non-cash counterparts -- declaring a dividend (a liability, no
// cash yet) and accruing the tax provision (an expense/liability, no cash
// yet) -- correctly stay on the general journal.
const SPECIAL_JOURNAL_SOURCES = {
  sales: ["customer_invoice"],
  purchases: ["invoice_approval"],
  cash_receipts: ["customer_payment", "equity_contribution", "equity_treasury_reissue"],
  cash_payments: [
    "bill_payment",
    "payroll_run",
    "income_tax_payment",
    "equity_distribution",
    "equity_dividend_paid",
    "equity_treasury_purchase",
  ],
};
const GENERAL_JOURNAL_SOURCES = Object.values(SPECIAL_JOURNAL_SOURCES).flat();

async function loadLinesWithAccountNames(journalEntryId) {
  const lines = await JournalLine.findAll({
    where: { journalEntryId },
    include: [{ model: Account, attributes: ["name", "code", "subtype"] }],
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

    if (req.query.journal) {
      if (req.query.journal === "general") {
        where.source = { [Op.notIn]: GENERAL_JOURNAL_SOURCES };
      } else if (SPECIAL_JOURNAL_SOURCES[req.query.journal]) {
        where.source = { [Op.in]: SPECIAL_JOURNAL_SOURCES[req.query.journal] };
      } else {
        return res.status(422).json({
          detail: `journal must be one of: ${["general", ...Object.keys(SPECIAL_JOURNAL_SOURCES)].join(", ")}`,
        });
      }
    }

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

    // Lines are included only on request (the purchases/cash-payments
    // journal views need them to build their specialized columns) --
    // fetched in one batched query rather than per row, since a page can
    // hold up to MAX_PAGE_SIZE entries.
    let linesByEntry = null;
    if (req.query.include === "lines" && rows.length) {
      linesByEntry = new Map();
      const lines = await JournalLine.findAll({
        where: { journalEntryId: rows.map((r) => r.id) },
        include: [{ model: Account, attributes: ["name", "code", "subtype"] }],
        order: [["position", "ASC"]],
      });
      for (const l of lines) {
        if (!linesByEntry.has(l.journalEntryId)) linesByEntry.set(l.journalEntryId, []);
        linesByEntry.get(l.journalEntryId).push(
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
    }

    res.json({
      items: rows.map((entry) => ({
        ...serializeJournalEntryListItem(entry, centsToDollars(totalByEntry.get(entry.id) || 0)),
        ...(linesByEntry ? { lines: linesByEntry.get(entry.id) || [] } : {}),
      })),
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
  doc_number: z.string().max(64).optional(),
  lines: z.array(lineSchema).min(2),
});

router.post("/api/journal-entries", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const { entry_date, memo = "", doc_number = "", lines } = parsed.data;

    const entry = await postJournalEntry(req.currentUser.orgId, {
      entryDate: entry_date,
      memo,
      docNumber: doc_number,
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
