// Recurring (adjusting) entries and year-end closing entries -- the two
// halves of "journalizing adjustments and closing entries" that a close
// actually consists of. recurringEntries.js and yearEndClose.js own the
// accounting; this is the HTTP surface.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { LedgerError, centsToDollars, dollarsToCents } from "../ledger.js";
import { RECURRING_FREQUENCIES } from "../models/RecurringEntry.js";
import {
  accountsExist,
  dueDates,
  loadTemplateLines,
  previewRecurringEntries,
  runRecurringEntries,
} from "../recurringEntries.js";
import {
  closedFiscalYears,
  postYearEndClose,
  previewYearEndClose,
  reopenYearEndClose,
} from "../yearEndClose.js";
import { Account, AuditLog, RecurringEntry, RecurringEntryLine } from "../models/index.js";

const router = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function serializeTemplate(t, lines = null, accountsById = null) {
  return {
    id: t.id,
    name: t.name,
    memo: t.memo,
    frequency: t.frequency,
    start_date: t.startDate,
    end_date: t.endDate,
    last_posted_date: t.lastPostedDate,
    active: t.active,
    next_due: dueDates(t, todayIso())[0] || null,
    ...(lines
      ? {
          lines: lines.map((l) => ({
            id: l.id,
            account_id: l.accountId,
            account_name: accountsById?.get(l.accountId)?.name,
            debit: centsToDollars(l.debitCents),
            credit: centsToDollars(l.creditCents),
            memo: l.memo,
          })),
        }
      : {}),
  };
}

// ---- Recurring / adjusting entries ----

router.get("/api/recurring-entries", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const templates = await RecurringEntry.findAll({ where: { orgId }, order: [["name", "ASC"]] });
    const accounts = await Account.findAll({ where: { orgId } });
    const byId = new Map(accounts.map((a) => [a.id, a]));

    const items = [];
    for (const t of templates) items.push(serializeTemplate(t, await loadTemplateLines(t.id), byId));
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

const templateLineSchema = z
  .object({
    account_id: z.string().min(1),
    debit: z.number().min(0).optional(),
    credit: z.number().min(0).optional(),
    memo: z.string().max(512).optional(),
  })
  .refine((l) => Boolean(l.debit) !== Boolean(l.credit), {
    message: "Each line must be a debit or a credit, never both or neither.",
  });

const templateSchema = z.object({
  name: z.string().min(1).max(256),
  memo: z.string().max(512).optional(),
  frequency: z.enum(RECURRING_FREQUENCIES),
  start_date: z.string().regex(ISO_DATE),
  end_date: z.string().regex(ISO_DATE).optional(),
  lines: z.array(templateLineSchema).min(2),
});

router.post("/api/recurring-entries", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = templateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;
    const data = parsed.data;

    if (data.end_date && data.end_date < data.start_date) {
      return res.status(422).json({ detail: "A recurring entry can't end before it starts." });
    }
    if (!(await accountsExist(orgId, data.lines.map((l) => l.account_id)))) {
      return res.status(422).json({ detail: "Every line must post to an account you own." });
    }

    // Balanced at template time, not just at posting time. An unbalanced
    // template is a trap: it looks saved, then fails every month forever
    // with an error nobody is watching for.
    const debits = data.lines.reduce((s, l) => s + dollarsToCents(l.debit || 0), 0);
    const credits = data.lines.reduce((s, l) => s + dollarsToCents(l.credit || 0), 0);
    if (debits !== credits) {
      return res.status(422).json({ detail: "This template doesn't balance -- debits and credits must be equal." });
    }
    if (debits === 0) return res.status(422).json({ detail: "A recurring entry needs a non-zero amount." });

    const template = await RecurringEntry.create({
      orgId,
      name: data.name,
      memo: data.memo || "",
      frequency: data.frequency,
      startDate: data.start_date,
      endDate: data.end_date || null,
    });
    await RecurringEntryLine.bulkCreate(
      data.lines.map((l, i) => ({
        recurringEntryId: template.id,
        accountId: l.account_id,
        debitCents: dollarsToCents(l.debit || 0),
        creditCents: dollarsToCents(l.credit || 0),
        memo: l.memo || "",
        position: i,
      }))
    );

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "recurring_entry_created",
      actor: req.currentUser.email,
      details: { name: template.name, frequency: template.frequency, amount: centsToDollars(debits) },
    });

    const accounts = await Account.findAll({ where: { orgId } });
    res.status(201).json(serializeTemplate(template, await loadTemplateLines(template.id), new Map(accounts.map((a) => [a.id, a]))));
  } catch (err) {
    next(err);
  }
});

