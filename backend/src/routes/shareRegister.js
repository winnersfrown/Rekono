// The share register's HTTP surface. shareRegister.js owns the rules about
// what a valid share movement is; this validates request shape, scopes
// everything to the caller's org, and writes the audit trail.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { LedgerError } from "../ledger.js";
import { SHARE_TRANSACTION_TYPES } from "../models/ShareRegister.js";
import {
  computeCapTable,
  computeShareCounts,
  deleteShareTransaction,
  recordShareTransaction,
  reconcileShareRegister,
  serializeShareClass,
  serializeShareTransaction,
  serializeShareholder,
} from "../shareRegister.js";
import { AuditLog, ShareClass, ShareTransaction, Shareholder } from "../models/index.js";

const router = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function asOfParam(req) {
  return ISO_DATE.test(req.query.as_of || "") ? req.query.as_of : null;
}

function handleLedgerError(err, res, next) {
  if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
  next(err);
}

/* ------------------------------- classes ------------------------------- */

const shareClassSchema = z.object({
  name: z.string().min(1).max(128),
  // Dollars per share, as written in the certificate of incorporation.
  // Delaware's default is $0.0001, so this has to survive four decimals --
  // hence a column in millionths rather than cents.
  par_value: z.number().min(0).default(0),
  authorized_shares: z.number().int().positive().nullable().optional(),
});

router.get("/api/share-classes", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const classes = await ShareClass.findAll({ where: { orgId: req.currentUser.orgId }, order: [["name", "ASC"]] });
    res.json({ items: classes.map(serializeShareClass) });
  } catch (err) {
    next(err);
  }
});

router.post("/api/share-classes", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = shareClassSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;
    const d = parsed.data;

    const existing = await ShareClass.findOne({ where: { orgId, name: d.name } });
    if (existing) return res.status(409).json({ detail: `There's already a share class called ${d.name}.` });

    const shareClass = await ShareClass.create({
      orgId,
      name: d.name,
      parValueMicros: Math.round(d.par_value * 1000000),
      authorizedShares: d.authorized_shares ?? null,
    });

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "share_class_created",
      actor: req.currentUser.email,
      details: { name: d.name, par_value: d.par_value, authorized_shares: d.authorized_shares ?? null },
    });

    res.status(201).json(serializeShareClass(shareClass));
  } catch (err) {
    next(err);
  }
});

const shareClassUpdateSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  authorized_shares: z.number().int().positive().nullable().optional(),
  active: z.boolean().optional(),
});

// Par value is deliberately absent from the update schema. It is fixed in
// the charter, and every issuance already posted split par from premium
// using the old number -- changing it here would silently invalidate the
// Common-Stock-divided-by-par reconciliation for every past issuance
// without touching a single journal entry. A class issued at the wrong par
// is corrected by fixing the entries, not by rewriting the class.
router.patch("/api/share-classes/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = shareClassUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;

    const shareClass = await ShareClass.findOne({ where: { id: req.params.id, orgId } });
    if (!shareClass) return res.status(404).json({ detail: "Share class not found" });

    const d = parsed.data;
    if (d.name !== undefined && d.name !== shareClass.name) {
      const clash = await ShareClass.findOne({ where: { orgId, name: d.name } });
      if (clash) return res.status(409).json({ detail: `There's already a share class called ${d.name}.` });
      shareClass.name = d.name;
    }
    if (d.authorized_shares !== undefined) {
      // Lowering the ceiling below what is already issued would leave the
      // register describing an impossible company. Raising it is fine, and
      // is what a charter amendment does.
      const issued = (await computeShareCounts(orgId)).find((c) => c.id === shareClass.id)?.issued ?? 0;
      if (d.authorized_shares !== null && d.authorized_shares < issued) {
        return res.status(422).json({ detail: `${issued} shares of this class are already issued, so it can't be authorized for fewer.` });
      }
      shareClass.authorizedShares = d.authorized_shares;
    }
    if (d.active !== undefined) shareClass.active = d.active;
    await shareClass.save();

    res.json(serializeShareClass(shareClass));
  } catch (err) {
    next(err);
  }
});

/* ----------------------------- shareholders ---------------------------- */

const shareholderSchema = z.object({
  name: z.string().min(1).max(256),
  email: z.string().email().max(320).optional().or(z.literal("")),
  notes: z.string().max(2000).optional(),
});

router.get("/api/shareholders", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const holders = await Shareholder.findAll({ where: { orgId: req.currentUser.orgId }, order: [["name", "ASC"]] });
    res.json({ items: holders.map(serializeShareholder) });
  } catch (err) {
    next(err);
  }
});

