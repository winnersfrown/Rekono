import { Router } from "express";
import { parse } from "csv-parse/sync";
import { requireAuth } from "../auth.js";
import { requireActiveTrial } from "../trial.js";
import * as matchingEngine from "../matching.js";
import { upload } from "../storage.js";
import { AuditLog, Invoice, MatchEntry, MatchResult, MatchSource } from "../models/index.js";
import { serializeMatchResult, serializeMatchSource } from "../serializers.js";

const router = Router();

const COLUMN_ALIASES = {
  vendor: ["vendor", "vendor_name", "payee", "supplier", "name"],
  amount: ["amount", "total", "value"],
  date: ["date", "entry_date", "transaction_date", "po_date"],
  reference: ["reference", "po_number", "po_reference", "ref", "check_number", "memo"],
};

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
  if (!resolved.vendor || !resolved.amount) {
    return null;
  }
  return resolved;
}

function parseAmount(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const cleaned = String(raw).replace(/[$,]/g, "").trim();
  const n = Number(cleaned);
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

router.post("/api/matching/sources", requireAuth, requireActiveTrial, upload.single("file"), async (req, res, next) => {
  try {
    const sourceType = req.query.source_type;
    if (!["po", "bank"].includes(sourceType)) {
      return res.status(422).json({ detail: "source_type must be 'po' or 'bank'" });
    }
    if (!req.file) {
      return res.status(422).json({ detail: "A file upload is required." });
    }

    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(req.file.path);
    await fs.rm(req.file.path, { force: true });

    let records;
    try {
      records = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
    } catch (exc) {
      return res.status(422).json({ detail: `Could not parse CSV: ${exc.message}` });
    }

    const headers = records.length ? Object.keys(records[0]) : [];
    const cols = resolveColumns(headers);
    if (!cols) {
      return res.status(422).json({
        detail: `CSV must include a vendor/payee column and an amount column. Found columns: ${JSON.stringify(headers)}`,
      });
    }

    const source = await MatchSource.create({ orgId: req.currentUser.orgId, name: req.file.originalname || "upload.csv", sourceType });

    await MatchEntry.bulkCreate(
      records.map((row) => ({
        sourceId: source.id,
        vendor: row[cols.vendor] || "",
        amount: parseAmount(row[cols.amount]),
        entryDate: cols.date ? parseDateToISO(row[cols.date]) : null,
        reference: cols.reference ? row[cols.reference] || "" : "",
        rawRow: row,
      }))
    );

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      action: "match_source_uploaded",
      actor: req.currentUser.email,
      details: { source_type: sourceType, rows: records.length },
    });

    res.status(201).json(serializeMatchSource(source, records.length));
  } catch (err) {
    next(err);
  }
});

router.get("/api/matching/sources", requireAuth, requireActiveTrial, async (req, res, next) => {
  try {
    const sources = await MatchSource.findAll({ where: { orgId: req.currentUser.orgId } });
    const out = await Promise.all(
      sources.map(async (s) => serializeMatchSource(s, await MatchEntry.count({ where: { sourceId: s.id } })))
    );
    res.json(out);
  } catch (err) {
    next(err);
  }
});

router.post("/api/matching/run", requireAuth, requireActiveTrial, async (req, res, next) => {
  try {
    const sources = await MatchSource.findAll({ where: { orgId: req.currentUser.orgId }, attributes: ["id"] });
    const entries = await MatchEntry.findAll({ where: { sourceId: sources.map((s) => s.id) } });
    const candidates = entries.map((e) => ({
      id: e.id,
      vendor: e.vendor,
      amount: e.amount,
      entryDate: e.entryDate,
      reference: e.reference,
    }));

    const invoices = await Invoice.findAll({
      where: { orgId: req.currentUser.orgId, status: ["extracted", "needs_review", "approved"] },
    });

    const counts = { matched: 0, partial: 0, unmatched: 0 };
    for (const invoice of invoices) {
      const outcome = matchingEngine.findBestMatch(
        invoice.vendorName,
        invoice.total,
        invoice.invoiceDate,
        invoice.poReference,
        candidates
      );
      await MatchResult.create({
        invoiceId: invoice.id,
        matchEntryId: outcome.entryId,
        status: outcome.status,
        score: outcome.score,
        reasoning: outcome.reasoning,
      });
      await AuditLog.create({
        orgId: req.currentUser.orgId,
        userId: req.currentUser.id,
        invoiceId: invoice.id,
        action: "match_evaluated",
        actor: req.currentUser.email,
        details: { status: outcome.status, score: outcome.score, reasoning: outcome.reasoning },
      });
      counts[outcome.status] += 1;
    }

    res.json({
      invoices_evaluated: invoices.length,
      matched: counts.matched,
      partial: counts.partial,
      unmatched: counts.unmatched,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/api/matching/results", requireAuth, requireActiveTrial, async (req, res, next) => {
  try {
    const results = await MatchResult.findAll({
      include: [{ model: Invoice, attributes: [], where: { orgId: req.currentUser.orgId }, required: true }],
      order: [["createdAt", "DESC"]],
    });
    res.json(results.map(serializeMatchResult));
  } catch (err) {
    next(err);
  }
});

export default router;
