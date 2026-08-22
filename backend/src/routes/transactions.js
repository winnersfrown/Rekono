import { Router } from "express";
import { parse } from "csv-parse/sync";
import { Op } from "sequelize";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { upload } from "../storage.js";
import { categorizeMerchants, normalizeMerchant } from "../transactionCategorization.js";
import { EXPENSE_CATEGORIES } from "../models/ExpenseReceipt.js";
import { AuditLog, MerchantCategory, Transaction } from "../models/index.js";

const router = Router();

// Same alias-resolution approach as routes/matching.js's CSV import: banks
// all export slightly different headers, and asking a user to rename
// columns before uploading their own statement is a pointless obstacle.
const COLUMN_ALIASES = {
  description: ["description", "merchant", "payee", "name", "details", "memo", "transaction"],
  amount: ["amount", "debit", "value", "total"],
  date: ["date", "posted_date", "posted", "transaction_date", "post date"],
};

const MAX_ROWS = 5000;

const correctSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  // Whether to remember this choice for the merchant. Defaults to true --
  // the whole point of correcting is that the next one shouldn't need it --
  // but a genuinely one-off charge from a merchant that usually belongs
  // elsewhere can opt out rather than corrupting the learned mapping.
  remember: z.boolean().optional(),
});

function resolveColumns(headers) {
  const lowerToActual = new Map(headers.map((h) => [h.toLowerCase().trim(), h]));
  const resolved = {};
  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      if (lowerToActual.has(alias)) {
        resolved[canonical] = lowerToActual.get(alias);
        break;
      }
    }
  }
  return resolved.description && resolved.amount ? resolved : null;
}

