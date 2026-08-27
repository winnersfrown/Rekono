// Chart of accounts CRUD -- mirrors routes/leases.js's shape (ownership
// helper, requireAuth + requireActivePlan, AuditLog per mutation,
// serializers.js response shaping) applied to Account instead of Lease.
// See ledger.js for the seeded defaults every org starts with and how
// invoice approval posts against these.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { ACCOUNT_TYPES } from "../models/Account.js";
import { Account, AuditLog } from "../models/index.js";
import { serializeAccount } from "../serializers.js";

const router = Router();

async function getOwnedAccount(id, orgId) {
  return Account.findOne({ where: { id, orgId } });
}

router.get("/api/accounts", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const where = { orgId: req.currentUser.orgId };
    if (req.query.type) where.type = req.query.type;
    if (req.query.active === "true") where.active = true;
    if (req.query.active === "false") where.active = false;

    const accounts = await Account.findAll({ where, order: [["code", "ASC"], ["name", "ASC"]] });
    res.json({ items: accounts.map(serializeAccount) });
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

export default router;