router.post("/api/shareholders", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = shareholderSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;
    const d = parsed.data;

    const holder = await Shareholder.create({
      orgId,
      name: d.name,
      email: d.email || "",
      notes: d.notes || "",
    });

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "shareholder_created",
      actor: req.currentUser.email,
      details: { name: d.name },
    });

    res.status(201).json(serializeShareholder(holder));
  } catch (err) {
    next(err);
  }
});

const shareholderUpdateSchema = shareholderSchema.partial().extend({ active: z.boolean().optional() });

router.patch("/api/shareholders/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = shareholderUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    const holder = await Shareholder.findOne({ where: { id: req.params.id, orgId: req.currentUser.orgId } });
    if (!holder) return res.status(404).json({ detail: "Shareholder not found" });

    const d = parsed.data;
    if (d.name !== undefined) holder.name = d.name;
    if (d.email !== undefined) holder.email = d.email || "";
    if (d.notes !== undefined) holder.notes = d.notes;
    if (d.active !== undefined) holder.active = d.active;
    await holder.save();

    res.json(serializeShareholder(holder));
  } catch (err) {
    next(err);
  }
});

/* ----------------------------- transactions ---------------------------- */

const shareTransactionSchema = z.object({
  type: z.enum(SHARE_TRANSACTION_TYPES),
  share_class_id: z.string().min(1),
  transaction_date: z.string().regex(ISO_DATE),
  shares: z.number().int().positive(),
  from_shareholder_id: z.string().min(1).nullable().optional(),
  to_shareholder_id: z.string().min(1).nullable().optional(),
  price_per_share: z.number().min(0).nullable().optional(),
  equity_transaction_id: z.string().min(1).nullable().optional(),
  memo: z.string().max(512).optional(),
});

router.get("/api/share-transactions", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const where = { orgId };
    if (SHARE_TRANSACTION_TYPES.includes(req.query.type)) where.type = req.query.type;
    if (req.query.share_class_id) where.shareClassId = req.query.share_class_id;

    // Names resolved from two small org-wide reads rather than an include
    // per row -- the same N+1 the bills endpoint was rewritten to avoid.
    const [transactions, holders, classes] = await Promise.all([
      ShareTransaction.findAll({ where, order: [["transactionDate", "DESC"], ["id", "DESC"]], limit: 500 }),
      Shareholder.findAll({ where: { orgId } }),
      ShareClass.findAll({ where: { orgId } }),
    ]);

    const holdersById = new Map(holders.map((h) => [h.id, h]));
    const classesById = new Map(classes.map((c) => [c.id, c]));
    res.json({ items: transactions.map((t) => serializeShareTransaction(t, { holdersById, classesById })) });
  } catch (err) {
    next(err);
  }
});

router.post("/api/share-transactions", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = shareTransactionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;
    const d = parsed.data;

    const transaction = await recordShareTransaction(orgId, {
      type: d.type,
      shareClassId: d.share_class_id,
      transactionDate: d.transaction_date,
      shares: d.shares,
      fromShareholderId: d.from_shareholder_id || null,
      toShareholderId: d.to_shareholder_id || null,
      pricePerShareMicros: d.price_per_share === undefined || d.price_per_share === null ? null : Math.round(d.price_per_share * 1000000),
      equityTransactionId: d.equity_transaction_id || null,
      memo: d.memo || "",
    });

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "share_transaction_recorded",
      actor: req.currentUser.email,
      details: { type: d.type, shares: d.shares, share_class_id: d.share_class_id },
    });

    res.status(201).json(serializeShareTransaction(transaction));
  } catch (err) {
    handleLedgerError(err, res, next);
  }
});

router.delete("/api/share-transactions/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const transaction = await deleteShareTransaction(orgId, req.params.id);
    if (!transaction) return res.status(404).json({ detail: "Share transaction not found" });

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "share_transaction_deleted",
      actor: req.currentUser.email,
      details: { type: transaction.type, shares: transaction.shares, share_class_id: transaction.shareClassId },
    });

    res.json({ status: "deleted", id: transaction.id });
  } catch (err) {
    handleLedgerError(err, res, next);
  }
});

/* ------------------------------- reports ------------------------------- */

router.get("/api/share-classes/counts", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    res.json({ items: await computeShareCounts(req.currentUser.orgId, { asOf: asOfParam(req) }) });
  } catch (err) {
    next(err);
  }
});

router.get("/api/cap-table", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    res.json(await computeCapTable(req.currentUser.orgId, { asOf: asOfParam(req) }));
  } catch (err) {
    next(err);
  }
});

router.get("/api/share-register/reconciliation", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    res.json(await reconcileShareRegister(req.currentUser.orgId, { asOf: asOfParam(req) }));
  } catch (err) {
    next(err);
  }
});

export default router;
