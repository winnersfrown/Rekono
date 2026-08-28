// Option pool and equity awards. equityAwards.js owns the vesting and
// pool arithmetic; this validates request shape, scopes to the caller's
// org, and writes the audit trail.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { LedgerError } from "../ledger.js";
import { EQUITY_AWARD_TYPES } from "../models/EquityAward.js";
import {
  awardsWithEvents,
  cancelAward,
  computeFullyDiluted,
  computePlanStatus,
  exerciseAward,
  recordAwardGrant,
  serializeAward,
  serializeEquityPlan,
} from "../equityAwards.js";
import { AuditLog, EquityPlan, ShareClass, Shareholder } from "../models/index.js";

const router = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function asOfParam(req) {
  return ISO_DATE.test(req.query.as_of || "") ? req.query.as_of : null;
}

function handleLedgerError(err, res, next) {
  if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
  next(err);
}

/* -------------------------------- plans -------------------------------- */

const planSchema = z.object({
  name: z.string().min(1).max(128),
  share_class_id: z.string().min(1),
  reserved_shares: z.number().int().positive(),
  adopted_date: z.string().regex(ISO_DATE),
});

router.get("/api/equity-plans", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    res.json({ items: await computePlanStatus(req.currentUser.orgId, { asOf: asOfParam(req) }) });
  } catch (err) {
    next(err);
  }
});

router.post("/api/equity-plans", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = planSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;
    const d = parsed.data;

    const shareClass = await ShareClass.findOne({ where: { id: d.share_class_id, orgId } });
    if (!shareClass) return res.status(404).json({ detail: "Share class not found" });

    const clash = await EquityPlan.findOne({ where: { orgId, name: d.name } });
    if (clash) return res.status(409).json({ detail: `There's already a plan called ${d.name}.` });

    const plan = await EquityPlan.create({
      orgId,
      name: d.name,
      shareClassId: d.share_class_id,
      reservedShares: d.reserved_shares,
      adoptedDate: d.adopted_date,
    });

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "equity_plan_created",
      actor: req.currentUser.email,
      details: { name: d.name, reserved_shares: d.reserved_shares },
    });

    res.status(201).json(serializeEquityPlan(plan));
  } catch (err) {
    next(err);
  }
});

const planUpdateSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  reserved_shares: z.number().int().positive().optional(),
  active: z.boolean().optional(),
});

// The share class is deliberately not editable. Awards already granted
// promise shares of one specific class, and repointing the plan would
// silently repoint every one of them -- including any already exercised
// into stock of the original class, which no amount of editing can undo.
router.patch("/api/equity-plans/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = planUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;

    const plan = await EquityPlan.findOne({ where: { id: req.params.id, orgId } });
    if (!plan) return res.status(404).json({ detail: "Equity plan not found" });

    const d = parsed.data;
    if (d.name !== undefined && d.name !== plan.name) {
      const clash = await EquityPlan.findOne({ where: { orgId, name: d.name } });
      if (clash) return res.status(409).json({ detail: `There's already a plan called ${d.name}.` });
      plan.name = d.name;
    }
    if (d.reserved_shares !== undefined) {
      // Raising the reserve is a board amendment and is the normal reason
      // to touch a plan at all. Lowering it below what's already committed
      // would describe a plan that can't honour its own grants.
      const status = (await computePlanStatus(orgId)).find((p) => p.id === plan.id);
      const committed = status ? status.granted - status.cancelled : 0;
      if (d.reserved_shares < committed) {
        return res.status(422).json({
          detail: `${committed.toLocaleString("en-US")} shares are already granted from this plan, so it can't be reserved for fewer.`,
        });
      }
      plan.reservedShares = d.reserved_shares;
    }
    if (d.active !== undefined) plan.active = d.active;
    await plan.save();

    res.json(serializeEquityPlan(plan));
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- awards ------------------------------- */

const awardSchema = z.object({
  equity_plan_id: z.string().min(1),
  shareholder_id: z.string().min(1),
  type: z.enum(EQUITY_AWARD_TYPES).optional(),
  grant_date: z.string().regex(ISO_DATE),
  shares: z.number().int().positive(),
  strike_price: z.number().min(0).nullable().optional(),
  vesting_start_date: z.string().regex(ISO_DATE).optional(),
  vesting_months: z.number().int().min(0).max(240).optional(),
  cliff_months: z.number().int().min(0).max(240).optional(),
  memo: z.string().max(512).optional(),
});

router.get("/api/equity-awards", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const where = {};
    if (req.query.equity_plan_id) where.equityPlanId = req.query.equity_plan_id;
    if (req.query.shareholder_id) where.shareholderId = req.query.shareholder_id;

    // Names resolved from two small org-wide reads rather than an include
    // per row -- the same N+1 the bills and share-movement endpoints avoid.
    const [rows, holders, plans] = await Promise.all([
      awardsWithEvents(orgId, where, asOfParam(req)),
      Shareholder.findAll({ where: { orgId } }),
      EquityPlan.findAll({ where: { orgId } }),
    ]);

    const holdersById = new Map(holders.map((h) => [h.id, h]));
    const plansById = new Map(plans.map((p) => [p.id, p]));
    const items = rows
      .map((r) => serializeAward(r, { holdersById, plansById }))
      .sort((a, b) => (a.grant_date < b.grant_date ? 1 : a.grant_date > b.grant_date ? -1 : 0));

    res.json({ items });
  } catch (err) {
    next(err);
  }
});

