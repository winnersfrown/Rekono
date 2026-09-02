// Chart of accounts CRUD -- mirrors routes/leases.js's shape (ownership
// helper, requireAuth + requireActivePlan, AuditLog per mutation,
// serializers.js response shaping) applied to Account instead of Lease.
// See ledger.js for the seeded defaults every org starts with and how
// invoice approval posts against these.

import { Router } from "express";
import { Op } from "sequelize";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { ACCOUNT_TYPES } from "../models/Account.js";
import { Account, AuditLog, JournalEntry, JournalLine } from "../models/index.js";
import { centsToDollars, sortAccounts } from "../ledger.js";
import { normalBalanceCents } from "../financialStatements.js";
import { ACCOUNT_SUBTYPES } from "../accountTaxonomy.js";
import { serializeAccount } from "../serializers.js";

const router = Router();

// Static, but served from an endpoint rather than duplicated into app.js:
// one list, so a subtype added here shows up in the picker without anyone
// having to remember to update the frontend's copy of it too.
router.get("/api/accounts/subtypes", requireAuth, requireActivePlan, (req, res) => {
  res.json({ subtypes: ACCOUNT_SUBTYPES });
});

async function getOwnedAccount(id, orgId) {
  return Account.findOne({ where: { id, orgId } });
}

router.get("/api/accounts", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const where = { orgId: req.currentUser.orgId };
    if (req.query.type) where.type = req.query.type;
    if (req.query.active === "true") where.active = true;
    if (req.query.active === "false") where.active = false;

    // Sorted in JS rather than by ORDER BY: the rule ranks by subtype and
    // then falls back through code (numerically) and creation order, which
    // is a comparator, not something SQLite and Postgres would order
    // identically on their own. See ledger.js's sortAccounts.
    const accounts = await Account.findAll({ where });
    res.json({ items: sortAccounts(accounts).map(serializeAccount) });
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  code: z.string().max(16).optional(),
  name: z.string().min(1).max(256),
  type: z.enum(ACCOUNT_TYPES),
  subtype: z.string().max(64).optional(),
});

router.post("/api/accounts", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const { code = "", name, type, subtype = "" } = parsed.data;

    // Case-insensitive: "Cash" and "cash" would otherwise both resolve
    // ambiguously wherever an account is looked up by name (ledger.js's
    // invoice-approval posting does exactly that).
    const existing = await Account.findOne({ where: { orgId: req.currentUser.orgId, name } });
    if (existing) {
      return res.status(409).json({ detail: `An account named "${name}" already exists.` });
    }

    const account = await Account.create({ orgId: req.currentUser.orgId, code, name, type, subtype });
    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      action: "account_created",
      actor: req.currentUser.email,
      details: { name, type },
    });
    res.status(201).json(serializeAccount(account));
  } catch (err) {
    next(err);
  }
});

const updateSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  code: z.string().max(16).optional(),
  subtype: z.string().max(64).optional(),
  active: z.boolean().optional(),
});

