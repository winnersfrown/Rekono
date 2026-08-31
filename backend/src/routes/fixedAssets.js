// Fixed assets -- see fixedAssets.js for the accounting, models/FixedAsset.js
// for why a dedicated record exists now instead of the one-shot calculator
// this supersedes (routes/adjustments.js used to expose
// POST /api/recurring-entries/depreciation; removed in the same change that
// added this file).

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { LedgerError } from "../ledger.js";
import { createFixedAsset, dollarsToFixedAssetCents, serializeFixedAsset } from "../fixedAssets.js";
import { FixedAsset, RecurringEntry, AuditLog } from "../models/index.js";

const router = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

router.get("/api/fixed-assets", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const assets = await FixedAsset.findAll({ where: { orgId: req.currentUser.orgId }, order: [["acquisitionDate", "ASC"], ["name", "ASC"]] });
    const templates = await RecurringEntry.findAll({ where: { orgId: req.currentUser.orgId } });
    const templateById = new Map(templates.map((t) => [t.id, t]));
    const items = await Promise.all(assets.map((a) => serializeFixedAsset(a, templateById.get(a.recurringEntryId))));
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  name: z.string().min(1).max(256),
  cost: z.number().positive(),
  salvage_value: z.number().min(0).default(0),
  useful_life_months: z.number().int().positive(),
  acquisition_date: z.string().regex(ISO_DATE),
  asset_account_id: z.string().min(1),
  expense_account_id: z.string().min(1),
  accumulated_depreciation_account_id: z.string().min(1),
});

router.post("/api/fixed-assets", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const d = parsed.data;
    const orgId = req.currentUser.orgId;

    if (d.salvage_value > d.cost) {
      return res.status(422).json({ detail: "Salvage value can't exceed cost." });
    }

    const asset = await createFixedAsset(orgId, {
      name: d.name,
      ...dollarsToFixedAssetCents(d),
      usefulLifeMonths: d.useful_life_months,
      acquisitionDate: d.acquisition_date,
      assetAccountId: d.asset_account_id,
      expenseAccountId: d.expense_account_id,
      accumulatedDepreciationAccountId: d.accumulated_depreciation_account_id,
    });

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "fixed_asset_created",
      actor: req.currentUser.email,
      details: { name: d.name, cost: d.cost, useful_life_months: d.useful_life_months },
    });

    res.status(201).json(await serializeFixedAsset(asset));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

router.patch("/api/fixed-assets/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = z.object({ name: z.string().min(1).max(256).optional(), active: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    const asset = await FixedAsset.findOne({ where: { id: req.params.id, orgId: req.currentUser.orgId } });
    if (!asset) return res.status(404).json({ detail: "Fixed asset not found" });

    if (parsed.data.name !== undefined) {
      asset.name = parsed.data.name;
      await asset.save();
    }
    if (parsed.data.active !== undefined) {
      // Pausing/resuming depreciation is really pausing/resuming the
      // RecurringEntry it owns -- the asset record itself doesn't carry an
      // active flag of its own, so there's exactly one place "is this
      // depreciating right now" can disagree with itself.
      const template = await RecurringEntry.findOne({ where: { id: asset.recurringEntryId, orgId: req.currentUser.orgId } });
      if (template) {
        template.active = parsed.data.active;
        await template.save();
      }
    }

    res.json(await serializeFixedAsset(asset));
  } catch (err) {
    next(err);
  }
});

// Deletes the asset record and its depreciation schedule. Entries already
// posted are real journal entries and stay -- same as deleting a
// RecurringEntry template directly (routes/adjustments.js), this stops
// future postings, it doesn't un-post history.
router.delete("/api/fixed-assets/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const asset = await FixedAsset.findOne({ where: { id: req.params.id, orgId: req.currentUser.orgId } });
    if (!asset) return res.status(404).json({ detail: "Fixed asset not found" });

    const template = await RecurringEntry.findOne({ where: { id: asset.recurringEntryId, orgId: req.currentUser.orgId } });
    await asset.destroy();
    if (template) await template.destroy();

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