router.post("/api/equity-awards", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = awardSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;
    const d = parsed.data;

    const award = await recordAwardGrant(orgId, {
      equityPlanId: d.equity_plan_id,
      shareholderId: d.shareholder_id,
      type: d.type || "option",
      grantDate: d.grant_date,
      shares: d.shares,
      // Millionths of a dollar -- a sub-cent strike is ordinary at the
      // seed stage, same reasoning as par value.
      strikePriceMicros: d.strike_price === undefined || d.strike_price === null ? null : Math.round(d.strike_price * 1000000),
      vestingStartDate: d.vesting_start_date,
      vestingMonths: d.vesting_months,
      cliffMonths: d.cliff_months,
      memo: d.memo || "",
    });

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "equity_award_granted",
      actor: req.currentUser.email,
      details: { shares: d.shares, type: d.type || "option", equity_plan_id: d.equity_plan_id },
    });

    res.status(201).json(serializeAward({ award, summary: null }));
  } catch (err) {
    handleLedgerError(err, res, next);
  }
});

const exerciseSchema = z
  .object({
    shares: z.number().int().positive(),
    event_date: z.string().regex(ISO_DATE),
    // Where the strike money landed. Given it, the exercise posts its own
    // capital contribution and the register's tie-out to the ledger stays
    // intact; without it, only shares move and the reconciliation says so.
    cash_account_id: z.string().min(1).nullable().optional(),
    // An exercise already posted by hand names its entry here instead.
    equity_transaction_id: z.string().min(1).nullable().optional(),
    memo: z.string().max(512).optional(),
  })
  .refine((d) => !(d.cash_account_id && d.equity_transaction_id), {
    message: "Name the account to post the contribution to, or an entry already posted -- not both.",
  });

router.post("/api/equity-awards/:id/exercise", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = exerciseSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;
    const d = parsed.data;

    const event = await exerciseAward(orgId, req.params.id, {
      shares: d.shares,
      eventDate: d.event_date,
      equityTransactionId: d.equity_transaction_id || null,
      cashAccountId: d.cash_account_id || null,
      memo: d.memo || "",
    });

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "equity_award_exercised",
      actor: req.currentUser.email,
      details: { award_id: req.params.id, shares: d.shares },
    });

    res.status(201).json({
      id: event.id,
      type: event.type,
      event_date: event.eventDate,
      shares: event.shares,
      share_transaction_id: event.shareTransactionId,
    });
  } catch (err) {
    handleLedgerError(err, res, next);
  }
});

const cancelSchema = z.object({
  // Omitted means "everything still outstanding", which is what a
  // departure almost always is.
  shares: z.number().int().positive().nullable().optional(),
  event_date: z.string().regex(ISO_DATE),
  memo: z.string().max(512).optional(),
});

router.post("/api/equity-awards/:id/cancel", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = cancelSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;
    const d = parsed.data;

    const event = await cancelAward(orgId, req.params.id, {
      shares: d.shares ?? null,
      eventDate: d.event_date,
      memo: d.memo || "",
    });

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "equity_award_cancelled",
      actor: req.currentUser.email,
      details: { award_id: req.params.id, shares: event.shares },
    });

    res.status(201).json({ id: event.id, type: event.type, event_date: event.eventDate, shares: event.shares });
  } catch (err) {
    handleLedgerError(err, res, next);
  }
});

/* -------------------------------- report ------------------------------- */

router.get("/api/cap-table/fully-diluted", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    res.json(await computeFullyDiluted(req.currentUser.orgId, { asOf: asOfParam(req) }));
  } catch (err) {
    next(err);
  }
});

export default router;