router.patch("/api/accounts/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    const account = await getOwnedAccount(req.params.id, req.currentUser.orgId);
    if (!account) return res.status(404).json({ detail: "Account not found" });

    // A system account (Cash, Accounts Payable, ...) can be renamed but
    // never deactivated -- other code (ledger.js's postInvoiceApproval)
    // posts to these by name and would silently stop working otherwise.
    if (account.isSystemAccount && parsed.data.active === false) {
      return res.status(409).json({ detail: "This is a system account and can't be deactivated." });
    }

    const changed = {};
    for (const [field, value] of Object.entries(parsed.data)) {
      if (value === undefined) continue;
      if (account[field] !== value) {
        changed[field] = { old: account[field], new: value };
        account[field] = value;
      }
    }

    if (Object.keys(changed).length) {
      await account.save();
      await AuditLog.create({
        orgId: req.currentUser.orgId,
        userId: req.currentUser.id,
        action: "account_updated",
        actor: req.currentUser.email,
        details: changed,
      });
    }

    res.json(serializeAccount(account));
  } catch (err) {
    next(err);
  }
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// The general ledger for one account -- every posted line that hit it,
// oldest first, with a running balance. This is the answer to "how was
// this number on the trial balance / income statement / balance sheet
// actually calculated": each report shows a single total per account, and
// this is what that total is the sum of. `from`/`to` mirror
// financialStatements.js's period vs. point-in-time reports -- give both
// for an income-statement line (activity within a period), give only `to`
// for a balance-sheet or trial-balance line (everything up to that date,
// starting from an opening balance that folds in everything before `from`
// so the running balance still ties out to the report).
router.get("/api/accounts/:id/ledger", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const account = await getOwnedAccount(req.params.id, orgId);
    if (!account) return res.status(404).json({ detail: "Account not found" });

    const from = typeof req.query.from === "string" && ISO_DATE.test(req.query.from) ? req.query.from : null;
    const to = typeof req.query.to === "string" && ISO_DATE.test(req.query.to) ? req.query.to : null;
    if (req.query.from && !from) return res.status(422).json({ detail: "from must be an ISO date (YYYY-MM-DD)." });
    if (req.query.to && !to) return res.status(422).json({ detail: "to must be an ISO date (YYYY-MM-DD)." });

    // Same "don't filter to posted" reasoning as financialStatements.js's
    // loadLines: a voided entry's reversal is what cancels it out, so both
    // have to count or the running balance stops tying to the reports.
    // `entryDate` is an already-built Sequelize where-value (or undefined
    // for no date restriction) -- not built from Object.keys here, since a
    // Sequelize Op key is a Symbol and Object.keys silently ignores those.
    async function linesFor(entryDate) {
      const entryWhere = { orgId };
      if (entryDate !== undefined) entryWhere.entryDate = entryDate;
      const entries = await JournalEntry.findAll({
        where: entryWhere,
        attributes: ["id", "entryDate", "memo", "source", "createdAt"],
        raw: true,
      });
      if (!entries.length) return [];
      const entryById = new Map(entries.map((e) => [e.id, e]));
      const lines = await JournalLine.findAll({
        where: { journalEntryId: { [Op.in]: entries.map((e) => e.id) } },
        attributes: ["journalEntryId", "accountId", "debitCents", "creditCents"],
        raw: true,
      });
      return { entryById, lines };
    }

    // Opening balance: everything on this account strictly before `from`,
    // collapsed to one number -- not a row-by-row list, since the point is
    // to carry a starting balance forward, not to re-list history the
    // period is deliberately excluding.
    let openingCents = 0;
    if (from) {
      const before = await linesFor({ [Op.lt]: from });
      if (before.lines) {
        for (const line of before.lines) {
          if (line.accountId !== account.id) continue;
          openingCents += normalBalanceCents(account.type, line.debitCents, line.creditCents);
        }
      }
    }

    let rangeDate;
    if (from && to) rangeDate = { [Op.gte]: from, [Op.lte]: to };
    else if (from) rangeDate = { [Op.gte]: from };
    else if (to) rangeDate = { [Op.lte]: to };
    const { entryById = new Map(), lines = [] } = (await linesFor(rangeDate)) || {};

    // Group by entry so a multi-line entry (e.g. a payroll run) shows the
    // other accounts it touched, not just a bare debit/credit against this
    // one -- that "what's on the other side" is exactly what makes a line
    // traceable back to the transaction that produced it.
    const otherAccountIdsByEntry = new Map();
    const thisAccountLinesByEntry = new Map();
    for (const line of lines) {
      if (line.accountId === account.id) {
        if (!thisAccountLinesByEntry.has(line.journalEntryId)) thisAccountLinesByEntry.set(line.journalEntryId, []);
        thisAccountLinesByEntry.get(line.journalEntryId).push(line);
      } else {
        if (!otherAccountIdsByEntry.has(line.journalEntryId)) otherAccountIdsByEntry.set(line.journalEntryId, new Set());
        otherAccountIdsByEntry.get(line.journalEntryId).add(line.accountId);
      }
    }

    const otherAccountIds = new Set([...otherAccountIdsByEntry.values()].flatMap((s) => [...s]));
    const otherAccounts = otherAccountIds.size
      ? await Account.findAll({ where: { id: [...otherAccountIds] }, attributes: ["id", "name"], raw: true })
      : [];
    const otherAccountNameById = new Map(otherAccounts.map((a) => [a.id, a.name]));

    const entryIds = [...thisAccountLinesByEntry.keys()].sort((a, b) => {
      const ea = entryById.get(a);
      const eb = entryById.get(b);
      if (ea.entryDate !== eb.entryDate) return ea.entryDate < eb.entryDate ? -1 : 1;
      return new Date(ea.createdAt) - new Date(eb.createdAt);
    });

    let runningCents = openingCents;
    const rows = [];
    for (const entryId of entryIds) {
      const entry = entryById.get(entryId);
      for (const line of thisAccountLinesByEntry.get(entryId)) {
        runningCents += normalBalanceCents(account.type, line.debitCents, line.creditCents);
        const otherNames = [...(otherAccountIdsByEntry.get(entryId) || [])].map((id) => otherAccountNameById.get(id) || "—");
        rows.push({
          journal_entry_id: entryId,
          entry_date: entry.entryDate,
          memo: entry.memo,
          source: entry.source,
          other_accounts: otherNames,
          debit: centsToDollars(line.debitCents),
          credit: centsToDollars(line.creditCents),
          balance: centsToDollars(runningCents),
        });
      }
    }

    res.json({
      account: serializeAccount(account),
      from,
      to,
      opening_balance: centsToDollars(openingCents),
      closing_balance: centsToDollars(runningCents),
      rows,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