function parseAmount(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const cleaned = String(raw).replace(/[$,]/g, "").trim();
  const negated = /^\((.*)\)$/.exec(cleaned); // "(12.34)" is how some exports write a debit
  const n = Number(negated ? `-${negated[1]}` : cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseDateToISO(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slash = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    let [, m, d, y] = slash;
    if (y.length === 2) y = `20${y}`;
    if (Number(m) > 12 && Number(d) <= 12) [m, d] = [d, m];
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return null;
}

function serializeTransaction(t) {
  return {
    id: t.id,
    posted_date: t.postedDate,
    description: t.description,
    merchant_key: t.merchantKey,
    amount: t.amount,
    category: t.category,
    category_confidence: t.categoryConfidence,
    category_source: t.categorySource,
    reviewed_at: t.reviewedAt,
    created_at: t.createdAt,
  };
}

// Categorization runs inline rather than through jobs.js. The queue exists
// for per-document OCR/LLM work that takes tens of seconds each; this is a
// single batched call over distinct merchants (see
// transactionCategorization.js), so it finishes in about the time the
// upload itself takes -- and doing it here means the response already
// contains categorized rows instead of the UI having to poll for them.
router.post("/api/transactions/upload", requireAuth, requireActivePlan, upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(422).json({ detail: "A file upload is required." });

    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(req.file.path);
    await fs.rm(req.file.path, { force: true });

    let records;
    try {
      records = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
    } catch (exc) {
      return res.status(422).json({ detail: `Could not parse CSV: ${exc.message}` });
    }

    if (records.length > MAX_ROWS) {
      return res.status(422).json({ detail: `That file has ${records.length} rows; the limit is ${MAX_ROWS} per upload.` });
    }

    const headers = records.length ? Object.keys(records[0]) : [];
    const cols = resolveColumns(headers);
    if (!cols) {
      return res.status(422).json({
        detail: `CSV must include a description/merchant column and an amount column. Found columns: ${JSON.stringify(headers)}`,
      });
    }

    const orgId = req.currentUser.orgId;
    const rows = records.map((row) => {
      const description = String(row[cols.description] || "").slice(0, 512);
      return {
        orgId,
        description,
        merchantKey: normalizeMerchant(description),
        amount: parseAmount(row[cols.amount]),
        postedDate: cols.date ? parseDateToISO(row[cols.date]) : null,
        rawRow: row,
      };
    });

    const resolved = await categorizeMerchants(orgId, rows.map((r) => r.merchantKey));
    for (const row of rows) {
      const hit = resolved.get(row.merchantKey);
      if (hit) {
        row.category = hit.category;
        row.categoryConfidence = hit.confidence;
        row.categorySource = hit.source;
      }
    }

    const created = await Transaction.bulkCreate(rows);

    const bySource = created.reduce((acc, t) => {
      const key = t.categorySource || "uncategorized";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "transactions_imported",
      actor: req.currentUser.email,
      details: { filename: req.file.originalname || "upload.csv", rows: created.length, by_source: bySource },
    });

    res.status(201).json({
      imported: created.length,
      distinct_merchants: new Set(rows.map((r) => r.merchantKey)).size,
      by_source: bySource,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/api/transactions", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const where = { orgId: req.currentUser.orgId };

    if (req.query.category) where.category = req.query.category;
    // The review queue: anything a human hasn't signed off on that isn't
    // already a learned (i.e. previously human-decided) category.
    if (req.query.needs_review === "true") {
      where.reviewedAt = null;
      where.categorySource = { [Op.notIn]: ["learned", "manual"] };
    }
    if (req.query.q) {
      where.description = { [Op.like]: `%${String(req.query.q).toLowerCase()}%` };
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(req.query.page_size) || 100));

    const { rows, count } = await Transaction.findAndCountAll({
      where,
      order: [["postedDate", "DESC"], ["createdAt", "DESC"]],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    // Category totals for the whole filtered set, not just this page --
    // "how much went to Travel" is the question this feature exists to
    // answer, and a per-page total would silently answer a different one.
    const all = await Transaction.findAll({ where, attributes: ["category", "amount"], raw: true });
    const totals = {};
    for (const t of all) {
      const key = t.category || "Uncategorized";
      totals[key] = Math.round(((totals[key] || 0) + (t.amount || 0)) * 100) / 100;
    }

    res.json({
      items: rows.map(serializeTransaction),
      total: count,
      page,
      page_size: pageSize,
      categories: EXPENSE_CATEGORIES,
      category_totals: totals,
    });
  } catch (err) {
    next(err);
  }
});

// Accepting or correcting a category. Both go through here: confirming the
// suggestion is just a correction that happens to agree with it, and both
// are equally worth remembering for the merchant.
router.post("/api/transactions/:id/categorize", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = correctSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    const orgId = req.currentUser.orgId;
    const transaction = await Transaction.findOne({ where: { id: req.params.id, orgId } });
    if (!transaction) return res.status(404).json({ detail: "Transaction not found" });

    const previous = transaction.category;
    const { category } = parsed.data;
    const remember = parsed.data.remember !== false;

    transaction.category = category;
    transaction.categoryConfidence = 1;
    transaction.categorySource = "manual";
    transaction.reviewedAt = new Date();
    await transaction.save();

    let alsoUpdated = 0;
    if (remember && transaction.merchantKey) {
      const [mapping] = await MerchantCategory.findOrCreate({
        where: { orgId, merchantKey: transaction.merchantKey },
        defaults: { category },
      });
      if (mapping.category !== category) {
        mapping.category = category;
        await mapping.save();
      }

      // Apply the decision to this merchant's other un-reviewed rows too.
      // Leaving them on a now-known-wrong guess would mean the same
      // correction has to be made over and over on one statement, which is
      // exactly the tedium this feature is supposed to remove. Rows a human
      // already reviewed are left alone -- their explicit decision wins.
      const [count] = await Transaction.update(
        { category, categoryConfidence: 0.98, categorySource: "learned" },
        { where: { orgId, merchantKey: transaction.merchantKey, reviewedAt: null, id: { [Op.ne]: transaction.id } } }
      );
      alsoUpdated = count;
    }

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "transaction_categorized",
      actor: req.currentUser.email,
      details: {
        description: transaction.description,
        merchant_key: transaction.merchantKey,
        from: previous || null,
        to: category,
        remembered: remember,
        also_applied_to: alsoUpdated,
      },
    });

    res.json({ transaction: serializeTransaction(transaction), also_applied_to: alsoUpdated });
  } catch (err) {
    next(err);
  }
});

router.delete("/api/transactions/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const transaction = await Transaction.findOne({ where: { id: req.params.id, orgId: req.currentUser.orgId } });
    if (!transaction) return res.status(404).json({ detail: "Transaction not found" });
    await transaction.destroy();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