router.patch("/api/recurring-entries/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = z
      .object({ name: z.string().min(1).max(256).optional(), active: z.boolean().optional(), end_date: z.string().regex(ISO_DATE).nullable().optional() })
      .safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    const template = await RecurringEntry.findOne({ where: { id: req.params.id, orgId: req.currentUser.orgId } });
    if (!template) return res.status(404).json({ detail: "Recurring entry not found" });

    if (parsed.data.name !== undefined) template.name = parsed.data.name;
    if (parsed.data.active !== undefined) template.active = parsed.data.active;
    if (parsed.data.end_date !== undefined) template.endDate = parsed.data.end_date;
    await template.save();

    res.json(serializeTemplate(template));
  } catch (err) {
    next(err);
  }
});

// Deleting stops future postings. Entries already posted are real journal
// entries and stay -- un-posting history is what voiding is for.
router.delete("/api/recurring-entries/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const template = await RecurringEntry.findOne({ where: { id: req.params.id, orgId: req.currentUser.orgId } });
    if (!template) return res.status(404).json({ detail: "Recurring entry not found" });
    await template.destroy();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/api/recurring-entries/pending", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const asOf = ISO_DATE.test(req.query.as_of || "") ? req.query.as_of : todayIso();
    res.json(await previewRecurringEntries(req.currentUser.orgId, asOf));
  } catch (err) {
    next(err);
  }
});

router.post("/api/recurring-entries/run", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = z
      .object({ as_of: z.string().regex(ISO_DATE).optional(), template_id: z.string().optional() })
      .safeParse(req.body || {});
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const asOf = parsed.data.as_of || todayIso();

    const result = await runRecurringEntries(req.currentUser.orgId, asOf, {
      postedByUserId: req.currentUser.id,
      templateId: parsed.data.template_id || null,
    });

    if (result.posted.length) {
      await AuditLog.create({
        orgId: req.currentUser.orgId,
        userId: req.currentUser.id,
        action: "recurring_entries_run",
        actor: req.currentUser.email,
        details: { as_of: asOf, posted: result.posted.length, amount: result.total },
      });
    }
    res.json({ as_of: asOf, ...result });
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

// ---- Year-end closing entries ----

router.get("/api/close/year-end", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const date = ISO_DATE.test(req.query.date || "") ? req.query.date : todayIso();
    const [preview, closed] = await Promise.all([
      previewYearEndClose(req.currentUser.orgId, date),
      closedFiscalYears(req.currentUser.orgId),
    ]);
    res.json({ ...preview, closed_years: closed });
  } catch (err) {
    next(err);
  }
});

router.post("/api/close/year-end", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = z.object({ date: z.string().regex(ISO_DATE).optional() }).safeParse(req.body || {});
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const date = parsed.data.date || todayIso();

    const entry = await postYearEndClose(req.currentUser.orgId, date, { postedByUserId: req.currentUser.id });
    const preview = await previewYearEndClose(req.currentUser.orgId, date);

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      action: "fiscal_year_closed",
      actor: req.currentUser.email,
      details: { fiscal_year: preview.fiscal_year.label, journal_entry_id: entry.id },
    });

    res.json({ fiscal_year: preview.fiscal_year, journal_entry_id: entry.id });
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

router.post("/api/close/year-end/reopen", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = z.object({ date: z.string().regex(ISO_DATE).optional() }).safeParse(req.body || {});
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    const fy = await reopenYearEndClose(req.currentUser.orgId, parsed.data.date || todayIso(), {
      postedByUserId: req.currentUser.id,
    });

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      action: "fiscal_year_reopened",
      actor: req.currentUser.email,
      details: { fiscal_year: fy.label },
    });

    res.json({ fiscal_year: fy });
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

export default router;
